import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, MemoryStorage, createRegistry, type Cursor, type EntryId, type EntryQuery, type HarnessOptions, type StorageWrite } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import {
  MIGRATION_MAX_BYTES, MIGRATION_MAX_RECORDS, readMigrationRecords, importLegacyTranscript, LEGACY_CONVERSATION_ID, LegacyMigrationConflict, LegacyMigrationDeferred,
  legacyHistoryOf, loadLegacyMigration, loadMigratedSnapshot, planLegacyMigration,
  readMigratedLegacyHistory, readMigratedLegacyRecords, validateLegacyMigration,
} from "../src/pi-durable/migration.ts";
import { Transcript, type TranscriptRecord } from "../src/transcript.ts";
import type { AppendLog } from "../shared/append-log.ts";
import { recoverDurableMessages } from "../src/pi-durable/agent.ts";

const context = BACKGROUND_CONTEXT;
const user = (content: string, extra = {}) => ({ role: "user", content, timestamp: 1, ...extra }) as AgentMessage;
const system = (content: string) => ({ role: "system", content, timestamp: 1 }) as SystemMessage;
const assistant = (content: unknown[], extra = {}) => ({
  role: "assistant", content, timestamp: 2, api: "openai-completions", provider: "test", model: "fake",
  usage: { input: 3, output: 4, cacheRead: 5, cacheWrite: 6, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: content.some((part: any) => part.type === "toolCall") ? "toolUse" : "stop", ...extra,
}) as AgentMessage;
const result = (id: string, extra = {}) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `result ${id}` }], timestamp: 3, isError: false, ...extra }) as AgentMessage;
const call = (id: string) => ({ type: "toolCall", id, name: "read", arguments: { key: "saved" } });

function fixture(): TranscriptRecord[] {
  return [
    { t: "message", message: user("discarded", { requestId: "discarded-request" }) },
    { t: "retract" },
    { t: "reset", messages: [
      user("old body", { requestId: "old-request", sender: { id: "discord:123", name: "Original Sender" }, opaque: { raw: "kept" } }),
      assistant([call("old-call"), { type: "thinking", thinking: "private reasoning", thinkingSignature: "signature-opaque" }], { providerMetadata: { response: "original" } }),
      result("old-call", { details: { checksum: "exact" } }),
    ] },
    { t: "turn", active: true },
    { t: "turn", active: false },
    { t: "system", message: system("original baseline"), leading: true },
    { t: "system", message: { ...system(""), sections: { instructions: "before compaction" } } },
    { t: "compaction", summary: "Every important old detail", cut: 3, tokensBefore: 4242, at: 4, details: { source: "opaque" }, system: system("folded baseline") },
    { t: "message", message: user("latest instruction", { requestId: "current-request", sender: { id: "user-2" } }) },
    { t: "message", message: assistant([call("current-call")]) },
    { t: "awaiting", calls: ["current-call"] },
    { t: "message", message: result("current-call", { details: { approvedBy: "human" } }) },
    { t: "system", message: { ...system(""), sections: { instructions: "after compaction" } } },
    { t: "message", message: assistant([{ type: "text", text: "finished", textSignature: "signed-text" }]) },
  ];
}

test("migration atomically preserves the exact archive, effective history, compacted context, and opaque message fields", async () => {
  const source = fixture();
  const before = JSON.stringify(source);
  const storage = new MemoryStorage();
  const imported = await importLegacyTranscript({ storage, sessionId: "public-session-id", records: source, now: 123 });
  assert.equal(imported.status, "imported");
  assert.equal(imported.sessionId, "public-session-id");
  assert.equal(imported.historyCount, 7);
  assert.equal(imported.recordCount, source.length);
  assert.equal(imported.importedAt, 123);
  assert.deepEqual(await readMigratedLegacyRecords(storage), source);
  assert.deepEqual(await readMigratedLegacyHistory(storage), legacyHistoryOf(source));
  assert.equal(JSON.stringify(source), before, "source records are never changed during conversion");
  const loaded = await loadMigratedSnapshot(storage);
  assert.ok(loaded);
  assert.deepEqual(loaded.snapshot.requests, ["old-request", "current-request"]);
  assert.deepEqual(loaded.snapshot.calls, [["old-call", 1], ["current-call", 4]]);
  assert.equal(loaded.snapshot.compaction?.cut, 3);
  assert.deepEqual(loaded.snapshot.system, system("folded baseline"));
  const restored = new Transcript({} as AppendLog<TranscriptRecord>);
  restored.restore(loaded.snapshot);
  const original = new Transcript({} as AppendLog<TranscriptRecord>);
  source.forEach(record => original.apply(record));
  assert.deepEqual(restored.view(), original.view());
  assert.deepEqual(await validateLegacyMigration(storage, source), loaded.metadata);

  // No provider is installed or called. The two pinned pi-ai versions brand TranscriptContext differently.
  const harness = await Harness.open(storage, { models: createModels() as unknown as HarnessOptions["models"], registry: createRegistry() }, context);
  try {
    const conversation = await harness.conversation(LEGACY_CONVERSATION_ID, context);
    assert.ok(conversation);
    assert.deepEqual((await conversation.context(context)).messages, planLegacyMigration(source).model, "real Pi context derivation has exact parity");
    const oldRequest = await storage.submissionByRequest(LEGACY_CONVERSATION_ID, "old-request", context);
    assert.ok(oldRequest);
    const retried = await conversation.submit({ type: "input", content: "must not rerun", requestId: "old-request" }, context);
    assert.equal(retried.id, oldRequest.id);
    assert.equal((await retried.wait(context)).status, "unanswered");
    assert.equal((await storage.scanTasks({}, 10, undefined, context)).items.length, 0, "import and old-request retries execute no tasks");
  } finally { await harness.close(context); }
});

test("retries and concurrent imports are idempotent; another session or source generation cannot reuse the store", async () => {
  const storage = new MemoryStorage();
  try {
    const source = fixture();
    const results = await Promise.all([
      importLegacyTranscript({ storage, sessionId: "session", records: source }),
      importLegacyTranscript({ storage, sessionId: "session", records: source }),
    ]);
    assert.deepEqual(results.map(value => value.status), ["imported", "existing"]);
    assert.equal(results[0].markerId, results[1].markerId);
    assert.equal((await storage.scanConversations({}, 10, undefined, context)).items.length, 1);
    assert.equal((await storage.scanEntries({ conversationId: LEGACY_CONVERSATION_ID }, 100, undefined, context)).items.length, Math.ceil(source.length / 128) + 1 + planLegacyMigration(source).model.length, "the marker, the archive and one context entry per message");
    await assert.rejects(importLegacyTranscript({ storage, sessionId: "other", records: source }), LegacyMigrationConflict);
    await assert.rejects(importLegacyTranscript({ storage, sessionId: "session", records: [...source, { t: "message", message: user("new source") }] }), LegacyMigrationConflict);
  } finally { await storage.close(context); }
});

test("commit failure leaves the source intact and no partial Pi session; ambiguous commit acknowledgement is retryable", async () => {
  class FaultStorage extends MemoryStorage {
    fault: "before" | "after" | undefined = "before";
    override async commit(writes: readonly StorageWrite[], context: Context) {
      if (this.fault === "before") throw new Error("write rejected");
      const seq = await super.commit(writes, context);
      if (this.fault === "after") { this.fault = undefined; throw new Error("ack lost after commit"); }
      return seq;
    }
  }
  const storage = new FaultStorage();
  const source = fixture();
  const original = JSON.stringify(source);
  try {
    await assert.rejects(importLegacyTranscript({ storage, sessionId: "recover", records: source }), /write rejected/);
    assert.equal(await storage.conversation(LEGACY_CONVERSATION_ID, context), undefined);
    storage.fault = "after";
    await assert.rejects(importLegacyTranscript({ storage, sessionId: "recover", records: source }), /ack lost/);
    const retried = await importLegacyTranscript({ storage, sessionId: "recover", records: source });
    assert.equal(retried.status, "existing");
    await validateLegacyMigration(storage, source);
    assert.equal(JSON.stringify(source), original);
  } finally { await storage.close(context); }
});

test("active runs, human waits, and contexts Pi would alter defer without creating or executing anything", async () => {
  const cases: [TranscriptRecord[], LegacyMigrationDeferred["reason"], LegacyMigrationDeferred["kind"]?][] = [
    [[{ t: "turn", active: true }, { t: "message", message: user("still running") }], "active"],
    [[{ t: "message", message: assistant([call("waiting")]) }, { t: "awaiting", calls: ["waiting"] }], "awaiting"],
    [[{ t: "message", message: assistant([call("unknown-outcome")]) }], "context_changed", "open_call"],
    [[{ t: "message", message: result("orphan") }], "context_changed", "order"],
    [[{ t: "message", message: assistant([{ type: "text", text: "failed" }], { stopReason: "error" }) }], "context_changed", "failed_response"],
    [[{ t: "message", message: assistant([call("a"), call("b")]) }, { t: "message", message: result("b") }, { t: "message", message: result("a") }], "context_changed", "order"],
  ];
  for (const [source, reason, kind] of cases) {
    const storage = new MemoryStorage();
    try {
      await assert.rejects(importLegacyTranscript({ storage, sessionId: "defer", records: source }), error => error instanceof LegacyMigrationDeferred && error.reason === reason && error.kind === kind);
      assert.equal((await storage.scanConversations({}, 10, undefined, context)).items.length, 0);
      assert.equal((await storage.scanTasks({}, 10, undefined, context)).items.length, 0);
    } finally { await storage.close(context); }
  }
});

test("SQLite reopen finds the migration without paging the archive, retaining archive, public identity, and deduplication", async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "session.sqlite");
  const initial = Array.from({ length: 300 }, (_, index) => user(`old-${index}: ${"x".repeat(5000)}`, { requestId: `old-${index}` }));
  const source: TranscriptRecord[] = [
    { t: "reset", messages: initial },
    { t: "compaction", summary: "archived", cut: initial.length, tokensBefore: 400000, at: 1 },
    { t: "message", message: user("new", { requestId: "new" }) },
  ];
  const leading = system("derived from existing configuration");
  const first = await openNodeSqliteStorage(path);
  const imported = await importLegacyTranscript({ storage: first, sessionId: "same-public-id", records: source, leadingSystem: leading });
  await first.close(context);
  const reopened = await openNodeSqliteStorage(path);
  try {
    let scans = 0;
    const originalScan = reopened.scanEntries.bind(reopened);
    reopened.scanEntries = async (query: EntryQuery, limit: number, cursor: Cursor | undefined, callContext: Context) => {
      assert.equal(limit, 1, "startup must never page archived bodies");
      assert.equal(query.order, "ascending");
      scans++;
      return originalScan(query, limit, cursor, callContext);
    };
    const marker = await loadLegacyMigration(reopened);
    assert.equal(scans, 1);
    reopened.scanEntries = originalScan;
    const checkpoint = (await reopened.entry(marker!.contextEntryId, context))!.entry;
    assert.ok(JSON.stringify(checkpoint).length < 20000, "the checkpoint head holds no old body and no second copy of the context");
    // The audit path reduces the archive again for the context; the reduced state beside it was stored with the checkpoint.
    const loaded = await loadMigratedSnapshot(reopened);
    assert.ok(loaded);
    assert.deepEqual(loaded.metadata, marker);
    assert.equal(loaded.metadata.sessionId, "same-public-id");
    assert.equal(loaded.metadata.fingerprint, imported.fingerprint);
    assert.equal(loaded.snapshot.total, 301);
    assert.equal(loaded.snapshot.requests.length, 301);
    assert.deepEqual(loaded.snapshot.system, leading);
    assert.ok(JSON.stringify(loaded.snapshot).length < 10000, "no old body is retained in the reduced snapshot");
    assert.ok(await reopened.submissionByRequest(LEGACY_CONVERSATION_ID, "old-0", context));
    assert.deepEqual(await readMigratedLegacyRecords(reopened), source);
    await validateLegacyMigration(reopened, source, leading);
  } finally { await reopened.close(context); }
});

test("empty sessions can migrate, but preexisting unmarked Pi storage is never overwritten", async () => {
  const storage = new MemoryStorage();
  try {
    assert.equal(await loadLegacyMigration(storage), undefined);
    const migrated = await importLegacyTranscript({ storage, sessionId: "empty", records: [] });
    assert.equal(migrated.historyCount, 0);
    assert.deepEqual(await readMigratedLegacyHistory(storage), []);
    await validateLegacyMigration(storage, []);
  } finally { await storage.close(context); }
  const unmarked = new MemoryStorage();
  try {
    await unmarked.commit([{ type: "conversation", value: { id: LEGACY_CONVERSATION_ID } }], context);
    await assert.rejects(importLegacyTranscript({ storage: unmarked, sessionId: "unsafe", records: [] }), LegacyMigrationConflict);
  } finally { await unmarked.close(context); }
});

test("fork imports retain source cursor evidence and encrypted signatures without inheriting its native ID domain", async () => {
  const source: TranscriptRecord[] = [
    { t: "message", message: user("ancestor", { requestId: "ancestor-request", sender: { account: "original" } }), pi: { entryId: 999_999, index: 0 } },
    { t: "message", message: assistant([
      { type: "thinking", thinking: "", thinkingSignature: "AAB+/=\nopaque-encrypted-thought-signature", redacted: true },
      { type: "text", text: "saved answer", textSignature: "signed\u0000bytes\nunchanged" },
    ], { encryptedReasoning: "provider-owned-blob+/=", opaque: { nested: [{ data: "unchanged" }] } }), pi: { entryId: 1_000_000, index: 0 } },
    { t: "pi", cursor: { entryId: 1_000_001, index: 2 } },
  ];
  const original = JSON.stringify(source);
  const left = new MemoryStorage();
  const right = new MemoryStorage();
  try {
    await importLegacyTranscript({ storage: left, sessionId: "fork-left", records: source });
    await importLegacyTranscript({ storage: right, sessionId: "fork-right", records: source });
    for (const storage of [left, right]) {
      assert.equal((await loadMigratedSnapshot(storage))!.snapshot.piCursor, undefined, "an ancestor's entry IDs never suppress this fork's new native WAL");
      assert.equal(JSON.stringify(await readMigratedLegacyRecords(storage)), original);
      assert.equal(JSON.stringify(await readMigratedLegacyHistory(storage)), JSON.stringify(legacyHistoryOf(source)), "provider-owned signatures survive byte for byte");
      await validateLegacyMigration(storage, source);
    }
    assert.equal((await loadLegacyMigration(left))!.sessionId, "fork-left");
    assert.equal((await loadLegacyMigration(right))!.sessionId, "fork-right");
    assert.equal(JSON.stringify(source), original);
  } finally { await left.close(context); await right.close(context); }
});

test("native WAL recovery pages the entire journal and resumes within multi-message entries without copying migration context", async () => {
  const storage = new MemoryStorage();
  try {
    await importLegacyTranscript({ storage, sessionId: "wal", records: fixture() });
    const writes: StorageWrite[] = [];
    const expected: { message: AgentMessage; cursor: { entryId: number; index: number } }[] = [];
    for (let index = 0; index < 520; index++) {
      const id = await storage.mintId<EntryId>();
      const messages = [user(`native-${index}`), ...(index === 257 ? [user("second message in one entry")] : [])];
      writes.push({ type: "entry", value: { id, conversationId: LEGACY_CONVERSATION_ID, kind: "pi.user", model: messages as any } });
      messages.forEach((message, offset) => expected.push({ message, cursor: { entryId: id, index: offset } }));
    }
    const originalUser = user("native sender", { requestId: "native-request", sender: { id: "discord-user", displayName: "Original" }, opaque: "signature+/=" });
    const originalId = await storage.mintId<EntryId>();
    writes.push({ type: "entry", value: { id: originalId, conversationId: LEGACY_CONVERSATION_ID, kind: "camel.user", model: [user("provider-normalized")] as any, data: { message: originalUser } as any } });
    expected.push({ message: originalUser, cursor: { entryId: originalId, index: 0 } });
    writes.push({ type: "entry", value: { id: await storage.mintId<EntryId>(), conversationId: LEGACY_CONVERSATION_ID, kind: "camel.legacy.context", model: [user("context copy must never become another user message")] as any } });
    await storage.commit(writes, context);
    assert.deepEqual(await recoverDurableMessages(storage, LEGACY_CONVERSATION_ID), expected);
    const checkpoint = expected.find(item => item.message.role === "user" && item.message.content === "native-257")!.cursor;
    const rest = await recoverDurableMessages(storage, LEGACY_CONVERSATION_ID, checkpoint);
    assert.deepEqual(rest, expected.slice(expected.findIndex(item => item.cursor.entryId === checkpoint.entryId) + 1));
    assert.equal((rest[0].message as any).content, "second message in one entry");

    const projected = new Transcript({} as AppendLog<TranscriptRecord>);
    const first = expected.slice(0, 259);
    const durableProjection: TranscriptRecord[] = first.map(item => ({ t: "message", message: item.message, pi: item.cursor }));
    durableProjection.forEach(record => projected.apply(record));
    const recovered = await recoverDurableMessages(storage, LEGACY_CONVERSATION_ID, projected.piCursor);
    for (const item of recovered) {
      const record: TranscriptRecord = { t: "message", message: item.message, pi: item.cursor };
      durableProjection.push(record);
      projected.apply(record);
    }
    assert.deepEqual(projected.context, expected.map(item => item.message), "a committed projection prefix followed by WAL recovery has each message exactly once");
    assert.deepEqual(await recoverDurableMessages(storage, LEGACY_CONVERSATION_ID, projected.piCursor), []);
    const restarted = new Transcript({} as AppendLog<TranscriptRecord>);
    durableProjection.forEach(record => restarted.apply(record));
    assert.deepEqual(restarted.piCursor, projected.piCursor, "the message and cursor persist in one append-log record");
    assert.deepEqual(await recoverDurableMessages(storage, LEGACY_CONVERSATION_ID, restarted.piCursor), []);
  } finally { await storage.close(context); }
});

test("large imports archive bounded blocks and reserve all IDs in one optional backend call", async () => {
  class BulkStorage extends MemoryStorage {
    reservations: number[] = [];
    async mintIds(count: number) {
      this.reservations.push(count);
      const ids: number[] = [];
      for (let index = 0; index < count; index++) ids.push(await super.mintId());
      return ids;
    }
    override async mintId(): Promise<any> { throw new Error("a bulk backend must not mint once per archive record or request"); }
  }
  const storage = new BulkStorage();
  const source: TranscriptRecord[] = [];
  for (let index = 0; index < 150; index++) source.push({ t: "message", message: user(`request ${index}`, { requestId: `request-${index}` }) }, { t: "message", message: assistant([{ type: "text", text: `answer ${index}` }]) });
  source.push({ t: "compaction", summary: "all old messages", cut: 300, tokensBefore: 10000, at: 999 });
  try {
    const imported = await importLegacyTranscript({ storage, sessionId: "blocked-archive", records: source });
    assert.deepEqual(storage.reservations, [3 + 2 + 150]);
    const archive = (await storage.scanEntries({ conversationId: LEGACY_CONVERSATION_ID, order: "ascending" }, 1000, undefined, context)).items.filter(entry => entry.kind === "camel.legacy.record");
    assert.deepEqual(archive.map(entry => (entry.data as any).index), [0, 128, 256]);
    assert.deepEqual(archive.map(entry => (entry.data as any).records.length), [128, 128, 45]);
    assert.equal(imported.recordCount, source.length);
    assert.deepEqual(await readMigratedLegacyRecords(storage), source);
    assert.deepEqual(await readMigratedLegacyHistory(storage), legacyHistoryOf(source));
    await validateLegacyMigration(storage, source);
    const nextReserved = (await storage.mintIds(1))[0];
    assert.ok(nextReserved > imported.contextEntryId);
  } finally { await storage.close(context); }
});

test("invalid backend bulk reservations cannot publish partial migrations", async () => {
  class InvalidStorage extends MemoryStorage {
    async mintIds(count: number) { return Array.from({ length: count }, () => 2); }
  }
  const storage = new InvalidStorage();
  try {
    await assert.rejects(importLegacyTranscript({ storage, sessionId: "invalid-reservation", records: fixture() }), /invalid ID reservation/);
    assert.equal(await storage.conversation(LEGACY_CONVERSATION_ID, context), undefined);
  } finally { await storage.close(context); }
});


test("oversized automatic migrations defer before creating Pi state", async () => {
  const storage = new MemoryStorage();
  const tooMany = Array.from({ length: MIGRATION_MAX_RECORDS + 1 }, (): TranscriptRecord => ({ t: "turn", active: false }));
  const tooLarge: TranscriptRecord[] = [{ t: "message", message: user("x".repeat(MIGRATION_MAX_BYTES)) }];
  try {
    for (const records of [tooMany, tooLarge]) {
      await assert.rejects(importLegacyTranscript({ storage, sessionId: "oversized", records }),
        error => error instanceof LegacyMigrationDeferred && error.reason === "size_limit");
      assert.equal(await loadLegacyMigration(storage), undefined);
      assert.equal((await storage.scanConversations({}, 10, undefined, context)).items.length, 0);
    }
    const result = await importLegacyTranscript({ storage, sessionId: "oversized", records: fixture() });
    assert.equal(result.status, "imported", "a refused import leaves no partial state blocking a later retry");
  } finally { await storage.close(context); }
});

test("migration never falls back to an unbounded archive read", async () => {
  const log: AppendLog<TranscriptRecord> = {
    read: async () => { throw new Error("unbounded read called"); },
    append: () => { throw new Error("unexpected write"); },
    flush: async () => {}, rewrite: async () => {}, close: async () => {}, appendedSinceRewrite: 0,
  };
  await assert.rejects(readMigrationRecords(log), error => error instanceof LegacyMigrationDeferred && error.reason === "size_limit");
  log.readBounded = async bound => { assert.equal(bound, MIGRATION_MAX_BYTES); return undefined; };
  await assert.rejects(readMigrationRecords(log), error => error instanceof LegacyMigrationDeferred && error.reason === "size_limit");
  log.readBounded = async () => fixture();
  assert.deepEqual(await readMigrationRecords(log), fixture());
});
