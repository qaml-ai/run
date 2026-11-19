import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { OAuth, type OAuthOptions } from "../../../src/oauth.ts";
import { PublicOrigins } from "../../../src/origins.ts";
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
