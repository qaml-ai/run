import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Accounts } from "../../../src/accounts.ts";
import { api, type ApiContext } from "../../../src/api.ts";
import { BrowserTokens } from "../../../src/browser-tokens.ts";
import { credentials, type ConfigurationContext } from "../../../src/client-sessions/configuration.ts";
import { ConsoleAuth } from "../../../src/console-auth.ts";
import { OAuth } from "../../../src/oauth.ts";
import { Passwords } from "../../../src/passwords.ts";
import { PublicOrigins } from "../../../src/origins.ts";
import { Tenants } from "../../../src/tenants.ts";
import { startFixture } from "./fixture.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

test("legacy agent credentials match the original REST response using read-only storage", { timeout: 180_000 }, async t => {
  const origin = "https://run.example.test", alias = "https://agents.example.test";
  const secret = "credential-parity-local-fixture-signing-secret";
  const token = "art_credential-parity-fixture", other = "art_credential-parity-foreign";
  const operator = "credential-parity-fixture-operator";
  const role = `credentials_${randomBytes(8).toString("hex")}`;
  const config = JSON.stringify({ tenants: { operator: { tokenSha256: sha(operator) } } });
  const f = await startFixture({
    tenants: [{ id: "fixture", token }, { id: "other", token: other }],
    databaseRole: { fixtureUser: role, grants: `grant usage on schema public to ${role};
      grant select on tenants, api_tokens, account_deletions, oauth_tokens, oauth_grants to ${role};
      grant select (id, tenant, header, expires_at, revoked) on agents to ${role};` },
    vars: { AGENT_TENANTS_JSON: config, AGENT_PUBLIC_URL: origin, AGENT_PUBLIC_ALIASES: alias,
      AGENT_ISSUER: alias, AGENT_SESSION_SECRET: secret },
    entrypoint: fileURLToPath(new URL("./legacy-mcp-entry.ts", import.meta.url)),
  });
  t.after(() => f.stop());
  const db = f.db as unknown as ApiContext["accounts"]["db"];
  const tenants = new Tenants({ read: async () => config, env: true });
  await tenants.reload();
  const accounts = new Accounts({ tenants, db, secretsKey: "0".repeat(64) });
  const consoleAuth = new ConsoleAuth({ accounts, passwords: new Passwords(db), publicUrl: origin });
  const browserTokens = new BrowserTokens(secret);
  const oauth = new OAuth({ accounts, db, consoleAuth, secret, github: false, origins: new PublicOrigins(origin, [alias], alias) });
  const context = { options: { secret }, db, sessions: new Map() } as ConfigurationContext;
  const legacy = api({ accounts, consoleAuth, oauth, browserTokens,
    clients: { credentials: (tenant: string, ref: string) => credentials(context, tenant, ref) } } as ApiContext);

  const seed = async (tenant: string, key: string, options: { generation?: number; rotation?: number; keyless?: boolean;
      expiresAt?: number; stateless?: boolean; revoked?: boolean; badDigest?: boolean } = {}) => {
    const scoped = options.generation ? `${key}#${options.generation}` : key;
    const id = `client_${sha(`${tenant}:${scoped}`).slice(0, 40)}`;
    const material = options.rotation ? `client-rotated:${tenant}:${id}:${options.rotation}` : `client-v2:${tenant}:${scoped}`;
    const digest = sha(createHmac("sha256", secret).update(material).digest("hex"));
    const header = { ...(!options.keyless ? { key } : {}), digest: options.badDigest ? sha("unrelated-fixture") : digest,
      provisionHash: "original-config-hash", ...(options.rotation ? { tokenRotation: options.rotation } : {}),
      ...(options.stateless ? { run: {} } : {}) };
    await f.db.query(`insert into agents(id,tenant,header,revision,name,type,model,expires_at,revoked)
      values($1,$2,$3,1,'','agent','test',$4,$5)`, [id, tenant, header, options.expiresAt ?? null, options.revoked ?? false]);
    return { id, digest };
  };
  await seed("fixture", "project", { revoked: true });
  const keyed = await seed("fixture", "project", { generation: 1 });
  const rotated = await seed("fixture", "private", { keyless: true, rotation: 2, expiresAt: Date.now() + 120_000 });
  const keyless = await seed("fixture", "random", { keyless: true });
  const expired = await seed("fixture", "expired", { expiresAt: 1 });
  const run = await seed("fixture", "run", { stateless: true });
  const corrupt = await seed("fixture", "corrupt", { badDigest: true });
  const op = await seed("operator", "operator");
  const browser = browserTokens.mint("fixture", keyed.id, {}).token;
  const oauthToken = "aro_credential-parity-fixture";
  await f.db.query(`insert into oauth_grants(id,tenant,client_id,client_name,scope,created_at,resource)
    values('fixture-grant','fixture','fixture-client','Fixture','agents',1,'agents')`);
  await f.db.query("insert into oauth_tokens(sha256,kind,grant_id,expires_at) values($1,'access','fixture-grant',$2)",
    [sha(oauthToken), Date.now() + 120_000]);

  const path = (id: string) => `/v1/agents/${id}/credentials`;
  const direct = (ref: string, bearer: string, host = origin, method = "GET") => fetch(f.url + path(ref), {
    method, headers: { "x-forwarded-host": new URL(host).host, authorization: `Bearer ${bearer}` },
  });
  const redact = ({ token, ...value }: Record<string, unknown>) =>
    ({ ...value, ...(typeof token === "string" ? { tokenDigest: sha(token) } : {}) });
  const compare = async (id: string, bearer: string, status: number, digest?: string) => {
    const expected = await legacy.request(origin + path(id), { headers: { authorization: `Bearer ${bearer}` } });
    assert.equal(expected.status, status);
    for (const host of [origin, alias]) {
      const actual = await direct(id, bearer, host);
      assert.equal(actual.status, status);
      if (status === 200) assert.equal(actual.headers.get("cache-control"), "no-store");
      const value = redact(await actual.json() as Record<string, unknown>);
      assert.deepEqual(value, redact(await expected.clone().json() as Record<string, unknown>));
      if (digest) assert.equal(value.tokenDigest, digest);
    }
  };
  await compare(keyed.id, token, 200, keyed.digest);
  await compare(rotated.id, token, 200, rotated.digest);
  await compare(op.id, operator, 200, op.digest);
  await compare(keyed.id, other, 404);
  await compare(expired.id, token, 404);
  await compare(run.id, token, 404);
  await compare(keyless.id, token, 409);
  await compare(keyed.id, oauthToken, 403);
  await compare(keyed.id, browser, 403);
  await compare(keyed.id, "abt_invalid", 401);
  const mismatched = await direct(corrupt.id, token);
  assert.equal(mismatched.status, 503);
  assert.deepEqual(await mismatched.json(), { error: "Agent credentials are unavailable", code: "UNAVAILABLE" });
  assert.equal((await direct(keyed.id, "art_unknown")).status, 418);
  assert.equal((await direct("project", token)).status, 418);
  assert.equal((await direct(keyed.id, token, origin, "POST")).status, 418);
  assert.equal((await fetch(f.url + path(keyed.id))).status, 418);
});
