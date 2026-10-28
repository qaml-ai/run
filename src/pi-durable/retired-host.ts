import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Cursor, EntryId, EntryRecord, Storage } from "@earendil-works/pi-durable";
import { durableEntryMessages } from "./agent.ts";
import { SESSION_CONVERSATION_ID as conversationId, HOST_ARCHIVE_KIND as ARCHIVE, HOST_BOOTSTRAP_KIND as BOOTSTRAP, SEED_MARKER_KIND } from "./seed.ts";

/**
 * The host transcript's records, as releases before its removal wrote them (plans/host-transcript-removal.md): read
 * here, never written, for the history before each session's journal base, which its history index may still lack
 * (`retiredHistory`). Once every session's index covers its base, this and the records go (plans/journal-reclaim.md).
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

/**
 * `retiredRecords`, streamed: the records one at a time, the legacy log's first (`legacy`, streamed too), each archive
 * block's in turn, and a host record's message from the native entry it names. Memory holds a page of entries and the
 * native entries since the newest one a record named: an older one is let go, as records name Pi's messages in the
 * order Pi committed them (a record naming one let go fails the read). Nothing when the session has no enabled host
 * generation.
 */
export async function* streamRetiredRecords(storage: Pick<Storage, "scanEntries">, legacy?: () => AsyncIterable<RetiredRecord>): AsyncIterable<RetiredRecord> {
  const bootstrap = await generation(storage);
  if (!bootstrap) return;
  if ((bootstrap.data as { archive?: string } | undefined)?.archive === "legacy-log") {
    if (!legacy) throw new Error("This session's history before its import is in its legacy log, which this read was not given");
    yield* legacy();
  }
  const pending = new Map<number, ReturnType<typeof durableEntryMessages>>();
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanEntries({ conversationId, minEntryId: bootstrap.id as EntryId, order: "ascending" }, 64, cursor, context);
    for (const entry of page.items) {
      if (entry.kind === ARCHIVE) yield* (entry.data as { records: RetiredRecord[] }).records;
      else if (entry.kind === RECORD) {
        const data = entry.data as { pi?: { entryId: number; index: number }; record?: RetiredRecord };
        if (data.pi) {
          const message = pending.get(data.pi.entryId)?.find(item => item.cursor.index === data.pi!.index)?.message;
          if (!message) throw new Error("Native transcript references a missing message");
          for (const id of pending.keys()) if (id < data.pi.entryId) pending.delete(id);
          yield { t: "message", message, pi: data.pi };
        } else if (data.record) yield data.record;
      } else {
        const messages = durableEntryMessages(entry);
        if (messages.length) pending.set(entry.id, messages);
      }
    }
    cursor = page.next;
  } while (cursor);
}

/**
 * `recordsHistory` over streamed records, holding only the messages not yet settled: those from the latest turn's start
 * on, or the last WINDOW_MESSAGES of a longer turn. Settled messages go to `settle` in order once at least `bytes` of
 * them wait, with where turns began among them. A retraction that would reach back past them fails, and so does a reset
 * after any (callers start from the last reset).
 */
export class HistoryWindow {
  static readonly WINDOW_MESSAGES = 256;
  /** Messages in the history so far, and where the held ones (not yet settled) begin. */
  total = 0;
  from = 0;
  private held: AgentMessage[] = [];
  private sizes: number[] = [];
  private turns: number[] = [];
  private readonly settle: (from: number, messages: AgentMessage[], turns: number[]) => Promise<void>;
  private readonly bytes: number;

  constructor(settle: (from: number, messages: AgentMessage[], turns: number[]) => Promise<void>, bytes: number) { this.settle = settle; this.bytes = bytes; }

  async apply(record: RetiredRecord) {
    if (record.t === "message") { this.held.push(record.message); this.sizes.push(JSON.stringify(record.message).length); this.total++; }
    else if (record.t === "retract") {
      if (this.total <= this.from) throw new Error(`A retraction reaches back past message ${this.from}, which was settled`);
      this.held.pop(); this.sizes.pop(); this.total--;
      this.turns = this.turns.filter(turn => turn <= this.total);
    } else if (record.t === "turn" && record.active && this.turns.at(-1) !== this.total) this.turns.push(this.total);
    else if (record.t === "reset") {
      if (this.from) throw new Error("A reset after messages were settled");
      this.held = [...record.messages]; this.sizes = this.held.map(message => JSON.stringify(message).length); this.total = this.held.length;
      this.turns = userTurns(0, this.held);
    }
    if (this.sizes.reduce((sum, size) => sum + size, 0) >= this.bytes) {
      await this.flush(Math.max(this.turns.findLast(turn => turn > this.from) ?? this.from, this.total - HistoryWindow.WINDOW_MESSAGES));
    }
  }

  /** Settle the held messages before `end` (all of them: `total`). */
  async flush(end: number) {
    if (end <= this.from) return;
    const count = end - this.from;
    await this.settle(this.from, this.held.slice(0, count), this.turns.filter(turn => turn >= this.from && turn < end));
    this.held = this.held.slice(count); this.sizes = this.sizes.slice(count); this.from = end;
    this.turns = this.turns.filter(turn => turn >= end);
  }
}
