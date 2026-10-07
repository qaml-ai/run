import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { DEFAULT_PRICING, micros, pricingFromEnvironment } from "../src/pricing.ts";
import { Tenants } from "../src/tenants.ts";
import { StorageUsage } from "../src/storage-usage.ts";
import { VolumeService } from "../src/volumes.ts";
import { postgresTail } from "../src/log-tail.ts";
import { memoryStorage } from "../shared/storage.ts";
import { testDatabase } from "./database.ts";
import { runtime } from "./runtime-server.ts";

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

async function accountsOn() {
  const { db } = await testDatabase();
  const tenants = new Tenants({ read: async () => JSON.stringify(tenantsFile) });
  await tenants.reload();
  return { db, accounts: new Accounts({ tenants, db, pricing: DEFAULT_PRICING, publicUrl: "https://agents.example.test" }) };
}

test("storage limits: the plan's by credit, the operator's when set, none for unbilled tenants, and spent credit refuses writes", async () => {
  assert.deepEqual([DEFAULT_PRICING.free.maxStorageBytes, DEFAULT_PRICING.maxStorageBytes], [1e9, 100e9]);
  const configured = pricingFromEnvironment({ AGENT_FREE_MAX_STORAGE_GB: "0.25", AGENT_MAX_STORAGE_GB: "20" });
  assert.deepEqual([configured.free.maxStorageBytes, configured.maxStorageBytes], [0.25e9, 20e9]);
  assert.throws(() => pricingFromEnvironment({ AGENT_MAX_STORAGE_GB: "-1" }), /non-negative number of GB/);

  const { db, accounts } = await accountsOn();
  const billing = accounts.billing;
  // Unbilled: no limit unless the tenants file sets one, and never refused for credit.
  assert.equal(await billing.storageLimit("ops"), undefined);
  assert.equal(await billing.storageLimit("capped"), 0.5e9);
  // Prepaid with nothing in the account: refused, 402 INSUFFICIENT_CREDIT.
  await assert.rejects(billing.storageLimit("prepaid"), (error: any) => error.status === 402 && error.code === "INSUFFICIENT_CREDIT" && /cannot store more files/.test(error.message));
  await billing.post([{ tenant: "prepaid", kind: "grant", amount: micros(5), key: "grant:prepaid" }]);
  assert.equal(await billing.storageLimit("prepaid"), 1e9, "free credit: 1 GB");
  await billing.post([{ tenant: "prepaid", kind: "purchase", amount: micros(5), key: "purchase:prepaid" }]);
  assert.equal(await billing.storageLimit("prepaid"), 100e9, "bought credit: 100 GB");

  // A self-serve tenant: the operator's limit (tenants.limits) wins over its plan's.
  await db.query("insert into tenants (id, created_at, billing) values ('selfie', $1, 'prepaid')", [Date.now()]);
  await billing.post([{ tenant: "selfie", kind: "grant", amount: micros(5), key: "grant:selfie" }]);
  assert.equal(await billing.storageLimit("selfie"), 1e9);
  await db.query(`update tenants set limits = '{"maxStorageBytes": 5000000000}' where id = 'selfie'`);
  billing.forgetLimits("selfie");
  assert.equal(await billing.storageLimit("selfie"), 5e9);
  // A spent balance refuses whatever the limit.
  await billing.post([{ tenant: "selfie", kind: "adjustment", amount: -micros(6), key: "spent:selfie" }]);
  await assert.rejects(billing.storageLimit("selfie"), (error: any) => error.status === 402 && /balance -\$1\.00/.test(error.message));
});

test("a tenant's stored bytes come from the tracked totals: chunks, live agents' logs, live volumes, and this node's unwritten chunk bytes", async () => {
  const { db } = await testDatabase();
  const usage = new StorageUsage(db, { flushMs: 60_000 });
  await db.query(`insert into agents (id, tenant, header, revision, name, type, model) values
    ('client_${"a".repeat(40)}', 'acme', '{}', 1, 'a', 'general', 'm'), ('client_${"b".repeat(40)}', 'acme', '{}', 1, 'b', 'general', 'm'), ('client_${"c".repeat(40)}', 'other', '{}', 1, 'c', 'general', 'm')`);
  await db.query(`update agents set purged_at = 1 where id = 'client_${"b".repeat(40)}'`);
  await db.query(`insert into volumes (id, tenant, name, created_at) values ('vol_${"1".repeat(24)}', 'acme', 'v', 0), ('vol_${"2".repeat(24)}', 'acme', 'gone', 0)`);
  await db.query(`update volumes set deleted_at = 1 where id = 'vol_${"2".repeat(24)}'`);
  await db.query(`insert into storage_usage (kind, owner, bytes) values
    ('tenant', 'acme', 1000), ('tenant', 'other', 7), ('agent', 'client_${"a".repeat(40)}', 200), ('agent', 'client_${"b".repeat(40)}', 50000),
    ('agent', 'client_${"c".repeat(40)}', 9), ('volume', 'vol_${"1".repeat(24)}', 30), ('volume', 'vol_${"2".repeat(24)}', 40000)`);
  assert.equal(await usage.tenantUsed("acme"), 1230, "purged agents and deleted volumes do not count");
  usage.meter(`chunks/acme/${"f".repeat(64)}`, 500);
  assert.equal(await usage.tenantUsed("acme"), 1730, "chunks this node wrote count before they are flushed");
  assert.equal(await usage.tenantUsed("nobody"), 0);
  await usage.flush();
  assert.equal(await usage.tenantUsed("acme"), 1730, "and are not counted twice once flushed");
});

test("volume writes are refused past the tenant's limit (507 STORAGE_LIMIT with limit and used) and when the quota refuses", async t => {
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db, { unfenced: true }));
  let quota: { limit: number; used: number } | Error | undefined = { limit: 3000, used: 1000 };
  const volumes = new VolumeService({ db, storage, quota: async () => { if (quota instanceof Error) throw quota; return quota; } });
  t.after(() => volumes.close());
  const { id } = await volumes.create("acme", { name: "docs" });
  const saved = await volumes.put("acme", id, "/fits.bin", Buffer.alloc(2000, 1));
  assert.equal(saved.size, 2000, "up to the limit");
  const full = (error: any) => error.status === 507 && error.code === "STORAGE_LIMIT" && error.details.limit === 3000 && error.details.used === 1000 && /storage limit/.test(error.message);
  await assert.rejects(volumes.put("acme", id, "/over.bin", Buffer.alloc(2001, 2)), full);
  // A stream is cut off once it passes the limit, before it is all read.
  let read = 0;
  async function* stream() { for (let i = 0; i < 100; i++) { read++; yield Buffer.alloc(1000, 3); } }
  await assert.rejects(volumes.put("acme", id, "/stream.bin", stream()), full);
  assert.ok(read < 10, `stopped reading early (${read} pieces)`);
  quota = { limit: 3000, used: 3000 };
  await assert.rejects(volumes.put("acme", id, "/empty.txt", Buffer.alloc(0)), (error: any) => error.status === 507 && error.details.used === 3000, "nothing more at the limit");
  quota = Object.assign(new Error("out of credit"), { status: 402 });
  await assert.rejects(volumes.put("acme", id, "/any.txt", Buffer.from("x")), /out of credit/);
  quota = undefined;
  assert.equal((await volumes.put("acme", id, "/free.txt", Buffer.from("no limit"))).size, 8);
});

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
  assert.deepEqual(await busy(), { busy: 0, limit: 20, source: "tier", tier: "Free", paid: 0, next: { tier: "Tier 1", paid: 5_000_000, limit: 50 } });
  assert.equal((await call("/v1/tenants/lab-store/limits", { method: "PUT", body: { maxBusyAgents: 0 }, token: OPS })).status, 400);
  assert.deepEqual((await call("/v1/tenants/lab-store/limits", { method: "PUT", body: { maxBusyAgents: 40 }, token: OPS })).json, { tenant: "lab-store", limits: { maxBusyAgents: 40 } });
  assert.deepEqual((await call("/v1/tenants/lab-store/limits", { method: "PUT", body: { maxStorageGb: 2 }, token: OPS })).json, { tenant: "lab-store", limits: { maxStorageGb: 2, maxBusyAgents: 40 } });
  assert.deepEqual(await busy(), { busy: 0, limit: 40, source: "tenant" });
  assert.deepEqual((await call("/v1/tenants/lab-store/limits", { method: "PUT", body: { maxBusyAgents: null }, token: OPS })).json, { tenant: "lab-store", limits: { maxStorageGb: 2 } });
  assert.equal((await busy()).limit, 20, "back to its tier's");
});
