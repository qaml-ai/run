import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Transcript, historyOf, type TranscriptRecord } from "../src/transcript.ts";
import { NativeTranscript, nativeTranscriptRecords } from "../src/pi-durable/transcript.ts";
import { importLegacyTranscript, LegacyMigrationDeferred, MIGRATION_MAX_RECORDS } from "../src/pi-durable/migration.ts";
import type { AppendLog } from "../shared/append-log.ts";

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
