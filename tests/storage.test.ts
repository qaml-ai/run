import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStorage, memoryStorage, type Storage, type StorageMeter } from "../shared/storage.ts";
import { storageOwner } from "../src/storage-usage.ts";
import { postgresTail } from "../src/log-tail.ts";
import { testDatabase } from "./database.ts";

type Context = { after(fn: () => Promise<void> | void): void };
const temporary = async (t: Context) => { const root = await mkdtemp(join(tmpdir(), "storage-test-")); t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })); return root; };
const tail = async () => postgresTail((await testDatabase()).db, { unfenced: true });
const backends: [string, (t: Context, meter?: StorageMeter) => Promise<Storage>][] = [
  ["memory", async (_t, meter) => memoryStorage(await tail(), meter)],
  ["file", async (t, meter) => fileStorage(await temporary(t), { meter })],
  ["shared file", async (t, meter) => fileStorage(await temporary(t), { tail: await tail(), meter })],
];
// Set AGENT_TEST_S3_BUCKET (and AWS credentials) to run the same contract against real S3.
if (process.env.AGENT_TEST_S3_BUCKET) {
  const { s3Storage } = await import("../shared/s3-storage.ts");
  backends.push(["s3", async (_t, meter) => s3Storage({ bucket: process.env.AGENT_TEST_S3_BUCKET!, region: process.env.AWS_REGION ?? "us-west-2", prefix: `tests/${randomUUID()}`, tail: await tail(), meter })]);
}

for (const [name, open] of backends) {
  test(`${name} storage: blobs are immutable: writing an existing key keeps the first bytes`, async t => {
    const storage = await open(t);
    assert.equal(await storage.readBlob("chunks/t/ab/abc"), undefined);
    await storage.writeBlob("chunks/t/ab/abc", new Uint8Array([1, 2, 3]));
    await storage.writeBlob("chunks/t/ab/abc", new Uint8Array([9]));
    assert.deepEqual([...await storage.readBlob("chunks/t/ab/abc") ?? []], [1, 2, 3]);
    await assert.rejects(storage.writeBlob("../escape", new Uint8Array()), /Invalid storage key/);
  });

  test(`${name} storage: removing blobs by prefix removes those and no others, and meters them`, async t => {
    const metered = new Map<string, number>();
    const storage = await open(t, (key, bytes) => metered.set(key, (metered.get(key) ?? 0) + bytes));
    const agent = `client_${"a".repeat(40)}`, other = `client_${"b".repeat(40)}`;
    await storage.writeBlob(`sessions/${agent}/history/0-2`, new Uint8Array(10));
    await storage.writeBlob(`sessions/${agent}/history/2-3`, new Uint8Array(20));
    await storage.writeBlob(`sessions/${other}/history/0-1`, new Uint8Array(5));
    await storage.removeBlobs(`sessions/${agent}/history/`);
    assert.equal(await storage.readBlob(`sessions/${agent}/history/0-2`), undefined);
    assert.equal(await storage.readBlob(`sessions/${agent}/history/2-3`), undefined);
    assert.equal((await storage.readBlob(`sessions/${other}/history/0-1`))?.length, 5);
    assert.equal(metered.get(`sessions/${agent}/history/0-2`), 0);
    assert.equal(metered.get(`sessions/${agent}/history/2-3`), 0);
    await storage.removeBlobs(`sessions/${agent}/history/`);
  });

  test(`${name} storage: logs append, fold into snapshots, compact, and survive reopening`, async t => {
    const storage = await open(t);
    assert.deepEqual(await storage.log("agents/x/log").read(), []);
    const log = storage.log<{ n: number; pad?: string }>("agents/x/log");
    await log.read();
    log.append({ n: 1 }); log.append({ n: 2 });
    await log.flush(true);
    log.append({ n: 3 });
    await log.flush(true);
    assert.deepEqual(await storage.log("agents/x/log").read(), [{ n: 1 }, { n: 2 }, { n: 3 }]);
    await log.rewrite(() => [{ n: 6 }]);
    log.append({ n: 7 });
    // Large enough to be stored as a blob rather than in the tail.
    log.append({ n: 8, pad: "x".repeat(100_000) });
    await log.flush(true);
    const expected = [{ n: 6 }, { n: 7 }, { n: 8, pad: "x".repeat(100_000) }];
    assert.deepEqual(await storage.log("agents/x/log").read(), expected);
    await log.close();
    assert.deepEqual(await storage.log("agents/x/log").read(), expected, "the same records after compaction");
    const reopened = storage.log<{ n: number; pad?: string }>("agents/x/log");
    await reopened.read();
    reopened.append({ n: 9 });
    await reopened.flush(true);
    await reopened.close();
    assert.deepEqual(await storage.log("agents/x/log").read(), [...expected, { n: 9 }]);
  });

  test(`${name} storage: a meter hears of every object created and deleted, so its totals per owner match a listing`, async t => {
    const add = (map: Map<string, number>, key: string, bytes: number) => {
      const owner = storageOwner(key);
      if (owner) map.set(`${owner.kind}:${owner.id}`, (map.get(`${owner.kind}:${owner.id}`) ?? 0) + bytes);
    };
    const metered = new Map<string, number>();
    let deletes = 0;
    const storage = await open(t, (key, bytes) => { add(metered, key, bytes); if (bytes < 0) deletes++; });
    if (!storage.metered) return; // single-host logs are appended files: reconciled by listing instead
    const agent = `client_${"a".repeat(40)}`, volume = `vol_${"b".repeat(24)}`;
    // A log compacted again and again folds into snapshots, deleting the segments and blobs they replace.
    for (let round = 0; round < 12; round++) {
      const log = storage.log<{ n: number; pad?: string }>(`sessions/${agent}/transcript`);
      await log.read();
      log.append({ n: round });
      if (round % 3 === 0) log.append({ n: round, pad: "y".repeat(70_000 + round) });
      await log.flush(true);
      if (round === 5) await log.rewrite(() => [{ n: -1, pad: "z".repeat(80_000) }]);
      await log.close();
    }
    // Writers racing on a content-addressed chunk store it, and count it, once; another tenant's copy is its own.
    const chunk = new Uint8Array(1234).fill(7);
    await Promise.all(Array.from({ length: 5 }, () => storage.writeBlob("chunks/acme/ab/abc", chunk)));
    await storage.writeBlob("chunks/acme/ab/abc", chunk);
    await storage.writeBlob("chunks/beta/ab/abc", chunk);
    await storage.writeBlob(`volumes/${volume}/snapshots/s1`, new Uint8Array(55));
    for (const key of [`client-sessions/${agent}.journal`, `volumes/${volume}/tree`]) {
      const log = storage.log<{ n: number; pad: string }>(key);
      await log.read();
      log.append({ n: 1, pad: "j".repeat(100_000) });
      await log.close();
    }
    const listing = async () => {
      const listed = new Map<string, number>();
      for (const prefix of ["sessions/", "client-sessions/", "volumes/", "chunks/"]) for await (const { key, bytes } of storage.objects!(prefix)) add(listed, key, bytes);
      return listed;
    };
    const nonzero = (map: Map<string, number>) => new Map([...map].filter(([, bytes]) => bytes !== 0));
    const before = await listing();
    assert.deepEqual(nonzero(metered), before);
    assert.deepEqual([before.get("tenant:acme"), before.get("tenant:beta")], [1234, 1234]);
    assert.ok(deletes > 0, "folding deleted segments and blobs");
    // Removing a log (as purging an agent does) takes away what its objects counted.
    await storage.removeLog(`client-sessions/${agent}.journal`);
    await storage.removeLog(`sessions/${agent}/transcript`);
    const after = await listing();
    assert.equal(after.get(`agent:${agent}`), undefined);
    assert.deepEqual(nonzero(metered), after);
    assert.ok(after.get(`volume:${volume}`)! > 100_000);
  });
}
