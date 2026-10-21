/**
 * The host history reader and native cursor scan as released before #322 (dd9d78e8), verbatim but for imports. A node
 * still on that release (a rolling deploy, a rollback) reads sessions this release imports with these.
 */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, Cursor, EntryId, Storage } from "@earendil-works/pi-durable";
import type { TranscriptRecord } from "../../src/transcript.ts";
import { durableEntryMessages, type DurableCursor } from "../../src/pi-durable/agent.ts";

const conversationId = 1 as ConversationId;
const BOOTSTRAP = "camel.host.bootstrap", ARCHIVE = "camel.host.archive", RECORD = "camel.host.record", DISABLED = "camel.host.disabled";
const nativeKinds = new Set(["pi.user", "pi.assistant", "pi.tool-result", "camel.user", "camel.message"]);

async function generation(storage: Pick<Storage, "scanEntries">): Promise<number | undefined> {
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanEntries({ conversationId, order: "descending" }, 128, cursor, context);
    for (const entry of page.items) {
      if (entry.kind === DISABLED) return undefined;
      if (entry.kind === BOOTSTRAP) return entry.id;
    }
    cursor = page.next;
  } while (cursor);
}

export async function nativeTranscriptRecords(storage: Pick<Storage, "scanEntries">): Promise<TranscriptRecord[] | undefined> {
  const start = await generation(storage);
  if (!start) return undefined;
  const records: TranscriptRecord[] = [];
  const pending = new Map<number, ReturnType<typeof durableEntryMessages>>();
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanEntries({ conversationId, minEntryId: start as EntryId, order: "ascending" }, 256, cursor, context);
    for (const entry of page.items) {
      if (entry.kind === ARCHIVE) records.push(...(entry.data as any).records);
      else if (entry.kind === RECORD) {
        const data = entry.data as any;
        if (data.pi) {
          const message = pending.get(data.pi.entryId)?.find(item => item.cursor.index === data.pi.index)?.message;
          if (!message) throw new Error("Native transcript references a missing message");
          records.push({ t: "message", message, pi: data.pi });
          const remaining = pending.get(data.pi.entryId)!.filter(item => item.cursor.index !== data.pi.index);
          if (remaining.length) pending.set(data.pi.entryId, remaining); else pending.delete(data.pi.entryId);
        } else {
          records.push(data.record);
          if (data.record.t === "pi") for (const id of pending.keys()) if (id <= data.record.cursor.entryId) pending.delete(id);
        }
      } else {
        const messages = durableEntryMessages(entry);
        if (messages.length) pending.set(entry.id, messages);
      }
    }
    cursor = page.next;
  } while (cursor);
  for (const items of pending.values()) for (const item of items) records.push({ t: "message", message: item.message, pi: item.cursor });
  return records;
}

export async function latestDurableCursor(storage: Storage, conversationId: ConversationId): Promise<DurableCursor | undefined> {
  let cursor;
  do {
    const page = await storage.scanEntries({ conversationId, order: "descending" }, 64, cursor, context);
    for (const entry of page.items) if (nativeKinds.has(entry.kind) && entry.model?.length) {
      return { entryId: entry.id, index: entry.model.length - 1 };
    } else if (entry.kind === "camel.legacy.context") {
      return { entryId: entry.id, index: -1 };
    }
    cursor = page.next;
  } while (cursor !== undefined);
}
