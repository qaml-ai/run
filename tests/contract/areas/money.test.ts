import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { contractTest, OPERATOR, OTHER_OPERATOR, until, fakeModel, freshWindow } from "../support.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const alice = OPERATOR, bob = OTHER_OPERATOR;
const PASSWORD = "correct-horse-battery-staple";
const browser = { "X-Agent-Runtime-Console": "1", "Sec-Fetch-Site": "same-origin" };
const apiOptions = { env: { AGENT_VERIFY_KEYS: "false", AGENT_PROVIDER: "camelrun", AGENT_MODEL: "default" }, tenants: { tenants: {
  alice: { tokenSha256: sha(alice), apiKeys: {} },
  bob: { tokenSha256: sha(bob), apiKeys: { anthropic: "bob-admin-anthropic-key" }, github: "Bob-Builder" },
} } };
const anonymous = (r: any) => (path: string, init: any = {}) => r.call(path, { token: null, ...init });

// These cases retain public HTTP assertions; storage-only assertions stay in their source suites.
contractTest("keys", "tests/api.test.ts:132","tenants set provider keys over REST; keys are never returned by public endpoints", async (t, r) => {
  const call = anonymous(r);
  assert.equal((await call("/v1/me")).status, 401);
  assert.deepEqual((await call("/v1/me", { token: alice })).json, { tenant: "alice", via: "operator", canStoreKeys: true, defaultModel: "camelrun/default" });
  const providers = (await call("/v1/providers", { token: alice })).json as any[];
  const anthropic = providers.find(provider => provider.id === "anthropic");
  assert.equal(anthropic.apiKey, true);
  assert.equal(anthropic.key, null);
  assert.equal((await call("/v1/providers/nope/key", { method: "PUT", token: alice, body: { apiKey: "x" } })).status, 404);

  // A Bedrock API key (a bearer token, never AWS access keys) is set with the region its calls go to.
  assert.equal(providers.find(provider => provider.id === "amazon-bedrock").apiKey, true);
  for (const body of [{ apiKey: "bedrock-key" }, { apiKey: "bedrock-key", region: "Oregon" }]) {
    assert.match((await call("/v1/providers/amazon-bedrock/key", { method: "PUT", token: alice, body })).json.error, /needs its region/, JSON.stringify(body));
  }
  assert.match((await call("/v1/providers/anthropic/key", { method: "PUT", token: alice, body: { apiKey: "x", region: "us-west-2" } })).json.error, /only for amazon-bedrock/);
  const beforeSet = await r.now();
  const bedrock = await call("/v1/providers/amazon-bedrock/key", { method: "PUT", token: alice, body: { apiKey: "bedrock-api-key-wxyz", region: "eu-west-3" } });
  const afterSet = await r.now();
  assert.equal(bedrock.status, 200, JSON.stringify(bedrock.json));
  assert.deepEqual([bedrock.json.last4, bedrock.json.region, bedrock.json.verification.status], ["wxyz", "eu-west-3", "unverified"]);
  // PUT does not return a timestamp. The public listing must expose the time
  // this write happened and retain it across reads; the source also compares SQL.
  const stored = (await call("/v1/providers", { token: alice })).json.find((provider: any) => provider.id === "amazon-bedrock").key;
  assert.ok(Number.isSafeInteger(stored.setAt) && stored.setAt >= beforeSet && stored.setAt <= afterSet);
  assert.deepEqual(stored, { provider: "amazon-bedrock", source: "tenant", last4: "wxyz", setAt: stored.setAt, region: "eu-west-3" });
  assert.equal((await call("/v1/providers", { token: alice })).json.find((provider: any) => provider.id === "amazon-bedrock").key.setAt, stored.setAt);
  assert.ok((await call("/v1/models?provider=amazon-bedrock&available=true", { token: alice })).json.some((model: any) => model.id === "amazon-bedrock/global.anthropic.claude-sonnet-5" && model.available));
  assert.equal((await call("/v1/providers/amazon-bedrock/key", { method: "DELETE", token: alice })).status, 200);

  const set = await call("/v1/providers/anthropic/key", { method: "PUT", token: alice, body: { apiKey: "sk-ant-alice-secret-1234" } });
  assert.equal(set.status, 200);
  assert.equal(set.json.last4, "1234");
  const status = (await call("/v1/providers", { token: alice })).json.find((provider: any) => provider.id === "anthropic").key;
  assert.equal(status.source, "tenant");
  assert.equal(status.last4, "1234");
  for (const path of ["/v1/providers", "/v1/me", "/v1/models?provider=anthropic"]) assert.equal(JSON.stringify((await call(path, { token: alice })).json).includes("sk-ant-alice"), false);

  // Bob has an admin-configured key, visible only as its source.
  assert.equal((await call("/v1/providers", { token: bob })).json.find((provider: any) => provider.id === "anthropic").key.source, "admin");
  assert.equal((await call("/v1/providers/anthropic/key", { method: "DELETE", token: alice })).status, 200);
  assert.equal((await call("/v1/providers/anthropic/key", { method: "DELETE", token: alice })).status, 404);
}, apiOptions);

contractTest("keys", "tests/api.test.ts:238","tenants mint and revoke their own API tokens", async (t, r) => {
  const call = anonymous(r);
  const minted = await call("/v1/tokens", { token: alice, body: { name: "ci" } });
  assert.equal(minted.status, 201);
  assert.match(minted.json.token, /^art_[a-f0-9]{64}$/);
  const token = minted.json.token;
  assert.deepEqual((await call("/v1/me", { token })).json.tenant, "alice");
  assert.equal((await call("/v1/me", { token })).json.via, "token");
  const listed = (await call("/v1/tokens", { token: alice })).json as any[];
  assert.deepEqual(listed.map(entry => entry.name), ["ci"]);
  assert.equal(JSON.stringify(listed).includes(token), false);
  assert.equal(listed[0].prefix, token.slice(0, 8));
  assert.equal((await call(`/v1/tokens/${minted.json.id}`, { method: "DELETE", token })).status, 400, "a token cannot revoke itself");
  // Minted tokens also work for the SDK's provisioning route.
  assert.equal((await call("/registry", { token })).status, 200);
  assert.equal((await call(`/v1/tokens/${minted.json.id}`, { method: "DELETE", token: bob })).status, 404);
  assert.equal((await call(`/v1/tokens/${minted.json.id}`, { method: "DELETE", token: alice })).status, 200);
  assert.equal((await call("/v1/me", { token })).status, 401);
}, apiOptions);

contractTest("auth", "tests/api.test.ts:261","console sessions require same-origin mutations; an email and password an operator set sign in", async (t, r) => {
  const call = anonymous(r), base = r.base;
  assert.deepEqual((await call("/console/auth/methods")).json, { github: false, google: false, password: true });
  assert.match(decodeURIComponent((await call("/console/auth/google")).headers.get("location")!), /Google sign-in is not configured/);
  // A self-hosted runtime's operator gives its own tenant a password with its operator token.
  assert.deepEqual((await call("/v1/tenants/alice/password", { method: "PUT", token: alice, body: { email: " Alice@Example.test ", password: PASSWORD } })).json, { tenant: "alice", email: "alice@example.test", signedOut: 0 });
  const credentials = { email: "alice@example.test", password: PASSWORD };
  assert.equal((await call("/console/auth/password", { body: credentials })).status, 403, "the console header is required");
  assert.equal((await call("/console/auth/password", { body: credentials, headers: { "X-Agent-Runtime-Console": "1" } })).status, 403, "and a browser's word that it is same-origin");
  assert.equal((await call("/console/auth/password", { body: credentials, headers: { "X-Agent-Runtime-Console": "1", Origin: "https://evil.example" } })).status, 403);
  assert.equal((await call("/console/auth/password", { body: { ...credentials, password: "wrong-password-here" }, headers: browser })).status, 401);
  const signIn = await call("/console/auth/password", { body: { ...credentials, email: "ALICE@example.test" }, headers: browser });
  assert.equal(signIn.status, 200, "addresses compare without case");
  for (const start of ["/console/?start=code"]) {
    assert.equal((await call("/console/auth/password", { body: { ...credentials, next: start }, headers: browser })).json.next, start, "a use-case start survives sign-in");
  }
  // Adding Camel to Discord is gone (Discord bots live in camelBots): its install route and start no longer survive sign-in.
  for (const next of ["//evil.example/", "/console/discord/install?guild_id=123456789012345678", "/console/discord/install?guild_id=1&next=https://evil.example", "/console/channels?discord_setup=123",
    "/console/?start=evil", "/console/?start=discord", "/console/?start=code&next=https://evil.example", "/console/agents?start=code"]) {
    assert.equal((await call("/console/auth/password", { body: { ...credentials, next }, headers: browser })).json.next, undefined);
  }
  const cookie = signIn.headers.get("set-cookie")!.split(";")[0];
  assert.match(cookie, /^ar_session=[A-Za-z0-9_-]{43}$/, "the cookie is only a random id");
  assert.match(signIn.headers.get("set-cookie")!, /HttpOnly; SameSite=Lax/);
  assert.deepEqual((await call("/v1/me", { headers: { Cookie: cookie } })).json, { tenant: "alice", via: "console", login: "alice@example.test", signIn: "password", canStoreKeys: true, defaultModel: "camelrun/default" });
  // Reads work with the cookie; writes need the console header and our origin, as Origin or Sec-Fetch-Site names it.
  const agent = { name: "x" };
  assert.equal((await call("/v1/agents", { body: agent, headers: { Cookie: cookie } })).status, 403);
  assert.equal((await call("/v1/agents", { body: agent, headers: { Cookie: cookie, "X-Agent-Runtime-Console": "1" } })).status, 403, "curl with no Origin cannot write with a cookie");
  assert.equal((await call("/v1/agents", { body: agent, headers: { Cookie: cookie, "X-Agent-Runtime-Console": "1", "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await call("/v1/agents", { body: agent, headers: { Cookie: cookie, "X-Agent-Runtime-Console": "1", Origin: "https://evil.example" } })).status, 403);
  assert.equal((await call("/v1/agents", { body: agent, headers: { Cookie: cookie, "X-Agent-Runtime-Console": "1", Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" } })).status, 403, "a foreign Origin wins");
  assert.equal((await call("/v1/agents", { body: agent, headers: { Cookie: cookie, "X-Agent-Runtime-Console": "1", Origin: "null" } })).status, 403);
  assert.equal((await call("/v1/agents", { body: { name: "y" }, headers: { Cookie: cookie, "X-Agent-Runtime-Console": "1", Origin: base } })).status, 201);
  assert.equal((await call("/v1/agents", { body: { name: "z" }, headers: { Cookie: cookie, ...browser } })).status, 201);
  assert.equal((await call("/console/auth/logout", { body: {}, headers: { Cookie: cookie, "X-Agent-Runtime-Console": "1" } })).status, 403, "nor sign out");
  const tampered = cookie.replace(/.$/, cookie.endsWith("A") ? "B" : "A");
  assert.equal((await call("/v1/me", { headers: { Cookie: tampered } })).status, 401);
  // Signing out ends the session on the server: the cookie, replayed, is nothing.
  const logout = await call("/console/auth/logout", { body: {}, headers: { Cookie: cookie, ...browser } });
  assert.equal(logout.headers.get("set-cookie")?.includes("Max-Age=0"), true);
  assert.equal((await call("/v1/me", { headers: { Cookie: cookie } })).status, 401, "logout ends the session server-side");
}, apiOptions);

contractTest("auth", "tests/api.test.ts:390","failed password sign-ins are limited per address and per source; a success still counts nothing", async (t, r) => {
  const call = anonymous(r);
  await call("/v1/tenants/alice/password", { method: "PUT", token: alice, body: { email: "alice@example.test", password: PASSWORD } });
  await call("/v1/tenants/bob/password", { method: "PUT", token: bob, body: { email: "bob@example.test", password: PASSWORD } });
  const signIn = (email: string, password: string, ip: string) => call("/console/auth/password", { body: { email, password }, headers: { ...browser, "CF-Connecting-IP": ip } });
  // Failures are counted in fixed 15-minute windows on the clock: the counting below (a few seconds) stays in one.
  await freshWindow(900, 30_000);
  assert.equal((await signIn("alice@example.test", PASSWORD, "203.0.113.1")).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await signIn("alice@example.test", "wrong-password-xyz", `203.0.113.${10 + i}`)).status, 401);
  // The address has failed three times, from three sources: now even the right password waits.
  const limited = await signIn("alice@example.test", PASSWORD, "203.0.113.20");
  assert.equal(limited.status, 429);
  assert.equal(limited.json.code, "RATE_LIMITED");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal((await signIn("bob@example.test", PASSWORD, "203.0.113.20")).status, 200, "another address is not limited");
  // Unknown addresses count against their source like wrong passwords.
  for (let i = 0; i < 5; i++) assert.equal((await signIn(`guess${i}@example.test`, "wrong-password-xyz", "198.51.100.7")).status, 401);
  assert.equal((await signIn("bob@example.test", PASSWORD, "198.51.100.7")).status, 429, "the source is limited");
  assert.equal((await signIn("bob@example.test", PASSWORD, "198.51.100.8")).status, 200);
}, { ...apiOptions, env: { ...apiOptions.env, AGENT_TRUST_CF_CONNECTING_IP: "true", AGENT_RATE_LIMIT_AUTH_PER_IP: "0", AGENT_RATE_LIMIT_PASSWORD_FAILURES_PER_EMAIL: "3", AGENT_RATE_LIMIT_PASSWORD_FAILURES_PER_IP: "5" } });

contractTest("auth", "tests/api.test.ts:562","console routes serve the app shell as HTML, never as a download", async (t, r) => {
  const call = anonymous(r);
  for (const path of ["/console/", "/console/agents", "/console/agents/client_x/requests"]) {
    const response = await call(path);
    // Built checkouts serve the shell; unbuilt ones say so, but a route is never application/octet-stream.
    if (response.status === 200) assert.match(response.headers.get("content-type")!, /^text\/html/);
    else assert.equal(response.status, 404);
  }
  // An encoded traversal reaches the server intact; it must never serve files outside the build.
  for (const path of ["/console/%2e%2e/src/server.ts", "/console/..%2f..%2fsrc%2fserver.ts"]) {
    const escaped = await call(path);
    assert.equal(String(escaped.json).includes("AGENT_SESSION_SECRET"), false, path);
  }
}, apiOptions);

contractTest("http", "tests/api.test.ts:577","the OpenAPI document is served without credentials", async (t, r) => {
  const call = anonymous(r);
  const served = await call("/v1/openapi.json");
  assert.equal(served.status, 200);
  assert.deepEqual(served.json, JSON.parse(await readFile(new URL("../../../openapi.json", import.meta.url), "utf8")));
}, apiOptions);

const USD = 1_000_000;

contractTest("credits", "tests/end-user-credits.test.ts:145","the end-user API: settings, entries, an end user and their ledger, for the tenant only", async (t, r) => {
  assert.equal((await r.call("/v1/end-user-settings", { method: "PUT", body: { enabled: true, allowances: { builder: 50 * USD }, markupBps: 2_500 } })).status, 200);
  assert.equal((await r.call("/v1/end-user-settings")).json.markupBps, 2_500);
  assert.equal((await r.call("/v1/end-user-settings", { method: "PUT", body: { markupBps: "lots" } })).status, 400);
  const merged = await r.call("/v1/end-user-settings", { method: "PATCH", body: { allowances: { "bot:*": USD } } });
  assert.deepEqual([merged.status, merged.json.allowances, merged.json.markupBps], [200, { builder: 50 * USD, "bot:*": USD }, 2_500], merged.text);

  const id = encodeURIComponent("discord:1234/abc");
  const posted = await r.call(`/v1/end-users/${id}/entries`, { body: { kind: "grant", amount: 10 * USD, key: "cs_1", reference: "Checkout cs_1" } });
  assert.equal(posted.status, 201, posted.text);
  assert.equal(posted.json.entry.balanceAfter, 10 * USD);
  const again = await r.call(`/v1/end-users/${id}/entries`, { body: { kind: "grant", amount: 10 * USD, key: "cs_1", reference: "Checkout cs_1" } });
  assert.deepEqual([again.status, again.json.replayed], [200, true]);
  assert.equal((await r.call(`/v1/end-users/${id}/entries`, { body: { kind: "grant", amount: 5, key: "cs_1" } })).status, 409);

  const user = await r.call(`/v1/end-users/${id}?buckets=bot:1`);
  assert.equal(user.status, 200, user.text);
  assert.deepEqual([user.json.id, user.json.balance, user.json.available, user.json.today.buckets.map((bucket: any) => bucket.bucket)], ["discord:1234/abc", 10 * USD, 10 * USD, ["bot:1", "builder"]]);
  const patched = await r.call(`/v1/end-users/${id}`, { method: "PATCH", body: { dailyLimit: 2 * USD } });
  assert.deepEqual([patched.status, patched.json.available], [200, 2 * USD], "the daily limit bounds what paid spend may take today");
  const ledger = await r.call(`/v1/end-users/${id}/ledger?limit=1`);
  assert.deepEqual([ledger.json.entries.length, ledger.json.entries[0].key, ledger.json.next], [1, "cs_1", undefined]);
  assert.equal((await r.call(`/v1/end-users/${id}/ledger?limit=0`)).status, 400);
  assert.deepEqual((await r.call("/v1/end-users")).json.endUsers.map((entry: any) => entry.id), ["discord:1234/abc"]);

  // Another tenant sees none of it.
  assert.equal((await r.call(`/v1/end-users/${id}`, { token: OTHER_OPERATOR })).json.balance, 0);
  assert.deepEqual((await r.call("/v1/end-users", { token: OTHER_OPERATOR })).json.endUsers, []);
  assert.equal((await r.call("/v1/end-users", { token: null })).status, 401);
});

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
const reply = (text: string) => () => ({ role: "assistant", content: text, usage: { prompt_tokens: 10, completion_tokens: 2 } });

contractTest("keys", "tests/key-scopes.test.ts:10","key scopes store sealed entries, and an agent's calls use its scope's current key, gateway and headers, else the tenant's", async (t, r) => {
  // The default model (openrouter) answers with the tenant's admin key; the gateway stands in for an AI gateway in front of OpenRouter.
  r.setModel(reply("tenant key"));
  const aiGateway = await fakeModel(t, reply("scope key"));
  const put = (scope: string, provider: string, body: unknown) => r.call(`/v1/key-scopes/${scope}/providers/${provider}`, { method: "PUT", body });

  for (const [scope, provider, body] of [
    ["org_1", "openrouter", { apiKey: "" }],
    ["org_1", "openrouter", { apiKey: "k", baseUrl: "https://10.1.2.3/openrouter" }],
    ["org_1", "openrouter", { apiKey: "k", baseUrl: "https://gateway.invalid" }],
    ["org_1", "openrouter", { apiKey: "k", region: "us-west-2" }],
    ["org_1", "openrouter", { apiKey: "k", headers: { "bad header": "x" } }],
    ["org_1", "no-such-provider", { apiKey: "k" }],
    // Google's client takes no fetch, so it could not be kept to the outbound guard.
    ["org_1", "google", { apiKey: "k", baseUrl: "https://gateway.example.com/google" }],
    ["bad scope!", "openrouter", { apiKey: "k" }],
  ] as const) assert.equal((await put(scope, provider, body)).status, 400, JSON.stringify([scope, provider, body]));

  // Created before its scope has a key: the tenant's.
  const { id: scoped, token } = (await r.call("/v1/agents", { body: { keyScope: "org_1" } })).json;
  const plain = (await r.call("/v1/agents", { body: {} })).json.id;
  assert.equal((await r.call(`/v1/agents/${scoped}`)).json.keyScope, "org_1");
  assert.equal((await r.call(`/v1/agents/${plain}`)).json.keyScope, null);
  assert.equal((await r.prompt(scoped, "Hi")).outcome.result.reply, "tenant key");

  const set = await put("org_1", "openrouter", { apiKey: "sk-or-org1-aaaa", baseUrl: `${aiGateway.url}/`, headers: { "cf-aig-authorization": "Bearer gateway-secret" } });
  assert.equal(set.status, 200, set.text);
  const shown = await r.call("/v1/key-scopes/org_1");
  assert.deepEqual(shown.json.providers.map(({ setAt: _at, ...entry }: any) => entry), [{ provider: "openrouter", last4: "aaaa", baseUrl: aiGateway.url, headers: ["cf-aig-authorization"] }]);
  for (const text of [set.text, shown.text]) assert.ok(!text.includes("sk-or-org1") && !text.includes("gateway-secret"), "secrets are never returned");

  // The running agent's next call takes the scope's key, at the gateway, with its headers; other agents keep the tenant's.
  assert.equal((await r.prompt(scoped, "Hi again")).outcome.result.reply, "scope key");
  assert.equal(aiGateway.keys.at(-1), "Bearer sk-or-org1-aaaa");
  assert.equal(aiGateway.headers.at(-1)!["cf-aig-authorization"], "Bearer gateway-secret");
  assert.equal((await r.prompt(plain, "Hi")).outcome.result.reply, "tenant key");
  assert.equal(r.model.keys.at(-1), "Bearer fixture-model-key");

  // Rotation reaches the same agent at its next call, without a restart.
  await put("org_1", "openrouter", { apiKey: "sk-or-org1-bbbb", baseUrl: aiGateway.url, headers: { "cf-aig-authorization": "Bearer gateway-secret" } });
  await r.prompt(scoped, "And again");
  assert.equal(aiGateway.keys.at(-1), "Bearer sk-or-org1-bbbb");

  // An agent moved into the scope, and back out: only the tenant can move it.
  const moved = await r.call(`/v1/agents/${plain}/configuration`, { method: "PATCH", body: { keyScope: "org_1" } });
  assert.equal(moved.status, 202, moved.text);
  assert.equal((await r.prompt(plain, "Moved")).outcome.result.reply, "scope key");
  await r.call(`/v1/agents/${plain}/configuration`, { method: "PATCH", body: { keyScope: null } });
  assert.equal((await r.prompt(plain, "Back")).outcome.result.reply, "tenant key");
  const own = await r.call(`/clients/${scoped}/requests`, { token, body: { id: "self-scope", method: "configure", params: { keyScope: "org_2" } } });
  assert.equal(own.status, 403, "an agent cannot choose its own keys");

  // Deleting the entry falls back to the tenant's key; deleting the scope leaves nothing.
  assert.equal((await r.call("/v1/key-scopes/org_1/providers/openrouter", { method: "DELETE" })).status, 200);
  assert.equal((await r.call("/v1/key-scopes/org_1/providers/openrouter", { method: "DELETE" })).status, 404);
  assert.equal((await r.prompt(scoped, "Fallback")).outcome.result.reply, "tenant key");
  await put("org_1", "anthropic", { apiKey: "sk-ant-1234" });
  assert.equal((await r.call("/v1/key-scopes/org_1", { method: "DELETE" })).status, 200);
  assert.deepEqual((await r.call("/v1/key-scopes/org_1")).json, { scope: "org_1", providers: [] });

  // Scope calls, like those on the admin's key (the entry's apiKeys), are the tenant's own: counted in /v1/usage, never as platform responses.
  const usage = (await r.call("/v1/usage")).json;
  assert.deepEqual([usage.totals.responses, usage.totals.platformResponses], [7, 0], JSON.stringify(usage.totals));
}, { env: LOCAL });

contractTest("billing", "tests/billing.test.ts:623", "without Stripe, checkout answers 503 and the webhook 404", async (_t, r) => {
  assert.equal((await r.call("/v1/billing")).json.checkout, false);
  assert.equal((await r.call("/v1/billing/checkout", { body: { amountUsd: 10 } })).status, 503);
  assert.equal((await r.call("/v1/billing/stripe/webhook", { body: {}, token: null })).status, 404);
});
