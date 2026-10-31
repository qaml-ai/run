import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Cursor, DocumentId, EntryId, EntryRecord, JsonObject, Storage, StorageWrite } from "@earendil-works/pi-durable";
import { durableEntryMessages } from "../../src/pi-durable/agent.ts";
import { SESSION_CONVERSATION_ID as conversationId, HOST_ARCHIVE_KIND as ARCHIVE, HOST_BOOTSTRAP_KIND as BOOTSTRAP, SEED_MARKER_KIND } from "../../src/pi-durable/seed.ts";

import { BASE_ADDRESS, baseWrites, JournalHistory, type HistoryBase } from "../../src/pi-durable/history.ts";
import { commitWrites } from "@earendil-works/pi-durable/testing";

/**
 * The host transcript's records and their retirement, as releases before the legacy readers' removal read and did them:
 * tests make sessions of the current format from them (`retireHostTranscript`), and read history the host transcript holds.
 */
export type RetiredRecord =
  | { t: "message"; message: AgentMessage; pi?: { entryId: number; index: number } }
  | { t: "pi"; cursor: { entryId: number; index: number } }
  | { t: "retract" }
  | { t: "turn"; active: boolean }
  | { t: "awaiting"; calls: string[]; released?: true }
  | { t: "reset"; messages: AgentMessage[] }
  | { t: "system" }
  | { t: "compaction" };

const RECORD = "camel.host.record", DISABLED = "camel.host.disabled";

/**
 * The latest host generation's marker, read back from the journal's end; undefined when none, or a later one disabled it
 * (unless `retired`: then also one its retirement disabled, whose records stay what they were).
 */
async function generation(storage: Pick<Storage, "scanEntries">, retired = false): Promise<EntryRecord | undefined> {
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanEntries({ conversationId, order: "descending" }, 128, cursor, context);
    for (const entry of page.items) {
      if (entry.kind === DISABLED && !(retired && (entry.data as { retired?: string } | undefined)?.retired)) return undefined;
      if (entry.kind === BOOTSTRAP) return entry;
    }
    cursor = page.next;
  } while (cursor);
}

/**
 * Every record the session's host generation holds, in order: an import too large to copy keeps its archive in the
 * session's legacy log, whose records come first (`legacy`). Undefined when the session has no host generation, or an
 * earlier release disabled it (`retired`: also read once its retirement has).
 */
export async function retiredRecords(storage: Pick<Storage, "scanEntries">, legacy?: () => Promise<RetiredRecord[]>, retired = false): Promise<RetiredRecord[] | undefined> {
  const bootstrap = await generation(storage, retired);
  if (!bootstrap) return undefined;
  const records: RetiredRecord[] = [];
  if ((bootstrap.data as { archive?: string } | undefined)?.archive === "legacy-log") {
    if (!legacy) throw new Error("This session's history before its import is in its legacy log, which this read was not given");
    records.push(...await legacy());
  }
  const pending = new Map<number, ReturnType<typeof durableEntryMessages>>();
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanEntries({ conversationId, minEntryId: bootstrap.id as EntryId, order: "ascending" }, 256, cursor, context);
    for (const entry of page.items) {
      if (entry.kind === ARCHIVE) records.push(...(entry.data as { records: RetiredRecord[] }).records);
      else if (entry.kind === RECORD) {
        const data = entry.data as { pi?: { entryId: number; index: number }; record?: RetiredRecord };
        if (data.pi) {
          const message = pending.get(data.pi.entryId)?.find(item => item.cursor.index === data.pi!.index)?.message;
          if (!message) throw new Error("Native transcript references a missing message");
          records.push({ t: "message", message, pi: data.pi });
        } else if (data.record) records.push(data.record);
      } else {
        const messages = durableEntryMessages(entry);
        if (messages.length) pending.set(entry.id, messages);
      }
    }
    cursor = page.next;
  } while (cursor);
  return records;
}

/** Where conversational turns begin in `messages` (absolute index `from` on) without turn records: at a user message after anything else, and at 0. */
function userTurns(from: number, messages: AgentMessage[]) {
  return messages.flatMap((message, index) => message.role === "user" && (from + index === 0 || messages[index - 1]?.role !== "user") ? [from + index] : []);
}

/** The history `records` give (messages, after retractions and resets), and where its turns began. */
export function recordsHistory(records: RetiredRecord[]): { messages: AgentMessage[]; turns: number[] } {
  let messages: AgentMessage[] = [], turns: number[] = [];
  for (const record of records) {
    if (record.t === "message") messages.push(record.message);
    else if (record.t === "retract") { messages.pop(); turns = turns.filter(turn => turn <= messages.length); }
    else if (record.t === "turn" && record.active && turns.at(-1) !== messages.length) turns.push(messages.length);
    else if (record.t === "reset") { messages = [...record.messages]; turns = userTurns(0, messages); }
  }
  // A turn begun with no message yet is kept: what follows (Pi's messages past the records) begins it.
  return { messages, turns: turns.filter(turn => turn <= messages.length) };
}

/**
 * The history of a session whose history is still only in the legacy format (its records in its legacy log: never
 * imported into a host generation, or rolled back off Pi by an earlier release), which this release refuses to start but
 * still reads: the log's records, then the native messages Pi committed past the newest one they name (or, with none, past
 * the seed's context checkpoint).
 */
export async function legacyHistory(storage: Pick<Storage, "scanEntries">, records: RetiredRecord[]): Promise<{ messages: AgentMessage[]; turns: number[] }> {
  const history = recordsHistory(records);
  let start: { entryId: number; index: number } | undefined;
  for (let index = records.length - 1; index >= 0 && !start; index--) {
    const record = records[index];
    start = record.t === "pi" ? record.cursor : record.t === "message" ? record.pi : undefined;
  }
  if (!start) {
    const marker = (await storage.scanEntries({ conversationId, order: "ascending" }, 1, undefined, context)).items[0];
    const entryId = marker?.kind === SEED_MARKER_KIND ? (marker.data as { contextEntryId?: number } | undefined)?.contextEntryId : undefined;
    if (entryId !== undefined) start = { entryId, index: -1 };
  }
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanEntries({ conversationId, order: "ascending", ...(start ? { minEntryId: start.entryId as EntryId } : {}) }, 256, cursor, context);
    for (const entry of page.items) for (const item of durableEntryMessages(entry)) {
      if (!start || item.cursor.entryId > start.entryId || item.cursor.entryId === start.entryId && item.cursor.index > start.index) history.messages.push(item.message);
    }
    cursor = page.next;
  } while (cursor);
  return { messages: history.messages, turns: history.turns.filter(turn => turn < history.messages.length) };
}

/** The host transcript's retirement, as releases from #374 to the readers' removal did it at a session's first load. */
/**
 * Retire a session's host transcript, once, as its first release without it loads the session. Its journal history
 * starts from the base marker an earlier release wrote, or else where the host's last snapshot stood (and so does one
 * written as a turn ran or waited on input, which holds none of that turn's messages): that base, with that turn's
 * messages before it (`kept`), is written then. Every settled message before the base the history index lacks is first indexed
 * from the host's records (`index`; the session's legacy log first, for an import too large to copy: `legacy`), so
 * none is only in them. Then, in one commit: the base, the base document, and the host document disabled and marked
 * `retired`, with a `camel.host.disabled` entry. An earlier release refuses the session from then on (its history
 * format is newer) rather than continue from that snapshot. False when there is no enabled host transcript to retire.
 */
export async function retireHostTranscript(storage: Storage, options: {
  indexed?: number;
  /** Index `messages` (the history's from `from`, where `turns` begin), as chunks; returns where the index ends then. */
  index?: (from: number, messages: AgentMessage[], turns: number[]) => Promise<number>;
  legacy?: () => Promise<RetiredRecord[]>;
} = {}): Promise<boolean> {
  const found = await JournalHistory.snapshotBase(storage);
  if (!found?.enabled) return false;
  const marker = await JournalHistory.findBase(storage);
  const marked = marker?.data as unknown as HistoryBase | undefined;
  const open = (base: HistoryBase) => (base.active || base.awaiting.length > 0) && base.turnStart < base.total;
  const keep = marked && !open(marked) ? marked : undefined;
  const base = keep ?? found.base;
  let history: ReturnType<typeof recordsHistory> | undefined;
  const records = async () => history ??= recordsHistory(await retiredRecords(storage, options.legacy) ?? []);
  if (!keep && open(base)) {
    // The running turn's messages before the base, whole (the snapshot's may start past a compaction within the turn).
    const all = (await records()).messages;
    if (all.length !== base.total) throw new Error(`The host's records hold ${all.length} messages, its snapshot ${base.total}`);
    base.kept = all.slice(base.turnStart);
  }
  const settled = open(base) ? base.turnStart : base.total;
  if (options.index && options.indexed !== undefined && options.indexed < settled) {
    const { messages, turns } = await records();
    if (messages.length < settled) throw new Error(`The host's records hold ${messages.length} messages, before its base ${settled}`);
    const indexed = await options.index(options.indexed, messages.slice(options.indexed, settled), turns);
    if (indexed < settled) throw new Error(`The history index ends at ${indexed}, before the journal's base ${settled}`);
  }
  const writes: StorageWrite[] = [];
  const existing = await JournalHistory.baseDocument(storage);
  if (!keep) writes.push(...baseWrites(await storage.mintId<EntryId>(), base, { id: existing ?? await storage.mintId<DocumentId>(), create: !existing }));
  else if (!existing) writes.push({ type: "document.create", record: { id: await storage.mintId<DocumentId>(), ...BASE_ADDRESS }, content: { version: 1, kind: "base", value: { entry: marker!.id } } });
  writes.push(
    { type: "entry", value: { id: await storage.mintId<EntryId>(), conversationId, kind: "camel.host.disabled", data: { retired: "journal" } } },
    { type: "document.change", id: found.documentId, content: { version: 1, kind: "base", value: { ...found.value, enabled: false, retired: "journal" } as JsonObject } },
  );
  await commitWrites(storage, writes, context);
  return true;
}
