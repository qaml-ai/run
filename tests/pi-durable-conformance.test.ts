import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Storage } from "@earendil-works/pi-durable";
import { createStorageConformance, type StorageConformanceAssertions } from "@earendil-works/pi-durable/testing";
import { openPiStorage, remotePiStorage, storageRequest } from "../src/pi-durable/storage.ts";
import { testDatabase } from "./database.ts";

// Pi's own contract for a Storage, on ours: Postgres, Postgres over the agent RPC, and SQLite with commit effects.
const assertions: StorageConformanceAssertions = {
  ok: (value, message) => assert.ok(value, message),
  strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
  deepEqual: (actual, expected) => assert.deepEqual(actual, expected),
  partialDeepEqual: (actual, expected) => (assert as unknown as { partialDeepStrictEqual(actual: unknown, expected: unknown): void }).partialDeepStrictEqual(actual, expected),
  greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} > ${expected}`),
  rejects: (operation, messageIncludes) => assert.rejects(operation, (error: Error) => error.message.includes(messageIncludes)),
};

const database = testDatabase();

const modes = {
  postgres: async () => { const storage = await openPiStorage({ sessionId: randomUUID(), directory: tmpdir(), db: (await database).db }); return { storage, inner: storage }; },
  "remote postgres": async () => {
    const inner = await openPiStorage({ sessionId: randomUUID(), directory: tmpdir(), db: (await database).db });
    const storage = remotePiStorage(async request => {
      const answer = await storageRequest(inner, JSON.parse(JSON.stringify(request)));
      return answer === undefined ? undefined : JSON.parse(JSON.stringify(answer));
    });
    return { storage, inner };
  },
  "sqlite with commit effects": async directory => { const storage = await openPiStorage({ sessionId: randomUUID(), directory, committing: async () => {} }); return { storage, inner: storage }; },
} satisfies Record<string, (directory: string) => Promise<{ storage: Storage; inner: Storage }>>;

for (const [mode, open] of Object.entries(modes)) {
  for (const { name, run } of createStorageConformance({ assertions, withStorage: async use => {
    const directory = await mkdtemp(join(tmpdir(), "pi-conformance-"));
    const { storage, inner } = await open(directory);
    try { await use(storage); }
    finally {
      await inner.close(context).catch(() => {});
      await rm(directory, { recursive: true, force: true });
    }
  } })) test(`${mode}: ${name}`, run);
}
