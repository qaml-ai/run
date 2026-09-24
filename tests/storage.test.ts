import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStorage, memoryStorage, type Storage } from "../shared/storage.ts";
import { postgresTail } from "../src/log-tail.ts";
import { testDatabase } from "./database.ts";

type Context = { after(fn: () => Promise<void> | void): void };
const temporary = async (t: Context) => { const root = await mkdtemp(join(tmpdir(), "storage-test-")); t.after(() => rm(root, { recursive: true, force: true })); return root; };
const tail = async () => postgresTail((await testDatabase()).db);
const backends: [string, (t: Context) => Promise<Storage>][] = [
  ["memory", async () => memoryStorage(await tail())],
  ["file", async t => fileStorage(await temporary(t))],
  ["shared file", async t => fileStorage(await temporary(t), { tail: await tail() })],
];
// Set AGENT_TEST_S3_BUCKET (and AWS credentials) to run the same contract against real S3.
if (process.env.AGENT_TEST_S3_BUCKET) {
  const { s3Storage } = await import("../shared/s3-storage.ts");
  backends.push(["s3", async () => s3Storage({ bucket: process.env.AGENT_TEST_S3_BUCKET!, region: process.env.AWS_REGION ?? "us-west-2", prefix: `tests/${randomUUID()}`, tail: await tail() })]);
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
}
