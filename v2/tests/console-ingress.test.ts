import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../ingress/index.ts";
import { openConsoleSession, sealConsoleSession } from "../ingress/console.ts";

const SECRET = "test-console-session-secret-0123456789abcdef";

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

test("authenticates via /console/auth/key, seals HttpOnly cookie, and proxies /console/v2/* to env.V2", async () => {
  const ASSETS = createAssetsStub({ "/index.html": { body: "<html></html>", type: "text/html" } });
  const apiKey = "cr_live_tnt_0123456789abcdef.a1b2c3_secretvalue";
  const seenCalls: { method: string; path: string; auth: string | null; cookie: string | null }[] = [];

  const env = {
    ASSETS,
    CONSOLE_SESSION_SECRET: SECRET,
    LEGACY_ECS_FALLBACK: "0",
    V2: {
      async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        seenCalls.push({
          method: request.method,
          path: url.pathname + url.search,
          auth: request.headers.get("authorization"),
          cookie: request.headers.get("cookie"),
        });
        if (request.headers.get("authorization") !== `Bearer ${apiKey}`) {
          return Response.json({ error: { code: "unauthorized", message: "Invalid API key" } }, { status: 401 });
        }
        if (url.pathname === "/v2/me") {
          return Response.json({ tenantId: "tnt_0123456789abcdef", name: "Acme", balanceUsd: 50, tier: "pro", busyAgents: { active: 0, limit: 25 } });
        }
        if (url.pathname === "/v2/agents") {
          return Response.json({ agents: [{ id: "agt_1", key: "demo" }] });
        }
        return Response.json({ ok: true });
      },
    },
  };

  // 1. Cross-origin POST without CSRF header is blocked
  const blocked = await worker.fetch(
    new Request("https://run.camelai.com/console/auth/key", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ apiKey }),
    }),
    env,
  );
  assert.equal(blocked.status, 403);

  // 2. Valid same-origin sign-in validates via /v2/me and sets encrypted HttpOnly cookie
  const signIn = await worker.fetch(
    new Request("https://run.camelai.com/console/auth/key", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://run.camelai.com",
        "X-Agent-Runtime-Console": "1",
      },
      body: JSON.stringify({ apiKey }),
    }),
    env,
  );
  assert.equal(signIn.status, 200);
  const setCookie = signIn.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /cr_console=v2\./);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /Path=\/console/);

  const cookiePair = setCookie.split(";")[0]!;
  const rawToken = cookiePair.slice("cr_console=".length);
  const opened = await openConsoleSession(rawToken, SECRET);
  assert.equal(opened?.apiKey, apiKey);

  // 3. Cookie-authenticated GET /console/v2/agents forwards Bearer token to env.V2 and strips Cookie
  const agentsRes = await worker.fetch(
    new Request("https://run.camelai.com/console/v2/agents", {
      headers: { Cookie: cookiePair },
    }),
    env,
  );
  assert.equal(agentsRes.status, 200);
  assert.deepEqual(await agentsRes.json(), { agents: [{ id: "agt_1", key: "demo" }] });
  assert.equal(seenCalls.at(-1)?.path, "/v2/agents");
  assert.equal(seenCalls.at(-1)?.auth, `Bearer ${apiKey}`);
  assert.equal(seenCalls.at(-1)?.cookie, null);

  // 4. Cookie-authenticated POST without console header is rejected (CSRF protection)
  const csrfBlocked = await worker.fetch(
    new Request("https://run.camelai.com/console/v2/tokens", {
      method: "POST",
      headers: { Cookie: cookiePair, Origin: "https://run.camelai.com" },
      body: JSON.stringify({ name: "test" }),
    }),
    env,
  );
  assert.equal(csrfBlocked.status, 403);

  // 5. Logout clears cookie
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
  const expired = await sealConsoleSession({ apiKey: "cr_live_tnt_1.a_b", exp: Date.now() - 1000 }, SECRET);
  assert.equal(await openConsoleSession(expired, SECRET), null);

  const valid = await sealConsoleSession({ apiKey: "cr_live_tnt_1.a_b", exp: Date.now() + 60_000 }, SECRET);
  assert.equal(await openConsoleSession(valid, "wrong-secret"), null);
});
