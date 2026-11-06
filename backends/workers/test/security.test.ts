import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createDecipheriv } from "node:crypto";
import { testDatabase } from "./billing-database.ts";
import { createTenants, keyServices, providerCredentials } from "../src/security-services.ts";
import { keyRoutes } from "../src/key-routes.ts";
import { Tenants } from "../src/tenants.ts";
import { Outbound, OutboundBlocked } from "../src/security-outbound.ts";
import { BrowserTokens, readableMessage, readableFrame } from "../src/browser-tokens.ts";
import { corsPreflight, corsResponse } from "../src/cors.ts";

test("account secret supplies platform OpenRouter credentials and missing secret leaves own providers usable", async () => {
  const tenants = await createTenants({ PILOT_OPENROUTER_KEY: { get: async () => "test-only-platform-key" } });
  assert.equal(tenants.platformKey("openrouter"), "test-only-platform-key");
  const absent = await createTenants({ PILOT_OPENROUTER_KEY: { get: async () => { throw new Error("Secret absent"); } } });
  assert.equal(absent.platformKey("openrouter"), undefined);
  const unchanged = await createTenants({ AGENT_TENANTS_JSON: '{"tenants":{},"platformKeys":{"openai":"test-only-existing-key"}}' });
  assert.equal(unchanged.platformKey("openai"), "test-only-existing-key");
});

test("source tenant policy rejects reused tokens, bad keys and ambiguous billing", async () => {
  const token = "a-test-operator-secret-at-least-24-characters";
  const sha = createHash("sha256").update(token).digest("hex");
  const load = async (tenants: object) => {
    const registry = new Tenants({ read: async () => JSON.stringify({ tenants }), env: true });
    await registry.reload(); return registry;
  };
  const registry = await load({ one: { tokenSha256: sha, apiKeys: { openai: "fake" }, billing: "prepaid" } });
  assert.equal(registry.authenticate(`Bearer ${token}`)?.id, "one");
  assert.equal(registry.authenticate(`Bearer ${token}bad`), undefined);
  assert.equal(registry.apiKey("one", "constructor"), undefined);
  await assert.rejects(load({ one: { tokenSha256: sha }, two: { tokenSha256: sha } }), /reuses/);
  await assert.rejects(load({ one: { tokenSha256: sha, apiKeys: { "*": "bad" } } }), /name each provider/);
  await assert.rejects(load({ one: { tokenSha256: sha, billing: "prepaid", platformKeys: false } }), /prepaid/);
});

test("provider endpoints reuse source CIDR policy and reject a private answer", async () => {
  const outbound = new Outbound({ resolve: async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }] });
  for (const url of ["https://127.0.0.1", "https://2130706433", "https://[::ffff:127.0.0.1]", "https://10.0.0.1", "http://example.com", "https://name:secret@example.com"]) assert.throws(() => outbound.check(url), OutboundBlocked);
  await assert.rejects(outbound.reachable("https://public.example"), /private, local or reserved/);
  const local = new Outbound({ allowHttp: true, allow: ["127.0.0.1/32"] });
  assert.equal((await local.reachable("http://127.0.0.1:1234/v1")).hostname, "127.0.0.1");
});

test("source browser-token scopes, expiry, redaction and CORS policy", () => {
  const tokens = new BrowserTokens("browser-test-secret"), agent = `client_${"a".repeat(40)}`;
  const minted = tokens.mint("tenant", agent, { scopes: ["history"], redact: ["usage.cost"] });
  const claims = tokens.verify(`Bearer ${minted.token}`);
  assert.deepEqual(claims.scopes, ["history"]);
  assert.throws(() => tokens.mint("tenant", agent, { scopes: ["children"] }), /at least one/);
  assert.throws(() => tokens.verify(`Bearer ${minted.token}x`), /Invalid browser token/);
  const message = { usage: { input: 12, cost: { total: 1 }, providerCost: 2 }, content: [] };
  assert.deepEqual(readableMessage(claims, message), { usage: { input: 12 }, content: [] });
  assert.equal(readableFrame(claims, { type: "event", event: { type: "compaction_usage" } }), undefined);
  const request = new Request(`https://example.test/v1/agents/${agent}/history`, { headers: { origin: "https://anything.test", authorization: `Bearer ${minted.token}` } });
  assert.equal(corsResponse(request, Response.json({})).headers.get("access-control-allow-origin"), "*");
  const preflight = corsPreflight(new Request(request, { method: "OPTIONS" }))!;
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
  assert.equal(corsResponse(new Request(request, { headers: { origin: "https://anything.test", authorization: "Bearer art_fake" } }), Response.json({})).headers.get("access-control-allow-origin"), null);
});

test("Workers account keys use source AES-GCM, API token revocation, scope precedence and custom provider retention", async () => {
  const { db, url } = await testDatabase();
  await db.query("insert into tenants(id,created_at) values ('keys-test',$1)", [Date.now()]);
  const env = { HYPERDRIVE: { connectionString: url }, AGENT_SECRETS_KEY: "ab".repeat(32), TEST_MODE: "1", AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
  const services = await keyServices(env), { accounts, keyScopes, modelProviders } = services;
  await accounts.setKey("keys-test", "openai", "fake-tenant-key-aaaa");
  const row = (await db.query("select sealed from provider_keys where tenant='keys-test' and provider='openai'")).rows[0];
  assert.deepEqual(Object.keys(row.sealed).sort(), ["ciphertext", "iv", "tag"]);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(env.AGENT_SECRETS_KEY, "hex"), Buffer.from(row.sealed.iv, "base64"));
  decipher.setAAD(Buffer.from("keys-test:openai")); decipher.setAuthTag(Buffer.from(row.sealed.tag, "base64"));
  assert.equal(Buffer.concat([decipher.update(Buffer.from(row.sealed.ciphertext, "base64")), decipher.final()]).toString(), "fake-tenant-key-aaaa");
  assert.throws(() => accounts.unseal("other:openai", row.sealed));
  assert.equal((await accounts.providerKey("keys-test", "openai"))?.key, "fake-tenant-key-aaaa");
  const token = await accounts.createToken("keys-test", "test client");
  assert.equal((await accounts.authenticate(`Bearer ${token.token}`))?.tokenId, token.id);
  assert.equal(JSON.stringify(await accounts.listTokens("keys-test")).includes(token.token), false);
  await accounts.revokeToken("keys-test", token.id);
  assert.equal(await accounts.authenticate(`Bearer ${token.token}`), undefined);
  await keyScopes.set("keys-test", "org-1", "openai", { apiKey: "scope-credential-bbbb", baseUrl: "http://127.0.0.1:1234/v1", headers: { "x-scope": "hidden-header" } });
  const status = await keyScopes.status("keys-test", "org-1");
  assert.equal(status.providers[0].last4, "bbbb");
  assert.equal(JSON.stringify(status).includes("hidden-header"), false);
  assert.equal((await providerCredentials(services, "keys-test", "openai", "org-1"))?.apiKey, "scope-credential-bbbb");
  await keyScopes.delete("keys-test", "org-1");
  assert.equal((await providerCredentials(services, "keys-test", "openai", "org-1"))?.apiKey, "fake-tenant-key-aaaa");
  const declared = { type: "openai-completions" as const, baseUrl: "http://127.0.0.1:1234/v1", models: [{ id: "local", contextWindow: 32768 }] };
  await modelProviders.set("keys-test", "custom", { ...declared, apiKey: "fake-provider-key-cccc", headers: { "x-custom": "hidden-provider" } });
  await modelProviders.set("keys-test", "custom", declared);
  assert.equal((await modelProviders.credentials("keys-test", "custom"))?.apiKey, "fake-provider-key-cccc");
  assert.equal((await modelProviders.credentials("keys-test", "custom"))?.headers?.["x-custom"], "hidden-provider");
  assert.equal(JSON.stringify(await modelProviders.list("keys-test")).includes("hidden-provider"), false);
  await modelProviders.set("keys-test", "custom", { ...declared, apiKey: null, headers: null });
  assert.equal((await modelProviders.credentials("keys-test", "custom"))?.apiKey, undefined);
  await modelProviders.set("keys-test", "custom", { ...declared, apiKey: "scope-only" }, [], "org-1");
  assert.equal((await modelProviders.credentials("keys-test", "custom", "org-1"))?.apiKey, "scope-only");
  assert.equal((await modelProviders.credentials("keys-test", "custom", "org-2"))?.apiKey, undefined);
  const auth = { tenantId: "keys-test", kind: "api" };
  await assert.rejects(keyRoutes(new Request("https://test/v1/providers/amazon-bedrock/key", { method: "PUT", body: JSON.stringify({ apiKey: "fake" }) }), env, auth, services), /needs its region/);
  const noKey = await keyRoutes(new Request("https://test/v1/providers"), env, auth, services);
  assert.equal(noKey?.status, 200);
  assert.equal((await noKey!.text()).includes("fake-tenant-key"), false);
});
