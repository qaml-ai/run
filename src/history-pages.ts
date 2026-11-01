import { HttpError } from "./http.ts";
import { legacyFormatRefused } from "./protocol.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Db } from "./db.ts";
import { durableEntryMessages } from "./pi-durable/agent.ts";
import { ARCHIVE_KIND, fillOrdinals, historyPositions, MARKER_KIND } from "./pi-durable/ordinals.ts";

/** One message of a page, at its index in the agent's history. */
export type HistoryEntry = { index: number; message: AgentMessage };
/**
 * A page of history: whole turns, oldest first, ending where the request said (`before`) or at the
 * newest message; a forward page (`after`) starts there instead. `next` is the `before` of the page older
 * than this one, null at the start. `split`: this page starts or ends inside a turn (a size bound can split
 * turns between messages). A forward page also says `nextAfter`: the `after` of the page newer than this one.
 * `truncated`: the history does not reach back to `after` (compacted away, or past its end).
 */
export type HistoryPage = { entries: HistoryEntry[]; next: number | null; total: number; split?: true; nextAfter?: number; truncated?: true };

/** Full-history reads (export, fork) may load at most this many stored UTF-8 bytes. */
export const FULL_HISTORY_READ_BYTES = 64 * 1024 * 1024;
/** A page returns about this much at most, beyond its first turn. */
export const PAGE_BYTES = 4_000_000;
/** Rows read at a time while looking for where a page starts. */
const ROWS = 128;
/** The most stored bytes one page loads, whatever its turns: past it the page is refused, never read. */
const PAGE_READ_BYTES = 64 * 1024 * 1024;
/**
 * The most session entries a read places itself (an agent the operator's fill has not reached): the fill holds the
 * agent's commits while it runs, so a larger one waits for the operator's (503).
 */
const LAZY_FILL_ENTRIES = 20_000;

type Piece = { start: number; count: number; bytes: number; turns: number[]; row: number; skip: number };
type OrdinalRow = { id: string; msg_from: number; msg_count: number; msg_skip: number; bytes: string };

/** A user message's entry kinds: a turn that starts with one is a page boundary. */
const USER_KINDS = ["pi.user", "camel.user"];
const kindIs = (kinds: string[]) => `(${kinds.map(kind => `substr(m.record, 1, 200) LIKE '%"kind":"${kind}"%'`).join(" OR ")})`;

/** A history row's messages, its own history messages from `skip`, `count` of them. */
export function rowMessages(entry: EntryRecord, skip: number, count: number): AgentMessage[] {
  const all = entry.kind === MARKER_KIND ? (entry.data as unknown as { kept?: AgentMessage[] }).kept ?? []
    : entry.kind === ARCHIVE_KIND ? (entry.data as unknown as { messages: AgentMessage[] }).messages
    : durableEntryMessages(entry).map(item => item.message);
  return all.slice(skip, skip + count);
}

/**
 * An agent's history, read from Pi storage by ordinal (pi-durable/ordinals.ts): a page reads the sizes of its rows and
 * then only the rows it returns, never the journal from its start, and every read is bounded before it reads. History
 * from before an agent's journal (a fork's copy, retired host transcripts, imports) is archive entries placed before it.
 */
export class AgentHistory {
  readonly db: Db;
  constructor(db: Db) { this.db = db; }

  /**
   * The agent's history length. An agent whose ordinals are not placed yet is placed first (`fillOrdinals`); one with no
   * Pi storage has none.
   */
  async total(agent: string): Promise<number> {
    const read = async () => (await this.db.query<{ history_next: number | null }>("select history_next from pi_durable_metadata where session_id = $1", [agent])).rows[0];
    const row = await read();
    if (!row) return 0;
    if (row.history_next !== null) return row.history_next;
    const filled = await fillOrdinals(this.db, agent, { dryRun: false, maxEntries: LAZY_FILL_ENTRIES });
    // A journal with no base marker holds history only a legacy format had: refused, as a load refuses it.
    if (filled.code === "no_base") throw legacyFormatRefused(agent, undefined, "not_on_pi");
    if (filled.code !== "placed" && filled.code !== "current") throw new HttpError(503, `The agent's history cannot be read yet (${filled.code}${filled.error ? `: ${filled.error}` : ""})`);
    return (await read())!.history_next ?? 0;
  }

  /**
   * The page of whole turns ending at `before` (default: the newest message), of at least `limit` messages where the
   * history has them and about PAGE_BYTES at most. `maxBytes` limits the serialized UTF-8 page, keeping at least one
   * message and allowing a page to start inside a turn.
   */
  async page(agent: string, { before, limit, maxBytes }: { before?: number; limit: number; maxBytes?: number }): Promise<HistoryPage> {
    const total = await this.total(agent);
    const end = Math.min(before ?? total, total);
    const pieces: Piece[] = [];
    // Rows newest first.
    let cursor = end;
    const more = async () => {
      if (cursor > 0) {
        const rows = (await this.db.query<OrdinalRow>(`select id, msg_from, msg_count, msg_skip, octet_length(record) as bytes from pi_durable_entries
          where session_id = $1 and msg_from < $2 and msg_count > 0 order by msg_from desc limit $3`, [agent, cursor, ROWS])).rows;
        const low = rows.length === ROWS ? rows.at(-1)!.msg_from : 0;
        const turns = await this.turns(agent, low, cursor);
        for (const row of rows) pieces.push({ start: row.msg_from, count: Math.min(row.msg_count, end - row.msg_from), bytes: Number(row.bytes), row: Number(row.id), skip: row.msg_skip,
          turns: turns.filter(turn => turn >= row.msg_from && turn < row.msg_from + row.msg_count) });
        cursor = rows.length === ROWS ? low : 0;
        return rows.length > 0;
      }
      return false;
    };
    // Back through turn starts, newest first, until the page has `limit` messages or would pass its size.
    let start: number | undefined, previous: number | undefined, split = false, bytes = 0;
    search: for (let index = 0; index < pieces.length || await more(); index++) {
      const piece = pieces[index];
      bytes += piece.bytes;
      for (const turn of [...piece.turns].reverse()) {
        if (bytes > PAGE_BYTES && previous !== undefined) { start = previous; break search; }
        previous = turn;
        if (end - turn >= limit) { start = turn; break search; }
      }
      // One turn larger than a page: the page starts inside it, at a row.
      if (bytes > PAGE_BYTES && previous === undefined) { start = piece.start; split = true; break; }
    }
    start ??= previous ?? (pieces.length ? pieces.at(-1)!.start : end);
    const needed = pieces.filter(piece => piece.count > 0 && piece.start + piece.count > start! && piece.start < end);
    const loaded = await this.load(agent, needed, PAGE_READ_BYTES);
    const entries: HistoryEntry[] = [];
    needed.forEach((piece, index) => loaded[index].forEach((message, offset) => {
      const at = piece.start + offset;
      if (at >= start! && at < end) entries.push({ index: at, message });
    }));
    entries.sort((a, b) => a.index - b.index);
    if (maxBytes !== undefined && entries.length) {
      // Keep a suffix of the normal page. Count UTF-8 bytes of the response, including indexes,
      // commas and the envelope; a message is indivisible, so the newest always survives.
      const turns = new Set(pieces.flatMap(piece => piece.turns));
      let first = entries.length - 1, entryBytes = 0;
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index];
        const candidateBytes = entryBytes + Buffer.byteLength(JSON.stringify(entry)) + (entryBytes ? 1 : 0);
        const envelope = { entries: [], next: entry.index > 0 ? entry.index : null, total, ...(!turns.has(entry.index) ? { split: true as const } : {}) };
        if (index < entries.length - 1 && candidateBytes + Buffer.byteLength(JSON.stringify(envelope)) > maxBytes) break;
        first = index;
        entryBytes = candidateBytes;
      }
      const kept = entries.slice(first);
      start = kept[0].index;
      return { entries: kept, next: start > 0 ? start : null, total, ...(!turns.has(start) ? { split: true as const } : {}) };
    }
    return { entries, next: start > 0 ? start : null, total, ...(split ? { split: true as const } : {}) };
  }

  /**
   * The forward page: whole turns from `after` (a message index, usually a previous page's `nextAfter`), of at least
   * `limit` messages where the history has them and about PAGE_BYTES at most. `nextAfter` is one past the last message
   * returned (`total` once caught up), so a poller reads each new message once. An `after` the history does not reach
   * (older history compacted away, or past its end) is answered with what exists and `truncated: true` rather than an
   * error; `nextAfter` puts the caller back in step.
   */
  async pageAfter(agent: string, { after, limit, maxBytes }: { after: number; limit: number; maxBytes?: number }): Promise<HistoryPage> {
    const total = await this.total(agent);
    // Caught up, or past the end (the history shrank: the caller starts again from `total`).
    if (after >= total) return { entries: [], next: null, total, nextAfter: total, ...(after > total ? { truncated: true as const } : {}) };
    const pieces: Piece[] = [], found: number[] = [];
    let cursor = after;
    // Rows oldest first from the one holding `after`, each with the turn starts it holds.
    const more = async () => {
      if (cursor >= total) return false;
      const rows = (await this.db.query<OrdinalRow>(`select id, msg_from, msg_count, msg_skip, octet_length(record) as bytes from pi_durable_entries
        where session_id = $1 and msg_from < $2 and msg_from + msg_count > $3 and msg_count > 0 order by msg_from limit $4`, [agent, total, cursor, ROWS])).rows;
      if (!rows.length) return false;
      const high = Math.min(rows.at(-1)!.msg_from + rows.at(-1)!.msg_count, total);
      const turns = await this.turns(agent, cursor, high);
      for (const row of rows) {
        const piece: Piece = { start: row.msg_from, count: Math.min(row.msg_count, total - row.msg_from), bytes: Number(row.bytes), row: Number(row.id), skip: row.msg_skip, turns: [] };
        piece.turns = turns.filter(turn => turn >= piece.start && turn < piece.start + piece.count);
        pieces.push(piece);
        found.push(...piece.turns);
      }
      cursor = rows.at(-1)!.msg_from + rows.at(-1)!.msg_count;
      return true;
    };
    if (!await more()) return { entries: [], next: null, total, nextAfter: total, truncated: true };
    // History older than the rows kept (compaction, or a journal that starts past its beginning): the page starts
    // where the history does, and says so.
    const start = Math.max(after, pieces[0].start);
    const truncated = start > after;
    let turn = 0, index = 0, bytes = 0, end: number | undefined;
    // The next turn start after `from`, reading rows until it is found (none left: the history's end).
    const nextTurn = async (from: number): Promise<number | undefined> => {
      while (turn < found.length || await more()) {
        if (found[turn] > from) return found[turn];
        turn++;
      }
      return undefined;
    };
    // The bytes of the rows before `boundary`.
    const countThrough = async (boundary: number) => {
      while (index < pieces.length || await more()) {
        if (pieces[index].start >= boundary) break;
        bytes += pieces[index++].bytes;
      }
    };
    // Turn by turn until the page has `limit` messages or is about to pass PAGE_BYTES.
    for (let from = start; ;) {
      const boundary = await nextTurn(from) ?? total;
      await countThrough(boundary);
      if (bytes > PAGE_BYTES) {
        if (end !== undefined) break;
        // One turn larger than a page: end the page inside it, after the last row that fits.
        let sum = 0, cut = start;
        for (const piece of pieces.slice(0, index)) {
          if (sum + piece.bytes > PAGE_BYTES && cut > start) break;
          sum += piece.bytes;
          cut = Math.max(cut, Math.min(piece.start + piece.count, boundary));
        }
        end = Math.max(cut, start + 1);
        break;
      }
      end = boundary;
      if (boundary === total || boundary - start >= limit) break;
      from = boundary;
    }
    end ??= total;
    const needed = pieces.filter(piece => piece.start < end! && piece.start + piece.count > start);
    const loaded = await this.load(agent, needed, PAGE_READ_BYTES);
    const entries: HistoryEntry[] = [];
    needed.forEach((piece, pieceIndex) => loaded[pieceIndex].forEach((message, offset) => {
      const at = piece.start + offset;
      if (at >= start && at < end!) entries.push({ index: at, message });
    }));
    entries.sort((a, b) => a.index - b.index);
    const splitAt = (at: number) => (start !== 0 && !found.includes(start)) || (at !== total && !found.includes(at));
    const response = (kept: HistoryEntry[]): HistoryPage => {
      const last = kept.length ? kept.at(-1)!.index + 1 : total;
      return { entries: kept, next: kept[0]?.index ? kept[0].index : null, total, nextAfter: last, ...(truncated ? { truncated: true as const } : {}), ...(splitAt(last) ? { split: true as const } : {}) };
    };
    if (maxBytes !== undefined && entries.length) {
      // Keep a prefix of the normal page: the caller resumes at the end of what it got. Count UTF-8 bytes of the
      // response, including indexes, commas and the envelope; a message is indivisible, so the first always survives.
      const first = entries[0].index > 0 ? entries[0].index : null;
      let kept = 1, entryBytes = Buffer.byteLength(JSON.stringify(entries[0]));
      for (let at = 1; at < entries.length; at++) {
        const candidateBytes = entryBytes + Buffer.byteLength(JSON.stringify(entries[at])) + 1;
        const envelope = { entries: [], next: first, total, nextAfter: entries[at].index + 1, ...(truncated ? { truncated: true as const } : {}), ...(splitAt(entries[at].index + 1) ? { split: true as const } : {}) };
        if (candidateBytes + Buffer.byteLength(JSON.stringify(envelope)) > maxBytes) break;
        kept = at + 1;
        entryBytes = candidateBytes;
      }
      return response(entries.slice(0, kept));
    }
    return response(entries);
  }

  /**
   * Where turns start in [from, to): turn markers whose first message is a person's (a run a continue or a host message
   * opened is not a page boundary), and the history's first message.
   */
  async turns(agent: string, from: number, to: number): Promise<number[]> {
    if (from >= to) return [];
    // A turn marker's turn opens at the message placed where it stands; an archive entry opening a turn holds that message.
    const { rows } = await this.db.query<{ at: number }>(`select distinct t.msg_from as at from pi_durable_entries t
      where t.session_id = $1 and t.turn_start and t.msg_from >= $2 and t.msg_from < $3 and (t.msg_count > 0 or exists (select 1 from pi_durable_entries m
        where m.session_id = t.session_id and m.msg_from = t.msg_from and m.msg_count > 0 and m.msg_skip = 0 and ${kindIs(USER_KINDS)}))
      order by 1`, [agent, from, to]);
    return [...new Set([...from === 0 ? [0] : [], ...rows.map(row => row.at)])].sort((a, b) => a - b);
  }

  /** Every turn start in the history. */
  async allTurns(agent: string): Promise<number[]> { return this.turns(agent, 0, await this.total(agent)); }

  /** The journal cursor of history message `index` (its entry, and where in it); undefined for one archived or kept by a base. */
  async cursorAt(agent: string, index: number): Promise<{ entryId: number; index: number } | undefined> {
    const row = (await this.db.query<{ id: string; msg_from: number; msg_count: number; msg_skip: number; record: string }>(`select id, msg_from, msg_count, msg_skip, record from pi_durable_entries
      where session_id = $1 and msg_from <= $2 and msg_count > 0 order by msg_from desc limit 1`, [agent, index])).rows[0];
    if (!row || index >= row.msg_from + row.msg_count) return undefined;
    const entry = JSON.parse(row.record) as EntryRecord;
    if (entry.kind === MARKER_KIND || entry.kind === ARCHIVE_KIND) return undefined;
    const position = historyPositions(entry)[row.msg_skip + index - row.msg_from];
    return position === undefined ? undefined : { entryId: Number(row.id), index: position };
  }

  /**
   * The history's messages in [from, to) (to: its end), in order. Every stored byte they take is counted before any is
   * read: past `limit` the read is refused (413).
   */
  async messages(agent: string, from = 0, to?: number, limit = FULL_HISTORY_READ_BYTES): Promise<AgentMessage[]> {
    const total = await this.total(agent);
    const end = Math.min(to ?? total, total);
    if (from >= end) return [];
    const { rows } = await this.db.query<OrdinalRow>(`select id, msg_from, msg_count, msg_skip, octet_length(record) as bytes from pi_durable_entries
      where session_id = $1 and msg_count > 0 and msg_from < $2 and msg_from + msg_count > $3 order by msg_from`, [agent, end, from]);
    const pieces: Piece[] = rows.map(row => ({ start: row.msg_from, count: row.msg_count, bytes: Number(row.bytes), turns: [], row: Number(row.id), skip: row.msg_skip }));
    const loaded = await this.load(agent, pieces, limit);
    const messages: AgentMessage[] = [];
    pieces.forEach((piece, index) => loaded[index].forEach((message, offset) => {
      const at = piece.start + offset;
      if (at >= from && at < end) messages.push(message);
    }));
    if (messages.length !== end - from) throw new Error(`The history of ${agent} holds ${messages.length} of messages ${from} to ${end}`);
    return messages;
  }

  /** Each piece's messages, its rows read in one statement; refused (413) past `limit` stored bytes. */
  private async load(agent: string, pieces: Piece[], limit: number): Promise<AgentMessage[][]> {
    const bytes = pieces.reduce((sum, piece) => sum + piece.bytes, 0);
    if (bytes > limit) throw new HttpError(413, `History messages ${pieces[0]?.start} to ${pieces.at(-1) && pieces.at(-1)!.start + pieces.at(-1)!.count} are ${bytes} bytes; one read is limited to ${limit} bytes. Read it in pages with limit/before/maxBytes.`);
    const ids = pieces.map(piece => piece.row);
    const records = new Map<number, EntryRecord>();
    if (ids.length) for (const row of (await this.db.query<{ id: string; record: string }>("select id, record from pi_durable_entries where session_id = $1 and id = any($2::bigint[])", [agent, ids])).rows) records.set(Number(row.id), JSON.parse(row.record));
    return pieces.map(piece => {
      const record = records.get(piece.row);
      if (!record) throw new Error(`History entry ${piece.row} of ${agent} is missing`);
      return rowMessages(record, piece.skip, piece.count);
    });
  }
}
