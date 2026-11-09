import assert from "node:assert/strict";
import { test } from "node:test";
import { sign, verify } from "../lib/session.ts";
import { configurationError, githubIdentity, oidcIdentity } from "../lib/oauth.ts";
const secret = "test-only-".repeat(8);
test("sessions reject tampering, wrong purpose, expiry and missing configuration", async () => {
  const token = await sign({ userId: "github:1", name: "sam" }, secret, "session", 60);
  assert.equal((await verify(token, secret, "session"))?.userId, "github:1");
  assert.equal(await verify(`${token.slice(0, -8)}tampered`, secret, "session"), null);
  assert.equal(await verify(token, secret, "oauth"), null);
  assert.equal(await verify(token, undefined, "session"), null);
  assert.equal(await verify(await sign({}, secret, "session", -1), secret, "session"), null);
});
test("GitHub requires active membership and fails closed on lookup errors", async () => {
  for (const [status, state] of [[200, "active"], [200, "pending"], [404, ""], [500, ""]] as const) {
    const fetcher: typeof fetch = async (url, options) => {
      assert.equal(options?.redirect, "manual");
      return String(url).endsWith("/user") ? Response.json({ id: 1, login: "sam" }) : Response.json({ state }, { status });
    };
    if (status === 500) await assert.rejects(githubIdentity("test", "org", fetcher));
    else assert.deepEqual(await githubIdentity("test", "org", fetcher), state === "active" ? { userId: "github:1", name: "sam" } : null);
  }
});

test("OIDC requires explicit admission and a verified exact email match", () => {
  const env = { AUTH_PROVIDER: "oidc", APP_URL: "https://app.example", SESSION_SECRET: secret,
    OIDC_ISSUER: "https://id.example", OIDC_CLIENT_ID: "client", OIDC_CLIENT_SECRET: "test" };
  const claims = { sub: "123", name: "Sam", email: "sam@example.com", email_verified: true };
  assert.match(configurationError(env)!, /OIDC_ALLOWED_DOMAINS or OIDC_ALLOWED_EMAILS/);
  assert.equal(oidcIdentity(claims, env), null);
  assert.equal(oidcIdentity(claims, { ...env, OIDC_ALLOWED_DOMAINS: " , " }), null);
  const allowed = { ...env, OIDC_ALLOWED_DOMAINS: "EXAMPLE.COM, other.example" };
  assert.equal(configurationError(allowed), null);
  assert.deepEqual(oidcIdentity(claims, allowed), { userId: "https://id.example:123", name: "Sam" });
  for (const overrides of [
    { email_verified: false }, { email_verified: "true" }, { email_verified: undefined }, { email: undefined },
    { email: "sam@evil-example.com" }, { email: "sam@sub.example.com" }, { email: "sam@example.com.evil" },
    { email: "sam@evil@example.com" }, { sub: "" },
  ]) assert.equal(oidcIdentity({ ...claims, ...overrides }, allowed), null);
  const individual = { ...env, OIDC_ALLOWED_EMAILS: " SAM@EXAMPLE.COM, other@example.net " };
  assert.deepEqual(oidcIdentity(claims, individual), { userId: "https://id.example:123", name: "Sam" });
  assert.equal(oidcIdentity({ ...claims, email: "other@example.com" }, individual), null);
});
test("Google requires the verified hosted-domain claim to match the admitted email domain", () => {
  const env = { OIDC_ISSUER: "https://accounts.google.com", OIDC_ALLOWED_DOMAINS: "example.com" };
  const claims = { sub: "123", email: "sam@example.com", email_verified: true };
  for (const hd of [undefined, "evil.example", "sub.example.com", "example.com.evil"])
    assert.equal(oidcIdentity({ ...claims, hd }, env), null);
  assert.equal(oidcIdentity({ ...claims, hd: "example.com" }, env)?.userId, "https://accounts.google.com:123");
  assert.equal(oidcIdentity({ ...claims, hd: "example.com", email_verified: false }, env), null);
});
