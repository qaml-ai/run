import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ConsoleAuth, type ConsoleAuthOptions } from "../../../src/console-auth.ts";
import { OAuth, type OAuthOptions } from "../../../src/oauth.ts";
import { PublicOrigins } from "../../../src/origins.ts";
import { Passwords } from "../../../src/passwords.ts";
import { RateLimited, RateLimits, rateLimitConfig } from "../../../src/rate-limits.ts";
import { startFixture } from "./fixture.ts";

test("the Worker exchanges, refreshes and revokes grants issued by legacy OAuth", { timeout: 180_000 }, async t => {
  const canonical = "https://run.example.test";
  const issuer = "https://agents.example.test";
  const secret = "legacy-oauth-issuer-fixture-secret-for-tests";
  const rateEnv = { AGENT_TRUST_CF_CONNECTING_IP: "true", AGENT_RATE_LIMIT_AUTH_PER_IP: "2" };
  const f = await startFixture({
    tenants: [{ id: "fixture", token: "art_fixture-tenant-key" }],
    vars: { AGENT_PUBLIC_URL: canonical, AGENT_PUBLIC_ALIASES: issuer, AGENT_ISSUER: issuer, AGENT_SESSION_SECRET: secret,
      LEGACY_OAUTH_TOKEN_ROUTES: "1", ...rateEnv },
    entrypoint: fileURLToPath(new URL("./legacy-mcp-entry.ts", import.meta.url)),
    loopbackServices: { MCP_LEGACY_API: "FixtureLegacyOrigin" },
  });
  t.after(() => f.stop());

  const db = f.db as unknown as OAuthOptions["db"];
  const legacy = new OAuth({ db, secret, github: false, origins: new PublicOrigins(canonical, [issuer], issuer),
    accounts: { exists: async (tenant: string) => tenant === "fixture" } as OAuthOptions["accounts"],
    consoleAuth: { principal: async () => ({ tenant: "fixture", via: "console" }) } as unknown as OAuthOptions["consoleAuth"],
  });
  const callback = "https://client.example.test/oauth";
  const client = legacy.register({ redirect_uris: [callback], token_endpoint_auth_method: "client_secret_basic" });
  const auth = "Basic " + Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64");
  const verifier = "v".repeat(43);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const legacyExchange = async () => {
    const consent = await legacy.app.request("/oauth/authorize", {
      method: "POST", headers: { origin: canonical }, body: new URLSearchParams({ decision: "allow", response_type: "code",
        client_id: client.client_id, redirect_uri: callback, code_challenge: challenge, code_challenge_method: "S256", resource: issuer + "/mcp" }),
    });
    assert.equal(consent.status, 302);
    const redirect = new URL(consent.headers.get("location")!);
    assert.equal(redirect.searchParams.get("iss"), issuer);
    return new URLSearchParams({ grant_type: "authorization_code", code: redirect.searchParams.get("code")!, code_verifier: verifier, redirect_uri: callback });
  };
  const original = await legacy.app.request("/oauth/token", { method: "POST", headers: { authorization: auth }, body: await legacyExchange() });
  assert.equal(original.status, 200);
  type Tokens = { access_token: string; refresh_token: string; scope: string };
  const initial = await original.json() as Tokens;
  assert.equal(initial.scope, "agents");

  const callWorker = (path: string, body: URLSearchParams, headers: Record<string, string> = {}) => fetch(f.url + path, {
    method: "POST", headers: { authorization: auth, "x-forwarded-host": new URL(issuer).host, ...headers }, body,
  });
  const hosted = async (token: string) => fetch(f.url + "/mcp", {
    method: "POST", headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal((await hosted(initial.access_token)).status, 200);
  const rotate = new URLSearchParams({ grant_type: "refresh_token", refresh_token: initial.refresh_token, resource: issuer + "/mcp" });
  const denied = await callWorker("/oauth/token", rotate, { authorization: "Basic " + Buffer.from(`${client.client_id}:bad-secret`).toString("base64") });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("www-authenticate"), 'Basic realm="oauth"');
  assert.equal((await denied.json() as { error: string }).error, "invalid_client");

  const refreshed = await callWorker("/oauth/token", rotate);
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.headers.get("cache-control"), "no-store");
  assert.equal(refreshed.headers.get("pragma"), "no-cache");
  assert.equal(refreshed.headers.get("access-control-allow-origin"), "*");
  const successor = await refreshed.json() as Tokens;
  assert.notEqual(successor.refresh_token, initial.refresh_token);
  assert.equal(successor.scope, initial.scope);
  const retry = await legacy.app.request("/oauth/token", { method: "POST", headers: { authorization: auth }, body: rotate });
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), successor);
  assert.ok(await legacy.authenticate(`Bearer ${successor.access_token}`));

  const revoked = await callWorker("/oauth/revoke", new URLSearchParams({ token: successor.refresh_token }));
  assert.equal(revoked.status, 200);
  assert.equal(await revoked.text(), "");
  assert.equal((await hosted(initial.access_token)).status, 401);
  assert.equal((await hosted(successor.access_token)).status, 401);
  assert.equal(await legacy.authenticate(`Bearer ${initial.access_token}`), undefined);
  assert.equal((await callWorker("/oauth/token", rotate)).status, 400);

  const exchanged = await callWorker("/oauth/token", await legacyExchange());
  assert.equal(exchanged.status, 200);
  assert.ok(await legacy.authenticate(`Bearer ${(await exchanged.json() as Tokens).access_token}`));
  assert.equal((await fetch(f.url + "/oauth/token", { method: "OPTIONS" })).status, 204);
  assert.equal((await fetch(f.url + "/oauth/authorize")).status, 418);
  assert.equal((await fetch(f.url + "/oauth/register", { method: "POST" })).status, 418);

  const limiter = new RateLimits({ db, config: rateLimitConfig(rateEnv), hashKey: secret, nodes: () => 1, free: async () => false });
  const ip = "192.0.2.17";
  await limiter.request("/oauth/token", ip);
  const forwarded = { "fixture-client-ip": ip };
  const unknown = new URLSearchParams({ token: "unknown" });
  assert.equal((await callWorker("/oauth/revoke", unknown, forwarded)).status, 200);
  const throttled = await callWorker("/oauth/revoke", unknown, forwarded);
  assert.equal(throttled.status, 429);
  assert.ok(Number(throttled.headers.get("retry-after")) > 0);
  assert.equal((await throttled.json() as { code: string }).code, "RATE_LIMITED");
  await assert.rejects(limiter.request("/oauth/token", ip), RateLimited);
});

test("Worker registration and browser consent use the same OAuth identity and sessions as legacy", { timeout: 180_000 }, async t => {
  const canonical = "https://run.example.test";
  const issuer = "https://agents.example.test";
  const secret = "legacy-oauth-browser-fixture-secret-for-tests";
  const tenant = "fixture";
  const email = "fixture@example.test";
  const password = "synthetic browser login password";
  const f = await startFixture({
    tenants: [{ id: tenant, token: "art_fixture-tenant-key", seedCredit: false }],
    vars: {
      AGENT_PUBLIC_URL: canonical, AGENT_PUBLIC_ALIASES: issuer, AGENT_ISSUER: issuer, AGENT_SESSION_SECRET: secret,
      LEGACY_OAUTH_REGISTRATION: "1", LEGACY_OAUTH_BROWSER: "1",
    },
    entrypoint: fileURLToPath(new URL("./legacy-mcp-entry.ts", import.meta.url)),
  });
  t.after(() => f.stop());
  const db = f.db as unknown as OAuthOptions["db"];
  const accounts = { db, exists: async (id: string) => id === tenant } as ConsoleAuthOptions["accounts"];
  const passwords = new Passwords(db);
  await passwords.set(tenant, email, password);
  const legacyConsole = new ConsoleAuth({ accounts, passwords, publicUrl: canonical });
  const legacy = new OAuth({ db, secret, github: false, origins: new PublicOrigins(canonical, [issuer], issuer),
    accounts, consoleAuth: legacyConsole,
  });
  const call = (path: string, init: RequestInit = {}) => fetch(f.url + path, { redirect: "manual", ...init });
  const callback = "https://client.example.test/oauth?keep=1";
  const preflight = await call("/oauth/register", { method: "OPTIONS" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  const rejected = await call("/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://client.example.test/oauth"] }),
  });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json() as { error: string }).error, "invalid_redirect_uri");
  const registration = await call("/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Browser fixture", redirect_uris: [callback], token_endpoint_auth_method: "client_secret_basic" }),
  });
  assert.equal(registration.status, 201);
  assert.equal(registration.headers.get("cache-control"), "no-store");
  assert.equal(registration.headers.get("access-control-allow-origin"), "*");
  const client = await registration.json() as { client_id: string; client_secret: string };
  const verifier = "p".repeat(43);
  const state = "keep-client-state";
  const request = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: callback,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    resource: issuer + "/mcp", state,
  });
  const next = "/oauth/authorize?" + request;
  const alias = await call(next, { headers: { "x-forwarded-host": new URL(issuer).host } });
  assert.equal(alias.status, 302);
  assert.equal(alias.headers.get("location"), canonical + next);
  const canonicalHost = { "x-forwarded-host": new URL(canonical).host };
  const signIn = await call(next, { headers: canonicalHost });
  assert.equal(signIn.status, 200);
  assert.equal(signIn.headers.get("x-robots-tag"), "noindex");
  assert.equal(signIn.headers.get("x-frame-options"), "DENY");
  assert.match(await signIn.text(), /Sign in to camelRun/);
  const oldCookie = (await legacyConsole.session(tenant, "github", "existing-login")).split(";")[0]!;
  const existing = await call(next, { headers: { ...canonicalHost, cookie: oldCookie } });
  assert.equal(existing.status, 200);
  assert.match(await existing.text(), /Signed in as <strong>existing-login<\/strong>/);

  const form = (values: Record<string, string>, cookie?: string, origin = canonical) => ({
    method: "POST", headers: { ...canonicalHost, origin, ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(values),
  });
  const badLogin = await call("/oauth/password", form({ next, email, password: "wrong password" }));
  assert.equal(badLogin.status, 401);
  assert.equal(badLogin.headers.get("set-cookie"), null);
  const login = await call("/oauth/password", form({ next, email, password }));
  assert.equal(login.status, 303);
  assert.equal(login.headers.get("location"), next);
  const setCookie = login.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /^ar_session=[\w-]+; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Lax; Secure$/);
  const cookie = setCookie.split(";")[0]!;
  const session = await legacyConsole.principal(new Request(canonical + next, { headers: { cookie } }));
  assert.equal(session?.tenant, tenant);
  assert.equal(session?.login, email);
  const consent = await call(next, { headers: { ...canonicalHost, cookie } });
  assert.equal(consent.status, 200);
  assert.match(await consent.text(), /Connect an application\?/);
  assert.equal(consent.headers.get("cache-control"), "no-store");
  const allow = { ...Object.fromEntries(request), decision: "allow" };
  const csrf = await call("/oauth/authorize", form(allow, cookie, "https://unrelated.example.test"));
  assert.equal(csrf.status, 403);
  assert.equal((await f.db.query("select count(*)::int n from oauth_tokens where kind = 'code'")).rows[0].n, 0);
  const denied = await call("/oauth/authorize", form({ ...allow, decision: "deny" }, cookie));
  assert.equal(denied.status, 302);
  assert.equal(new URL(denied.headers.get("location")!).searchParams.get("error"), "access_denied");
  const authorized = await call("/oauth/authorize", form(allow, cookie));
  assert.equal(authorized.status, 302);
  const redirect = new URL(authorized.headers.get("location")!);
  assert.equal(redirect.origin + redirect.pathname, "https://client.example.test/oauth");
  assert.equal(redirect.searchParams.get("keep"), "1");
  assert.equal(redirect.searchParams.get("state"), state);
  assert.equal(redirect.searchParams.get("iss"), issuer);
  const code = redirect.searchParams.get("code");
  assert.ok(code);
  const exchanged = await legacy.app.request("/oauth/token", {
    method: "POST", headers: { authorization: "Basic " + Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64") },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: callback }),
  });
  assert.equal(exchanged.status, 200);
  const tokens = await exchanged.json() as { access_token: string; scope: string };
  assert.equal(tokens.scope, "agents");
  const principal = await legacy.authenticate(`Bearer ${tokens.access_token}`);
  assert.equal(principal?.tenant, tenant);
  assert.equal(principal?.login, email);
});
