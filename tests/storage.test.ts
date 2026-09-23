import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStorage, memoryStorage, PreconditionFailed, type Storage } from "../shared/storage.ts";
import { postgresLeases, storageLeases, type LeaseStore } from "../shared/leases.ts";

type Context = { after(fn: () => Promise<void> | void): void };
const backends: [string, (t: Context) => Promise<Storage>][] = [
  ["memory", async () => memoryStorage()],
  ["file", async t => { const root = await mkdtemp(join(tmpdir(), "storage-test-")); t.after(() => rm(root, { recursive: true, force: true })); return fileStorage(root); }],
  ["shared file", async t => { const root = await mkdtemp(join(tmpdir(), "storage-test-")); t.after(() => rm(root, { recursive: true, force: true })); return fileStorage(root, { shared: true }); }],
];
// Set AGENT_TEST_S3_BUCKET (and AWS credentials) to run the same contract against real S3.
if (process.env.AGENT_TEST_S3_BUCKET) {
  const { s3Storage } = await import("../shared/s3-storage.ts");
  backends.push(["s3", async () => s3Storage({ bucket: process.env.AGENT_TEST_S3_BUCKET!, region: process.env.AWS_REGION ?? "us-west-2", prefix: `tests/${randomUUID()}` })]);
}

for (const [name, open] of backends) {
  test(`${name} storage: documents are versioned and conditional writes fail on conflict`, async t => {
    const storage = await open(t);
    assert.equal(await storage.readJson("a/b"), undefined);
    const v1 = await storage.writeJson("a/b", { n: 1 }, null);
    await assert.rejects(storage.writeJson("a/b", { n: 2 }, null), PreconditionFailed);
    const v2 = await storage.writeJson("a/b", { n: 2 }, v1);
    await assert.rejects(storage.writeJson("a/b", { n: 3 }, v1), PreconditionFailed, "a stale version loses");
    assert.deepEqual(await storage.readJson("a/b"), { value: { n: 2 }, version: v2 });
    await storage.writeJson("a/c/d", { n: 4 });
    await storage.writeJson("a-other", { n: 5 });
    assert.deepEqual(await storage.listJson("a/"), ["a/b", "a/c/d"]);
    await storage.deleteJson("a/b");
    assert.deepEqual(await storage.listJson("a/"), ["a/c/d"]);
    await assert.rejects(storage.writeJson("../escape", {}), /Invalid storage key/);
  });

  test(`${name} storage: blobs are immutable: writing an existing key keeps the first bytes`, async t => {
    const storage = await open(t);
    assert.equal(await storage.readBlob("chunks/t/ab/abc"), undefined);
    await storage.writeBlob("chunks/t/ab/abc", new Uint8Array([1, 2, 3]));
    await storage.writeBlob("chunks/t/ab/abc", new Uint8Array([9]));
    assert.deepEqual([...await storage.readBlob("chunks/t/ab/abc") ?? []], [1, 2, 3]);
    await assert.rejects(storage.writeBlob("../escape", new Uint8Array()), /Invalid storage key/);
  });

  test(`${name} storage: logs append, fold into snapshots, and survive reopening`, async t => {
    const storage = await open(t);
    assert.equal(await storage.hasLog("agents/x/log"), false);
    const log = storage.log<{ n: number }>("agents/x/log");
    await log.read();
    log.append({ n: 1 }); log.append({ n: 2 });
    await log.flush(true);
    log.append({ n: 3 });
    await log.flush(true);
    assert.equal(await storage.hasLog("agents/x/log"), true);
    assert.deepEqual(await storage.log("agents/x/log").read(), [{ n: 1 }, { n: 2 }, { n: 3 }]);
    await log.rewrite(() => [{ n: 6 }]);
    log.append({ n: 7 });
    await log.flush(true);
    assert.deepEqual(await storage.log("agents/x/log").read(), [{ n: 6 }, { n: 7 }]);
    await log.close();
  });
}

test("a log writer that loses a segment race is fenced out for good", async () => {
  const storage = memoryStorage();
  const stale = storage.log<{ n: number }>("agents/y/log");
  const owner = storage.log<{ n: number }>("agents/y/log");
  await stale.read(); await owner.read();
  owner.append({ n: 1 });
  await owner.flush(true);
  stale.append({ n: 99 });
  await assert.rejects(stale.flush(true), PreconditionFailed);
  stale.append({ n: 100 });
  await assert.rejects(stale.flush(true), /another owner/);
  owner.append({ n: 2 });
  await owner.flush(true);
  assert.deepEqual(await storage.log("agents/y/log").read(), [{ n: 1 }, { n: 2 }]);
});

async function leaseContract(t: Context, leases: LeaseStore, advance: (ms: number) => Promise<void>) {
  const agent = `agent-${randomUUID()}`;
  const first = await leases.acquire(agent, "node-a", 1_000);
  assert.ok("lease" in first);
  assert.equal(first.lease.epoch, 1);
  const contested = await leases.acquire(agent, "node-b", 1_000);
  assert.ok("heldBy" in contested && contested.heldBy.owner === "node-a");
  const again = await leases.acquire(agent, "node-a", 1_000);
  assert.ok("lease" in again && again.lease.epoch === 1, "re-acquiring your own live lease keeps the epoch");
  assert.ok(await leases.renew(first.lease, 1_000));
  assert.equal((await leases.get(agent))?.live, true);
  await advance(4_000);
  assert.equal((await leases.get(agent))?.live, false);
  const takeover = await leases.acquire(agent, "node-b", 1_000);
  assert.ok("lease" in takeover && takeover.lease.epoch === 2 && takeover.lease.owner === "node-b");
  assert.equal(await leases.renew(first.lease, 1_000), undefined, "the old owner learns it lost the lease");
  await leases.release(first.lease);
  assert.equal((await leases.get(agent))?.owner, "node-b", "a stale release changes nothing");
  await leases.release(takeover.lease);
  const handoff = await leases.acquire(agent, "node-a", 1_000);
  assert.ok("lease" in handoff && handoff.lease.epoch === 3, "a released lease can be taken at once, with a new epoch");
}

test("storage leases: one owner at a time, takeover after expiry, stale owners detected", async t => {
  let clock = 1_000_000;
  await leaseContract(t, storageLeases(memoryStorage(), () => clock), async ms => { clock += ms; });
});

// Set AGENT_TEST_POSTGRES_URL to run the contract against Postgres (its own clock, so we wait).
test("postgres leases", { skip: !process.env.AGENT_TEST_POSTGRES_URL }, async t => {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.AGENT_TEST_POSTGRES_URL });
  const table = `leases_test_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  t.after(async () => { await pool.query(`drop table if exists ${table}`); await pool.end(); });
  await leaseContract(t, await postgresLeases(pool, table), ms => new Promise(resolve => setTimeout(resolve, ms / 2)));
});

test("shared file storage fences a stale log writer across instances", async t => {
  const root = await mkdtemp(join(tmpdir(), "storage-shared-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = fileStorage(root, { shared: true }), b = fileStorage(root, { shared: true });
  const stale = a.log<{ n: number }>("x/log"), owner = b.log<{ n: number }>("x/log");
  await stale.read(); await owner.read();
  owner.append({ n: 1 }); await owner.flush(true);
  stale.append({ n: 2 });
  await assert.rejects(stale.flush(true), PreconditionFailed);
  const results = await Promise.allSettled([a.writeJson("doc", { by: "a" }, null), b.writeJson("doc", { by: "b" }, null)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1, "exactly one conditional create wins");
  assert.ok(results.some(result => result.status === "rejected" && result.reason instanceof PreconditionFailed));
});

test("a single-host data directory copies into another backend, and copying again is harmless", async t => {
  const { copyStorage } = await import("../src/migrate-storage.ts");
  const root = await mkdtemp(join(tmpdir(), "agent-migrate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = fileStorage(root);
  await source.writeJson("tenants/alice/keys", { anthropic: "sealed" });
  const transcript = source.log<{ t: string; n: number }>("sessions/client_a/transcript");
  for (let n = 0; n < 3; n++) transcript.append({ t: "message", n });
  await transcript.flush(true);
  await source.writeBlob("chunks/alice/ab/abc", new Uint8Array([7, 8]));
  const target = memoryStorage();
  for (let run = 0; run < 2; run++) assert.deepEqual(await copyStorage(root, target), { documents: 1, logs: 1, records: 3, blobs: 1 });
  assert.deepEqual([...await target.readBlob("chunks/alice/ab/abc") ?? []], [7, 8]);
  assert.deepEqual((await target.readJson("tenants/alice/keys"))?.value, { anthropic: "sealed" });
  assert.deepEqual((await target.log("sessions/client_a/transcript").read()).map((record: any) => record.n), [0, 1, 2]);
});
