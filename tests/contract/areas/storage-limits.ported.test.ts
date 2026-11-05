import {portedTest} from "../ported.ts";
const test = portedTest("quotas", "tests/storage-limits.test.ts");
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {runtime} from "../support.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const OPS = "ops-operator-token-at-least-24-chars";

const tenantsFile = {
  tenants: {
    ops: { tokenSha256: sha(OPS), apiKeys: {} },
    capped: { tokenSha256: sha("capped-operator-token-at-least-24"), apiKeys: {}, maxStorageGb: 0.5 },
    prepaid: { tokenSha256: sha("prepaid-operator-token-at-least-24"), apiKeys: {}, billing: "prepaid" },
  },
  platformKeys: { openrouter: "fixture-platform-key" },
};

test("over the API: uploads need credit, stop at the free limit with STORAGE_LIMIT, and the operator can raise a tenant's limit", { timeout: 120_000 }, async t => {
  const { call } = await runtime(t, () => ({ role: "assistant", content: "ok" }),
    { AGENT_BILLING_ADMINS: "ops", AGENT_FREE_MAX_STORAGE_GB: "0.000003" }, tenantsFile);
  const created = await call("/v1/tenants", { body: { id: "lab-store" }, token: OPS });
  assert.equal(created.status, 201, created.text);
  const token = created.json.token.token;
  const volume = (await call("/v1/volumes", { body: { name: "files" }, token })).json;
  const upload = (path: string, size: number) => call(`/v1/volumes/${volume.id}/files/${path}`, { method: "PUT", body: path[0].repeat(size - 2), token });

  // No credit yet: refused before anything is stored.
  const broke = await upload("a.txt", 1000);
  assert.equal(broke.status, 402, broke.text);
  assert.equal(broke.json.code, "INSUFFICIENT_CREDIT");
  assert.match(broke.json.error, /out of credit .* cannot store more files/);

  assert.equal((await call("/v1/billing/adjustments", { body: { tenant: "lab-store", amount: 1_000_000, reason: "test", idempotencyKey: "store:1" }, token: OPS })).status, 201);
  assert.equal((await upload("a.txt", 2000)).status, 201);
  const over = await upload("b.txt", 2000);
  assert.equal(over.status, 507, over.text);
  assert.equal(over.json.code, "STORAGE_LIMIT");
  assert.equal(over.json.limit, 3000);
  assert.ok(over.json.used >= 2000, `used counts the first file (${over.json.used})`);

  // Only the platform operator sets limits, only for self-serve tenants, and null returns to the plan's.
  assert.equal((await call("/v1/tenants/lab-store/limits", { method: "PUT", body: { maxStorageGb: 1 }, token })).status, 403);
  assert.equal((await call("/v1/tenants/ops/limits", { method: "PUT", body: { maxStorageGb: 1 }, token: OPS })).status, 409);
  assert.equal((await call("/v1/tenants/nobody/limits", { method: "PUT", body: { maxStorageGb: 1 }, token: OPS })).status, 404);
  const raised = await call("/v1/tenants/lab-store/limits", { method: "PUT", body: { maxStorageGb: 0.00001 }, token: OPS });
  assert.equal(raised.status, 200, raised.text);
  assert.deepEqual(raised.json, { tenant: "lab-store", limits: { maxStorageGb: 0.00001 } });
  assert.equal((await upload("b.txt", 2000)).status, 201, "the raised limit applies at once on the node that set it");
  const reset = await call("/v1/tenants/lab-store/limits", { method: "PUT", body: { maxStorageGb: null }, token: OPS });
  assert.deepEqual(reset.json, { tenant: "lab-store", limits: {} });
  assert.equal((await upload("c.txt", 100)).status, 507, "back to the plan's limit");

  // An unbilled admin tenant (like chiridion-prod) has no limit and no balance: its writes are never refused.
  const own = (await call("/v1/volumes", { body: { name: "admin" }, token: OPS })).json;
  for (const [index, size] of [6000, 9000].entries()) {
    const written = await call(`/v1/volumes/${own.id}/files/admin-${index}.bin`, { method: "PUT", body: String(index).repeat(size), token: OPS });
    assert.equal(written.status, 201, written.text);
  }

  // Its busy-agent limit too, in place of its usage tier's; each limit is set or removed without touching the other.
  const busy = async () => (await call("/v1/billing", { token })).json.busyAgents;
  assert.deepEqual(await busy(), { busy: 0, limit: 50, source: "tier", tier: "Free", paid: 0, next: { tier: "Tier 1", paid: 5_000_000, limit: 250 } });
  assert.equal((await call("/v1/tenants/lab-store/limits", { method: "PUT", body: { maxBusyAgents: 0 }, token: OPS })).status, 400);
  assert.deepEqual((await call("/v1/tenants/lab-store/limits", { method: "PUT", body: { maxBusyAgents: 40 }, token: OPS })).json, { tenant: "lab-store", limits: { maxBusyAgents: 40 } });
  assert.deepEqual((await call("/v1/tenants/lab-store/limits", { method: "PUT", body: { maxStorageGb: 2 }, token: OPS })).json, { tenant: "lab-store", limits: { maxStorageGb: 2, maxBusyAgents: 40 } });
  assert.deepEqual(await busy(), { busy: 0, limit: 40, source: "tenant" });
  assert.deepEqual((await call("/v1/tenants/lab-store/limits", { method: "PUT", body: { maxBusyAgents: null }, token: OPS })).json, { tenant: "lab-store", limits: { maxStorageGb: 2 } });
  assert.equal((await busy()).limit, 50, "back to its tier's");
});
