import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { startFixture } from "./fixture.ts";

// Same identity/nonce/PKCE assertions as the sign-in coverage in tests/api.test.ts.
test("Workers Github and Google sign-ins preserve stable identities, state, nonce and PKCE", { timeout: 90_000 }, async t => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "fixture-key", alg: "RS256", use: "sig" };
  let issuer = "", googleNonce = "", googleChallenge = "", githubLogin = "new-user", badNonce = false;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const json = (body: unknown) => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    if (request.url === "/login/oauth/access_token") return void json({ access_token: "fixture-github-token" });
    if (request.url === "/user") return void json({ id: 49281, login: githubLogin, name: "Fixture", created_at: "2020-01-01T00:00:00Z" });
    if (request.url === "/.well-known/openid-configuration") return void json({ issuer, authorization_endpoint: issuer + "/authorize", token_endpoint: issuer + "/token", jwks_uri: issuer + "/keys" });
    if (request.url === "/keys") return void json({ keys: [jwk] });
    if (request.url === "/token") {
      const form = new URLSearchParams(raw);
      const verifier = form.get("code_verifier");
      assert.ok(verifier && createHash("sha256").update(verifier).digest("base64url") === googleChallenge, "token exchange supplies matching PKCE verifier");
      const id = await new SignJWT({ sub: "fixture-google-stable-sub", email: "google@example.test", email_verified: true, nonce: badNonce ? "wrong" : googleNonce, name: "Fixture Google" })
        .setProtectedHeader({ alg: "RS256", kid: "fixture-key" }).setIssuer(issuer).setAudience("fixture-google-client").setIssuedAt().setExpirationTime("5m").sign(privateKey);
      return void json({ id_token: id });
    }
    response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  issuer = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const f = await startFixture({ vars: {
    AGENT_PUBLIC_URL: "https://agents.example.test", AGENT_OPEN_SIGNUP: "true",
    GITHUB_CLIENT_ID: "fixture-github-client", GITHUB_CLIENT_SECRET: "fixture-github-secret", AGENT_SIGNUP_MIN_ACCOUNT_DAYS: "7",
    TEST_GITHUB_WEB_URL: issuer, TEST_GITHUB_API_URL: issuer,
    GOOGLE_CLIENT_ID: "fixture-google-client", GOOGLE_CLIENT_SECRET: "fixture-google-secret", TEST_GOOGLE_ISSUER: issuer,
  } });
  t.after(() => f.stop());
  const begin = async (provider: string) => {
    const response = await fetch(f.url + `/console/auth/${provider}`, { redirect: "manual" });
    assert.equal(response.status, 302);
    const authorization = new URL(response.headers.get("location")!);
    return { authorization, cookie: response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") };
  };
  const callback = (provider: string, state: string, cookie: string) => fetch(f.url + `/console/auth/${provider === "github" ? "callback" : "google/callback"}?${new URLSearchParams({ state, code: "fixture-code" })}`, { redirect: "manual", headers: { Cookie: cookie } });
  const identity = async (response: Response) => {
    const cookie = response.headers.getSetCookie().find(value => value.startsWith("ar_session="))?.split(";")[0];
    assert.ok(cookie, "successful callback establishes a console session");
    const me = await fetch(f.url + "/v1/me", { headers: { Cookie: cookie } });
    assert.equal(me.status, 200);
    return me.json() as Promise<{tenant: string; login: string; signIn: string}>;
  };
  await t.test("Github state is mandatory and numeric identity survives a renamed login", async () => {
    const flow = await begin("github");
    const bad = await callback("github", "wrong-state", flow.cookie);
    assert.ok(!bad.headers.getSetCookie().some(value => value.startsWith("ar_session=")));
    const good = await callback("github", flow.authorization.searchParams.get("state")!, flow.cookie);
    const first = await identity(good);
    assert.deepEqual([first.tenant, first.login, first.signIn], ["new-user", "new-user", "github"]);
    githubLogin = "renamed-user";
    const next = await begin("github");
    const renamed = await identity(await callback("github", next.authorization.searchParams.get("state")!, next.cookie));
    assert.deepEqual([renamed.tenant, renamed.login], [first.tenant, "renamed-user"]);
    assert.equal((await f.db.query("select count(*)::int n from tenants where github_id=49281")).rows[0].n, 1);
  });
  await t.test("Google binds ID-token nonce and PKCE, verifies its email and gives no automatic grant", async () => {
    const flow = await begin("google");
    googleNonce = flow.authorization.searchParams.get("nonce")!;
    googleChallenge = flow.authorization.searchParams.get("code_challenge")!;
    assert.equal(flow.authorization.searchParams.get("code_challenge_method"), "S256");
    badNonce = true;
    const bad = await callback("google", flow.authorization.searchParams.get("state")!, flow.cookie);
    assert.ok(!bad.headers.getSetCookie().some(value => value.startsWith("ar_session=")));
    badNonce = false;
    const again = await begin("google");
    googleNonce = again.authorization.searchParams.get("nonce")!;
    googleChallenge = again.authorization.searchParams.get("code_challenge")!;
    const who = await identity(await callback("google", again.authorization.searchParams.get("state")!, again.cookie));
    assert.equal(who.signIn, "google");
    assert.equal(who.login, "google@example.test");
    assert.match(who.tenant, /^u-[a-f0-9]{16}$/);
    assert.equal((await f.db.query("select count(*)::int n from credit_ledger where tenant=$1", [who.tenant])).rows[0].n, 0);
  });
});
