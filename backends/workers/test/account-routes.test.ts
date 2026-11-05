import { test } from "node:test";
import assert from "node:assert/strict";
import { keyServices } from "../src/security-services.ts";
import { keyRoutes } from "../src/key-routes.ts";
import { accountServices, publicAccountRoutes, accountManagementRoutes } from "../src/account-services.ts";
import { Webhooks } from "../src/webhook-policy.ts";
import { testDatabase } from "./billing-database.ts";

async function fixture() {
  const { db, url } = await testDatabase();
  const env = { HYPERDRIVE: { connectionString: url }, AGENT_SECRETS_KEY: "ab".repeat(32), API_TOKEN: "fake-account-routes-operator-token-32-characters", AGENT_PUBLIC_URL: "https://runtime.example.test" };
  await db.query("insert into tenants(id, created_at) values ('alice', $1)", [Date.now()]);
  const keys = await keyServices(env);
  const account = accountServices(env, keys.accounts, env.AGENT_PUBLIC_URL);
  const webhooks = new Webhooks({ db, accounts: keys.accounts, outbound: keys.outbound });
  return { db, env, keys, account, webhooks };
}

test("OAuth authorization-server discovery advertises the source endpoints and public response headers", async () => {
  const { account } = await fixture();
  const response = await publicAccountRoutes(new Request("https://runtime.example.test/.well-known/oauth-authorization-server"), account);
  assert.equal(response?.status, 200);
  assert.deepEqual(await response!.json(), { issuer: account.oauth.issuer, jwks_uri: account.oauth.issuer + "/.well-known/jwks.json", ...account.oauth.metadata() });
  assert.equal(response!.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response!.headers.get("Cache-Control"), "public, max-age=300");
});

test("account initialization preserves source secret length and public-origin configuration guards", async () => {
  const { env, keys } = await fixture();
  assert.throws(() => accountServices({ ...env, AGENT_SESSION_SECRET: "weak" }, keys.accounts, env.AGENT_PUBLIC_URL), /at least 32/);
  assert.throws(() => accountServices({ ...env, AGENT_PUBLIC_URL: undefined, AGENT_PUBLIC_ALIASES: "https:\/\/alias.example.test" }, keys.accounts, env.AGENT_PUBLIC_URL), /need AGENT_PUBLIC_URL/);
  assert.throws(() => accountServices({ ...env, AGENT_PUBLIC_URL: undefined, AGENT_ISSUER: env.AGENT_PUBLIC_URL }, keys.accounts, env.AGENT_PUBLIC_URL), /need AGENT_PUBLIC_URL/);
});

test("sign-in and consent pages reached through a configured alias move to the canonical origin", async () => {
  const { env, keys } = await fixture();
  const service = accountServices({ ...env, AGENT_PUBLIC_ALIASES: "https://alias.example.test" }, keys.accounts, env.AGENT_PUBLIC_URL);
  for (const path of ["/console/auth/github?next=%2Fconsole%2F", "/oauth/authorize?state=fixture", "/console/"]) {
    const response = await publicAccountRoutes(new Request("https://alias.example.test" + path, { headers: { Host: "alias.example.test" } }), service);
    assert.equal(response?.status, 302);
    assert.equal(response!.headers.get("Location"), env.AGENT_PUBLIC_URL + path);
  }
});

test("OAuth can read the provider catalog while credential-management routes remain forbidden", async () => {
  const { env, keys } = await fixture();
  const auth = { tenantId: "alice", kind: "oauth" };
  assert.equal((await keyRoutes(new Request("https://runtime.example.test/v1/providers"), env, auth, keys))?.status, 200);
  for (const [path, method] of [["/v1/providers/openai/key", "PUT"], ["/v1/tokens", "GET"], ["/v1/key-scopes/tenant", "GET"]]) {
    await assert.rejects(keyRoutes(new Request("https://runtime.example.test" + path, { method }), env, auth, keys), (error: any) => error.status === 403);
  }
});

test("account-management rejects malformed JSON and marks account facts private", async () => {
  const { account } = await fixture();
  const principal = { tenant: "alice", via: "console" as const };
  await assert.rejects(accountManagementRoutes(new Request("https://runtime.example.test/v1/account/password", { method: "PUT", body: "{" }), account, principal), (error: any) => error.status === 400 && error.message === "Invalid JSON");
  const response = await accountManagementRoutes(new Request("https://runtime.example.test/v1/account/password"), account, principal);
  assert.equal(response?.headers.get("Cache-Control"), "no-store");
});

test("token revocation rejects itself and unknown ids, and lists the webhooks it leaves sending", async () => {
  const { env, keys, webhooks } = await fixture();
  const minted = await keys.accounts.createToken("alice", "fixture");
  const route = new Request(`https://runtime.example.test/v1/tokens/${minted.id}`, { method: "DELETE" });
  const self = { tenantId: "alice", kind: "api", principal: { tokenId: minted.id } };
  await assert.rejects(keyRoutes(route, env, self, keys), (error: any) => error.status === 400 && /cannot revoke itself/.test(error.message));
  assert.equal((await keys.accounts.authenticate(`Bearer ${minted.token}`))?.tokenId, minted.id);
  const hook = await webhooks.create("alice", { url: "https://receiver.example.test/hook", events: ["run.completed"] }, `token:${minted.id}`);
  await webhooks.setUsageWebhook("alice", "https://receiver.example.test/legacy", `token:${minted.id}`);
  const admin = { tenantId: "alice", kind: "operator" };
  const response = await keyRoutes(route, env, admin, keys);
  assert.equal(response?.status, 200);
  assert.equal(response?.headers.get("Cache-Control"), "no-store");
  const result = await response!.json() as any;
  assert.equal(result.revoked, true);
  assert.deepEqual(result.left.sort((a: any, b: any) => a.kind.localeCompare(b.kind)), [
    { kind: "usage-webhook", url: "https://receiver.example.test/legacy" },
    { kind: "webhook", id: hook.id, url: hook.url },
  ]);
  assert.equal(await keys.accounts.authenticate(`Bearer ${minted.token}`), undefined);
  await assert.rejects(keyRoutes(route, env, admin, keys), (error: any) => error.status === 404 && error.message === "Unknown token");
});

test("grant revocation returns the source response and keeps attributed webhooks available for review", async () => {
  const { db, account, webhooks } = await fixture();
  const id = "grant-fixture";
  await db.query("insert into oauth_grants(id,tenant,client_id,client_name,scope,created_at) values ($1,'alice','fixture-client','Fixture','agents',$2)", [id, Date.now()]);
  const hook = await webhooks.create("alice", { url: "https://receiver.example.test/hook", events: ["run.completed"] }, `oauth:${id}`);
  const request = new Request(`https://runtime.example.test/v1/oauth/grants/${id}`, { method: "DELETE" });
  const response = await accountManagementRoutes(request, account, { tenant: "alice", via: "operator" }, webhooks);
  assert.equal(response?.status, 200);
  assert.deepEqual(await response!.json(), { revoked: true, left: [{ kind: "webhook", id: hook.id, url: hook.url }] });
  await assert.rejects(accountManagementRoutes(request, account, { tenant: "alice", via: "operator" }, webhooks), (error: any) => error.status === 404 && error.message === "Unknown grant");
});
