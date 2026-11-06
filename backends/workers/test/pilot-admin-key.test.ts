import assert from "node:assert/strict";
import test from "node:test";
// The operator entry point is plain Node JavaScript; importing never runs its CLI.
// @ts-ignore JavaScript operator helper has no declaration file.
import { setupPilotAdmin } from "../scripts/pilot-admin-key.mjs";

test("pilot admin credit failure revokes only the new key and leaves a retryable tenant", async () => {
  const calls: string[] = [];
  const key = { id: "00000000-0000-0000-0000-000000000001", token: "unused-test-placeholder" };
  const operator = { async request(path: string, init: { method?: string } = {}) {
    calls.push(`${init.method ?? "POST"} ${path}`);
    if (path.startsWith("/pilot/inspect")) return { tenants: 0, deleted_tenants: 0, deleting_tenants: 0 };
    if (path === "/v1/tenants") return { tenant: "pilot-admin", token: key };
    if (path === "/v1/billing/adjustments") throw new Error("simulated grant failure");
    return { revoked: true };
  } };
  await assert.rejects(setupPilotAdmin(operator), /new key was revoked/);
  assert.ok(calls.includes(`DELETE /v1/tenants/pilot-admin/tokens/${key.id}`));
  assert.ok(!calls.includes("DELETE /v1/tenants/pilot-admin"));
});

test("pilot admin retry mints through the existing tenant's bounded token path", async () => {
  const calls: string[] = [];
  const operator = { async request(path: string) {
    calls.push(path);
    if (path.startsWith("/pilot/inspect")) return { tenants: 1, deleted_tenants: 0, deleting_tenants: 0 };
    if (path.endsWith("/tokens")) return { id: "00000000-0000-0000-0000-000000000002", token: "unused-test-placeholder" };
    return {};
  } };
  assert.equal((await setupPilotAdmin(operator)).tenant, "pilot-admin");
  assert.ok(calls.includes("/v1/tenants/pilot-admin/tokens"));
  assert.ok(!calls.includes("/v1/tenants"));
});

test("pilot admin never retries a permanently deleted tenant identifier", async () => {
  let calls = 0;
  await assert.rejects(setupPilotAdmin({ async request() { calls++; return { tenants: 0, deleted_tenants: 1 }; } }), /cannot be reused/);
  assert.equal(calls, 1);
});
