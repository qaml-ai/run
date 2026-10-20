import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createStorageConformance, type StorageConformanceAssertions } from "@earendil-works/pi-durable/testing";
import type { ConversationId, EntryId, Storage } from "@earendil-works/pi-durable";
import { deletePiStorage, hasPiStorage, openPiStorage, PostgresPiStorage, purgePiStorage, remotePiStorage, storageRequest } from "../src/pi-durable/storage.ts";
import { LostClaim, Ownership } from "../src/ownership.ts";
import { testDatabase } from "./database.ts";
import { transaction } from "../src/db.ts";

function partial(actual: unknown, expected: unknown): void {
  if (expected && typeof expected === "object") {
    assert.ok(actual && typeof actual === "object");
    for (const [key, value] of Object.entries(expected)) partial((actual as Record<string, unknown>)[key], value);
  } else assert.deepEqual(actual, expected);
}
const assertions: StorageConformanceAssertions = {
  ok: assert.ok, strictEqual: assert.strictEqual, deepEqual: assert.deepEqual, partialDeepEqual: partial,
  greaterThan: (actual, expected) => assert.ok(actual > expected, `${actual} > ${expected}`),
  rejects: async (operation, message) => { await assert.rejects(operation, error => error instanceof Error && error.message.includes(message)); },
};
const database = testDatabase();
for (const mode of ["sqlite", "postgres", "remote-postgres"] as const) {
  const cases = createStorageConformance({ assertions, withStorage: async use => {
    const sessionId = randomUUID();
    const directory = mode === "sqlite" ? await mkdtemp(join(tmpdir(), "pi-storage-")) : "unused";
    const storage = await openPiStorage({ sessionId, directory, ...(mode !== "sqlite" ? { db: (await database).db } : {}) });
    try {
      // JSON roundtrip is the actual process boundary. Contexts and methods cannot cross it.
      const selected = mode === "remote-postgres" ? remotePiStorage(async request => {
        const response = await storageRequest(storage, JSON.parse(JSON.stringify(request)));
        return response === undefined ? undefined : JSON.parse(JSON.stringify(response));
      }) : storage;
      await use(selected);
    } finally {
      await storage.close(context);
      if (mode === "sqlite") await rm(directory, { recursive: true, force: true });
    }
  } });
  for (const item of cases) test(`Pi ${mode}: ${item.name}`, item.run);
}

test("Pi shared storage retains IDs, isolates sessions, and reopens only indexed active ranges", async () => {
  const { db } = await database;
  const sessionId = randomUUID();
  const root = 1 as ConversationId;
  const storage = await PostgresPiStorage.open(db, sessionId);
  const isolated = await PostgresPiStorage.open(db, randomUUID());
  await storage.commit([{ type: "conversation", value: { id: root } }], context);
  const writes = Array.from({ length: 3_000 }, (_, n) => ({ type: "entry" as const, value: {
    id: (n + 2) as EntryId, conversationId: root, kind: "message", data: "x".repeat(100),
    ...(n === 2990 ? { head: (n + 2) as EntryId } : {}),
  } }));
  await storage.commit(writes, context);
  const minted = await storage.mintId<EntryId>();
  await storage.close(context);
  assert.equal(await isolated.conversation(root, context), undefined);
  const reopened = await PostgresPiStorage.open(db, sessionId);
  assert.ok(await reopened.mintId<EntryId>() > minted);
  const marker = await reopened.findLatestHeadMarker(root, undefined, context);
  assert.equal(marker?.head, 2992);
  const active = await reopened.scanEntries({ conversationId: root, minEntryId: marker!.head, order: "ascending" }, 100, undefined, context);
  assert.equal(active.items.length, 10);
  await purgePiStorage(db, sessionId);
  assert.equal(await reopened.conversation(root, context), undefined);
  await reopened.close(context);
  await isolated.close(context);
});

test("Pi shared writes and ID allocation are fenced against stale owners", async t => {
  const { db } = await database;
  const ownership = new Ownership(db, { node: `pi-storage-${randomUUID()}` });
  await ownership.start();
  t.after(() => ownership.close());
  const acquired = await ownership.acquire(`pi-actor-${randomUUID()}`);
  assert.ok("claim" in acquired);
  const claim = acquired.claim;
  const sessionId = randomUUID();
  const stale = await PostgresPiStorage.open(db, sessionId, claim);
  await stale.commit([{ type: "conversation", value: { id: 1 as ConversationId } }], context);
  await db.query("update actor_owners set epoch = epoch + 1 where actor = $1", [claim.actor]);
  await assert.rejects(stale.commit([], context), LostClaim);
  await assert.rejects(stale.mintId<EntryId>(), LostClaim);
  await assert.rejects(stale.mintIds(100), LostClaim);
  await assert.rejects(purgePiStorage(db, sessionId, claim), LostClaim);
  const active = await PostgresPiStorage.open(db, sessionId, { ...claim, epoch: claim.epoch + 1 });
  assert.ok(await active.conversation(1 as ConversationId, context));
  await active.commit([], context);
  await active.close(context);
  await stale.close(context);
});

test("Pi shared ID reservations are atomic across storage handles", async () => {
  const { db } = await database;
  const sessionId = randomUUID();
  const handles = await Promise.all(Array.from({ length: 4 }, () => PostgresPiStorage.open(db, sessionId)));
  const ids = await Promise.all(Array.from({ length: 100 }, (_, i) => handles[i % handles.length].mintId<EntryId>()));
  assert.equal(new Set(ids).size, ids.length);
  await Promise.all(handles.map(handle => handle.close(context)));
});


test("Pi local probing does not create data and database files are private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-private-"));
  try {
    const options = { sessionId: "probe", directory };
    assert.equal(await hasPiStorage(options), false);
    assert.deepEqual(await readdir(directory), []);
    const storage = await openPiStorage(options);
    assert.equal(await hasPiStorage(options), true);
    assert.equal((await stat(join(directory, "pi-durable.sqlite"))).mode & 0o777, 0o600);
    await storage.close(context);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Pi deletion participates in the caller transaction and preserves other sessions", async () => {
  const { db } = await database;
  const first = randomUUID(), second = randomUUID();
  const a = await PostgresPiStorage.open(db, first);
  const b = await PostgresPiStorage.open(db, second);
  await a.commit([{ type: "conversation", value: { id: 1 as ConversationId } }], context);
  await b.commit([{ type: "conversation", value: { id: 1 as ConversationId } }], context);
  await assert.rejects(transaction(db, async sql => {
    await deletePiStorage(sql, first);
    throw new Error("later tombstone write failed");
  }), /later tombstone write failed/);
  assert.equal(await hasPiStorage({ sessionId: first, directory: "unused", db }), true);
  assert.ok(await a.conversation(1 as ConversationId, context));
  await transaction(db, sql => deletePiStorage(sql, first));
  assert.equal(await hasPiStorage({ sessionId: first, directory: "unused", db }), false);
  assert.ok(await b.conversation(1 as ConversationId, context));
  await a.close(context);
  await b.close(context);
});


test("Pi bulk ID ranges stay unique, fenced, and durable across handles and RPC", async () => {
  const { db } = await database;
  const sessionId = randomUUID();
  const a = await PostgresPiStorage.open(db, sessionId);
  const b = await PostgresPiStorage.open(db, sessionId);
  const remote = remotePiStorage(async request => {
    const answer = await storageRequest(a, JSON.parse(JSON.stringify(request)));
    return answer === undefined ? undefined : JSON.parse(JSON.stringify(answer));
  }) as Storage & { mintIds(count: number): Promise<number[]> };
  const ranges = await Promise.all([a.mintIds(100), b.mintIds(100), remote.mintIds(100)]);
  const ids = ranges.flat();
  assert.equal(new Set(ids).size, 300);
  for (const range of ranges) assert.deepEqual(range, Array.from({ length: 100 }, (_, n) => range[0] + n));
  const next = await b.mintId<EntryId>();
  assert.ok(next > Math.max(...ids));
  await assert.rejects(a.mintIds(0), /Invalid durable ID reservation count/);
  await assert.rejects(a.mintIds(1.5), /Invalid durable ID reservation count/);
  assert.equal(await a.mintId<EntryId>(), next + 1, "invalid reservations have no durable effect");
  await a.close(context);
  await b.close(context);
  const reopened = await PostgresPiStorage.open(db, sessionId);
  assert.equal(await reopened.mintId<EntryId>(), next + 2);
  await reopened.close(context);
});
