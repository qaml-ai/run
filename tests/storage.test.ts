import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStorage, memoryStorage, PreconditionFailed, type Storage } from "../shared/storage.ts";

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

test("shared file storage fences a stale log writer across instances", async t => {
  const root = await mkdtemp(join(tmpdir(), "storage-shared-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = fileStorage(root, { shared: true }), b = fileStorage(root, { shared: true });
  const stale = a.log<{ n: number }>("x/log"), owner = b.log<{ n: number }>("x/log");
  await stale.read(); await owner.read();
  owner.append({ n: 1 }); await owner.flush(true);
  stale.append({ n: 2 });
  await assert.rejects(stale.flush(true), PreconditionFailed);
  assert.deepEqual(await b.log("x/log").read(), [{ n: 1 }]);
});
