import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TenantStorage } from "../src/tenant-storage.ts";

function fixture(t: test.TestContext) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  let now = 1_000, alarm: number | null = null, lists = 0;
  const objects = new Map<string, number>();
  const storage = {
    sql: { exec(query: string, ...args: any[]) {
      const rows = db.prepare(query).all(...args);
      return { toArray: () => rows };
    } },
    transactionSync<T>(write: () => T): T {
      db.exec("BEGIN");
      try { const result = write(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    async setAlarm(at: number) { alarm = at; },
  } as unknown as DurableObjectStorage;
  const bucket = { async list({ prefix, cursor }: { prefix: string; cursor?: string }) {
    lists++;
    const matching = [...objects].filter(([key]) => key.startsWith(prefix));
    const offset = Number(cursor ?? 0), page = matching.slice(offset, offset + 2);
    return { objects: page.map(([key, size]) => ({ key, size })), truncated: offset + 2 < matching.length, cursor: String(offset + 2) };
  } } as unknown as R2Bucket;
  const meter = () => new TenantStorage(storage, bucket, () => now);
  const key = (id: string) => `files/lab/${id}`;
  return { objects, meter, key, bucket, storage, lists: () => lists, alarm: () => alarm, advance: (ms: number) => { now += ms; } };
}

test("native usage bootstraps once and counts writes, retained versions and deletes without listing per upload", async t => {
  const f = fixture(t);
  f.objects.set(f.key("old"), 10);
  f.objects.set(f.key("second"), 20);
  f.objects.set(f.key("third"), 30);
  f.objects.set("files/other/private", 999);
  let usage = f.meter();
  assert.equal(await usage.used("lab"), 60);
  assert.equal(f.lists(), 2, "bootstrap follows every R2 page");
  for (let i = 0; i < 100; i++) {
    f.objects.set(f.key(`version-${i}`), 2);
    await usage.record("lab", f.key(`version-${i}`), 2);
    await usage.record("lab", f.key(`version-${i}`), 2);
    assert.equal(await usage.used("lab"), 62 + 2 * i);
  }
  assert.equal(f.lists(), 2, "quota reads and uploads use the durable total");
  usage = f.meter();
  assert.equal(await usage.used("lab"), 260, "a restart preserves the total");
  f.objects.delete(f.key("old"));
  await usage.deleted("lab", f.key("old"));
  await usage.deleted("lab", f.key("old"));
  assert.equal(await usage.used("lab"), 250, "GC releases bytes once, not on logical removal");
  await assert.rejects(usage.record("lab", "files/other/private", 999), /Invalid native storage/);
  assert.equal(await usage.used("lab"), 250);
});

test("daily reconciliation repairs missed writes and deletes even without another upload", async t => {
  const f = fixture(t), usage = f.meter();
  f.objects.set(f.key("deleted"), 40);
  assert.equal(await usage.used("lab"), 40);
  assert.equal(f.alarm(), 1_000 + TenantStorage.reconcileMs);
  f.objects.delete(f.key("deleted"));
  f.objects.set(f.key("missed"), 70);
  assert.equal(await usage.used("lab"), 40, "the hot path reads the counter");
  f.advance(TenantStorage.reconcileMs);
  assert.equal(await usage.used("lab"), 40, "an overdue repair does not scan on the upload path");
  assert.equal(f.lists(), 1);
  await usage.alarm();
  assert.equal(await usage.used("lab"), 70);
  assert.equal(f.alarm(), 1_000 + 2 * TenantStorage.reconcileMs);
  assert.equal(f.lists(), 2);
});

test("a write completing during reconciliation is not lost or counted twice", async t => {
  const f = fixture(t);
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  f.bucket.list = (async () => {
    await gate;
    return { objects: [{ key: f.key("included"), size: 10 }], truncated: false };
  }) as R2Bucket["list"];
  const usage = f.meter();
  const listing = usage.used("lab");
  const included = usage.record("lab", f.key("included"), 10);
  const missed = usage.record("lab", f.key("missed"), 20);
  resume();
  assert.equal(await listing, 10);
  await Promise.all([included, missed]);
  assert.equal(await usage.used("lab"), 30);
});
