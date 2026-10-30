import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createStorageConformance, type StorageConformanceAssertions } from "@earendil-works/pi-durable/testing";
import type { ConversationId, EntryId, Seq, Storage } from "@earendil-works/pi-durable";
import { deletePiStorage, hasPiStorage, openPiStorage, PostgresPiStorage, purgePiStorage, remotePiStorage, storageRequest } from "../src/pi-durable/storage.ts";
import { LostClaim, Ownership } from "../src/ownership.ts";
import { testDatabase } from "./database.ts";
import { transaction } from "../src/db.ts";
import { commitWrites } from "@earendil-works/pi-durable/testing";

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
  await commitWrites(storage, [{ type: "conversation", value: { id: root } }], context);
  const writes = Array.from({ length: 3_000 }, (_, n) => ({ type: "entry" as const, value: {
    id: (n + 2) as EntryId, conversationId: root, kind: "message", data: "x".repeat(100),
    ...(n === 2990 ? { head: (n + 2) as EntryId } : {}),
  } }));
  await commitWrites(storage, writes, context);
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
  await commitWrites(stale, [{ type: "conversation", value: { id: 1 as ConversationId } }], context);
  await db.query("update actor_owners set epoch = epoch + 1 where actor = $1", [claim.actor]);
  await assert.rejects(commitWrites(stale, [], context), LostClaim);
  // A holder that has no block left reserves one, and is fenced. (IDs left in an earlier block are handed out, but no
  // write using them can commit.)
  await assert.rejects(stale.mintId<EntryId>(), LostClaim);
  await assert.rejects(stale.mintIds(100), LostClaim);
  await assert.rejects(purgePiStorage(db, sessionId, claim), LostClaim);
  const active = await PostgresPiStorage.open(db, sessionId, { ...claim, epoch: claim.epoch + 1 });
  assert.ok(await active.conversation(1 as ConversationId, context));
  await commitWrites(active, [], context);
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
  await commitWrites(a, [{ type: "conversation", value: { id: 1 as ConversationId } }], context);
  await commitWrites(b, [{ type: "conversation", value: { id: 1 as ConversationId } }], context);
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
  const reserved = await nextReserved(sessionId);
  await assert.rejects(a.mintIds(0), /Invalid durable ID reservation count/);
  await assert.rejects(a.mintIds(1.5), /Invalid durable ID reservation count/);
  assert.equal(await nextReserved(sessionId), reserved, "invalid reservations have no durable effect");
  const later = await a.mintId<EntryId>();
  assert.ok(later > next);
  await a.close(context);
  await b.close(context);
  const end = await nextReserved(sessionId);
  const reopened = await PostgresPiStorage.open(db, sessionId);
  assert.ok(await reopened.mintId<EntryId>() >= end, "a reopened handle starts past every reserved block");
  await reopened.close(context);
});

test("Pi shared storage takes a lost commit that only updated a record for what it is: run again, not landed", async () => {
  const { db } = await database;
  // The next statement that writes tasks fails as a lost connection does, and the transaction rolls back.
  let failNext = false;
  const lost = () => Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
  const flaky = {
    ...db,
    query: (...args: Parameters<typeof db.query>) => db.query(...args),
    connect: async () => {
      const client = await db.connect();
      return { ...client, release: client.release.bind(client), on: client.on.bind(client), off: client.off.bind(client),
        query: async (text: string, values?: unknown[]) => {
          if (failNext && text.includes("pi_durable_tasks")) { failNext = false; throw lost(); }
          return client.query(text, values as never);
        } };
    },
  } as unknown as typeof db;
  const storage = await PostgresPiStorage.open(flaky, randomUUID(), undefined, undefined, 10_000);
  const [conversation, id] = await storage.mintIds(2);
  const task = (phase: string) => ({ id, conversationId: conversation, kind: "test", version: 1, input: {}, state: { status: "pending", checkpoint: { phase } }, background: false, abortRequested: false });
  await commitWrites(storage, [{ type: "conversation", value: { id: conversation as ConversationId } }, { type: "task", value: task("first") }] as never, context);
  failNext = true;
  await commitWrites(storage, [{ type: "task", value: task("second") }] as never, context);
  assert.equal(failNext, false);
  assert.equal(((await storage.task(id as never, context))!.state as any).checkpoint.phase, "second", "what the commit said it stored is stored");
  await storage.close(context);
});

test("Pi shared storage rides out a database it cannot reach: reads are asked again, and a commit whose answer was lost lands once", async () => {
  const { db } = await database;
  const sessionId = randomUUID();
  // The database as a node sees it in a failover: `down` statements fail before they run; `loseCommit` lets the next
  // commit land and then loses its answer.
  let down = 0, loseCommit = false;
  const lost = () => Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
  const flaky = {
    ...db,
    query: async (...args: Parameters<typeof db.query>) => { if (down > 0) { down--; throw lost(); } return db.query(...args); },
    connect: async () => {
      const client = await db.connect();
      return { ...client, release: client.release.bind(client), on: client.on.bind(client), off: client.off.bind(client),
        query: async (text: string, values?: unknown[]) => {
          if (down > 0) { down--; throw lost(); }
          const result = await client.query(text, values as never);
          if (text === "commit" && loseCommit) { loseCommit = false; throw lost(); }
          return result;
        } };
    },
  } as unknown as typeof db;
  const storage = await PostgresPiStorage.open(flaky, sessionId, undefined, undefined, 10_000);
  const [conversation, entry] = await storage.mintIds(2);
  const write = [
    { type: "conversation" as const, value: { id: conversation as ConversationId } },
    { type: "entry" as const, value: { id: entry as EntryId, conversationId: conversation as ConversationId, kind: "test" } },
  ];
  loseCommit = true;
  const received: Seq[] = [];
  const result = await storage.commit([write as never], (_index, seq) => received.push(seq), context);
  assert.equal(result.stored, 1);
  assert.equal(received.length, 1, "received once, though its answer was lost");
  const [seq] = received;
  const entries = (await db.query("select id from pi_durable_entries where session_id = $1", [sessionId])).rows;
  assert.deepEqual(entries.map(row => Number(row.id)), [entry], "written once, though its answer was lost");
  down = 3;
  const page = await storage.scanEntries({ conversationId: conversation as ConversationId }, 10, undefined, context);
  assert.deepEqual(page.items.map(item => item.id), [entry], "a read the database did not answer is asked again");
  down = 2;
  const next = await commitWrites(storage, [{ type: "entry", value: { id: await storage.mintId<EntryId>(), conversationId: conversation as ConversationId, kind: "test" } }] as never, context);
  assert.ok(next > seq);
  await storage.close(context);
  // Without a retry window, it fails as before.
  const strict = await PostgresPiStorage.open(flaky, sessionId);
  down = 1;
  await assert.rejects(strict.scanEntries({ conversationId: conversation as ConversationId }, 10, undefined, context), /Connection terminated/);
  await strict.close(context);
});

const nextReserved = async (sessionId: string) =>
  Number((await (await database).db.query("select next_id from pi_durable_metadata where session_id = $1", [sessionId])).rows[0].next_id);

test("Pi shared mintId reserves IDs in blocks, and a later holder never reuses one", async () => {
  const { db } = await database;
  const sessionId = randomUUID();
  const first = await PostgresPiStorage.open(db, sessionId);
  const ids: number[] = [];
  for (let i = 0; i < 300; i++) ids.push(await first.mintId<EntryId>());
  assert.deepEqual(ids, Array.from({ length: 300 }, (_, n) => 2 + n), "consecutive IDs from the block");
  assert.equal(await nextReserved(sessionId), 2 + 2 * 256, "two fenced reservations for 300 IDs, not 300");
  // A lease handoff: the next holder opens the session while the first still holds most of its second block.
  const next = await PostgresPiStorage.open(db, sessionId);
  const taken = await next.mintId<EntryId>();
  assert.ok(taken >= 2 + 2 * 256, "the new holder starts past the old holder's whole block");
  assert.ok(await first.mintId<EntryId>() < taken, "the old holder's unused IDs stay its own (its commits are fenced)");
  // IDs stay greater than every one reserved in bulk or written here.
  const bulk = await next.mintIds(10);
  const after = await next.mintId<EntryId>();
  assert.ok(after > bulk.at(-1)!);
  await commitWrites(next, [{ type: "conversation", value: { id: (after + 100) as ConversationId } }], context);
  assert.ok(await next.mintId<EntryId>() > after + 100);
  await first.close(context);
  await next.close(context);
});

test("Pi shared document reads take no transaction or metadata lock, and one commit checks its documents in one read", async () => {
  const { db } = await database;
  const sessionId = randomUUID();
  const storage = await PostgresPiStorage.open(db, sessionId);
  const id = await storage.mintId<any>();
  const address = { kind: "probe", scope: { kind: "session" as const } };
  await commitWrites(storage, [{ type: "document.create", record: { id, ...address }, content: { kind: "base", version: 1, value: { n: 0 } } }], context);
  for (let n = 1; n <= 3; n++) await commitWrites(storage, [{ type: "document.change", id, content: { kind: "delta", version: 1, ops: [["s", ["n"], n]] } }], context);
  // A writer holds the session's metadata lock: a read neither waits for it nor sees its uncommitted change.
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select next_id from pi_durable_metadata where session_id = $1 for update", [sessionId]);
    const read = await Promise.race([storage.document(id, "current", context), new Promise(resolve => setTimeout(() => resolve("blocked"), 2_000))]);
    assert.deepEqual(read, { record: { id, ...address, createdAt: 1 }, version: 1, value: { n: 3 }, deltasSinceBase: 3 });
  } finally { await client.query("rollback"); client.release(); }
  await assert.rejects(commitWrites(storage, [{ type: "document.change", id, content: { kind: "delta", version: 2, ops: [] } }], context), /version transition requires a base/);
  await assert.rejects(commitWrites(storage, [{ type: "document.create", record: { id: await storage.mintId<any>(), ...address }, content: { kind: "base", version: 1, value: {} } }], context), /already has a current incarnation/);
  await commitWrites(storage, [{ type: "document.retire", id }], context);
  assert.equal(await storage.document(id, "current", context), undefined);
  await storage.close(context);
});

test("Pi shared journal reads match the SQLite reference through forks, head markers, bounds and cursors", async () => {
  const { db } = await database;
  const directory = await mkdtemp(join(tmpdir(), "pi-storage-reference-"));
  const sessionId = randomUUID();
  const shared = await PostgresPiStorage.open(db, sessionId);
  const reference = await openPiStorage({ sessionId, directory });
  try {
    // root 1: entries 2..21, a head marker at 12 (head 6); fork 30 of root at 15: 31..40, a head marker at 36 (head 33);
    // fork 50 of fork 30 at 34: 51..58, no marker of its own; 60, a conversation with no entries.
    const entry = (id: number, conversationId: number, head?: number) => ({ type: "entry" as const, value: {
      id: id as EntryId, conversationId: conversationId as ConversationId, kind: head === undefined ? "message" : "marker", data: { n: id },
      ...(head === undefined ? {} : { head: head as EntryId }) } });
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, n) => from + n);
    const batches = [
      [{ type: "conversation" as const, value: { id: 1 as ConversationId } }, ...range(2, 21).map(id => entry(id, 1, id === 12 ? 6 : undefined))],
      [{ type: "conversation" as const, value: { id: 30 as ConversationId, parent: { conversationId: 1 as ConversationId, at: 15 as EntryId } } },
        ...range(31, 40).map(id => entry(id, 30, id === 36 ? 33 : undefined))],
      [{ type: "conversation" as const, value: { id: 50 as ConversationId, parent: { conversationId: 30 as ConversationId, at: 34 as EntryId } } },
        ...range(51, 58).map(id => entry(id, 50))],
      [{ type: "conversation" as const, value: { id: 60 as ConversationId } }],
    ];
    for (const batch of batches) {
      await commitWrites(shared, batch as never, context);
      await commitWrites(reference, batch as never, context);
    }
    const same = async (what: string, read: (storage: Storage) => Promise<unknown>) => {
      const expected = await read(reference).then(value => ({ value }), (error: Error) => ({ error: error.message }));
      const actual = await read(shared).then(value => ({ value }), (error: Error) => ({ error: error.message }));
      assert.deepEqual(actual, expected, what);
    };
    const conversations = [1, 30, 50, 60, 99] as ConversationId[];
    const points = [undefined, 1, 5, 6, 12, 13, 15, 16, 20, 33, 34, 35, 36, 40, 52, 58, 70];
    for (const conversationId of conversations) {
      for (const at of points) {
        await same(`head marker of ${conversationId} at ${at}`, storage => storage.findLatestHeadMarker(conversationId, at as EntryId | undefined, context));
        if (at !== undefined) await same(`entry ${at} from ${conversationId}`, storage => storage.entry(conversationId, at as EntryId, context));
      }
      for (const order of ["ascending", "descending"] as const) for (const limit of [1, 3, 256]) for (const minEntryId of [undefined, 5, 16, 35]) for (const maxEntryId of [undefined, 14, 34, 55]) {
        await same(`all of ${conversationId} ${order} by ${limit} in [${minEntryId}, ${maxEntryId}]`, async storage => {
          const items: unknown[] = [];
          let cursor;
          do {
            const page = await storage.scanEntries({ conversationId, order, ...(minEntryId === undefined ? {} : { minEntryId: minEntryId as EntryId }),
              ...(maxEntryId === undefined ? {} : { maxEntryId: maxEntryId as EntryId }) }, limit, cursor, context);
            items.push(...page.items);
            cursor = page.next;
          } while (cursor !== undefined);
          return items;
        });
      }
    }
  } finally {
    await shared.close(context);
    await reference.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

test("Pi shared storage reads a conversation's journal in one statement and commits a step in five", async () => {
  const { db } = await database;
  const sessionId = randomUUID();
  const statements: string[] = [];
  const count = <T extends { query: (...args: any[]) => any }>(target: T): T => new Proxy(target, { get(object, key) {
    if (key === "query") return (text: string, ...rest: unknown[]) => { statements.push(text); return object.query(text, ...rest); };
    if (key === "connect") return async () => count(await (object as unknown as typeof db).connect());
    const value = Reflect.get(object, key, object); return typeof value === "function" ? value.bind(object) : value;
  } });
  const storage = await PostgresPiStorage.open(count(db), sessionId);
  const root = 1 as ConversationId;
  const [task, document, ...ids] = await storage.mintIds(10);
  await commitWrites(storage, [{ type: "conversation", value: { id: root } },
    { type: "document.create", record: { id: document as never, kind: "probe", scope: { kind: "conversation", conversationId: root }, history: "latest" } as never, content: { kind: "base", version: 1, value: { n: 0 } } }], context);
  const measure = async (work: () => Promise<unknown>) => { statements.length = 0; await work(); return statements.length; };
  // A step's commit: an entry, its task and a current-only document's new base (Pi's live state) in one transaction.
  assert.equal(await measure(() => commitWrites(storage, [
    { type: "entry", value: { id: ids[0] as EntryId, conversationId: root, kind: "message" } },
    { type: "task", value: { id: task, conversationId: root, kind: "probe", state: { status: "running" } } as never },
    { type: "document.change", id: document as never, content: { kind: "base", version: 1, value: { n: 1 } } },
  ], context)), 5, "begin, the metadata lock taking the sequence, one check, one write, commit");
  assert.deepEqual((await storage.document(document as never, "current", context))?.value, { n: 1 }, "the base replaced, its old revision gone");
  assert.equal(Number((await db.query("select count(*) from pi_durable_document_revisions where session_id = $1", [sessionId])).rows[0].count), 1);
  assert.equal(await measure(() => storage.scanEntries({ conversationId: root }, 10, undefined, context)), 1);
  assert.equal(await measure(() => storage.scanEntries({ conversationId: root, order: "ascending", minEntryId: ids[0] as EntryId }, 10, undefined, context)), 1);
  assert.equal(await measure(() => storage.findLatestHeadMarker(root, undefined, context)), 1);
  assert.equal(await measure(() => storage.entry(root, ids[0] as EntryId, context)), 1);
  await assert.rejects(storage.scanEntries({ conversationId: 99 as ConversationId }, 10, undefined, context), /Unknown conversation: 99/);
  await storage.close(context);
});

test("Pi shared commits check the claim in their lock statement: a takeover waits for a commit in flight, and a node that lost the lease writes nothing", async t => {
  const { db } = await database;
  const ownership = new Ownership(db, { node: `pi-storage-${randomUUID()}` });
  await ownership.start();
  t.after(() => ownership.close());
  const acquired = await ownership.acquire(`pi-actor-${randomUUID()}`);
  assert.ok("claim" in acquired);
  const claim = acquired.claim;
  const sessionId = randomUUID();
  const statements: string[] = [];
  const counted = new Proxy(db, { get(target, key) {
    if (key === "connect") return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(inner, name) {
        if (name === "query") return (text: string, values?: unknown[]) => { statements.push(text); return inner.query(text, values as never); };
        const value = Reflect.get(inner, name, inner); return typeof value === "function" ? value.bind(inner) : value;
      } });
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  // A commit in flight holds the claim: its entry's commit effect waits here, inside the transaction.
  let hold: PromiseWithResolvers<void> | undefined, entered: PromiseWithResolvers<void> | undefined;
  const node = await PostgresPiStorage.open(counted, sessionId, claim, async () => { entered?.resolve(); await hold?.promise; });
  const root = 1 as ConversationId;
  await commitWrites(node, [{ type: "conversation", value: { id: root } }], context);
  const [first, second, third] = await node.mintIds(3);
  statements.length = 0;
  await commitWrites(node, [{ type: "entry", value: { id: first as EntryId, conversationId: root, kind: "message" } }], context);
  assert.equal(statements.length, 5, "begin, the claim and metadata lock in one statement, one check, one write, commit");

  hold = Promise.withResolvers(); entered = Promise.withResolvers();
  const inFlight = commitWrites(node, [{ type: "entry", value: { id: second as EntryId, conversationId: root, kind: "message" } }], context);
  await entered.promise;
  let takenOver = false;
  const takeover = db.query("update actor_owners set epoch = epoch + 1 where actor = $1", [claim.actor]).then(() => { takenOver = true; });
  await new Promise(resolve => setTimeout(resolve, 300));
  const waited = !takenOver;
  hold.resolve(); hold = undefined; entered = undefined;
  await inFlight;
  await takeover;
  assert.ok(waited, "the takeover waits for the commit holding the claim");

  // The lease is gone: the old node's next commit fails and writes nothing, though its IDs and metadata are in hand.
  const before = (await db.query("select next_seq from pi_durable_metadata where session_id = $1", [sessionId])).rows[0].next_seq;
  await assert.rejects(commitWrites(node, [{ type: "entry", value: { id: third as EntryId, conversationId: root, kind: "message" } }], context), LostClaim);
  await assert.rejects(node.mintIds(5), LostClaim);
  assert.equal((await db.query("select next_seq from pi_durable_metadata where session_id = $1", [sessionId])).rows[0].next_seq, before);
  const ids = (await db.query("select id from pi_durable_entries where session_id = $1 order by id", [sessionId])).rows.map(row => Number(row.id));
  assert.deepEqual(ids, [first, second], "the commit in flight landed; the stale node's did not");
  const next = await PostgresPiStorage.open(db, sessionId, { ...claim, epoch: claim.epoch + 1 });
  await commitWrites(next, [{ type: "entry", value: { id: third as EntryId, conversationId: root, kind: "message" } }], context);
  await next.close(context);
  await node.close(context);
});

test("Pi shared entryIds lists a conversation's entry IDs in a range without their records, also over the agent RPC", async () => {
  const { db } = await database;
  const storage = await PostgresPiStorage.open(db, randomUUID());
  const conversationId = 1 as ConversationId;
  await commitWrites(storage, [{ type: "conversation", value: { id: conversationId } }], context);
  const ids: number[] = [];
  for (let i = 0; i < 5; i++) ids.push(await storage.mintId<EntryId>());
  await commitWrites(storage, ids.map(id => ({ type: "entry", value: { id: id as EntryId, conversationId, kind: "test", data: { big: "x".repeat(1000) } } })) as never, context);
  assert.deepEqual(await storage.entryIds(conversationId, ids[1], ids[3]), ids.slice(1, 4));
  const remote = remotePiStorage(request => storageRequest(storage, request)) as typeof storage;
  assert.deepEqual(await remote.entryIds(conversationId, ids[0], ids[4]), ids);
});

const storageModes = ["sqlite", "sqlite-committing", "postgres", "remote-postgres"] as const;
async function openMode(mode: typeof storageModes[number], sessionId: string, directory: string): Promise<{ storage: Storage; close(): Promise<void> }> {
  const sqlite = mode === "sqlite" || mode === "sqlite-committing";
  const storage = await openPiStorage({ sessionId, directory, ...(sqlite ? {} : { db: (await database).db }),
    ...(mode === "sqlite-committing" ? { committing: async () => {} } : {}) });
  const selected = mode === "remote-postgres" ? remotePiStorage(async request => {
    const answer = await storageRequest(storage, JSON.parse(JSON.stringify(request)));
    return answer === undefined ? undefined : JSON.parse(JSON.stringify(answer));
  }) : storage;
  return { storage: selected, close: () => storage.close(context) };
}

for (const mode of storageModes) {
  test(`Pi ${mode}: commit adopts each durable batch once, before it resolves and before the next commit`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-adopt-"));
    const { storage, close } = await openMode(mode, randomUUID(), directory);
    try {
      const root = await storage.mintId<ConversationId>();
      const first = await commitWrites(storage, [{ type: "conversation", value: { id: root } }], context);
      const order: string[] = [];
      const entry = async () => ({ type: "entry" as const, value: { id: await storage.mintId<EntryId>(), conversationId: root, kind: "test" } });
      const step = async (name: string) => {
        const write = await entry();
        // Adoption runs when the batch is durable: a read started inside it already sees the batch.
        let visible: Promise<unknown> | undefined;
        let seq: Seq | undefined;
        await storage.commit([[write]], (_index, received) => { seq = received; order.push(`adopt ${name} ${received}`); visible = storage.entry(write.value.id, context); }, context);
        order.push(`resolved ${name} ${seq}`);
        assert.ok(await visible, "adopted after the batch is durable");
        return seq!;
      };
      const a = await step("a");
      const b = await step("b");
      assert.ok(a > first && b > a);
      assert.deepEqual(order, [`adopt a ${a}`, `resolved a ${a}`, `adopt b ${b}`, `resolved b ${b}`]);
      // A batch that fails before it is durable (an ID that names another record) is never adopted.
      let adopted = 0;
      const clash = [{ type: "entry" as const, value: { id: root as unknown as EntryId, conversationId: root, kind: "test" } }];
      const refused = await storage.commit([clash], () => adopted++, context);
      assert.equal(refused.stored, 0);
      assert.match(String((refused.refused as Error).message), /already belongs/);
      assert.equal(adopted, 0);
      // Batches in order, each with its seq and checked as of those before it: a refused one keeps those before it stored, and those after it are not.
      const [one, two, three] = [await entry(), await entry(), await entry()];
      const seqs: Seq[] = [];
      const part = await storage.commit([[one], [two], [{ ...one }], [three]], (index, seq) => { assert.equal(index, seqs.length); seqs.push(seq); }, context);
      assert.equal(part.stored, 2);
      assert.match(String((part.refused as Error).message), /already belongs/);
      assert.equal(seqs.length, 2);
      assert.ok(seqs[0] > b && seqs[1] > seqs[0]);
      assert.ok(await storage.entry(two.value.id, context));
      assert.equal(await storage.entry(three.value.id, context), undefined);
    } finally {
      await close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  test(`Pi ${mode}: mintId is above every ID minted since open and every ID stored, stored ones also across reopen`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-mint-"));
    const sessionId = randomUUID();
    let opened = await openMode(mode, sessionId, directory);
    try {
      const minted: number[] = [];
      for (let i = 0; i < 5; i++) minted.push(await opened.storage.mintId<EntryId>());
      assert.ok(minted.every((id, index) => index === 0 || id > minted[index - 1]));
      // A record stored with an ID above everything minted (as an import's reserved range writes).
      const stored = minted.at(-1)! + 1_000;
      await commitWrites(opened.storage, [{ type: "conversation", value: { id: stored as ConversationId } }], context);
      const after = await opened.storage.mintId<EntryId>();
      assert.ok(after > stored, `${after} > stored ${stored}`);
      await opened.close();
      opened = await openMode(mode, sessionId, directory);
      const reopened = await opened.storage.mintId<EntryId>();
      // Across reopen the contract covers stored IDs; minted IDs never stored may be minted again (SQLite does).
      assert.ok(reopened > stored, `${reopened} > stored ${stored}`);
      const last = (await commitWrites(opened.storage, [{ type: "conversation", value: { id: reopened as unknown as ConversationId } }], context), reopened);
      assert.ok(await opened.storage.mintId<EntryId>() > last);
    } finally {
      await opened.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
