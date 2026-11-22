import assert from "node:assert/strict";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import worker from "../ingress/index.ts";
import { sealConsoleSession } from "../ingress/console.ts";

const SESSION_SECRET = "test-ops-session-secret-0123456789abcdef";
const ADMIN_SECRET = "test-ops-admin-secret-0123456789abcdef";

function createAssetsStub() {
  const files: Record<string, { body: string; type: string }> = {
    "/index.html": { body: "<!doctype html><html><head><title>console</title></head><body>console</body></html>", type: "text/html; charset=utf-8" },
    "/admin.html": { body: "<!doctype html><html><head><title>camelRun ops</title></head><body><div id=\"root\"></div></body></html>", type: "text/html; charset=utf-8" },
    "/ops-favicon.svg": { body: "<svg>ops</svg>", type: "image/svg+xml" },
  };
  return {
    async fetch(request: Request): Promise<Response> {
      const pathname = new URL(request.url).pathname;
      const hit = files[pathname];
      if (!hit) return new Response("Not Found", { status: 404 });
      return new Response(hit.body, { headers: { "Content-Type": hit.type } });
    },
  };
}

test("unauthenticated browser requests to /ops redirect to /console/?next=/ops/ and /ops/api/* returns 401", async () => {
  const env = {
    ASSETS: createAssetsStub(),
    CONSOLE_SESSION_SECRET: SESSION_SECRET,
    ADMIN_SECRET,
    LEGACY_ECS_FALLBACK: "0",
    V2: { fetch: async () => new Response("unexpected", { status: 500 }) },
  };

  const bare = await worker.fetch(new Request("https://run.camelai.com/ops"), env);
  assert.equal(bare.status, 302);
  assert.equal(bare.headers.get("location"), "/console/?next=%2Fops%2F");

  const deep = await worker.fetch(new Request("https://run.camelai.com/ops/?tab=health&days=7"), env);
  assert.equal(deep.status, 302);
  assert.equal(deep.headers.get("location"), "/console/?next=%2Fops%2F%3Ftab%3Dhealth%26days%3D7");

  const api = await worker.fetch(new Request("https://run.camelai.com/ops/api/health"), env);
  assert.equal(api.status, 401);
  assert.deepEqual(await api.json(), { error: "sign_in_required" });

  // Spoofed Cloudflare Access headers WITHOUT configured team/aud must be rejected
  const spoofed = await worker.fetch(
    new Request("https://run.camelai.com/ops/api/me", {
      headers: {
        "Cf-Access-Authenticated-User-Email": "ceo@camelai.com",
        "Cf-Access-Jwt-Assertion": "eyJhbGciOiJSUzI1NiJ9.eyJlbWFpbCI6ImNlb0BjYW1lbGFpLmNvbSJ9.fake",
      },
    }),
    env,
  );
  assert.equal(spoofed.status, 401);

  // Ops favicon is served publicly
  const icon = await worker.fetch(new Request("https://run.camelai.com/ops-favicon.svg"), env);
  assert.equal(icon.status, 200);
});

test("non-operator signed-in users and unverified password signups get 403 Forbidden", async () => {
  const env = {
    ASSETS: createAssetsStub(),
    CONSOLE_SESSION_SECRET: SESSION_SECRET,
    ADMIN_SECRET,
    LEGACY_ECS_FALLBACK: "0",
    V2: { fetch: async () => new Response("unexpected", { status: 500 }) },
  };

  // External Gmail user -> 403 HTML on /ops/, 403 JSON on /ops/api/*
  const outsiderToken = await sealConsoleSession(
    {
      tenantId: "tnt_outsider",
      apiKey: "cr_live_tnt_outsider.abc_secret",
      email: "user@gmail.com",
      login: "user@gmail.com",
      provider: "google",
      exp: Date.now() + 60_000,
    },
    SESSION_SECRET,
  );

  const htmlRes = await worker.fetch(
    new Request("https://run.camelai.com/ops/", { headers: { Cookie: `cr_console=${outsiderToken}` } }),
    env,
  );
  assert.equal(htmlRes.status, 403);
  assert.match(await htmlRes.text(), /403 Forbidden/);

  const apiRes = await worker.fetch(
    new Request("https://run.camelai.com/ops/api/growth", { headers: { Cookie: `cr_console=${outsiderToken}` } }),
    env,
  );
  assert.equal(apiRes.status, 403);
  assert.deepEqual(await apiRes.json(), { error: "admin_required" });

  // Unverified password signup claiming @camelai.com MUST STILL BE REJECTED (403)
  const passwordToken = await sealConsoleSession(
    {
      tenantId: "tnt_pw_spoof",
      apiKey: "cr_live_tnt_pw_spoof.abc_secret",
      email: "attacker@camelai.com",
      login: "attacker@camelai.com",
      provider: "password",
      exp: Date.now() + 60_000,
    },
    SESSION_SECRET,
  );
  const pwRes = await worker.fetch(
    new Request("https://run.camelai.com/ops/api/me", { headers: { Cookie: `cr_console=${passwordToken}` } }),
    env,
  );
  assert.equal(pwRes.status, 403);
});

test("allows @camelai.com / @qaml.ai OAuth, OPS_ALLOWED_EMAILS, OPS_ALLOWED_GITHUB, and enforces CSRF on mutations", async () => {
  const captured: Array<{ path: string; method: string; adminKey: string | null; viewer: string | null; cookie: string | null }> = [];
  const env = {
    ASSETS: createAssetsStub(),
    CONSOLE_SESSION_SECRET: SESSION_SECRET,
    ADMIN_SECRET,
    OPS_ALLOWED_EMAILS: "contractor@partner.org",
    OPS_ALLOWED_GITHUB: "MikeyS",
    LEGACY_ECS_FALLBACK: "0",
    V2: {
      async fetch(request: Request): Promise<Response> {
        const u = new URL(request.url);
        captured.push({
          path: u.pathname + u.search,
          method: request.method,
          adminKey: request.headers.get("x-admin-key"),
          viewer: request.headers.get("x-ops-viewer"),
          cookie: request.headers.get("cookie"),
        });
        return Response.json({ ok: true, viewer: request.headers.get("x-ops-viewer") });
      },
    },
  };

  const teamToken = await sealConsoleSession(
    {
      tenantId: "tnt_team",
      apiKey: "cr_live_tnt_team.abc_secret",
      email: "alex@camelai.com",
      login: "alex",
      provider: "google",
      exp: Date.now() + 60_000,
    },
    SESSION_SECRET,
  );

  // /ops redirects 308 -> /ops/ when authenticated
  const bare = await worker.fetch(
    new Request("https://run.camelai.com/ops?tab=usage", { headers: { Cookie: `cr_console=${teamToken}` } }),
    env,
  );
  assert.equal(bare.status, 308);
  assert.equal(bare.headers.get("location"), "/ops/?tab=usage");

  // /ops/ serves admin.html with injected <meta name="admin-base" content="/ops" />
  const spa = await worker.fetch(
    new Request("https://run.camelai.com/ops/", { headers: { Cookie: `cr_console=${teamToken}` } }),
    env,
  );
  assert.equal(spa.status, 200);
  const html = await spa.text();
  assert.match(html, /<meta name="admin-base" content="\/ops" \/>/);
  assert.equal(spa.headers.get("cache-control"), "no-store");
  assert.equal(spa.headers.get("x-frame-options"), "DENY");

  // /ops/api/growth proxies to /v2/admin/ops/growth with X-Admin-Key + X-Ops-Viewer, stripping Cookie
  const apiGet = await worker.fetch(
    new Request("https://run.camelai.com/ops/api/growth?days=7", { headers: { Cookie: `cr_console=${teamToken}` } }),
    env,
  );
  assert.equal(apiGet.status, 200);
  assert.deepEqual(captured.at(-1), {
    path: "/v2/admin/ops/growth?days=7",
    method: "GET",
    adminKey: ADMIN_SECRET,
    viewer: "alex@camelai.com",
    cookie: null,
  });

  // POST mutation without CSRF header is blocked (403)
  const blockedPost = await worker.fetch(
    new Request("https://run.camelai.com/ops/api/account/credits", {
      method: "POST",
      headers: { Cookie: `cr_console=${teamToken}`, "Content-Type": "application/json", Origin: "https://run.camelai.com" },
      body: JSON.stringify({ tenantId: "tnt_1", amountUsd: 10 }),
    }),
    env,
  );
  assert.equal(blockedPost.status, 403);

  // POST mutation WITH CSRF header & same-origin succeeds
  const okPost = await worker.fetch(
    new Request("https://run.camelai.com/ops/api/account/credits", {
      method: "POST",
      headers: {
        Cookie: `cr_console=${teamToken}`,
        "Content-Type": "application/json",
        Origin: "https://run.camelai.com",
        "X-Agent-Runtime-Console": "1",
      },
      body: JSON.stringify({ tenantId: "tnt_1", amountUsd: 10 }),
    }),
    env,
  );
  assert.equal(okPost.status, 200);

  // OPS_ALLOWED_GITHUB login (even without email) is allowed
  const ghToken = await sealConsoleSession(
    {
      tenantId: "tnt_gh",
      apiKey: "cr_live_tnt_gh.abc_secret",
      email: null,
      login: "mikeys",
      provider: "github",
      exp: Date.now() + 60_000,
    },
    SESSION_SECRET,
  );
  const ghRes = await worker.fetch(
    new Request("https://run.camelai.com/ops/api/me", { headers: { Cookie: `cr_console=${ghToken}` } }),
    env,
  );
  assert.equal(ghRes.status, 200);
  assert.equal(((await ghRes.json()) as { viewer: string }).viewer, "mikeys");

  // Direct X-Admin-Key works for API scripts (including POST without browser CSRF headers)
  const keyRes = await worker.fetch(
    new Request("https://run.camelai.com/ops/api/register-tenant", {
      method: "POST",
      headers: { "X-Admin-Key": ADMIN_SECRET, "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId: "tnt_prod" }),
    }),
    env,
  );
  assert.equal(keyRes.status, 200);
});

test("verifies Cloudflare Access RS256 JWT when AGENT_ADMIN_ACCESS_TEAM and AUD are configured", async (t) => {
  const team = "https://camelai-test.cloudflareaccess.com";
  const aud = "cf-access-aud-ops-123";
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "cf-kid-1";
  jwk.alg = "RS256";
  jwk.use = "sig";

  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${team}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [jwk] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const validJwt = await new SignJWT({ email: "ops@camelai.com" })
    .setProtectedHeader({ alg: "RS256", kid: "cf-kid-1" })
    .setIssuer(team)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  const env = {
    ASSETS: createAssetsStub(),
    ADMIN_SECRET,
    AGENT_ADMIN_ACCESS_TEAM: team,
    AGENT_ADMIN_ACCESS_AUD: aud,
    LEGACY_ECS_FALLBACK: "0",
    V2: {
      async fetch(request: Request): Promise<Response> {
        return Response.json({ viewer: request.headers.get("x-ops-viewer") });
      },
    },
  };

  const ok = await worker.fetch(
    new Request("https://run.camelai.com/ops/api/me", {
      headers: {
        "Cf-Access-Authenticated-User-Email": "ops@camelai.com",
        "Cf-Access-Jwt-Assertion": validJwt,
      },
    }),
    env,
  );
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { viewer: "ops@camelai.com" });

  // Mismatched email header -> 403
  const mismatch = await worker.fetch(
    new Request("https://run.camelai.com/ops/api/me", {
      headers: {
        "Cf-Access-Authenticated-User-Email": "someone-else@camelai.com",
        "Cf-Access-Jwt-Assertion": validJwt,
      },
    }),
    env,
  );
  assert.equal(mismatch.status, 403);
});

test("normalizes bare Cloudflare Access team slug and accepts CF_Authorization cookie fallback", async (t) => {
  const slug = "qaml-test";
  const issuerOrigin = `https://${slug}.cloudflareaccess.com`;
  const aud = "cf-access-aud-ops-slug";
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "cf-kid-slug";
  jwk.alg = "RS256";
  jwk.use = "sig";

  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${issuerOrigin}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [jwk] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const validJwt = await new SignJWT({ email: "miguel@camelai.com" })
    .setProtectedHeader({ alg: "RS256", kid: "cf-kid-slug" })
    .setIssuer(issuerOrigin)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  // Even when a user also carries a non-admin cr_console cookie, a verified CF Access JWT must allow /ops
  const outsiderConsoleCookie = await sealConsoleSession(
    {
      tenantId: "tnt_personal",
      apiKey: "cr_live_tnt_personal.abc_secret",
      email: "personal@example.com",
      login: "personal@example.com",
      provider: "google",
      exp: Date.now() + 60_000,
    },
    SESSION_SECRET,
  );

  for (const configuredTeam of [slug, `${slug}.cloudflareaccess.com`, issuerOrigin]) {
    const env = {
      ASSETS: createAssetsStub(),
      CONSOLE_SESSION_SECRET: SESSION_SECRET,
      ADMIN_SECRET,
      AGENT_ADMIN_ACCESS_TEAM: configuredTeam,
      AGENT_ADMIN_ACCESS_AUD: aud,
      V2: {
        async fetch(request: Request): Promise<Response> {
          return Response.json({ viewer: request.headers.get("x-ops-viewer") });
        },
      },
    };

    const pageRes = await worker.fetch(
      new Request("https://run.camelai.com/ops/", {
        headers: {
          "Cf-Access-Authenticated-User-Email": "miguel@camelai.com",
          "Cf-Access-Jwt-Assertion": validJwt,
          Cookie: `cr_console=${outsiderConsoleCookie}`,
        },
      }),
      env,
    );
    assert.equal(pageRes.status, 200, `expected 200 for team=${configuredTeam}`);
    assert.match(await pageRes.text(), /<meta name="admin-base" content="\/ops" \/>/);

    // CF_Authorization cookie fallback works when Cf-Access-Jwt-Assertion header is absent
    const cookieRes = await worker.fetch(
      new Request("https://run.camelai.com/ops/api/me", {
        headers: {
          Cookie: `CF_Authorization=${validJwt}; cr_console=${outsiderConsoleCookie}`,
        },
      }),
      env,
    );
    assert.equal(cookieRes.status, 200, `expected 200 via CF_Authorization for team=${configuredTeam}`);
    assert.deepEqual(await cookieRes.json(), { viewer: "miguel@camelai.com" });
  }
});

test("console OAuth next parameter accepts /ops/ and rejects external redirects", async () => {
  const env = {
    ASSETS: createAssetsStub(),
    CONSOLE_SESSION_SECRET: SESSION_SECRET,
    ADMIN_SECRET,
    GITHUB_CLIENT_ID: "gh_id",
    GITHUB_CLIENT_SECRET: "gh_sec",
    LEGACY_ECS_FALLBACK: "0",
    V2: { fetch: async () => new Response("ok") },
  };

  const startOps = await worker.fetch(
    new Request("https://run.camelai.com/console/auth/github?next=%2Fops%2F%3Ftab%3Dhealth"),
    env,
  );
  assert.equal(startOps.status, 302);
  const cookies = (startOps.headers as Headers & { getSetCookie: () => string[] }).getSetCookie();
  assert.ok(cookies.some((c) => c.startsWith("cr_oauth_next=")), "expected cr_oauth_next cookie for /ops/");

  const startEvil = await worker.fetch(
    new Request("https://run.camelai.com/console/auth/github?next=https%3A%2F%2Fevil.example"),
    env,
  );
  const evilCookies = (startEvil.headers as Headers & { getSetCookie: () => string[] }).getSetCookie();
  assert.ok(!evilCookies.some((c) => c.startsWith("cr_oauth_next=")), "external next must be ignored");
});
