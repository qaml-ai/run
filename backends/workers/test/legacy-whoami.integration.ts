import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { api, type ApiContext } from "../../../src/api.ts";
import { Accounts } from "../../../src/accounts.ts";
import { ConsoleAuth } from "../../../src/console-auth.ts";
import { OAuth } from "../../../src/oauth.ts";
import { Passwords } from "../../../src/passwords.ts";
import { PublicOrigins } from "../../../src/origins.ts";
import { Tenants } from "../../../src/tenants.ts";
import { configuredModel, defaultModels } from "../../../src/model.ts";
import { modelReference } from "../../../src/virtual-models.ts";
import { startFixture } from "./fixture.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

test("hosted whoami matches legacy identity without origin calls or database writes", { timeout: 180_000 }, async t => {
  const origin = "https://run.example.test", alias = "https://agents.example.test";
  const secret = "legacy-whoami-same-issuer-secret-for-fixtures";
  const operator = "operator-fixture-key", token = "art_fixture-account-key", other = "art_other-account-key";
  const config = JSON.stringify({ tenants: { operator: { tokenSha256: sha(operator), github: "Operator" } } });
  const role = `whoami_${randomBytes(8).toString("hex")}`;
  const f = await startFixture({
    tenants: [{ id: "fixture", token }, { id: "other", token: other }],
    databaseRole: { fixtureUser: role, grants: `grant usage on schema public to ${role};
      grant select on tenants, api_tokens, account_deletions, provider_keys, tenant_passwords, oauth_tokens, oauth_grants, console_sessions to ${role};` },
    vars: { MODEL: "camelrun/default", AGENT_MODEL_FALLBACKS: "anthropic/claude-sonnet-5-5",
      AGENT_TENANTS_JSON: config, AGENT_PUBLIC_URL: origin, AGENT_PUBLIC_ALIASES: alias, AGENT_ISSUER: alias, AGENT_SESSION_SECRET: secret },
    entrypoint: fileURLToPath(new URL("./legacy-whoami-entry.ts", import.meta.url)),
    loopbackServices: { MCP_LEGACY_API: "UnexpectedLegacyOrigin" },
  });
  t.after(() => f.stop());
  await f.db.query("update tenants set google_email='owner@example.test' where id='fixture'");
  await f.db.query("update tenants set github='Other' where id='other'");
  await f.db.query("insert into provider_keys(tenant,provider,sealed,last4,set_at) values('other','anthropic','{}','test',1)");
  const tenants = new Tenants({ read: async () => config, env: true });
  await tenants.reload();
  const db = f.db as unknown as ApiContext["accounts"]["db"];
  const accounts = new Accounts({ tenants, db, secretsKey: "0".repeat(64) });
  const consoleAuth = new ConsoleAuth({ accounts, passwords: new Passwords(db), publicUrl: origin });
  const oauth = new OAuth({ accounts, db, consoleAuth, secret, github: false, origins: new PublicOrigins(origin, [alias], alias) });
  const defaults = defaultModels(configuredModel({}), "anthropic/claude-sonnet-5-5");
  const legacy = api({ accounts, clients: {}, consoleAuth, oauth, defaultModel: async tenant => {
    const own = await accounts.ownProviders(tenant);
    const keyed = await accounts.keyedProviders(tenant);
    return modelReference(defaults.find(model => own(model.provider)) ?? defaults.find(model => keyed(model.provider, model.id)) ?? defaults[0]);
  } } as ApiContext);
  const cookie = (await consoleAuth.startSession({ tenant: "fixture", method: "google", login: "person@example.test", name: "Person" })).split(";")[0];
  const client = oauth.register({ redirect_uris: ["https://client.example.test/callback"], token_endpoint_auth_method: "none" });
  const verifier = "v".repeat(43);
  const form = { response_type: "code", client_id: client.client_id, redirect_uri: "https://client.example.test/callback",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: `${alias}/mcp` };
  const consent = await oauth.app.request("/oauth/authorize", { method: "POST", headers: { origin, cookie }, body: new URLSearchParams({ ...form, decision: "allow" }) });
  assert.equal(consent.status, 302);
  const issued = await oauth.app.request("/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: client.client_id,
    redirect_uri: form.redirect_uri, code: new URL(consent.headers.get("location")!).searchParams.get("code")!, code_verifier: verifier, resource: form.resource }) });
  assert.equal(issued.status, 200);
  const credentials = await issued.json() as { access_token: string; refresh_token: string };
  const hosted = (bearer?: string, headers: Record<string, string> = {}) => fetch(`${f.url}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }),
  });
  const read = async (bearer: string, host = origin) => {
    const response = await hosted(bearer, { "x-forwarded-host": new URL(host).host });
    assert.equal(response.status, 200);
    const result = await response.json() as { result: { isError?: boolean; content: { text: string }[] } };
    assert.equal(result.result.isError, undefined);
    return JSON.parse(result.result.content[0].text);
  };
  for (const bearer of [operator, token, other, credentials.access_token]) {
    const expected = await legacy.request(`${origin}/v1/me`, { headers: { authorization: `Bearer ${bearer}` } });
    assert.equal(expected.status, 200);
    const value = { ...await expected.json() as Record<string, unknown>, url: origin };
    assert.deepEqual(await read(bearer), value);
    assert.deepEqual(await read(bearer, alias), value);
  }
  assert.equal((await read(other)).defaultModel, "anthropic/claude-sonnet-5-5");
  assert.equal((await read(token)).defaultModel, "camelrun/default");
  assert.equal((await read(credentials.access_token)).login, "person@example.test");
  for (const bearer of [undefined, "art_invalid", credentials.refresh_token]) assert.equal((await hosted(bearer, { cookie })).status, 401);
  assert.equal((await hosted(undefined, { cookie })).status, 401, "console cookies never authorize hosted MCP");
  const principal = await oauth.authenticate(`Bearer ${credentials.access_token}`);
  assert.ok(principal);
  await f.db.query("update oauth_grants set resource='ops' where id=$1", [principal.grantId]);
  assert.equal((await hosted(credentials.access_token)).status, 401, "an operations grant cannot read the account through hosted MCP");
  await f.db.query("update oauth_grants set resource='agents' where id=$1", [principal.grantId]);
  await f.db.query("update oauth_tokens set expires_at=0 where sha256=$1", [sha(credentials.access_token)]);
  assert.equal((await hosted(credentials.access_token)).status, 401);
  await f.db.query("update oauth_tokens set expires_at=$2 where sha256=$1", [sha(credentials.access_token), Date.now() + 60_000]);
  assert.equal((await read(credentials.access_token)).tenant, "fixture");
  await oauth.revoke("fixture", principal.grantId);
  assert.equal((await hosted(credentials.access_token)).status, 401);
  await f.db.query("delete from api_tokens where sha256=$1", [sha(other)]);
  assert.equal((await hosted(other)).status, 401);
  for (const [path, method] of [["/v1/me", "GET"], ["/v1/me", "POST"], ["/v1/billing", "GET"]]) {
    assert.equal((await fetch(f.url + path, { method, headers: { authorization: `Bearer ${token}` } })).status, 418);
  }
});
