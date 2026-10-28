import { HttpError } from "./http.ts";
import { legacyFormatRefused } from "./protocol.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Storage } from "../shared/storage.ts";
import type { Db, Sql } from "./db.ts";
import { durableEntryMessages } from "./pi-durable/agent.ts";
import { ARCHIVE_KIND, fillOrdinals, historyPositions, MARKER_KIND } from "./pi-durable/ordinals.ts";

/** One message of a page, at its index in the agent's history. */
export type HistoryEntry = { index: number; message: AgentMessage };
/**
 * A page of history: whole turns, oldest first, ending where the request said (`before`) or at the
 * newest message. `next` is the `before` of the page older than this one, null at the start.
 * `split`: this page starts inside a turn (a size bound can split turns between messages).
 */
export type HistoryPage = { entries: HistoryEntry[]; next: number | null; total: number; split?: true };

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

type Piece = { start: number; count: number; bytes: number; turns: number[]; row?: number; skip?: number; chunk?: ChunkRow };
type ChunkRow = { start: number; count: number; bytes: number; turns: number[]; hash: string };
type OrdinalRow = { id: string; msg_from: number; msg_count: number; msg_skip: number; bytes: string };

/** A user message's entry kinds: a turn that starts with one is a page boundary. */
const USER_KINDS = ["pi.user", "camel.user"];
const kindIs = (kinds: string[]) => `(${kinds.map(kind => `substr(m.record, 1, 200) LIKE '%"kind":"${kind}"%'`).join(" OR ")})`;

/**
 * An agent's history length (`history_next`, null: not placed), where its journal's messages begin (`journal`: its first
 * placed message that is not archived), and how many messages archive entries hold before that (`archived`).
 */
export async function placedExtent(db: Pick<Db, "query">, agent: string): Promise<{ history_next: number | null; journal: number; archived: number } | undefined> {
  const row = (await db.query<{ history_next: number | null; journal: number | null; archived: number }>(`
    select m.history_next, j.journal, (select coalesce(sum(a.msg_count), 0)::int from pi_durable_entries a where a.session_id = m.session_id
      and a.msg_from is not null and a.msg_count > 0 and a.msg_from < coalesce(j.journal, m.history_next)) as archived
    from pi_durable_metadata m left join lateral (select e.msg_from as journal from pi_durable_entries e where e.session_id = m.session_id
      and e.msg_from is not null and e.msg_count > 0 and substr(e.record, 1, 200) not like '%"kind":"${ARCHIVE_KIND}"%' order by e.msg_from limit 1) j on true
    where m.session_id = $1`, [agent])).rows[0];
  return row && { history_next: row.history_next, journal: row.journal ?? row.history_next ?? 0, archived: row.archived };
}

/** A history row's messages, its own history messages from `skip`, `count` of them. */
export function rowMessages(entry: EntryRecord, skip: number, count: number): AgentMessage[] {
  const all = entry.kind === MARKER_KIND ? (entry.data as unknown as { kept?: AgentMessage[] }).kept ?? []
    : entry.kind === ARCHIVE_KIND ? (entry.data as unknown as { messages: AgentMessage[] }).messages
    : durableEntryMessages(entry).map(item => item.message);
  return all.slice(skip, skip + count);
}

/**
 * An agent's history, read from Pi storage by ordinal (pi-durable/ordinals.ts): a page reads the index of its rows and
 * then only the rows it returns, never the journal from its start, and every read is bounded before it reads. History
 * before an agent's first placed message (retired host transcripts, imports and forks from before the archive) is in the
 * history index's chunks (Storage blobs, `agent_history_chunks`) until it moves into Pi (H3).
 */
export class HistoryIndex {
  readonly db: Db;
  readonly storage: Storage;
  constructor(db: Db, storage: Storage) { this.db = db; this.storage = storage; }

  private key(agent: string, row: Pick<ChunkRow, "start" | "count" | "hash">) { return `sessions/${agent}/history/${row.start}-${row.count}-${row.hash}`; }

  /**
   * The agent's history length (`total`) and its first message in Pi storage (`from`: those before it are the index's).
   * An agent whose ordinals are not placed yet is placed first (`fillOrdinals`); one with no Pi storage has none.
   */
  async extent(agent: string): Promise<{ total: number; from: number }> {
    const read = () => placedExtent(this.db, agent);
    let row = await read();
    if (!row) return { total: 0, from: 0 };
    if (row.history_next === null) {
      const filled = await fillOrdinals(this.db, agent, { dryRun: false, maxEntries: LAZY_FILL_ENTRIES });
      // A journal with no base marker holds history only a legacy format had: refused, as a load refuses it.
      if (filled.code === "no_base") throw legacyFormatRefused(agent, undefined, "not_on_pi");
      if (filled.code !== "placed" && filled.code !== "current") throw new HttpError(503, `The agent's history cannot be read yet (${filled.code}${filled.error ? `: ${filled.error}` : ""})`);
      row = (await read())!;
    }
    // Archive entries hold every message before the journal's (a fork's, or moved from the index): Pi storage holds it all.
    return { total: row.history_next!, from: row.archived === row.journal ? 0 : row.journal };
  }

  /** Delete the agent's history index (Pi storage goes with the agent's), for an agent being purged. */
  async remove(agent: string, sql: Sql) {
    await this.storage.removeBlobs(`sessions/${agent}/history/`);
    await sql.query("delete from agent_history_chunks where agent = $1", [agent]);
    await sql.query("delete from agent_history_index where agent = $1", [agent]);
  }

  /**
   * The page of whole turns ending at `before` (default: the newest message), of at least `limit` messages where the
   * history has them and about PAGE_BYTES at most. `maxBytes` limits the serialized UTF-8 page, keeping at least one
   * message and allowing a page to start inside a turn.
   */
  async page(agent: string, { before, limit, maxBytes }: { before?: number; limit: number; maxBytes?: number }): Promise<HistoryPage> {
    const { total, from: placed } = await this.extent(agent);
    const end = Math.min(before ?? total, total);
    const pieces: Piece[] = [];
    // Rows newest first, then (before the first placed message) index chunks newest first.
    let cursor = end, chunkCursor = Math.min(end, placed);
    const more = async () => {
      if (cursor > placed) {
        const rows = (await this.db.query<OrdinalRow>(`select id, msg_from, msg_count, msg_skip, octet_length(record) as bytes from pi_durable_entries
          where session_id = $1 and msg_from < $2 and msg_from >= $4 and msg_count > 0 order by msg_from desc limit $3`, [agent, cursor, ROWS, placed])).rows;
        const low = rows.length === ROWS ? rows.at(-1)!.msg_from : placed;
        const turns = await this.turns(agent, low, cursor);
        for (const row of rows) pieces.push({ start: row.msg_from, count: Math.min(row.msg_count, end - row.msg_from), bytes: Number(row.bytes), row: Number(row.id), skip: row.msg_skip,
          turns: turns.filter(turn => turn >= row.msg_from && turn < row.msg_from + row.msg_count) });
        cursor = rows.length === ROWS ? low : placed;
        if (rows.length) return true;
      }
      if (chunkCursor <= 0) return false;
      const { rows } = await this.db.query<ChunkRow>("select start, count, bytes, turns, hash from agent_history_chunks where agent = $1 and start < $2 order by start desc limit $3", [agent, chunkCursor, 16]);
      for (const row of rows) pieces.push({ start: row.start, count: Math.min(row.count, placed - row.start), bytes: row.bytes, turns: row.turns.filter(turn => turn < Math.min(end, placed)), chunk: row });
      chunkCursor = rows.length === 16 ? rows.at(-1)!.start : 0;
      return rows.length > 0;
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

  /** Every turn start in the history: the index chunks' before its first placed message, then by ordinal. */
  async allTurns(agent: string): Promise<number[]> {
    const { total, from: placed } = await this.extent(agent);
    const chunks = placed > 0 ? (await this.db.query<{ turns: number[] }>("select turns from agent_history_chunks where agent = $1 and start < $2 order by start", [agent, placed])).rows.flatMap(row => row.turns.filter(turn => turn < placed)) : [];
    return [...new Set([...chunks, ...await this.turns(agent, placed, total)])].sort((a, b) => a - b);
  }

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
    const { total, from: placed } = await this.extent(agent);
    const end = Math.min(to ?? total, total);
    if (from >= end) return [];
    const pieces: Piece[] = [];
    if (from < placed) {
      const { rows } = await this.db.query<ChunkRow>("select start, count, bytes, turns, hash from agent_history_chunks where agent = $1 and start < $2 and start + count > $3 order by start", [agent, Math.min(end, placed), from]);
      for (const row of rows) pieces.push({ start: row.start, count: Math.min(row.count, placed - row.start), bytes: row.bytes, turns: [], chunk: row });
      const covered = pieces.length ? pieces.at(-1)!.start + pieces.at(-1)!.count : from;
      if ((pieces[0]?.start ?? from) > from || covered < Math.min(end, placed)) throw new Error(`The history index of ${agent} does not hold messages ${from} to ${Math.min(end, placed)}`);
    }
    if (end > placed) {
      const { rows } = await this.db.query<OrdinalRow>(`select id, msg_from, msg_count, msg_skip, octet_length(record) as bytes from pi_durable_entries
        where session_id = $1 and msg_count > 0 and msg_from < $2 and msg_from + msg_count > $3 order by msg_from`, [agent, end, Math.max(from, placed)]);
      for (const row of rows) pieces.push({ start: row.msg_from, count: row.msg_count, bytes: Number(row.bytes), turns: [], row: Number(row.id), skip: row.msg_skip });
    }
    const loaded = await this.load(agent, pieces, limit);
    const messages: AgentMessage[] = [];
    pieces.forEach((piece, index) => loaded[index].forEach((message, offset) => {
      const at = piece.start + offset;
      if (at >= from && at < end) messages.push(message);
    }));
    if (messages.length !== end - from) throw new Error(`The history of ${agent} holds ${messages.length} of messages ${from} to ${end}`);
    return messages;
  }

  /** Each piece's messages: rows read in one statement, chunks from Storage; refused (413) past `limit` stored bytes. */
  private async load(agent: string, pieces: Piece[], limit: number): Promise<AgentMessage[][]> {
    const bytes = pieces.reduce((sum, piece) => sum + piece.bytes, 0);
    if (bytes > limit) throw new HttpError(413, `History messages ${pieces[0]?.start} to ${pieces.at(-1) && pieces.at(-1)!.start + pieces.at(-1)!.count} are ${bytes} bytes; one read is limited to ${limit} bytes. Read it in pages with limit/before/maxBytes.`);
    const ids = pieces.flatMap(piece => piece.row === undefined ? [] : [piece.row]);
    const records = new Map<number, EntryRecord>();
    if (ids.length) for (const row of (await this.db.query<{ id: string; record: string }>("select id, record from pi_durable_entries where session_id = $1 and id = any($2::bigint[])", [agent, ids])).rows) records.set(Number(row.id), JSON.parse(row.record));
    return Promise.all(pieces.map(async piece => {
      if (piece.chunk) {
        const stored = await this.storage.readBlob(this.key(agent, piece.chunk));
        if (!stored) throw new Error(`History chunk ${piece.chunk.start} of ${agent} is missing`);
        return (JSON.parse(Buffer.from(stored).toString("utf8")) as AgentMessage[]).slice(0, piece.count);
      }
      const record = records.get(piece.row!);
      if (!record) throw new Error(`History entry ${piece.row} of ${agent} is missing`);
      return rowMessages(record, piece.skip ?? 0, piece.count);
    }));
  }
}
