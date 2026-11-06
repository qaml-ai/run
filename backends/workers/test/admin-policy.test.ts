import assert from "node:assert/strict";
import test from "node:test";
import { handleAdminRequest } from "../src/admin-api.ts";

const env = { HYPERDRIVE: { connectionString: "postgresql://invalid.invalid/test" } };
const auth = { tenantId: "administrator", kind: "operator" as const, scopes: ["*"] };
test("admin API is disabled by default and scoped keys cannot read it", async () => {
  const request = new Request("https://runtime.test/admin/api/me");
  assert.equal((await handleAdminRequest(request, env, auth))?.status, 403);
  assert.equal((await handleAdminRequest(request, { ...env, ADMIN_TENANTS: "other" }, auth))?.status, 403);
  assert.equal((await handleAdminRequest(request, { ...env, ADMIN_TENANTS: auth.tenantId }, { ...auth, scopes: ["agents:read"] }))?.status, 403);
  assert.equal((await handleAdminRequest(request, { ...env, ADMIN_TENANTS: auth.tenantId }, auth))?.status, 200);
});
test("admin path is bounded and does not shadow the public API", async () => {
  assert.equal(await handleAdminRequest(new Request("https://runtime.test/v1/models"), env, auth), null);
  assert.equal(await handleAdminRequest(new Request("https://runtime.test/admin-other/api/me"), env, auth), null);
  assert.equal((await handleAdminRequest(new Request("https://runtime.test/ops/api/me"), { ...env, ADMIN_SITE_PATH: "/ops", ADMIN_TENANTS: auth.tenantId }, auth))?.status, 200);
});
