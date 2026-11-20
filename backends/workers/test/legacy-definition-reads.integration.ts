import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Accounts } from "../../../src/accounts.ts";
import { api, type ApiContext } from "../../../src/api.ts";
import { BrowserTokens } from "../../../src/browser-tokens.ts";
import { ConsoleAuth } from "../../../src/console-auth.ts";
import { Definitions } from "../../../src/definitions.ts";
import { databaseFromEnvironment } from "../../../src/db.ts";
import { OAuth } from "../../../src/oauth.ts";
import { Passwords } from "../../../src/passwords.ts";
import { PublicOrigins } from "../../../src/origins.ts";
import { Tenants } from "../../../src/tenants.ts";
import { startFixture } from "./fixture.ts";

test("named legacy definition reads match Node without touching agents or source tools", { timeout: 180_000 }, async t => {
  const primary = "https://run.example.test", alias = "https://agents.example.test";
  const secret = "definition-read-fixture-session-secret", token = "art_definitions_fixture";
  const other = "art_definitions_foreign", grant = "aro_definitions_fixture";
  const role = `definitions_${randomBytes(8).toString("hex")}`;
  const f = await startFixture({
    tenants: [{ id: "fixture", token }, { id: "other", token: other }],
    databaseRole: { fixtureUser: role, grants: `grant usage on schema public to ${role};
      grant select on tenants, api_tokens, account_deletions, oauth_tokens, oauth_grants, definitions to ${role};
      grant select (id, tenant, header, revoked, purged_at, expires_at) on agents to ${role};
      grant select (tenant, channel) on channels to ${role};` },
    vars: { AGENT_PUBLIC_URL: primary, AGENT_PUBLIC_ALIASES: alias, AGENT_ISSUER: alias,
      AGENT_SESSION_SECRET: secret, LEGACY_DEFINITION_READS: "1" },
    entrypoint: fileURLToPath(new URL("./legacy-mcp-entry.ts", import.meta.url)),
    loopbackServices: { MCP_LEGACY_API: "FixtureLegacyOrigin" },
  });
  let db: Awaited<ReturnType<typeof databaseFromEnvironment>> | undefined;
  t.after(async () => {
    try { await db?.end(); }
    finally { await f.stop(); }
  });
  db = await databaseFromEnvironment({ AGENT_DATABASE_URL: f.databaseUrl });
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: {} }), env: true });
  await tenants.reload();
  const accounts = new Accounts({ tenants, db, secretsKey: "0".repeat(64) });
  const consoleAuth = new ConsoleAuth({ accounts, passwords: new Passwords(db), publicUrl: primary });
  const browserTokens = new BrowserTokens(secret);
  const oauth = new OAuth({ accounts, db, consoleAuth, secret, github: false, origins: new PublicOrigins(primary, [alias], alias) });
  const original = api({ accounts, consoleAuth, oauth, browserTokens, definitions: new Definitions({ db }) } as ApiContext);

  await f.db.query("insert into oauth_grants(id,tenant,client_id,client_name,scope,resource,created_at) values('grant','fixture','fixture','Fixture','agents','agents',1)");
  await f.db.query("insert into oauth_tokens(sha256,kind,grant_id,expires_at) values($1,'access','grant',$2)",
    [createHash("sha256").update(grant).digest("hex"), Date.now() + 600_000]);
  const [used, unused, byChannel, foreign] = ["1", "2", "3", "4"].map(char => "def_" + char.repeat(20));
  const [active, expired, revoked, purged] = ["1", "2", "3", "4"].map(char => "client_" + char.repeat(40));
  const oldSpec = {
    channel: "internal-placeholder", builtins: ["web_search", "workflow"], workflow: true,
    humanInput: { expiresInSeconds: 60, onExpire: "retired" },
    mcpServers: [{ name: "fixture", url: "https://mcp.invalid", headerNames: ["X-Test"], sealed: "hidden-value" }],
    openApi: [{ name: "rest", baseUrl: "https://rest.invalid", sealed: "other-hidden", operations: [{ name: "get_item", hidden: "internal" }] }],
  };
  for (const [id, tenant, spec, created] of [[used, "fixture", oldSpec, 1], [unused, "fixture", {}, 2],
    [byChannel, "fixture", {}, 3], [foreign, "other", {}, 4]] as const) {
    await f.db.query("insert into definitions(id,tenant,name,revision,spec,created_at,updated_at) values($1,$2,$1,2,$3,$4,5)", [id, tenant, spec, created]);
  }
  for (const [id, expiresAt, isRevoked, purgedAt] of [[active, null, false, null], [expired, 2, false, null],
    [revoked, null, true, null], [purged, null, false, 3]] as const) {
    await f.db.query(`insert into agents(id,tenant,header,revision,name,type,model,expires_at,revoked,purged_at)
      values($1,'fixture',$2,1,'','agent','test',$3,$4,$5)`, [id, { definition: { id: used, revision: 1 } }, expiresAt, isRevoked, purgedAt]);
  }
  await f.db.query("insert into channels(id,tenant,channel,created_at) values('fixture-channel','fixture',$1,1)", [{ definition: byChannel }]);

  const base = "/v1/definitions", exact = `${base}/${used}`;
  const read = (path: string, bearer: string, origin = primary, method = "GET") => fetch(f.url + path, {
    method, headers: { "x-forwarded-host": new URL(origin).host, authorization: `Bearer ${bearer}` },
  });
  const compare = async (path: string, bearer = token, status = 200) => {
    const node = await original.request(primary + path, { headers: { authorization: `Bearer ${bearer}` } });
    assert.equal(node.status, status);
    const expected = await node.json();
    for (const origin of [primary, alias]) {
      const edge = await read(path, bearer, origin);
      assert.equal(edge.status, status);
      assert.equal(edge.headers.get("cache-control"), "no-store");
      assert.deepEqual(await edge.json(), expected);
    }
    return expected;
  };
  const list = await compare(base) as { id: string }[];
  assert.deepEqual(list.map(entry => entry.id), [used, unused, byChannel]);
  assert.deepEqual((await compare(base + "?unused=true") as { id: string }[]).map(entry => entry.id), [unused]);
  const visible = await compare(exact, grant) as object;
  assert.deepEqual(visible, {
    id: used, name: used, revision: 2, createdAt: 1, updatedAt: 5, builtins: ["web_search"],
    humanInput: { expiresInSeconds: 60 },
    mcpServers: [{ name: "fixture", url: "https://mcp.invalid", headerNames: ["X-Test"] }],
    openApi: [{ name: "rest", baseUrl: "https://rest.invalid", tools: ["get_item"] }],
  });
  assert.deepEqual(await compare(exact + "/agents"), [{ id: active, revision: 1 }]);
  await compare(exact, other, 404);
  await compare(`${base}/unrecognized-key`, token, 404);
  await compare(exact, browserTokens.mint("fixture", active, {}).token, 403);
  await compare(exact.replace("/def_", "/%64ef_"));
  assert.equal((await read(exact, "art_unknown")).status, 418);
  assert.equal((await read(base, token, primary, "POST")).status, 418);
  assert.equal((await read(exact, token, primary, "PATCH")).status, 418);
  assert.equal((await fetch(f.url + exact)).status, 418);

  const mcp = await fetch(f.url + "/mcp", {
    method: "POST", headers: { authorization: `Bearer ${grant}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_definition", arguments: { definition: used } } }),
  });
  assert.equal(mcp.status, 200);
  const result = await mcp.json() as { result: { isError?: boolean; content: { text: string }[] } };
  assert.equal(result.result.isError, undefined);
  assert.deepEqual(JSON.parse(result.result.content[0].text), visible);
});
