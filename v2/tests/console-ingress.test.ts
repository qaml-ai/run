import assert from "node:assert/strict";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker from "../ingress/index.ts";
import { openConsoleSession, sealConsoleSession } from "../ingress/console.ts";

const SESSION_SECRET = "test-console-session-secret-0123456789abcdef";
const ADMIN_SECRET = "test-admin-secret-0123456789abcdef";

function createAssetsStub(files: Record<string, { body: string; type: string }>) {
  return {
    async fetch(request: Request): Promise<Response> {
      const pathname = new URL(request.url).pathname;
      const hit = files[pathname];
      if (!hit) return new Response("Not Found", { status: 404 });
      return new Response(hit.body, { headers: { "Content-Type": hit.type } });
    },
  };
}

function getSetCookies(res: Response): string[] {
  const hdrs = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof hdrs.getSetCookie === "function") return hdrs.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

function cookiePair(cookies: string[], name: string): string {
  const match = cookies.find(c => c.startsWith(`${name}=`));
  assert.ok(match, `expected Set-Cookie for ${name}`);
  return match.split(";")[0]!;
}

test("redirects / and /console to /console/ while preserving query strings", async () => {
  const ASSETS = createAssetsStub({ "/index.html": { body: "<html>console</html>", type: "text/html" } });
  const env = { ASSETS, V2: { fetch: async () => new Response("ok") }, LEGACY_ECS_FALLBACK: "0" };

  const root = await worker.fetch(new Request("https://run.camelai.com/?start=code"), env);
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/console/?start=code");

  const bare = await worker.fetch(new Request("https://run.camelai.com/console"), env);
  assert.equal(bare.status, 302);
  assert.equal(bare.headers.get("location"), "/console/");
});

test("serves SPA index.html for console routes and immutable static assets for /console/assets/*", async () => {
  const ASSETS = createAssetsStub({
    "/index.html": { body: "<!doctype html><html><body>console</body></html>", type: "text/html; charset=utf-8" },
    "/assets/main-abc.js": { body: "console.log('hi')", type: "application/javascript" },
    "/favicon.svg": { body: "<svg/>", type: "image/svg+xml" },
  });
  const env = { ASSETS, V2: { fetch: async () => new Response("ok") }, LEGACY_ECS_FALLBACK: "0" };

  const spa = await worker.fetch(new Request("https://run.camelai.com/console/agents/agt_123"), env);
  assert.equal(spa.status, 200);
  assert.match(await spa.text(), /console/);
  assert.equal(spa.headers.get("cache-control"), "no-cache");
  assert.match(spa.headers.get("content-security-policy") ?? "", /default-src 'self'/);

  const asset = await worker.fetch(new Request("https://run.camelai.com/console/assets/main-abc.js"), env);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");

  const missingAsset = await worker.fetch(new Request("https://run.camelai.com/console/assets/missing.js"), env);
  assert.equal(missingAsset.status, 404);

  const favicon = await worker.fetch(new Request("https://run.camelai.com/favicon.svg"), env);
  assert.equal(favicon.status, 200);
});

test("advertises configured auth methods without API key sign-in", async () => {
  const ASSETS = createAssetsStub({ "/index.html": { body: "<html></html>", type: "text/html" } });
  const env = {
    ASSETS,
    CONSOLE_SESSION_SECRET: SESSION_SECRET,
    ADMIN_SECRET,
    GITHUB_CLIENT_ID: "gh_id",
    GITHUB_CLIENT_SECRET: "gh_sec",
    GOOGLE_CLIENT_ID: "goog_id",
    GOOGLE_CLIENT_SECRET: "goog_sec",
    LEGACY_ECS_FALLBACK: "0",
    V2: { fetch: async () => new Response("ok") },
  };

  const res = await worker.fetch(new Request("https://run.camelai.com/console/auth/methods"), env);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    github: true,
    google: true,
    password: true,
    signup: true,
    open: true,
  });
});

test("completes GitHub OAuth flow, seals HttpOnly cookie, and augments /console/v2/me", async t => {
  const ASSETS = createAssetsStub({ "/index.html": { body: "<html></html>", type: "text/html" } });
  const apiKey = "cr_live_tnt_0123456789abcdef.a1b2c3_secretvalue";

  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/login/oauth/access_token")) {
      return Response.json({ access_token: "gho_test_token" });
    }
    if (url.endsWith("/user")) {
      return Response.json({ id: 4242, login: "octocat", name: "The Octocat" });
    }
    if (url.endsWith("/user/emails")) {
      return Response.json([{ email: "octocat@github.com", primary: true, verified: true }]);
    }
    throw new Error(`Unexpected external fetch: ${url}`);
  });

  const v2Calls: { path: string; adminKey: string | null; auth: string | null; body?: unknown }[] = [];
  const env = {
    ASSETS,
    CONSOLE_SESSION_SECRET: SESSION_SECRET,
    ADMIN_SECRET,
    GITHUB_CLIENT_ID: "gh_client_id",
    GITHUB_CLIENT_SECRET: "gh_client_secret",
    LEGACY_ECS_FALLBACK: "0",
    V2: {
      async fetch(request: Request): Promise<Response> {
        const u = new URL(request.url);
        const body = request.method === "POST" ? await request.json() : undefined;
        v2Calls.push({
          path: u.pathname,
          adminKey: request.headers.get("x-admin-key"),
          auth: request.headers.get("authorization"),
          body,
        });
        if (u.pathname === "/v2/admin/console/oauth-login") {
          assert.equal(request.headers.get("x-admin-key"), ADMIN_SECRET);
          return Response.json({
            tenantId: "tnt_0123456789abcdef",
            apiKey,
            email: "octocat@github.com",
            login: "octocat",
            name: "The Octocat",
            created: true,
          });
        }
        if (u.pathname === "/v2/me") {
          assert.equal(request.headers.get("authorization"), `Bearer ${apiKey}`);
          assert.equal(request.headers.get("cookie"), null);
          return Response.json({
            tenantId: "tnt_0123456789abcdef",
            tenant: "tnt_0123456789abcdef",
            name: "The Octocat",
            balanceUsd: 25,
            tier: "pro",
            busyAgents: { active: 0, limit: 25 },
          });
        }
        return Response.json({ ok: true });
      },
    },
  };

  // 1. Start GitHub OAuth with ?ref= and ?from=
  const start = await worker.fetch(new Request("https://run.camelai.com/console/auth/github?ref=run-slack&from=www.example.org"), env);
  assert.equal(start.status, 302);
  const authLocation = new URL(start.headers.get("location")!);
  assert.equal(authLocation.origin, "https://github.com");
  assert.equal(authLocation.pathname, "/login/oauth/authorize");
  assert.equal(authLocation.searchParams.get("redirect_uri"), "https://run.camelai.com/console/auth/callback");
  const state = authLocation.searchParams.get("state")!;
  assert.ok(state.length > 10);
  const startCookies = getSetCookies(start);
  const stateCookie = cookiePair(startCookies, "cr_oauth_state");
  const sourceCookie = cookiePair(startCookies, "cr_oauth_source");

  // 2. Callback exchanges code, forwards signupSource, and mints encrypted session cookie
  const cb = await worker.fetch(
    new Request(`https://run.camelai.com/console/auth/callback?code=gh_code_1&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: `${stateCookie}; ${sourceCookie}` },
    }),
    env,
  );
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get("location"), "/console/");
  const oauthCall = v2Calls.find((c) => c.path === "/v2/admin/console/oauth-login");
  assert.deepEqual((oauthCall?.body as Record<string, unknown>)?.signupSource, {
    ref: "run-slack",
    referrer: "example.org",
  });
  const sessionCookie = cookiePair(getSetCookies(cb), "cr_console");

  const opened = await openConsoleSession(sessionCookie.slice("cr_console=".length), SESSION_SECRET);
  assert.equal(opened?.apiKey, apiKey);
  assert.equal(opened?.provider, "github");
  assert.equal(opened?.email, "octocat@github.com");

  // 3. /console/v2/me injects Bearer token and augments with signed-in user info
  const meRes = await worker.fetch(
    new Request("https://run.camelai.com/console/v2/me", { headers: { Cookie: sessionCookie } }),
    env,
  );
  assert.equal(meRes.status, 200);
  const meJson = (await meRes.json()) as Record<string, unknown>;
  assert.equal(meJson.email, "octocat@github.com");
  assert.equal(meJson.login, "octocat");
  assert.equal(meJson.signIn, "github");
});

test("completes Google OIDC PKCE + nonce + RS256 JWKS verification flow", async t => {
  const ASSETS = createAssetsStub({ "/index.html": { body: "<html></html>", type: "text/html" } });
  const apiKey = "cr_live_tnt_abcdef0123456789.x1y2z3_secretvalue";
  const issuer = "https://google-oidc.test";
  const clientId = "google-client-123.apps.googleusercontent.com";

  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-kid-1";
  jwk.alg = "RS256";
  jwk.use = "sig";

  let capturedNonce = "";
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return Response.json({
        authorization_endpoint: `${issuer}/auth`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
    }
    if (url === `${issuer}/token`) {
      const idToken = await new SignJWT({
        sub: "google-sub-999",
        email: "founder@gmail.com",
        email_verified: true,
        name: "Founder",
        nonce: capturedNonce,
        azp: clientId,
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-kid-1" })
        .setIssuer(issuer)
        .setAudience(clientId)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return Response.json({ id_token: idToken });
    }
    if (url === `${issuer}/jwks`) {
      return Response.json({ keys: [jwk] });
    }
    throw new Error(`Unexpected external fetch: ${url}`);
  });

  const env = {
    ASSETS,
    CONSOLE_SESSION_SECRET: SESSION_SECRET,
    ADMIN_SECRET,
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: "google_secret",
    GOOGLE_ISSUER: issuer,
    LEGACY_ECS_FALLBACK: "0",
    V2: {
      async fetch(request: Request): Promise<Response> {
        const u = new URL(request.url);
        if (u.pathname === "/v2/admin/console/oauth-login") {
          const body = (await request.json()) as Record<string, unknown>;
          assert.equal(body.provider, "google");
          assert.equal(body.externalId, "google-sub-999");
          assert.equal(body.email, "founder@gmail.com");
          return Response.json({
            tenantId: "tnt_abcdef0123456789",
            apiKey,
            email: "founder@gmail.com",
            login: "founder@gmail.com",
            name: "Founder",
            created: false,
          });
        }
        return Response.json({ ok: true });
      },
    },
  };

  // 1. Start Google OIDC
  const start = await worker.fetch(new Request("https://run.camelai.com/console/auth/google"), env);
  assert.equal(start.status, 302);
  const authLoc = new URL(start.headers.get("location")!);
  assert.equal(authLoc.origin, issuer);
  assert.equal(authLoc.searchParams.get("redirect_uri"), "https://run.camelai.com/console/auth/google/callback");
  assert.equal(authLoc.searchParams.get("code_challenge_method"), "S256");
  const state = authLoc.searchParams.get("state")!;
  capturedNonce = authLoc.searchParams.get("nonce")!;
  const gCookie = cookiePair(getSetCookies(start), "cr_google_oauth");

  // 2. Callback verifies JWT signature + nonce + email_verified and issues session cookie
  const cb = await worker.fetch(
    new Request(`https://run.camelai.com/console/auth/google/callback?code=goog_code&state=${encodeURIComponent(state)}`, {
      headers: { Cookie: gCookie },
    }),
    env,
  );
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get("location"), "/console/");
  const sessionCookie = cookiePair(getSetCookies(cb), "cr_console");
  const opened = await openConsoleSession(sessionCookie.slice("cr_console=".length), SESSION_SECRET);
  assert.equal(opened?.apiKey, apiKey);
  assert.equal(opened?.provider, "google");
  assert.equal(opened?.email, "founder@gmail.com");
});

test("supports email/password signup, login, CSRF enforcement, and logout", async () => {
  const ASSETS = createAssetsStub({ "/index.html": { body: "<html></html>", type: "text/html" } });
  const apiKey = "cr_live_tnt_1111222233334444.aa_secret";

  const env = {
    ASSETS,
    CONSOLE_SESSION_SECRET: SESSION_SECRET,
    ADMIN_SECRET,
    LEGACY_ECS_FALLBACK: "0",
    V2: {
      async fetch(request: Request): Promise<Response> {
        const u = new URL(request.url);
        const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string };
        if (u.pathname === "/v2/admin/console/password-signup") {
          return Response.json(
            { tenantId: "tnt_1111222233334444", apiKey, email: body.email, login: body.email, name: "Ada", created: true },
            { status: 201 },
          );
        }
        if (u.pathname === "/v2/admin/console/password-login") {
          if (body.password !== "correct-pass") {
            return Response.json({ error: { code: "unauthorized", message: "Wrong email or password" } }, { status: 401 });
          }
          return Response.json({ tenantId: "tnt_1111222233334444", apiKey, email: body.email, login: body.email, name: "Ada" });
        }
        return Response.json({ ok: true });
      },
    },
  };

  // Cross-origin CSRF blocked
  const blocked = await worker.fetch(
    new Request("https://run.camelai.com/console/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ email: "ada@example.com", password: "correct-pass" }),
    }),
    env,
  );
  assert.equal(blocked.status, 403);

  // Signup sets cookie
  const signup = await worker.fetch(
    new Request("https://run.camelai.com/console/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://run.camelai.com", "X-Agent-Runtime-Console": "1" },
      body: JSON.stringify({ email: "ada@example.com", password: "correct-pass", name: "Ada" }),
    }),
    env,
  );
  assert.equal(signup.status, 201);
  const signupCookie = cookiePair(getSetCookies(signup), "cr_console");
  assert.equal((await openConsoleSession(signupCookie.slice("cr_console=".length), SESSION_SECRET))?.provider, "password");

  // Wrong password -> 401
  const badLogin = await worker.fetch(
    new Request("https://run.camelai.com/console/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://run.camelai.com", "X-Agent-Runtime-Console": "1" },
      body: JSON.stringify({ email: "ada@example.com", password: "wrong" }),
    }),
    env,
  );
  assert.equal(badLogin.status, 401);

  // Logout clears cookie
  const logout = await worker.fetch(
    new Request("https://run.camelai.com/console/auth/logout", {
      method: "POST",
      headers: { Origin: "https://run.camelai.com", "X-Agent-Runtime-Console": "1" },
      body: "{}",
    }),
    env,
  );
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
});

test("rejects expired or tampered console session cookies", async () => {
  const expired = await sealConsoleSession({ apiKey: "cr_live_tnt_1.a_b", exp: Date.now() - 1000 }, SESSION_SECRET);
  assert.equal(await openConsoleSession(expired, SESSION_SECRET), null);

  const valid = await sealConsoleSession({ apiKey: "cr_live_tnt_1.a_b", exp: Date.now() + 60_000 }, SESSION_SECRET);
  assert.equal(await openConsoleSession(valid, "wrong-secret"), null);
});
