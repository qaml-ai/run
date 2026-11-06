import assert from "node:assert/strict";
import test from "node:test";
import { startFixture } from "./fixture.ts";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

test("admin read APIs reuse the source queries and require an explicitly allowed account", { timeout: 120_000 }, async t => {
  const tenant = "admin-platform-fixture";
  const token = "local-admin-fixture-token-with-32-characters";
  const ordinary = "local-ordinary-fixture-token-with-32-characters";
  const viewer = "admin@example.test", host = "admin.example.test", audience = "local-admin-fixture";
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "fixture", alg: "RS256" };
  const keys = createServer((request, response) => {
    assert.equal(request.url, "/cdn-cgi/access/certs");
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
  }).listen(0, "127.0.0.1");
  await once(keys, "listening");
  t.after(() => new Promise<void>(resolve => keys.close(() => resolve())));
  const issuer = `http://127.0.0.1:${(keys.address() as { port: number }).port}`;
  const access = (email: string) => new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);
  const assertion = await access(viewer);
  // src/admin-site.ts protects these reports with Access and an email allowlist.
  const f = await startFixture({ tenant, token, tenants: [{ id: tenant, token }, { id: "ordinary-account", token: ordinary }], vars: {
    AGENT_ADMIN_URL: `https://${host}/admin`, AGENT_ADMIN_ACCESS_TEAM: issuer,
    AGENT_ADMIN_ACCESS_AUD: audience, AGENT_ADMIN_EMAILS: viewer,
  } });
  t.after(() => f.stop());
  // Match Cloudflare's incoming Host header rather than fetch's target origin.
  const send = (path: string, headers: Record<string, string> = {}, method = "GET") => new Promise<Response>((resolve, reject) => {
    httpRequest(f.url + path, { method, headers: { host, "cf-access-jwt-assertion": assertion, ...headers } }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on("data", chunk => chunks.push(chunk)).on("end", () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode!, headers: incoming.headers as Record<string, string> })));
    }).on("error", reject).end();
  });
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await send(path, init.headers as Record<string, string>, init.method);
    const body = await response.json() as any;
    assert.equal(response.headers.get("cache-control"), "no-store", `${response.status}: ${JSON.stringify(body)}`);
    return { status: response.status, body };
  };
  const me = await request("/admin/api/me");
  assert.deepEqual(me, { status: 200, body: { viewer } });
  for (const tab of ["growth", "acquisition", "mcp", "usage", "revenue", "health", "stats", "product-signals", "activity-trend"]) {
    const result = await request(`/admin/api/${tab}?days=7`);
    assert.equal(result.status, 200, `${tab}: ${JSON.stringify(result.body)}`);
    if (tab === "usage") {
      assert.ok(!result.body.features.some((feature: any) => feature.key === "channel"));
      assert.ok(!result.body.integrations.some((feature: any) => ["voice", "discord", "email"].includes(feature.key)));
    }
    if (tab === "health") assert.ok(!result.body.checks.some((check: any) => ["channels", "nodes"].includes(check.key)));
    if (tab === "product-signals") assert.equal(result.body.activation_coverage.status, "unavailable");
  }
  const account = await request(`/admin/api/account?tenant=${tenant}`);
  assert.equal(account.status, 200);
  assert.equal(account.body.account.tenant, tenant);
  assert.equal("channels" in account.body, false);
  assert.equal((await request("/admin/api/account?tenant=unknown")).status, 404);
  assert.equal((await request("/admin/api/growth?days=0")).status, 400);
  assert.equal((await request("/admin/api/stats?days=1.5")).status, 400);
  assert.equal((await request("/admin/api/product-signals?start_date=2026-01-01")).status, 400);
  assert.equal((await request("/admin/api/me", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await request("/admin/api/report", { method: "POST" })).status, 404);
  const unlisted = await send("/admin/api/stats", { "cf-access-jwt-assertion": await access("ordinary@example.test") });
  assert.equal(unlisted.status, 403);
  // An unauthenticated caller gets no dashboard data through the public router.
  const denied = await send("/admin/api/stats", { "cf-access-jwt-assertion": "" });
  assert.equal(denied.status, 401);
  const bearer = await send("/admin/api/stats", { "cf-access-jwt-assertion": "", authorization: `Bearer ${ordinary}` });
  assert.equal(bearer.status, 401, "an account token does not bypass Access");
});
