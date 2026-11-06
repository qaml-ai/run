import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { TestContext } from "node:test";
import type { ContractFixture } from "../fixture.ts";
import { contractTest, OPERATOR, OTHER_OPERATOR, freshWindow } from "../support.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const alice = OPERATOR, bob = OTHER_OPERATOR;
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


const tenants = { tenants: {
  alice: { tokenSha256: sha(alice), apiKeys: {} },
  bob: { tokenSha256: sha(bob), apiKeys: { anthropic: "bob-admin-anthropic-key" }, github: "Bob-Builder" },
} };
type Github = Awaited<ReturnType<typeof fakeGithub>>;
type Google = Awaited<ReturnType<typeof fakeGoogle>>;
function githubTest(source: string, name: string, members: Record<string, "active" | "pending">, body: (t: TestContext, r: ContractFixture, github: Github) => Promise<void>, env: Record<string, string> = {}) {
  let github: Github;
  contractTest("auth", source, name, (t, r) => body(t, r, github), { tenants, prepare: async t => {
    github = await fakeGithub(t, members);
    return { AGENT_PROVIDER: "camelrun", AGENT_MODEL: "default", GITHUB_CLIENT_ID: "client-id", GITHUB_CLIENT_SECRET: "client-secret", GITHUB_ORG: "qaml-ai", AGENT_SIGNUP_MIN_ACCOUNT_DAYS: "7", AGENT_GITHUB_WEB_URL: github.url, AGENT_GITHUB_API_URL: github.url, ...env };
  } });
}
function googleTest(source: string, name: string, body: (t: TestContext, r: ContractFixture, google: Google) => Promise<void>) {
  let google: Google;
  contractTest("auth", source, name, (t, r) => body(t, r, google), { tenants, prepare: async t => {
    google = await fakeGoogle(t);
    return { AGENT_PROVIDER: "camelrun", AGENT_MODEL: "default", GOOGLE_CLIENT_ID: "google-client", GOOGLE_CLIENT_SECRET: "google-secret", AGENT_GOOGLE_ISSUER: google.url, AGENT_OPEN_SIGNUP: "true" };
  } });
}
const anonymous = (r: ContractFixture) => (path: string, init: any = {}) => r.call(path, { token: null, ...init });

githubTest("tests/api.test.ts:411","sign-ups per address per day: behind Cloudflare, a new account past the limit waits a day; existing accounts still sign in", { Carol: "active", Dave: "active" }, async (t, r, github) => {
  const call = anonymous(r);
  const signIn = async (login: string, ip: string) => {
    github.signInAs(login);
    const headers = { "CF-Connecting-IP": ip };
    const start = await call("/console/auth/github", { headers });
    const authorize = new URL(start.headers.get("location")!);
    const cookies = start.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const callback = await call(`/console/auth/callback?code=abc&state=${authorize.searchParams.get("state")}`, { headers: { ...headers, Cookie: cookies } });
    return { location: decodeURIComponent(callback.headers.get("location")!), session: callback.headers.getSetCookie().some(value => value.startsWith("ar_session=")) };
  };
  // Sign-ups are counted per UTC day: the counting below stays in one.
  await freshWindow(86_400, 30_000);
  assert.equal((await signIn("Carol", "203.0.113.5")).session, true);
  const refused = await signIn("Dave", "203.0.113.5");
  assert.equal(refused.session, false);
  assert.match(refused.location, /Too many new accounts from this network today \(at most 1 a day\)/);
  assert.equal((await signIn("Carol", "203.0.113.5")).session, true, "an existing account is not a sign-up");
  assert.equal((await signIn("Dave", "203.0.113.6")).session, true);
}, { AGENT_TRUST_CF_CONNECTING_IP: "true", AGENT_RATE_LIMIT_SIGNUPS_PER_IP: "1" });

githubTest("tests/api.test.ts:434","GitHub sign-in admits active org members, links admin tenants, and creates new tenants", { "Bob-Builder": "active", Carol: "active", Mallory: "pending" }, async (t, r, github) => {
  const call = anonymous(r);
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
  // Only the MCP consent and managed server setup routes survive sign-in.
  assert.equal((await signIn("Bob-Builder", "/oauth/authorize?client_id=x&state=y")).location, "/oauth/authorize?client_id=x&state=y");
  assert.equal((await signIn("Bob-Builder", "/console/discord/install")).location, "/console/discord/install");
  assert.equal((await signIn("Bob-Builder", "/console/discord/install?redirect=https://evil.example")).location, "/console/");
  assert.equal((await signIn("Bob-Builder", "https://evil.example/")).location, "/console/");
  assert.equal((await signIn("Bob-Builder", "//evil.example/oauth/authorize?")).location, "/console/");
  assert.equal((await call("/v1/me", { headers: { Cookie: bobSession.session! } })).json.tenant, "bob");
  const carol = await signIn("Carol");
  assert.deepEqual((await call("/v1/me", { headers: { Cookie: carol.session! } })).json, { tenant: "carol", via: "console", login: "Carol", signIn: "github", canStoreKeys: true, defaultModel: "camelrun/default" });
  const mallory = await signIn("Mallory");
  assert.equal(mallory.session, undefined);
  assert.match(decodeURIComponent(mallory.location), /Only members of the qaml-ai/);
  // A forged state is rejected.
  const forged = await call("/console/auth/callback?code=abc&state=forged", { headers: { Cookie: "ar_oauth_state=other" } });
  assert.match(decodeURIComponent(forged.headers.get("location")!), /expired or was tampered/);
});

googleTest("tests/api.test.ts:468","Google sign-in verifies the ID token, creates separate tenants, and returns to the consent page", async (t, r, google) => {
  const call = anonymous(r);
  assert.deepEqual((await call("/console/auth/methods")).json, { github: false, google: true, password: true });
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
  assert.deepEqual((await call("/v1/me", { headers: { Cookie: ada.session! } })).json, { tenant: neutral("1001"), via: "console", login: "ada@example.com", name: "Ada Lovelace", signIn: "google", canStoreKeys: true, defaultModel: "camelrun/default" });
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
  // The neutral fixture can expose a distinct public origin; clients discover
  // its protected resource instead of treating the private listening URL as it.
  const resource = (await call("/.well-known/oauth-protected-resource")).json.resource;
  const consent = `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "http://127.0.0.1:43210/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "s-1", resource })}`;
  assert.ok(String((await call(consent)).json).includes(`href="/console/auth/google?next=${encodeURIComponent(consent)}"`));
  assert.match(String((await call(consent)).json), /<form method="post" action="\/oauth\/password">/, "and email and password sign-in");
  assert.doesNotMatch(String((await call(consent)).json), /API token/);
  const returned = await signIn({ sub: "1001", email: "ada@example.com", email_verified: true }, { next: consent });
  assert.equal(returned.location, decodeURIComponent(consent));
  assert.match(String((await call(consent, { headers: { Cookie: returned.session! } })).json), /Connect an application\?[\s\S]*Signed in as <strong>ada@example\.com<\/strong>/);
  // An API token of a Google tenant names the person too, in /v1/me.
  const token = (await call("/v1/tokens", { body: { name: "script" }, headers: { Cookie: ada.session!, "X-Agent-Runtime-Console": "1", "Sec-Fetch-Site": "same-origin" } })).json.token;
  assert.equal((await call("/v1/me", { token })).json.login, "ada@example.com");
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
});


const PASSWORD = "correct-horse-battery-staple";
const browser = { "X-Agent-Runtime-Console": "1", "Sec-Fetch-Site": "same-origin" };
githubTest("tests/api.test.ts:306","password sign-in: a person's session; unknown addresses fail like wrong passwords; setting, changing or clearing a password ends its sessions; token sign-in is gone", { Carol: "active" }, async (t, r, provider) => {
  const call = anonymous(r);
  const signIn = async (email: string, password: string) => {
    const response = await call("/console/auth/password", { body: { email, password }, headers: browser });
    return { status: response.status, json: response.json, cookie: response.headers.getSetCookie().find(value => value.startsWith("ar_session="))?.split(";")[0] };
  };
  const as = (cookie: string) => (path: string, init: { method?: string; body?: unknown } = {}) => call(path, { ...init, headers: { Cookie: cookie, ...browser } });

  // Who sets a password: the platform operator for any tenant, an operator token for its own; never an API token or another operator.
  const carol = (await call("/v1/tenants", { method: "POST", token: bob, body: { id: "carol" } })).json;
  const carolPassword = { email: "carol@example.com", password: PASSWORD };
  assert.equal((await call("/v1/tenants/carol/password", { method: "PUT", token: carol.token.token, body: carolPassword })).status, 403, "not with an API token");
  assert.equal((await call("/v1/tenants/carol/password", { method: "PUT", token: alice, body: carolPassword })).status, 403, "not with another tenant's operator token");
  assert.equal((await call("/v1/tenants/nobody/password", { method: "PUT", token: bob, body: carolPassword })).status, 404);
  assert.equal((await call("/v1/tenants/carol/password", { method: "PUT", token: bob, body: { ...carolPassword, password: "too-short" } })).status, 400);
  assert.equal((await call("/v1/tenants/carol/password", { method: "PUT", token: bob, body: { ...carolPassword, email: "not-an-address" } })).status, 400);
  assert.deepEqual((await call("/v1/tenants/carol/password", { method: "PUT", token: bob, body: carolPassword })).json, { tenant: "carol", email: "carol@example.com", signedOut: 0 });
  assert.equal((await call("/v1/tenants/alice/password", { method: "PUT", token: alice, body: { ...carolPassword, email: "CAROL@example.com" } })).status, 409, "one address, one account");
  // An API token names the person by the address too.
  assert.equal((await call("/v1/me", { token: carol.token.token })).json.login, "carol@example.com");

  // A password session is a person's, as GitHub's and Google's are: it may mint tokens and change billing.
  const first = await signIn("carol@example.com", PASSWORD);
  assert.equal(first.status, 200);
  assert.equal((await as(first.cookie!)("/v1/tokens", { body: { name: "from-console" } })).status, 201);
  assert.equal((await as(first.cookie!)("/v1/account/password")).json.email, "carol@example.com");

  // Wrong password and unknown address: the same answer, and both check a password hash.
  const wrong = await signIn("carol@example.com", "not-the-password-1");
  const unknown = await signIn("nobody@example.com", "not-the-password-1");
  assert.deepEqual([wrong.status, wrong.json, wrong.cookie], [401, { error: "Wrong email or password" }, undefined]);
  assert.deepEqual([unknown.status, unknown.json, unknown.cookie], [wrong.status, wrong.json, wrong.cookie]);
  const time = async (email: string) => { const started = performance.now(); await signIn(email, "not-the-password-1"); return performance.now() - started; };
  const median = (values: number[]) => values.sort((a, b) => a - b)[1];
  const wrongMs = median([await time("carol@example.com"), await time("carol@example.com"), await time("carol@example.com")]);
  const unknownMs = median([await time("nobody@example.com"), await time("nobody@example.com"), await time("nobody@example.com")]);
  assert.ok(unknownMs > wrongMs / 3 && wrongMs > unknownMs / 3, `comparable timing (wrong ${wrongMs.toFixed(0)} ms, unknown ${unknownMs.toFixed(0)} ms)`);

  // Changing it takes the current password, and ends every other password session; this one stays.
  const second = (await signIn("carol@example.com", PASSWORD)).cookie!;
  const change = (cookie: string, body: Record<string, unknown>) => as(cookie)("/v1/account/password", { method: "PUT", body });
  assert.equal((await change(first.cookie!, { currentPassword: "not-the-password-1", newPassword: "a-new-password-for-carol" })).status, 403);
  assert.equal((await change(first.cookie!, { currentPassword: PASSWORD, newPassword: "short" })).status, 400);
  assert.equal((await call("/v1/account/password", { method: "PUT", token: carol.token.token, body: { currentPassword: PASSWORD, newPassword: "a-new-password-for-carol" } })).status, 403, "not with a token");
  assert.deepEqual((await change(first.cookie!, { currentPassword: PASSWORD, newPassword: "a-new-password-for-carol" })).json, { changed: true, signedOut: 1 });
  assert.equal((await as(first.cookie!)("/v1/me")).status, 200, "the session that changed it stays");
  assert.equal((await as(second)("/v1/me")).status, 401, "the others end");
  assert.equal((await signIn("carol@example.com", PASSWORD)).status, 401);
  const third = (await signIn("carol@example.com", "a-new-password-for-carol")).cookie!;

  // Setting it again, or clearing it, ends its password sessions; GitHub and Google sessions, and other tenants', stay.
  // Seed the configured identity mapping, then obtain this distinct session through OAuth.
  await r.seedTenant("carol", { config: { github: "Carol" } });
  provider.signInAs("Carol");
  const started = await call("/console/auth/github");
  const authorize = new URL(started.headers.get("location")!);
  const callback = await call(`/console/auth/callback?code=abc&state=${authorize.searchParams.get("state")}`, { headers: {
    Cookie: started.headers.getSetCookie().map(value => value.split(";")[0]).join("; "),
  } });
  const github = callback.headers.getSetCookie().find(value => value.startsWith("ar_session="))!.split(";")[0].slice("ar_session=".length);
  await call("/v1/tenants/alice/password", { method: "PUT", token: alice, body: { email: "alice@example.test", password: PASSWORD } });
  const alices = (await signIn("alice@example.test", PASSWORD)).cookie!;
  assert.deepEqual((await call("/v1/tenants/carol/password", { method: "PUT", token: bob, body: { email: "carol@example.org", password: PASSWORD } })).json, { tenant: "carol", email: "carol@example.org", signedOut: 2 });
  for (const ended of [first.cookie!, third]) assert.equal((await as(ended)("/v1/me")).status, 401);
  assert.equal((await as(`ar_session=${github}`)("/v1/me")).status, 200);
  assert.equal((await as(alices)("/v1/me")).status, 200);
  assert.equal((await signIn("carol@example.com", "a-new-password-for-carol")).status, 401, "the old address is gone");
  const fourth = (await signIn("carol@example.org", PASSWORD)).cookie!;
  assert.deepEqual((await call("/v1/tenants/carol/password", { method: "DELETE", token: bob })).json, { tenant: "carol", email: null, signedOut: 1 });
  assert.equal((await as(fourth)("/v1/me")).status, 401);
  assert.equal((await as(`ar_session=${github}`)("/v1/me")).status, 200);
  assert.deepEqual((await signIn("carol@example.org", PASSWORD)).json, { error: "Wrong email or password" }, "a cleared password fails like any other");
  assert.equal((await as(`ar_session=${github}`)("/v1/account/password")).json.email, null);

  // Signing in with a token is gone, at the console and the consent page; tokens still work as Bearer auth for the API.
  assert.equal((await call("/console/auth/token", { body: { token: alice }, headers: browser })).status, 404);
  assert.equal((await call("/oauth/login", { body: { token: alice } })).status, 404);
  assert.equal((await call("/v1/me", { token: alice })).json.via, "operator");
  assert.equal((await call("/v1/me", { token: carol.token.token })).json.via, "token");

}, { AGENT_BILLING_ADMINS: "bob" });
