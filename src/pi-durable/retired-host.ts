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

/** Native entries a streamed read keeps, at most, for the host records that name them; one not kept is read again. */
const NATIVE_CACHE = 256;
/** Entries per page of a streamed read: an archive block holds 128 records of any size, so a page holds few. */
const STREAM_PAGE = 8;

/**
 * `retiredRecords`, streamed: the records one at a time, the legacy log's first (`legacy`, streamed too), each archive
 * block's in turn, and a host record's message from the native entry it names. Memory holds a page of STREAM_PAGE
 * entries and at most NATIVE_CACHE native entries since the newest one a record named; a record naming one not held has
 * it read again. Nothing when the session has no enabled host generation.
 */
export async function* streamRetiredRecords(storage: Pick<Storage, "scanEntries">, legacy?: () => AsyncIterable<RetiredRecord>): AsyncIterable<RetiredRecord> {
  const bootstrap = await generation(storage);
  if (!bootstrap) return;
  if ((bootstrap.data as { archive?: string } | undefined)?.archive === "legacy-log") {
    if (!legacy) throw new Error("This session's history before its import is in its legacy log, which this read was not given");
    yield* legacy();
  }
  const pending = new Map<number, ReturnType<typeof durableEntryMessages>>();
  const native = async (id: number) => {
    const held = pending.get(id);
    if (held) return held;
    const entry = (await storage.scanEntries({ conversationId, minEntryId: id as EntryId, order: "ascending" }, 1, undefined, context)).items[0];
    return entry?.id === id ? durableEntryMessages(entry) : undefined;
  };
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanEntries({ conversationId, minEntryId: bootstrap.id as EntryId, order: "ascending" }, STREAM_PAGE, cursor, context);
    for (const entry of page.items) {
      if (entry.kind === ARCHIVE) yield* (entry.data as { records: RetiredRecord[] }).records;
      else if (entry.kind === RECORD) {
        const data = entry.data as { pi?: { entryId: number; index: number }; record?: RetiredRecord };
        if (data.pi) {
          const message = (await native(data.pi.entryId))?.find(item => item.cursor.index === data.pi!.index)?.message;
          if (!message) throw new Error("Native transcript references a missing message");
          for (const id of pending.keys()) if (id < data.pi.entryId) pending.delete(id);
          yield { t: "message", message, pi: data.pi };
        } else if (data.record) yield data.record;
      } else {
        const messages = durableEntryMessages(entry);
        if (messages.length) {
          pending.set(entry.id, messages);
          // The oldest first: kept in the order they were read.
          if (pending.size > NATIVE_CACHE) pending.delete(pending.keys().next().value!);
        }
      }
    }
    cursor = page.next;
  } while (cursor);
}

/**
 * `recordsHistory` over streamed records, holding only what is not yet settled. Messages are settled (handed to
 * `settle` in order, with where turns began among them) only when no later record takes them back (`final`, from a
 * first pass: `finalTotals`), never the newest HOLD_BACK, and only once at least `bytes` of them can go while at most
 * `bytes` stay: so held memory is about twice `bytes` plus a message, whatever the turns' lengths, and each settle is
 * `bytes` or more. A retraction reaching back past what was settled, or a reset after any, fails (neither happens with
 * `final` from the same records).
 */
export class HistoryWindow {
  static readonly HOLD_BACK = 4;
  /** Messages in the history so far, and where the held ones (not yet settled) begin. */
  total = 0;
  from = 0;
  /** The most message JSON (in characters) held at once: for tests. */
  maxHeldBytes = 0;
  private held: AgentMessage[] = [];
  private sizes: number[] = [];
  private heldBytes = 0;
  private turns: number[] = [];
  private readonly settle: (from: number, messages: AgentMessage[], turns: number[]) => Promise<void>;
  private readonly bytes: number;

  constructor(settle: (from: number, messages: AgentMessage[], turns: number[]) => Promise<void>, bytes: number) { this.settle = settle; this.bytes = bytes; }

  /** Apply `record`; `final`: no later record takes back a message before it (0: settle nothing yet). */
  async apply(record: RetiredRecord, final = 0) {
    if (record.t === "message") {
      const size = JSON.stringify(record.message).length;
      this.held.push(record.message); this.sizes.push(size); this.heldBytes += size; this.total++;
    } else if (record.t === "retract") {
      if (this.total <= this.from) throw new Error(`A retraction reaches back past message ${this.from}, which was settled`);
      this.held.pop(); this.heldBytes -= this.sizes.pop()!; this.total--;
      this.turns = this.turns.filter(turn => turn <= this.total);
    } else if (record.t === "turn" && record.active && this.turns.at(-1) !== this.total) this.turns.push(this.total);
    else if (record.t === "reset") {
      if (this.from) throw new Error("A reset after messages were settled");
      this.held = [...record.messages]; this.sizes = this.held.map(message => JSON.stringify(message).length);
      this.heldBytes = this.sizes.reduce((sum, size) => sum + size, 0); this.total = this.held.length;
      this.turns = userTurns(0, this.held);
    }
    this.maxHeldBytes = Math.max(this.maxHeldBytes, this.heldBytes);
    if (this.heldBytes < 2 * this.bytes) return;
    // The latest end that leaves at most `bytes` held after it, the newest HOLD_BACK always among them.
    let end = this.total, staying = 0;
    while (end > this.from && staying + this.sizes[end - 1 - this.from] <= this.bytes) staying += this.sizes[--end - this.from];
    end = Math.min(end, this.total - HistoryWindow.HOLD_BACK, final);
    if (end > this.from && this.heldBytes - this.bytesFrom(end) >= this.bytes) await this.flush(end);
  }

  /** The held messages' size from absolute index `index` on. */
  private bytesFrom(index: number) {
    let sum = 0;
    for (let at = index - this.from; at < this.sizes.length; at++) sum += this.sizes[at];
    return sum;
  }

  /** Settle the held messages before `end` (all of them, once the records end: `total`). */
  async flush(end: number) {
    if (end <= this.from) return;
    const count = end - this.from;
    await this.settle(this.from, this.held.slice(0, count), this.turns.filter(turn => turn >= this.from && turn < end));
    this.heldBytes -= this.sizes.slice(0, count).reduce((sum, size) => sum + size, 0);
    this.held = this.held.slice(count); this.sizes = this.sizes.slice(count); this.from = end;
    this.turns = this.turns.filter(turn => turn >= end);
  }
}

/**
 * For each of `records` (from the last reset on), how many of the history's messages no later record takes back: the
 * least the history's length is from that record on. Four bytes a record. With the index of the last reset.
 */
export async function finalTotals(records: AsyncIterable<RetiredRecord>): Promise<{ final: Int32Array; reset: number; count: number }> {
  let totals = new Int32Array(1024), count = 0, reset = 0, total = 0;
  for await (const record of records) {
    if (record.t === "message") total++;
    else if (record.t === "retract") total = Math.max(0, total - 1);
    else if (record.t === "reset") { total = record.messages.length; reset = count; }
    if (count === totals.length) { const grown = new Int32Array(totals.length * 2); grown.set(totals); totals = grown; }
    totals[count++] = total;
  }
  for (let index = count - 2; index >= 0; index--) totals[index] = Math.min(totals[index], totals[index + 1]);
  return { final: totals.subarray(0, count), reset, count };
}
