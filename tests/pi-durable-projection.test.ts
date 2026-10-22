import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, EntryId, Storage } from "@earendil-works/pi-durable";
import { fileAppendLog } from "../shared/append-log.ts";
import { Transcript, type TranscriptRecord } from "../src/transcript.ts";
import { seedWithoutGeneration } from "./fixtures/pi-seed-before-322.ts";
import { projectPiRecords, projectPiTranscript, reconcilePiTranscript } from "../src/pi-durable/projection.ts";
import { openPiJournalReader, openPiStorage } from "../src/pi-durable/storage.ts";
import { testDatabase } from "./database.ts";
const database = testDatabase();
const user = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
const root = 1 as ConversationId;

for (const mode of ["sqlite", "postgres"] as const) {
  test(`Pi ${mode}: read-only native projection recovers a committed tail exactly once`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-project-"));
    const options = { sessionId: randomUUID(), directory, ...(mode === "postgres" ? { db: (await database).db } : {}) };
    const storage = await openPiStorage(options);
    try {
      const records: TranscriptRecord[] = [{ t: "message", message: user("legacy") }];
      const migration = await seedWithoutGeneration(storage, options.sessionId, records);
      const native = await storage.mintId<EntryId>();
      await storage.commit([{ type: "entry", value: { id: native, conversationId: root, kind: "pi.user", model: [user("committed"), user("second in entry")] as any } }], context);
      const before = mode === "sqlite" ? await readFile(join(directory, "pi-durable.sqlite")) : undefined;
      const reader = await openPiJournalReader(options);
      assert.ok(reader);
      const merged = await projectPiRecords(records, reader, root);
      assert.equal(merged.length, 3);
      assert.deepEqual(records, [{ t: "message", message: user("legacy") }], "read projection leaves the source records alone");
      assert.deepEqual(await projectPiRecords(merged, reader, root), merged);
      const suppressed: TranscriptRecord[] = [...records, { t: "pi", cursor: { entryId: native, index: 1 } }];
      assert.deepEqual(await projectPiRecords(suppressed, reader, root), suppressed, "intentional t:pi suppression is retained");
      const partiallyCopied = [...records, merged[1]];
      assert.deepEqual(await projectPiRecords(partiallyCopied, reader, root), merged, "mid-entry cursor recovers only the missing message");
      const disposable = new Transcript({ append() { throw new Error("read projection must never write"); }, read: async () => records } as any, 0, Infinity);
      records.forEach(record => disposable.apply(record));
      assert.equal(await projectPiTranscript(disposable, reader, root), 2);
      assert.equal(disposable.backlog?.messages.length, 3);
      assert.equal(await projectPiTranscript(disposable, reader, root), 0);
      await reader.close(context);
      if (before) assert.deepEqual(await readFile(join(directory, "pi-durable.sqlite")), before, "read-only open and close do not checkpoint or modify the database");

      const file = join(directory, "transcript.jsonl");
      const log = fileAppendLog<TranscriptRecord>(file);
      await log.rewrite(() => records);
      const transcript = new Transcript(log);
      await transcript.load();
      let min: number | undefined;
      const bounded = { scanEntries: async (...args: Parameters<Storage["scanEntries"]>) => {
        if (args[0].minEntryId !== undefined) min = args[0].minEntryId;
        return storage.scanEntries(...args);
      } };
      assert.equal(await reconcilePiTranscript(transcript, bounded, root), 2);
      assert.equal(min, migration.contextEntryId, "the initial recovery skips archived records");
      assert.equal(await reconcilePiTranscript(transcript, storage, root), 0);
      await log.close();
      const reopened = new Transcript(fileAppendLog<TranscriptRecord>(file));
      await reopened.load();
      assert.deepEqual(reopened.context, [user("legacy"), user("committed"), user("second in entry")]);
      assert.equal(await reconcilePiTranscript(reopened, storage, root), 0);
      await reopened.log.close();
    } finally { await storage.close(context); await rm(directory, { recursive: true, force: true }); }
  });
}

test("Pi read-only probe never creates a missing local directory", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-readonly-missing-"));
  try {
    assert.equal(await openPiJournalReader({ sessionId: "missing", directory: join(parent, "missing") }), undefined);
    assert.deepEqual(await readdir(parent), []);
  } finally { await rm(parent, { recursive: true, force: true }); }
});


test("Pi read-only journal skips deferred migration namespaces without a root", async () => {
  const { db } = await database;
  const sessionId = randomUUID();
  const storage = await openPiStorage({ sessionId, directory: "unused", db });
  assert.equal(await openPiJournalReader({ sessionId, directory: "unused", db }), undefined);
  await storage.close(context);
  const directory = await mkdtemp(join(tmpdir(), "pi-readonly-empty-"));
  try {
    const local = await openPiStorage({ sessionId, directory });
    assert.equal(await openPiJournalReader({ sessionId, directory }), undefined);
    await local.close(context);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
