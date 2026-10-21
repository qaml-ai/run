import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Transcript, historyOf, type TranscriptRecord } from "../src/transcript.ts";
import { NativeTranscript, nativeTranscriptRecords } from "../src/pi-durable/transcript.ts";
import { importLegacyTranscript, LegacyMigrationDeferred, MIGRATION_MAX_RECORDS, readMigratedLegacyRecords, validateLegacyMigration } from "../src/pi-durable/migration.ts";
import * as previous from "./fixtures/pi-readers-before-322.ts";
import type { AppendLog } from "../shared/append-log.ts";
import type { Storage, StorageWrite } from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import { openPiStorage } from "../src/pi-durable/storage.ts";
import { testDatabase } from "./database.ts";

function legacy() {
  const records: TranscriptRecord[] = [];
  const log: AppendLog<TranscriptRecord> = { read: async () => records, readBounded: async () => records, append: record => { records.push(record); },
    flush: async () => {}, rewrite: async snapshot => { records.splice(0, records.length, ...snapshot()); }, close: async () => {}, appendedSinceRewrite: 0 };
  return { transcript: new Transcript(log), records };
}

test("native transcript reload uses only the bounded checkpoint and indexed request lookup", async () => {
  const storage = new MemoryStorage();
  const source = legacy();
  for (let i = 0; i < 2000; i++) await source.transcript.push({ role: "user", content: `request ${i}`, requestId: `request-${i}`, timestamp: i } as any);
  await source.transcript.compact({ summary: "Earlier requests", cut: 1999, tokensBefore: 10000, at: 2001 }, undefined, () => undefined);
  await importLegacyTranscript({ storage, sessionId: "test", records: source.records });
  const transcript = await NativeTranscript.adopt(storage, source.transcript);
  const head = await storage.findLatestHeadMarker(1 as any, undefined, context);
  assert.equal(head?.id, transcript.piCursor?.entryId, "native context begins after the imported archive");
  assert.ok((head?.model?.length ?? 0) <= 2, "the new head carries only the bounded working context");
  assert.equal(transcript.requests.size, 0);
  assert.ok(await transcript.hasRequest("request-0"));
  const count = source.records.length;
  await transcript.setActive(true);
  await transcript.push({ role: "user", content: "new", requestId: "new", timestamp: 2002 } as any);
  await transcript.setActive(false);
  assert.equal(source.records.length, count, "native writes leave the legacy archive unchanged");
  const scan = storage.scanEntries;
  storage.scanEntries = async () => { throw new Error("Reload must not scan historical entries"); };
  const reopened = (await NativeTranscript.open(storage))!;
  assert.equal(reopened.total, 2001);
  assert.equal(reopened.context.length, 2);
  assert.equal(reopened.requests.size, 0);
  assert.ok(await reopened.hasRequest("request-0"));
  assert.ok(await reopened.hasRequest("new"));
  assert.equal(await reopened.hasRequest("missing"), false);
  storage.scanEntries = scan;
  assert.equal(historyOf((await nativeTranscriptRecords(storage))!).length, 2001);
});

test("failed native checkpoint never advances host state; canonical response recovers once", async () => {
  const storage = new MemoryStorage(), source = legacy();
  await importLegacyTranscript({ storage, sessionId: "test", records: [] });
  const transcript = await NativeTranscript.adopt(storage, source.transcript);
  const id = await storage.mintId<any>();
  const message = { role: "user", content: "committed", timestamp: 1 } as const;
  await storage.commit([{ type: "entry", value: { id, conversationId: 1 as any, kind: "pi.user", model: [message] } }], context);
  const commit = storage.commit.bind(storage);
  storage.commit = async () => { throw new Error("disk full"); };
  await assert.rejects(transcript.push(message, { entryId: id, index: 0 }), /disk full/);
  assert.equal(transcript.total, 0);
  storage.commit = commit;
  const recovered = (await NativeTranscript.open(storage))!;
  await recovered.push(message, { entryId: id, index: 0 });
  assert.equal(historyOf((await nativeTranscriptRecords(storage))!).length, 1);
});


test("adoption after rollback applies the import bound before changing the native generation", async () => {
  const storage = new MemoryStorage(), source = legacy();
  await importLegacyTranscript({ storage, sessionId: "test", records: [] });
  for (let i = 0; i <= MIGRATION_MAX_RECORDS; i++) source.records.push({ t: "turn", active: false });
  await assert.rejects(NativeTranscript.adopt(storage, source.transcript),
    error => error instanceof LegacyMigrationDeferred && error.reason === "size_limit");
  assert.equal(await NativeTranscript.open(storage), undefined);
  source.records.length = 0;
  const adopted = await NativeTranscript.adopt(storage, source.transcript);
  assert.equal(adopted.total, 0, "retrying a refused adoption succeeds without partial-generation state");
  await storage.close(context);
});

for (const backend of ["memory", "postgres"] as const) test(`native transcript commits write what they add, not the working set again (${backend})`, async () => {
  const storage: Storage = backend === "memory" ? new MemoryStorage() :
    await openPiStorage({ sessionId: randomUUID(), directory: "unused", db: (await testDatabase()).db });
  const written: Extract<StorageWrite, { type: "document.change" }>["content"][] = [];
  const commit = storage.commit.bind(storage);
  storage.commit = async (writes, at) => {
    for (const write of writes) if (write.type === "document.change") written.push(write.content);
    return commit(writes, at);
  };
  await importLegacyTranscript({ storage, sessionId: "test", records: [] });
  const transcript = await NativeTranscript.adopt(storage, legacy().transcript);
  const big = "x".repeat(2_000_000);
  await transcript.push({ role: "user", content: big, timestamp: 1 } as any);
  written.length = 0;
  await transcript.setActive(true);
  for (let i = 0; i < 20; i++) await transcript.push({ role: "user", content: `small ${i}`, requestId: `r${i}`, timestamp: 2 + i } as any);
  await transcript.setActive(false);
  assert.equal(written.length, 22);
  for (const content of written) {
    assert.equal(content.kind, "delta");
    assert.ok(JSON.stringify(content).length < 10_000, "a delta never carries the earlier working set");
  }
  const reopened = (await NativeTranscript.open(storage))!;
  assert.deepEqual(reopened.snapshot(), transcript.snapshot(), "base + deltas reload the same state");

  // A change that is not an append (here a retraction) writes the whole state as a new base.
  written.length = 0;
  await reopened.commit(() => [{ t: "retract" }]);
  assert.deepEqual(written.map(content => content.kind), ["base"]);
  for (let i = 0; i < 600; i++) await reopened.push({ role: "user", content: `more ${i}`, timestamp: 100 + i } as any);
  assert.ok(written.filter(content => content.kind === "base").length >= 2, "deltas are folded into a new base");
  assert.deepEqual((await NativeTranscript.open(storage))!.snapshot(), reopened.snapshot());
  await storage.close(context);
});

test("a host's import writes its archive and context once, in one commit with its generation, and exports the whole history", async () => {
  const storage = new MemoryStorage(), source = legacy();
  for (let i = 0; i < 300; i++) {
    await source.transcript.push({ role: "user", content: `request ${i}`, requestId: `request-${i}`, timestamp: i } as any);
    await source.transcript.push({ role: "assistant", content: [{ type: "text", text: `answer ${i}` }], api: "openai-completions", provider: "test", model: "fake",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: i } as any);
  }
  const commits: StorageWrite[][] = [];
  const commit = storage.commit.bind(storage);
  storage.commit = async (batch, at) => { commits.push([...batch]); return commit(batch, at); };
  const working = source.transcript.view();
  const { metadata, transcript } = await NativeTranscript.importLegacy(storage, source.transcript, { sessionId: "test", records: source.records, working });
  assert.ok(transcript);
  assert.equal(commits.length, 1, "the import, the generation and its document land together");
  const kinds = new Map<string, number>();
  for (const write of commits[0]) {
    const kind = write.type === "entry" ? write.value.kind : write.type;
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries(kinds), { conversation: 1, "camel.legacy.migration": 1, "camel.host.bootstrap": 1, "camel.host.archive": 5,
    "camel.legacy.context": 1, "camel.context.message": 599, submission: 300, "document.create": 1 }, "one archive, one context checkpoint (a head and one entry per message), no copies");
  assert.deepEqual(transcript.piCursor, { entryId: metadata.contextEntryId, index: -1 });
  assert.equal((await storage.findLatestHeadMarker(1 as any, undefined, context))?.id, metadata.contextEntryId);
  assert.ok(await transcript.hasRequest("request-0"));
  assert.deepEqual(await readMigratedLegacyRecords(storage), source.records);
  await validateLegacyMigration(storage, source.records);
  await transcript.setActive(true);
  await transcript.push({ role: "user", content: "new", requestId: "new", timestamp: 301 } as any);
  await transcript.setActive(false);
  const history = historyOf((await nativeTranscriptRecords(storage))!);
  assert.equal(history.length, 601, "export reads the generation's archive, then its records");
  assert.deepEqual(history.slice(0, 600), historyOf(source.records));
  const reopened = (await NativeTranscript.open(storage))!;
  assert.deepEqual(reopened.snapshot(), transcript.snapshot());

  // A node on the release before (a rolling deploy, a rollback) reads the same whole history, and finds Pi's context
  // checkpoint where it looks for one.
  assert.deepEqual(historyOf((await previous.nativeTranscriptRecords(storage))!), history);
  assert.deepEqual(await previous.latestDurableCursor(storage, 1 as any), { entryId: metadata.contextEntryId, index: -1 });
});
