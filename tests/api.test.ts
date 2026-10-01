import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { checkProviderKey } from "../src/key-check.ts";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";
import { attachSilently } from "./runtime-server.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const alice = "alice-operator-token-at-least-24-chars";
const bob = "bob-operator-token-at-least-24-chars";

async function fakeGithub(t: { after(fn: () => Promise<void>): void }, members: Record<string, "active" | "pending">) {
  let nextLogin = "";
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const url = new URL(req.url!, "http://github.test");
    if (url.pathname === "/login/oauth/access_token") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ access_token: `gho_${nextLogin}` })); return; }
    const login = (req.headers.authorization ?? "").replace("Bearer gho_", "");
    // Each login is its own account, with a stable numeric id.
    if (url.pathname === "/user") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ login, id: parseInt(sha(login).slice(0, 8), 16), created_at: "2015-01-01T00:00:00Z" })); return; }
    if (url.pathname === "/user/memberships/orgs/qaml-ai") {
      const state = members[login];
      res.writeHead(state ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify(state ? { state } : { message: "Not Found" }));
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, signInAs(login: string) { nextLogin = login; } };
}

/**
 * An OpenID provider like Google's: discovery, an authorization code exchange that checks the PKCE
 * verifier, and ID tokens signed with its published key. `nextSignIn` sets the claims (and how to
 * spoil the token) for the next code; the test reads the nonce and challenge from the authorize URL.
 */
async function fakeGoogle(t: { after(fn: () => Promise<void>): void }) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const stranger = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...await exportJWK(publicKey), kid: "k1", alg: "RS256", use: "sig" };
  let next: { claims: Record<string, unknown>; challenge: string; nonce: string; key?: CryptoKey; expired?: boolean } | undefined;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const path = new URL(req.url!, "http://google.test").pathname;
    const send = (status: number, value: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (path === "/.well-known/openid-configuration") return send(200, { issuer: url, authorization_endpoint: `${url}/o/oauth2/v2/auth`, token_endpoint: `${url}/token`, jwks_uri: `${url}/oauth2/v3/certs` });
    if (path === "/oauth2/v3/certs") return send(200, { keys: [jwk] });
    if (path === "/token") {
      const form = new URLSearchParams(body);
      if (!next || form.get("client_id") !== "google-client" || form.get("client_secret") !== "google-secret" || form.get("grant_type") !== "authorization_code"
        || createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== next.challenge) return send(400, { error: "invalid_grant" });
      const now = Math.floor(Date.now() / 1000) - (next.expired ? 7200 : 0);
      const token = await new SignJWT({ iss: url, aud: "google-client", nonce: next.nonce, ...next.claims }).setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuedAt(now).setExpirationTime(now + 3600).sign(next.key ?? privateKey);
      return send(200, { access_token: "ya29.fixture", id_token: token, token_type: "Bearer" });
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, stranger, nextSignIn(authorize: URL, claims: Record<string, unknown>, spoil: { key?: CryptoKey; expired?: boolean; nonce?: string } = {}) {
    next = { claims, challenge: authorize.searchParams.get("code_challenge")!, nonce: spoil.nonce ?? authorize.searchParams.get("nonce")!, key: spoil.key, expired: spoil.expired };
  } };
}

const neutral = (sub: string) => `u-${sha(`google:${sub}`).slice(0, 16)}`;

const defaultTenants = {
  alice: { tokenSha256: sha(alice), apiKeys: {} },
  bob: { tokenSha256: sha(bob), apiKeys: { anthropic: "bob-admin-anthropic-key" }, github: "Bob-Builder" },
};

async function runtime(t: { after(fn: () => Promise<void>): void }, github?: string, env: Record<string, string> = {}, tenants: Record<string, unknown> = defaultTenants) {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-api-"));
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants }));
  const { db, url } = await testDatabase();
  const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("../src/server.ts", import.meta.url))], {
    env: {
      PATH: process.env.PATH, HOME: root, AGENT_DATA_DIR: root, AGENT_DATABASE_URL: url, PORT: "0", HOST: "127.0.0.1",
      AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_SESSION_SECRET: "api-test-session-secret-with-32-characters",
      AGENT_SECRETS_KEY: randomBytes(32).toString("hex"), AGENT_VERIFY_KEYS: "false",
      ...env,
      ...(github ? { GITHUB_CLIENT_ID: "client-id", GITHUB_CLIENT_SECRET: "client-secret", GITHUB_ORG: "qaml-ai", AGENT_SIGNUP_MIN_ACCOUNT_DAYS: "7", AGENT_GITHUB_WEB_URL: github, AGENT_GITHUB_API_URL: github } : {}),
    } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, "close"); child.kill("SIGTERM"); await closed; }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const ready = Promise.withResolvers<number>();
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; if (output.includes("\n")) ready.resolve(JSON.parse(output.split("\n")[0]).address.port); });
  child.on("exit", code => ready.reject(new Error(`Server exited: ${code}`)));
  const base = `http://127.0.0.1:${await ready.promise}`;
  const call = async (path: string, init: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const response = await fetch(base + path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"), redirect: "manual",
      headers: { ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}), ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await response.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, json, headers: response.headers };
  };
  /** Resolves once the server logs a line matching `pattern` (after this call). */
  const logged = (pattern: RegExp) => new Promise<void>(resolve => {
    const listener = (chunk: Buffer) => { if (pattern.test(String(chunk))) { child.stdout.off("data", listener); resolve(); } };
    child.stdout.on("data", listener);
  });
  return { root, db, base, call, child, logged };
}

test("tenants set provider keys over REST; keys are encrypted at rest and never returned", async t => {
  const { db, call } = await runtime(t);
  assert.equal((await call("/v1/me")).status, 401);
  assert.deepEqual((await call("/v1/me", { token: alice })).json, { tenant: "alice", via: "operator", canStoreKeys: true, defaultModel: "anthropic/claude-sonnet-5-5" });
  const providers = (await call("/v1/providers", { token: alice })).json as any[];
  const anthropic = providers.find(provider => provider.id === "anthropic");
  assert.equal(anthropic.apiKey, true);
  assert.equal(anthropic.key, null);
  assert.equal(providers.find(provider => provider.id === "amazon-bedrock").apiKey, false);
  assert.equal((await call("/v1/providers/amazon-bedrock/key", { method: "PUT", token: alice, body: { apiKey: "x" } })).status, 400);
  assert.equal((await call("/v1/providers/nope/key", { method: "PUT", token: alice, body: { apiKey: "x" } })).status, 404);

  const set = await call("/v1/providers/anthropic/key", { method: "PUT", token: alice, body: { apiKey: "sk-ant-alice-secret-1234" } });
  assert.equal(set.status, 200);
  assert.equal(set.json.last4, "1234");
  const status = (await call("/v1/providers", { token: alice })).json.find((provider: any) => provider.id === "anthropic").key;
  assert.equal(status.source, "tenant");
  assert.equal(status.last4, "1234");
  const stored = JSON.stringify((await db.query("select * from provider_keys where tenant = 'alice'")).rows);
  assert.match(stored, /"last4":"1234"/);
  assert.equal(stored.includes("sk-ant-alice-secret"), false);
  for (const path of ["/v1/providers", "/v1/me", "/v1/models?provider=anthropic"]) assert.equal(JSON.stringify((await call(path, { token: alice })).json).includes("sk-ant-alice"), false);

  // Bob has an admin-configured key, visible only as its source.
  assert.equal((await call("/v1/providers", { token: bob })).json.find((provider: any) => provider.id === "anthropic").key.source, "admin");
  assert.equal((await call("/v1/providers/anthropic/key", { method: "DELETE", token: alice })).status, 200);
  assert.equal((await call("/v1/providers/anthropic/key", { method: "DELETE", token: alice })).status, 404);
});

test("agents can live until deleted, or for a chosen time", async t => {
  const { call } = await runtime(t);
  await call("/v1/providers/anthropic/key", { method: "PUT", token: alice, body: { apiKey: "sk-ant-alice" } });
  const lasting = await call("/v1/agents", { token: alice, body: { name: "Always on", model: "anthropic/claude-sonnet-5", ttlSeconds: null } });
  assert.equal(lasting.status, 201);
  assert.equal(lasting.json.expiresAt, null);
  const hour = await call("/v1/agents", { token: alice, body: { name: "An hour", model: "anthropic/claude-sonnet-5", ttlSeconds: 3600 } });
  assert.ok(Math.abs(hour.json.expiresAt - (Date.now() + 3_600_000)) < 60_000);
  for (const ttlSeconds of [0, 59, 1.5, "3600", 400 * 86_400]) {
    assert.equal((await call("/v1/agents", { token: alice, body: { model: "anthropic/claude-sonnet-5", ttlSeconds } })).status, 400, String(ttlSeconds));
  }
  const listed = (await call("/v1/agents", { token: alice })).json as any[];
  assert.equal(listed.find(agent => agent.id === lasting.json.id).expiresAt, null);
  assert.equal((await call(`/clients/${lasting.json.id}/state`, { token: lasting.json.token })).status, 200);
});

test("models are chosen by name over REST, at creation and mid-conversation", async t => {
  const { call } = await runtime(t);
  const all = (await call("/v1/models?provider=anthropic", { token: alice })).json as any[];
  assert.ok(all.some(model => model.id === "anthropic/claude-sonnet-5" && model.contextWindow > 0 && model.cost.input >= 0));
  assert.deepEqual((await call("/v1/models?available=true", { token: alice })).json, []);
  // An agent on a model with no key is made all the same: its runs say which key to set.
  const noKey = await call("/v1/agents", { token: alice, body: { name: "Scratch", model: "anthropic/claude-sonnet-5" } });
  assert.equal(noKey.status, 201, JSON.stringify(noKey.json));
  assert.equal((await call(`/v1/agents/${noKey.json.id}`, { method: "DELETE", token: alice })).status, 200);
  await call("/v1/providers/anthropic/key", { method: "PUT", token: alice, body: { apiKey: "sk-ant-alice" } });
  assert.ok((await call("/v1/models?available=true", { token: alice })).json.every((model: any) => model.provider === "anthropic"));
  assert.equal((await call("/v1/agents", { token: alice, body: { model: "anthropic/not-a-model" } })).status, 400);
  assert.equal((await call("/v1/agents", { token: alice, body: { model: "claude-sonnet-5" } })).status, 400);

  const created = await call("/v1/agents", { token: alice, body: { name: "Planner", model: "anthropic/claude-sonnet-5" }, headers: { "Idempotency-Key": "planner" } });
  assert.equal(created.status, 201);
  const agents = (await call("/v1/agents", { token: alice })).json as any[];
  assert.deepEqual(agents.map(agent => [agent.name, agent.model]), [["Planner", "anthropic/claude-sonnet-5"]]);
  const id = created.json.id;

  // Switch models with the agent's scoped token; a provider without a key is refused.
  const configure = (model: string, requestId: string) => call(`/clients/${id}/requests`, { token: created.json.token, body: { id: requestId, method: "configure", params: { model } } });
  assert.equal((await configure("anthropic/claude-haiku-4-5", "to-haiku")).status, 202);
  const settle = async (requestId: string) => {
    for (let i = 0; i < 100; i++) {
      const record = (await call(`/clients/${id}/requests/${requestId}`, { token: created.json.token })).json;
      if (record.state !== "running") return record;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  assert.equal((await settle("to-haiku")).outcome.error, undefined);
  assert.equal((await call("/v1/agents", { token: alice })).json[0].model, "anthropic/claude-haiku-4-5");
  await configure("openai/gpt-4o", "to-openai");
  assert.match((await settle("to-openai")).outcome.error, /No openai API key/);

  // Agents belong to their tenant.
  assert.deepEqual((await call("/v1/agents", { token: bob })).json, []);
  assert.equal((await call(`/v1/agents/${id}`, { token: bob })).status, 404);
  assert.equal((await call(`/v1/agents/${id}/history`, { token: bob })).status, 404);
  assert.equal((await call(`/v1/agents/${id}`, { method: "DELETE", token: bob })).status, 404);
  assert.deepEqual((await call(`/v1/agents/${id}/history`, { token: alice })).json, { messages: [] });
  assert.equal((await call(`/v1/agents/${id}`, { token: alice })).json.name, "Planner");
  assert.equal((await call(`/v1/agents/${id}`, { method: "DELETE", token: alice })).status, 200);
  assert.deepEqual((await call("/v1/agents", { token: alice })).json, []);
});

test("tenants mint and revoke their own API tokens", async t => {
  const { call } = await runtime(t);
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
});

test("console sessions require same-origin mutations; token sign-in sets a session", async t => {
  const { call, base } = await runtime(t);
  assert.deepEqual((await call("/console/auth/methods")).json, { github: false, google: false, token: true });
  assert.match(decodeURIComponent((await call("/console/auth/google")).headers.get("location")!), /Google sign-in is not configured/);
  assert.equal((await call("/console/auth/token", { body: { token: alice } })).status, 403, "the console header is required");
  assert.equal((await call("/console/auth/token", { body: { token: "wrong" }, headers: { "X-Agent-Runtime-Console": "1" } })).status, 401);
  const signIn = await call("/console/auth/token", { body: { token: alice }, headers: { "X-Agent-Runtime-Console": "1" } });
  assert.equal(signIn.status, 200);
  const cookie = signIn.headers.get("set-cookie")!.split(";")[0];
  assert.match(signIn.headers.get("set-cookie")!, /HttpOnly; SameSite=Lax/);
  assert.equal((await call("/v1/me", { headers: { Cookie: cookie } })).json.via, "console");
  // Reads work with the cookie; writes need the console header and our origin.
  assert.equal((await call("/v1/tokens", { body: { name: "x" }, headers: { Cookie: cookie } })).status, 403);
  assert.equal((await call("/v1/tokens", { body: { name: "x" }, headers: { Cookie: cookie, "X-Agent-Runtime-Console": "1", Origin: "https://evil.example" } })).status, 403);
  assert.equal((await call("/v1/tokens", { body: { name: "x" }, headers: { Cookie: cookie, "X-Agent-Runtime-Console": "1", Origin: base } })).status, 201);
  const tampered = cookie.replace(/.$/, cookie.endsWith("A") ? "B" : "A");
  assert.equal((await call("/v1/me", { headers: { Cookie: tampered } })).status, 401);
  assert.equal((await call("/console/auth/logout", { body: {}, headers: { Cookie: cookie, "X-Agent-Runtime-Console": "1" } })).headers.get("set-cookie")?.includes("Max-Age=0"), true);
});

test("GitHub sign-in admits active org members, links admin tenants, and creates new tenants", async t => {
  const github = await fakeGithub(t, { "Bob-Builder": "active", Carol: "active", Mallory: "pending" });
  const { call } = await runtime(t, github.url);
  assert.equal((await call("/console/auth/methods")).json.github, true);
  const signIn = async (login: string, next?: string) => {
    github.signInAs(login);
    const start = await call(`/console/auth/github${next ? `?next=${encodeURIComponent(next)}` : ""}`);
    assert.equal(start.status, 302);
    const authorize = new URL(start.headers.get("location")!);
    assert.equal(authorize.searchParams.get("scope"), "read:org");
    const stateCookies = start.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const callback = await call(`/console/auth/callback?code=abc&state=${authorize.searchParams.get("state")}`, { headers: { Cookie: stateCookies } });
    const session = callback.headers.getSetCookie().find(value => value.startsWith("ar_session="))?.split(";")[0];
    return { location: callback.headers.get("location")!, session };
  };
  const bobSession = await signIn("Bob-Builder");
  assert.equal(bobSession.location, "/console/");
  // Started from the MCP consent page, sign-in returns there; anywhere else is ignored.
  assert.equal((await signIn("Bob-Builder", "/oauth/authorize?client_id=x&state=y")).location, "/oauth/authorize?client_id=x&state=y");
  assert.equal((await signIn("Bob-Builder", "https://evil.example/")).location, "/console/");
  assert.equal((await signIn("Bob-Builder", "//evil.example/oauth/authorize?")).location, "/console/");
  assert.equal((await call("/v1/me", { headers: { Cookie: bobSession.session! } })).json.tenant, "bob");
  const carol = await signIn("Carol");
  assert.deepEqual((await call("/v1/me", { headers: { Cookie: carol.session! } })).json, { tenant: "carol", via: "console", login: "Carol", canStoreKeys: true, defaultModel: "anthropic/claude-sonnet-5-5" });
  const mallory = await signIn("Mallory");
  assert.equal(mallory.session, undefined);
  assert.match(decodeURIComponent(mallory.location), /Only members of the qaml-ai/);
  // A forged state is rejected.
  const forged = await call("/console/auth/callback?code=abc&state=forged", { headers: { Cookie: "ar_oauth_state=other" } });
  assert.match(decodeURIComponent(forged.headers.get("location")!), /expired or was tampered/);
});

test("Google sign-in verifies the ID token, creates separate tenants, and returns to the consent page", async t => {
  const google = await fakeGoogle(t);
  const { call, db, base } = await runtime(t, undefined, { GOOGLE_CLIENT_ID: "google-client", GOOGLE_CLIENT_SECRET: "google-secret", AGENT_GOOGLE_ISSUER: google.url, AGENT_OPEN_SIGNUP: "true" });
  assert.deepEqual((await call("/console/auth/methods")).json, { github: false, google: true, token: true });
  const signIn = async (claims: Record<string, unknown>, options: { next?: string; spoil?: Parameters<typeof google.nextSignIn>[2]; state?: string } = {}) => {
    const start = await call(`/console/auth/google${options.next ? `?next=${encodeURIComponent(options.next)}` : ""}`);
    assert.equal(start.status, 302);
    const authorize = new URL(start.headers.get("location")!);
    assert.equal(authorize.origin + authorize.pathname, `${google.url}/o/oauth2/v2/auth`);
    assert.equal(authorize.searchParams.get("scope"), "openid email profile");
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorize.searchParams.get("response_type"), "code");
    assert.match(authorize.searchParams.get("redirect_uri")!, /\/console\/auth\/google\/callback$/);
    google.nextSignIn(authorize, claims, options.spoil);
    const cookies = start.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const callback = await call(`/console/auth/google/callback?code=fixture&state=${options.state ?? authorize.searchParams.get("state")}`, { headers: { Cookie: cookies } });
    const session = callback.headers.getSetCookie().find(value => value.startsWith("ar_session="))?.split(";")[0];
    return { location: decodeURIComponent(callback.headers.get("location")!), session };
  };
  const ada = await signIn({ sub: "1001", email: "ada@example.com", email_verified: true, name: "Ada Lovelace" });
  assert.equal(ada.location, "/console/");
  assert.deepEqual((await call("/v1/me", { headers: { Cookie: ada.session! } })).json, { tenant: neutral("1001"), via: "console", login: "ada@example.com", name: "Ada Lovelace", canStoreKeys: true, defaultModel: "anthropic/claude-sonnet-5-5" });
  // No automatic starting credit: the account starts at zero.
  const billing = (await call("/v1/billing", { headers: { Cookie: ada.session! } })).json;
  assert.equal(billing.balance, 0);
  assert.equal(billing.startingCredit.status, "not_granted");
  // The same Google account keeps its tenant; another account with a similar address gets its own. Ids never carry the address.
  assert.equal((await signIn({ sub: "1001", email: "ada.renamed@example.com", email_verified: true })).location, "/console/");
  const other = await signIn({ sub: "1002", email: "ada@example.org", email_verified: true });
  assert.equal((await call("/v1/me", { headers: { Cookie: other.session! } })).json.tenant, neutral("1002"));
  const admin = await signIn({ sub: "1003", email: "alice@example.com", email_verified: true });
  assert.equal((await call("/v1/me", { headers: { Cookie: admin.session! } })).json.tenant, neutral("1003"));
  // The MCP consent page offers Google, and sign-in started there returns there, signed in.
  const client = (await call("/oauth/register", { body: { client_name: "Test Agent", redirect_uris: ["http://127.0.0.1:43210/cb"], token_endpoint_auth_method: "none" } })).json;
  const consent = `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "http://127.0.0.1:43210/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s-1", resource: `${base}/mcp` })}`;
  assert.ok(String((await call(consent)).json).includes(`href="/console/auth/google?next=${encodeURIComponent(consent)}"`));
  const returned = await signIn({ sub: "1001", email: "ada@example.com", email_verified: true }, { next: consent });
  assert.equal(returned.location, decodeURIComponent(consent));
  assert.match(String((await call(consent, { headers: { Cookie: returned.session! } })).json), /Connect Test Agent\?[\s\S]*Signed in as <strong>ada@example\.com<\/strong>/);
  // An API token of a Google tenant names the person too, in /v1/me and in a console session it signs in.
  const token = (await call("/v1/tokens", { body: { name: "script" }, headers: { Cookie: ada.session!, "X-Agent-Runtime-Console": "1" } })).json.token;
  assert.equal((await call("/v1/me", { token })).json.login, "ada@example.com");
  const tokenSession = (await call("/console/auth/token", { body: { token }, headers: { "X-Agent-Runtime-Console": "1" } })).headers.getSetCookie()[0].split(";")[0];
  assert.equal((await call("/v1/me", { headers: { Cookie: tokenSession } })).json.login, "ada@example.com");
  // Unverified addresses, and tokens with the wrong nonce, signer or lifetime, never sign in or create a tenant.
  const refused = [
    [await signIn({ sub: "2001", email: "eve@example.com", email_verified: false }), /email address is verified/],
    [await signIn({ sub: "2002", email: "eve@example.com", email_verified: true }, { spoil: { nonce: "replayed" } }), /did not verify/],
    [await signIn({ sub: "2003", email: "eve@example.com", email_verified: true }, { spoil: { key: google.stranger } }), /did not verify/],
    [await signIn({ sub: "2004", email: "eve@example.com", email_verified: true }, { spoil: { expired: true } }), /did not verify/],
    [await signIn({ sub: "2005", email: "eve@example.com", email_verified: true, aud: "someone-else" }), /did not verify/],
    [await signIn({ sub: "2006", email: "eve@example.com", email_verified: true, iss: "https://evil.example" }), /did not verify/],
    [await signIn({ sub: "2007", email: "eve@example.com", email_verified: true }, { state: "forged" }), /expired or was tampered/],
  ] as const;
  for (const [result, message] of refused) { assert.equal(result.session, undefined); assert.match(result.location, message); }
  assert.equal((await db.query("select count(*) as n from tenants where google_sub like '2%'")).rows[0].n, 0);
  assert.equal((await db.query("select count(*) as n from tenants")).rows[0].n, 3);
});

test("Google sign-in needs open sign-up", async t => {
  await assert.rejects(runtime(t, undefined, { GOOGLE_CLIENT_ID: "google-client", GOOGLE_CLIENT_SECRET: "google-secret" }), /Server exited/);
});

test("key checks treat only 401/403 as invalid and send each API's auth header", async () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const fetcher = (status: number) => (async (url: any, init: any) => { seen.push({ url: String(url), headers: init.headers }); return new Response("{}", { status }); }) as typeof fetch;
  assert.deepEqual(await checkProviderKey("anthropic", "k1", fetcher(200)), { status: "valid" });
  assert.equal(seen[0].headers["x-api-key"], "k1");
  assert.equal((await checkProviderKey("openai", "k2", fetcher(401))).status, "invalid");
  assert.equal(seen[1].headers.Authorization, "Bearer k2");
  assert.equal((await checkProviderKey("google", "k3", fetcher(503))).status, "unverified");
  assert.equal(seen[2].headers["x-goog-api-key"], "k3");
  assert.equal((await checkProviderKey("openai", "k4", (async () => { throw new Error("offline"); }) as typeof fetch)).status, "unverified");
  // OpenRouter also serves Claude over Anthropic's API, but its key is checked the OpenAI way.
  assert.equal((await checkProviderKey("openrouter", "k5", fetcher(200))).status, "valid");
  assert.deepEqual(seen[3], { url: "https://openrouter.ai/api/v1/models", headers: { Authorization: "Bearer k5" } });
});

test("usage is recorded per response and summed per day and model across nodes", async () => {
  const { db } = await testDatabase();
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: {} }) });
  const nodeA = new Accounts({ tenants, db });
  const nodeB = new Accounts({ tenants, db });
  const message = (at: number, input: number) => ({ provider: "anthropic", model: "claude-sonnet-5", timestamp: at, usage: { input, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } } });
  nodeA.recordUsage("alice", "agent-1", message(Date.UTC(2026, 8, 1, 10), 100));
  nodeB.recordUsage("alice", "agent-2", message(Date.UTC(2026, 8, 1, 18), 50));
  nodeA.recordUsage("alice", "agent-1", message(Date.UTC(2026, 8, 2, 9), 1));
  await nodeB.flushUsage();
  const usage = await nodeA.usage("alice", Date.UTC(2026, 8, 1));
  assert.deepEqual(usage.totals, { responses: 3, input: 151, output: 30, cacheRead: 0, cacheWrite: 0, cost: 1.5, platformResponses: 0, platformCost: 0 });
  assert.deepEqual(usage.days.map(day => [day.day, day.responses]), [["2026-09-01", 2], ["2026-09-02", 1]]);
  assert.equal((await nodeA.usage("bob", 0)).totals.responses, 0);
});

test("console routes serve the app shell as HTML, never as a download", async t => {
  const { call } = await runtime(t);
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
});

test("the OpenAPI document is served without credentials", async t => {
  const { call } = await runtime(t);
  const served = await call("/v1/openapi.json");
  assert.equal(served.status, 200);
  assert.deepEqual(served.json, JSON.parse(await readFile(new URL("../openapi.json", import.meta.url), "utf8")));
});

test("a tenant at its agent quota gets 429 with Retry-After and nothing half-created; the same key succeeds once a slot frees", async t => {
  const { db, base, call } = await runtime(t, undefined, { AGENT_MAX_AGENTS: "4", AGENT_MAX_AGENTS_PER_TENANT: "1", AGENT_TOOL_TIMEOUT_MS: "3000" });
  const hold = { name: "hold", description: "Never answered", inputSchema: { type: "object", properties: {}, additionalProperties: false } };
  const busy = await call("/v1/agents", { token: bob, body: { mcp: { tools: [hold] } }, headers: { "Idempotency-Key": "busy" } });
  assert.equal(busy.status, 201);
  // A call sent to an application that never answers keeps the agent busy until the tool timeout, so it cannot be evicted.
  const app = await attachSilently(t, base, busy.json.id, busy.json.token);
  const run = await call(`/clients/${busy.json.id}/requests`, { token: busy.json.token, body: { id: "hold-1", method: "execute", params: { code: "return await tools.hold({})" } } });
  assert.equal(run.status, 202);
  for (let tries = 0; !app.calls.length; tries++) {
    assert.ok(tries < 100, "the call was sent");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const agents = async () => Number((await db.query("select count(*) as count from agents where tenant = 'bob'")).rows[0].count);
  for (const key of ["second", "third"]) {
    const refused = await call("/v1/agents", { token: bob, body: {}, headers: { "Idempotency-Key": key } });
    assert.equal(refused.status, 429, key);
    assert.equal(refused.headers.get("retry-after"), "5");
    assert.match(JSON.stringify(refused.json), /already has 1 agents running/);
  }
  assert.equal(await agents(), 1, "a refused create persists nothing");
  // Other statuses keep theirs too: a reused key for someone else conflicts, not "bad request".
  assert.equal((await call("/v1/agents", { token: bob, body: { mcp: { tools: [hold] }, subject: "someone-else" }, headers: { "Idempotency-Key": "busy" } })).status, 409);
  // The tool times out, the busy agent goes idle, and the refused create's retry takes its slot.
  let retried;
  for (let tries = 0; (retried = await call("/v1/agents", { token: bob, body: {}, headers: { "Idempotency-Key": "second" } })).status === 429; tries++) {
    assert.ok(tries < 100, "the slot frees");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(retried.status, 201);
  assert.equal(await agents(), 2);
});

test("a tenant's own maxAgents replaces the default limit, and a change applies at the next tenants reload without a restart", async t => {
  const tenants = (bobLimit: number) => ({
    alice: { tokenSha256: sha(alice), apiKeys: { anthropic: "alice-admin-anthropic-key" } },
    bob: { tokenSha256: sha(bob), apiKeys: { anthropic: "bob-admin-anthropic-key" }, maxAgents: bobLimit },
  });
  // The held calls are never answered: shut down without draining them for the tool timeout.
  const { root, base, call, child, logged } = await runtime(t, undefined, { AGENT_MAX_AGENTS: "10", AGENT_MAX_AGENTS_PER_TENANT: "1", AGENT_TOOL_TIMEOUT_MS: "20000", AGENT_DRAIN_TIMEOUT_MS: "0" }, tenants(2));
  const hold = { name: "hold", description: "Never answered", inputSchema: { type: "object", properties: {}, additionalProperties: false } };
  const create = (token: string, key: string) => call("/v1/agents", { token, body: { mcp: { tools: [hold] } }, headers: { "Idempotency-Key": key } });
  const statuses = (results: { status: number }[]) => results.map(result => result.status).sort();

  // Three concurrent starts for bob (his own limit, 2), two for alice (the default, 1).
  const logs = [logged(/"quota_rejected".*"tenant":"bob".*"limit":"agentsPerTenant","value":2,"source":"tenant"/), logged(/"quota_rejected".*"tenant":"alice".*"value":1,"source":"default"/)];
  const [bobs, alices] = await Promise.all([Promise.all(["b1", "b2", "b3"].map(key => create(bob, key))), Promise.all(["a1", "a2"].map(key => create(alice, key)))]);
  assert.deepEqual(statuses(bobs), [201, 201, 429]);
  assert.deepEqual(statuses(alices), [201, 429]);
  await Promise.all(logs);
  const refused = ["b1", "b2", "b3"][bobs.findIndex(result => result.status === 429)];

  // Bob's two agents are busy, each with a call delivered to an application that never answers, so nothing can be evicted for the refused one.
  for (const agent of bobs.filter(result => result.status === 201).map(result => result.json)) {
    const app = await attachSilently(t, base, agent.id, agent.token);
    assert.equal((await call(`/clients/${agent.id}/requests`, { token: agent.token, body: { id: "hold", method: "execute", params: { code: "return await tools.hold({})" } } })).status, 202);
    for (let tries = 0; !app.calls.length; tries++) {
      assert.ok(tries < 100, "the call was sent");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  assert.equal((await create(bob, refused)).status, 429);

  // Raise bob's limit in the tenants file and reload, as the secret's refresh does: no restart.
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: tenants(3) }));
  const reloaded = logged(/tenants_reloaded/);
  child.kill("SIGHUP");
  await reloaded;
  assert.equal((await create(bob, refused)).status, 201);
  assert.equal((await create(alice, "a3")).status, 201, "alice's idle agent makes room under the default");
});

test("a tenant's monthly spend cap ends a turn after the response that crosses it, refuses new runs, and a reload raising it lets the turn continue", async t => {
  // Each response costs $0.15: 5000 input tokens of openai/gpt-5.5-pro, far below its context window.
  const bodies: any[] = [];
  const model = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    bodies.push(body);
    const index = bodies.length - 1;
    const delta = index < 2 ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${index}`, type: "function", function: { name: "js_exec", arguments: JSON.stringify({ code: `return ${index}` }) } }] } : { role: "assistant", content: "finished" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: index < 2 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5000, completion_tokens: 0 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  }).listen(0, "127.0.0.1");
  await once(model, "listening");
  t.after(async () => { model.closeAllConnections(); await new Promise(resolve => model.close(resolve)); });
  const tenants = (cap: number) => ({ alice: { tokenSha256: sha(alice), apiKeys: { openrouter: "fixture-key" }, maxMonthlyCost: cap } });
  const { root, call, child, logged } = await runtime(t, undefined, {
    AGENT_PROVIDER: "openrouter", AGENT_MODEL: "openai/gpt-5.5-pro", AGENT_BASE_URL: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`,
    ...(process.env.AGENT_HOSTING ? { AGENT_HOSTING: process.env.AGENT_HOSTING } : {}),
  }, tenants(0.25));
  const agent = (await call("/v1/agents", { token: alice, body: {} })).json;
  const settled = async (requestId: string) => {
    for (let tries = 0; ; tries++) {
      const record = (await call(`/v1/agents/${agent.id}/requests/${requestId}`, { token: alice })).json;
      if (record.state === "completed") return record.outcome;
      assert.ok(tries < 200, "the run settles");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  assert.equal((await call(`/v1/agents/${agent.id}/prompt`, { token: alice, body: { text: "go", requestId: "first" } })).status, 202);
  const first = await settled("first");
  assert.equal(first.result.stopped, "spend_limit");
  assert.match(first.result.error, /monthly spend limit of \$0\.25/);
  assert.equal(bodies.length, 2, "the turn ended after the response that crossed the cap");
  const history = (await call(`/v1/agents/${agent.id}/history`, { token: alice })).json.messages;
  assert.deepEqual(history.map((message: any) => message.role), ["user", "assistant", "toolResult", "assistant", "toolResult"], "every tool call has its result");

  const refused = await call(`/v1/agents/${agent.id}/prompt`, { token: alice, body: { text: "again", requestId: "refused" } });
  assert.equal(refused.status, 402);
  assert.match(refused.json.error, /spend limit/);
  assert.equal(bodies.length, 2);

  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: tenants(10) }));
  const reloaded = logged(/tenants_reloaded/);
  child.kill("SIGHUP");
  await reloaded;
  assert.equal((await call(`/v1/agents/${agent.id}/prompt`, { token: alice, body: { text: "carry on", requestId: "after" } })).status, 202);
  const after = await settled("after");
  assert.equal(after.result.error, null);
  assert.equal(after.result.reply, "finished");
  assert.deepEqual(bodies[2].messages.map((message: any) => message.role).filter((role: string) => !["system", "developer"].includes(role)), ["user", "assistant", "tool", "assistant", "tool", "user"]);
  const usage = (await call("/v1/usage", { token: alice })).json;
  assert.equal(usage.totals.responses, 3);
});
