import { nativeTranscriptRecords } from "./transcript.ts";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, Cursor, EntryId, Storage } from "@earendil-works/pi-durable";
import { Transcript, type PiMessageCursor, type TranscriptRecord } from "../transcript.ts";
import { durableEntryMessages, recoverDurableMessages } from "./agent.ts";
import { LEGACY_MIGRATION_KIND } from "./migration.ts";

export type PiJournal = Pick<Storage, "scanEntries">;
const after = (item: PiMessageCursor, cursor?: PiMessageCursor) => !cursor || item.entryId > cursor.entryId || item.entryId === cursor.entryId && item.index > cursor.index;

/** An import may contain millions of non-model archive entries before the initial context. Skip them on reload. */
async function recoveryCursor(storage: PiJournal, conversationId: ConversationId, cursor?: PiMessageCursor): Promise<PiMessageCursor | undefined> {
  if (cursor) return cursor;
  const marker = (await storage.scanEntries({ conversationId, order: "ascending" }, 1, undefined, context)).items[0];
  if (marker?.kind !== LEGACY_MIGRATION_KIND) return undefined;
  const metadata = marker.data as { contextEntryId?: number } | undefined;
  if (!Number.isSafeInteger(metadata?.contextEntryId) || metadata!.contextEntryId! < 1) throw new Error("Malformed Pi migration context cursor");
  return { entryId: metadata!.contextEntryId!, index: -1 };
}

/** Visit only the committed native tail, retaining at most a page of entries at a time. */
async function visitPiTail(transcript: Transcript, storage: PiJournal, conversationId: ConversationId | number,
  adopt: (record: Extract<TranscriptRecord, { t: "message" }>) => Promise<void>): Promise<number> {
  const id = conversationId as ConversationId;
  const start = await recoveryCursor(storage, id, transcript.piCursor);
  let cursor: Cursor | undefined;
  let appended = 0;
  do {
    const page = await storage.scanEntries({ conversationId: id, order: "ascending", ...(start ? { minEntryId: start.entryId as EntryId } : {}) }, 256, cursor, context);
    for (const entry of page.items) for (const item of durableEntryMessages(entry)) {
      if (!after(item.cursor, start)) continue;
      await adopt({ t: "message", message: item.message, pi: item.cursor });
      appended++;
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return appended;
}

/** Copy the committed native tail before repairing an interrupted turn. Caller must hold the session's exclusive claim. */
export async function reconcilePiTranscript(transcript: Transcript, storage: PiJournal, conversationId: ConversationId | number): Promise<number> {
  return visitPiTail(transcript, storage, conversationId, record => transcript.commit(() =>
    // The commit callback runs after any previously queued projection writes.
    after(record.pi!, transcript.piCursor) ? [record] : []));
}

/** Merge a native tail into a disposable read-only Transcript, e.g. a paged-history backlog. Never flushes its log. */
export async function projectPiTranscript(transcript: Transcript, storage: PiJournal, conversationId: ConversationId | number): Promise<number> {
  return visitPiTail(transcript, storage, conversationId, async record => {
    if (after(record.pi!, transcript.piCursor)) transcript.apply(record);
  });
}

/** Full-record archive API: merge a native tail without changing the legacy log or the live owner's storage. */
export async function projectPiRecords(records: readonly TranscriptRecord[], storage: PiJournal, conversationId: ConversationId | number): Promise<TranscriptRecord[]> {
  const native = await nativeTranscriptRecords(storage);
  if (native) return native;
  let cursor: PiMessageCursor | undefined;
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index];
    if (record.t === "pi") { cursor = record.cursor; break; }
    if (record.t === "message" && record.pi) { cursor = record.pi; break; }
  }
  const start = await recoveryCursor(storage, conversationId as ConversationId, cursor);
  const tail = await recoverDurableMessages(storage, conversationId, start);
  return [...records, ...tail.map(item => ({ t: "message" as const, message: item.message, pi: item.cursor }))];
}
