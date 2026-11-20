import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Accounts } from "../../../src/accounts.ts";
import { api, type ApiContext } from "../../../src/api.ts";
import { BrowserTokens } from "../../../src/browser-tokens.ts";
import { ClientSessions } from "../../../src/client-sessions.ts";
import { ConsoleAuth } from "../../../src/console-auth.ts";
import { OAuth } from "../../../src/oauth.ts";
import { Passwords } from "../../../src/passwords.ts";
import { PublicOrigins } from "../../../src/origins.ts";
import { Tenants } from "../../../src/tenants.ts";
import { V1Compatibility } from "../../../src/v1-v2-compatibility.ts";
import { startFixture } from "./fixture.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

test("unkeyed legacy browser-token issuance preserves the original policy with a read-only role", { timeout: 180_000 }, async t => {
  const origin = "https://run.camelai.com", alias = "https://agents.camelai.dev";
  const secret = "browser-token-parity-local-only-session-secret";
  const token = "art_browser-token-fixture", other = "art_browser-token-foreign";
  const operator = "browser-token-fixture-operator";
  const role = `browser_tokens_${randomBytes(8).toString("hex")}`;
  const config = JSON.stringify({ tenants: { operator: { tokenSha256: sha(operator) } } });
  const f = await startFixture({
    tenants: [{ id: "fixture", token }, { id: "other", token: other }],
    databaseRole: { fixtureUser: role, grants: `grant usage on schema public to ${role};
      grant select on tenants, api_tokens, account_deletions, oauth_tokens, oauth_grants to ${role};
      grant select (id, tenant, header, expires_at, revoked) on agents to ${role};
      grant select on agent_v2_cutovers, agent_v2_routes to ${role};
      alter role ${role} set default_transaction_read_only=on;` },
    vars: { AGENT_TENANTS_JSON: config, AGENT_PUBLIC_URL: origin, AGENT_PUBLIC_ALIASES: alias,
      AGENT_ISSUER: alias, AGENT_SESSION_SECRET: secret },
    entrypoint: fileURLToPath(new URL("./legacy-browser-tokens-entry.ts", import.meta.url)),
    loopbackServices: { V2_LEGACY_RUNS: "UnexpectedBrowserTokenRuntime" },
  });
  t.after(() => f.stop());
  const db = f.db as unknown as ApiContext["accounts"]["db"];
  const tenants = new Tenants({ read: async () => config, env: true });
  await tenants.reload();
  const accounts = new Accounts({ tenants, db, secretsKey: "0".repeat(64) });
  const consoleAuth = new ConsoleAuth({ accounts, passwords: new Passwords(db), publicUrl: origin });
  const browserTokens = new BrowserTokens(secret);
  const oauth = new OAuth({ accounts, db, consoleAuth, secret, github: false, origins: new PublicOrigins(origin, [alias], alias) });
  let browserOverride: string | undefined;
  const compatibility = new V1Compatibility(db, async () => { throw new Error("No native request is needed to mint a browser token"); });
  const legacy = api({ accounts, consoleAuth, oauth, browserTokens, v1Compatibility: compatibility,
    get browserUrl() { return browserOverride === undefined ? origin : browserOverride || undefined; },
    clients: { owns: (id: string, tenant: string, agentsOnly: boolean) =>
      ClientSessions.prototype.owns.call({ db } as ClientSessions, id, tenant, agentsOnly) },
  } as ApiContext);
  const seed = async (tenant: string, digit: string, options: { revoked?: boolean; expiresAt?: number; run?: boolean } = {}) => {
    const id = `client_${digit.repeat(40)}`;
    await f.db.query(`insert into agents(id,tenant,header,revision,name,type,model,expires_at,revoked)
      values($1,$2,$3,1,'','agent','test',$4,$5)`, [id, tenant, options.run ? { run: {} } : {}, options.expiresAt ?? null, options.revoked ?? false]);
    return id;
  };
  const agent = await seed("fixture", "1"), foreign = await seed("other", "2");
  const revoked = await seed("fixture", "3", { revoked: true }), expired = await seed("fixture", "4", { expiresAt: 1 });
  const run = await seed("fixture", "5", { run: true }), migrated = await seed("fixture", "6");
  const fenced = await seed("fixture", "7"), opAgent = await seed("operator", "8");
  for (const id of [migrated, fenced]) await f.db.query("insert into agent_v2_cutovers(tenant,agent,operation) values('fixture',$1,$2)", [id, randomUUID()]);
  await f.db.query(`insert into agent_v2_routes(tenant,agent,destination_tenant,destination_agent,event_base)
    values('fixture',$1,$2,$3,0)`, [migrated, `tnt_${"1".repeat(16)}`, `agt_${"2".repeat(16)}`]);
  const oauthToken = "aro_browser-token-fixture";
  await f.db.query(`insert into oauth_grants(id,tenant,client_id,client_name,scope,created_at,resource)
    values('browser-token-grant','fixture','fixture-client','Fixture','agents',1,'agents')`);
  await f.db.query("insert into oauth_tokens(sha256,kind,grant_id,expires_at) values($1,'access','browser-token-grant',$2)", [sha(oauthToken), Date.now() + 120_000]);

  await t.test("the restricted role can read source and placement metadata and cannot mutate", async () => {
    const client = await f.db.connect();
    try {
      await client.query("begin read only");
      await client.query(`set local role ${role}`);
      const { rows: [permissions] } = await client.query(`select current_user as role, current_setting('transaction_read_only') as read_only,
        has_column_privilege(current_user,'agents','header','UPDATE') as update_agent,
        has_table_privilege(current_user,'idempotency_keys','INSERT') as insert_idempotency`);
      assert.deepEqual(permissions, { role, read_only: "on", update_agent: false, insert_idempotency: false });
      assert.equal((await client.query("select id,tenant,header,expires_at,revoked from agents where id=$1", [agent])).rowCount, 1);
      assert.equal((await client.query("select f.tenant,r.destination_agent from agent_v2_cutovers f left join agent_v2_routes r using(tenant,agent) where f.tenant=$1", ["fixture"])).rowCount, 2);
      await assert.rejects(client.query("update agents set revoked=true where id=$1", [agent]), error =>
        ["25006", "42501"].includes((error as { code: string }).code));
    } finally { await client.query("rollback"); client.release(); }
  });

  const path = (id = agent) => `/v1/agents/${id}/browser-tokens`;
  const direct = (id = agent, bearer: string | null = token, body: string | null = "{}", extra: Record<string, string> = {}, host = origin, method = "POST") => fetch(f.url + path(id), {
    method, headers: { "x-forwarded-host": new URL(host).host, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...extra },
    ...(!["GET", "HEAD"].includes(method) && body !== null ? { body } : {}),
  });
  const compare = async (id = agent, bearer = token, body: string | undefined = "{}", status = 201) => {
    const expected = await legacy.request(origin + path(id), { method: "POST", headers: { authorization: `Bearer ${bearer}` }, ...(body === undefined ? {} : { body }) });
    assert.equal(expected.status, status);
    const expectedValue = await expected.json() as Record<string, unknown>;
    for (const host of [origin, alias]) {
      const actual = await direct(id, bearer, body ?? null, { origin: "https://other.example.test" }, host);
      assert.equal(actual.status, status);
      assert.equal(actual.headers.get("access-control-allow-origin"), null);
      const value = await actual.json() as Record<string, unknown>;
      if (status === 201) {
        assert.equal(actual.headers.get("cache-control"), "no-store");
        const claims = browserTokens.verify(`Bearer ${value.token}`);
        const expectedClaims = browserTokens.verify(`Bearer ${expectedValue.token}`);
        assert.deepEqual({ ...claims, exp: 0 }, { ...expectedClaims, exp: 0 });
        assert.equal(value.expiresAt, claims.exp);
        assert.ok(Math.abs(claims.exp - expectedClaims.exp) < 5000);
        const withoutToken = ({ token: _token, expiresAt: _expiry, ...rest }: Record<string, unknown>) => rest;
        assert.deepEqual(withoutToken(value), withoutToken(expectedValue));
      } else assert.deepEqual(value, expectedValue);
    }
  };
  await t.test("original claims, body validation, ownership and published-placement refusal are preserved", async () => {
    for (const input of [undefined, "", "null", "{}", JSON.stringify({ ttlSeconds: 5, scopes: ["events", "children"], events: ["agent_end"], redact: ["usage.cost"], subject: "reader" }), JSON.stringify({ ttlSeconds: 3600 })]) await compare(agent, token, input);
    for (const body of ["[", "[]", "1", JSON.stringify({ ttlSeconds: 4 }), JSON.stringify({ ttlSeconds: 3601 }), JSON.stringify({ scopes: ["children"] }), JSON.stringify({ scopes: ["prompt"] }), JSON.stringify({ unknown: true })]) await compare(agent, token, body, 400);
    await compare(agent, token, JSON.stringify({ subject: "x".repeat(16 * 1024) }), 413);
    for (const id of [foreign, revoked, expired, run, `client_${"9".repeat(40)}`]) await compare(id, token, "{}", 404);
    await compare(agent, other, "{}", 404);
    await compare(opAgent, operator);
    await compare(migrated, token, "{}", 501);
    await compare(fenced);
    await compare(agent, oauthToken, "{}", 403);
    await compare(agent, browserTokens.mint("fixture", agent, {}).token, "{}", 403);
    await compare(agent, "abt_invalid", "{}", 401);
    assert.equal((await f.db.query("select 1 from idempotency_keys")).rowCount, 0);
  });
  await t.test("missing placement authority leaves every mint to the original runtime", async () => {
    await f.restart({ FIXTURE_PLACEMENT_AUTHORITY: "none" });
    for (const id of [agent, migrated]) {
      const response = await direct(id, token, "original unparsed body");
      assert.equal(response.status, 418);
      assert.deepEqual(await response.json(), { legacy: true, body: "original unparsed body" });
    }
    await f.restart({ FIXTURE_PLACEMENT_AUTHORITY: "configured" });
  });
  await t.test("unsupported requests fall through before the body is consumed", async () => {
    for (const extra of [{ "idempotency-key": "once" }, { "idempotency-key": "" }]) {
      const response = await direct(agent, token, "unparsed original body", extra);
      assert.equal(response.status, 418);
      assert.deepEqual(await response.json(), { legacy: true, body: "unparsed original body" });
    }
    for (const bearer of [null, "unknown-bearer", "agent-original-token"]) {
      const response = await direct(agent, bearer, "unparsed original body");
      assert.equal(response.status, 418);
      assert.deepEqual(await response.json(), { legacy: true, body: "unparsed original body" });
    }
    assert.equal((await direct(agent, token, undefined, {}, origin, "GET")).status, 418);
    const preflight = await direct(agent, token, undefined, { origin: "https://other.example.test", "access-control-request-method": "POST" }, origin, "OPTIONS");
    assert.equal(preflight.status, 418);
    assert.equal(preflight.headers.get("access-control-allow-origin"), null);
    const unselectedHost = await direct(agent, token, "original unparsed body", {}, "https://example.com");
    assert.equal(unselectedHost.status, 418);
    assert.deepEqual(await unselectedHost.json(), { legacy: true, body: "original unparsed body" });
  });
  await t.test("URL omission, override and missing pinned signing key remain explicit", async () => {
    for (const value of ["", "https://chat.example/agents/"]) {
      browserOverride = value.replace(/\/+$/, "");
      await f.restart({ AGENT_BROWSER_URL: value });
      await compare();
    }
    await f.restart({ AGENT_SESSION_SECRET: "" });
    const missing = await direct();
    assert.equal(missing.status, 503);
    assert.equal(missing.headers.get("retry-after"), "1");
    assert.equal(missing.headers.get("retry-after"), "1");
    assert.equal((await missing.json() as { error: string }).error, "Browser tokens are unavailable");
  });
  await t.test("handled requests retain the shared IP admission and operator exemption", async () => {
    await f.restart({ AGENT_SESSION_SECRET: secret, AGENT_TRUST_CF_CONNECTING_IP: "true", AGENT_RATE_LIMIT_API_PER_IP: "1" });
    const headers = { "fixture-client-ip": "192.0.2.41" };
    // A fallback must not spend the Worker's IP budget as well as the origin's.
    assert.equal((await direct(agent, "unknown-bearer", "original unparsed body", headers)).status, 418);
    assert.equal((await direct(agent, token, "original unparsed body", { ...headers, "idempotency-key": "once" })).status, 418);
    assert.equal((await direct(agent, token, "{}", headers)).status, 201);
    const limited = await direct(agent, token, "{}", headers);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    assert.equal((await limited.json() as { code: string }).code, "RATE_LIMITED");
    for (let i = 0; i < 2; i++) assert.equal((await direct(opAgent, operator, "{}", headers)).status, 201);
  });
});
