import assert from "node:assert/strict";
import test from "node:test";
import { startFixture } from "./fixture.ts";

test("admin read APIs reuse the source queries and require an explicitly allowed account", { timeout: 120_000 }, async t => {
  const tenant = "admin-platform-fixture";
  const token = "local-admin-fixture-token-with-32-characters";
  const ordinary = "local-ordinary-fixture-token-with-32-characters";
  const f = await startFixture({ tenant, token, tenants: [{ id: tenant, token }, { id: "ordinary-account", token: ordinary }], vars: { ADMIN_TENANTS: tenant } });
  t.after(() => f.stop());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(f.url + path, { ...init, headers: { authorization: `Bearer ${f.token}`, ...init.headers as Record<string, string> } });
    const body = await response.json() as any;
    assert.equal(response.headers.get("cache-control"), "no-store");
    return { status: response.status, body };
  };
  const me = await request("/admin/api/me");
  assert.deepEqual(me, { status: 200, body: { viewer: tenant } });
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
  const unlisted = await fetch(f.url + "/admin/api/stats", { headers: { authorization: `Bearer ${ordinary}` } });
  assert.equal(unlisted.status, 403);
  // An unauthenticated caller gets no dashboard data through the public router.
  const denied = await fetch(f.url + "/admin/api/stats");
  assert.equal(denied.status, 401);
});
