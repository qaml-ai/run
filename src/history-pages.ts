import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Storage } from "../shared/storage.ts";
import { underClaim, type Claim } from "./ownership.ts";
import type { Db, Sql } from "./db.ts";
import type { Backlog } from "./transcript.ts";

/** Messages from absolute index `start`, and where turns begin among them. */
export type HistoryChunk = { start: number; messages: AgentMessage[]; turns: number[] };
/** One message of a page, at its index in the agent's history. */
export type HistoryEntry = { index: number; message: AgentMessage };
/**
 * A page of history: whole turns, oldest first, ending where the request said (`before`) or at the
 * newest message. `next` is the `before` of the page older than this one, null at the start.
 * `split`: one turn alone was larger than a page, so this page starts inside it.
 */
export type HistoryPage = { entries: HistoryEntry[]; next: number | null; total: number; split?: true };

/** A chunk holds about this much; a turn larger than it is split between messages. */
export const CHUNK_BYTES = 1_000_000;
/** A page returns about this much at most, beyond its first turn. */
const PAGE_BYTES = 4_000_000;
/** Chunk rows read at a time while looking for where a page starts. */
const ROWS = 16;
/** Chunks read from Storage at once. */
const READS = 8;

/** Where turns begin among `messages` (from absolute `from`): run starts that begin with a user message, and index 0. */
export function boundaries(from: number, messages: AgentMessage[], turns: number[]) {
  const starts = turns.filter(turn => turn >= from && turn < from + messages.length && messages[turn - from].role === "user");
  return [...new Set(from === 0 && messages.length ? [0, ...starts] : starts)].sort((a, b) => a - b);
}

/**
 * The first `count` messages of a backlog as chunks of whole turns, each about CHUNK_BYTES at most;
 * a turn larger than that is split between its messages.
 */
export function chunksOf(backlog: Backlog, count = backlog.messages.length): HistoryChunk[] {
  const turns = boundaries(backlog.from, backlog.messages.slice(0, count), backlog.turns);
  const chunks: HistoryChunk[] = [];
  let start = 0, bytes = 0;
  const cut = (end: number) => {
    if (end <= start) return;
    chunks.push({ start: backlog.from + start, messages: backlog.messages.slice(start, end), turns: turns.filter(turn => turn >= backlog.from + start && turn < backlog.from + end) });
    start = end; bytes = 0;
  };
  for (let index = 0; index < count; index++) {
    const size = backlog.sizes[index];
    if (bytes && bytes + size > CHUNK_BYTES) {
      // Back to the latest turn start in the chunk, unless the chunk is one turn: then between messages.
      const turn = turns.findLast(turn => turn > backlog.from + start && turn <= backlog.from + index);
      const end = turn !== undefined ? turn - backlog.from : index;
      cut(end);
      for (let kept = end; kept < index; kept++) bytes += backlog.sizes[kept];
    }
    bytes += size;
  }
  cut(count);
  return chunks;
}

type Row = { start: number; count: number; bytes: number; turns: number[]; hash: string };
type Piece = Omit<Row, "hash"> & { hash?: string; messages?: AgentMessage[] };

/**
 * An agent's history as pages: chunks of its settled messages in Storage, and their index in
 * Postgres. The owner writes a chunk once its turn has settled (or its turn grows past a chunk);
 * what is newer comes from the running agent. So a page reads a few index rows and the chunks it
 * returns, never the whole log, and a settled page never changes.
 */
export class HistoryIndex {
  readonly db: Db;
  readonly storage: Storage;
  constructor(db: Db, storage: Storage) { this.db = db; this.storage = storage; }

  private key(agent: string, row: Pick<Row, "start" | "count" | "hash">) { return `sessions/${agent}/history/${row.start}-${row.count}-${row.hash}`; }

  /** Whether the agent is not deleted (`lock`: and keep it so until the transaction ends). */
  private async live(agent: string, sql: Sql, lock = false) {
    return !!(await sql.query(`select 1 from agents where id = $1 and not revoked and purged_at is null${lock ? " for share" : ""}`, [agent])).rowCount;
  }

  /** Start a new agent's index, empty. */
  async begin(agent: string) {
    await this.db.query("insert into agent_history_index (agent, indexed) values ($1, 0) on conflict (agent) do nothing", [agent]);
  }

  /** How many of the agent's messages the chunks cover; undefined for an agent never indexed. */
  async indexed(agent: string): Promise<number | undefined> {
    return (await this.db.query("select indexed from agent_history_index where agent = $1", [agent])).rows[0]?.indexed;
  }

  /**
   * Write a chunk where the index ends, under the owner's claim; returns where the index ends now.
   * A chunk that does not start there (another writer indexed these messages first) is not written.
   */
  async write(agent: string, claim: Claim | undefined, chunk: HistoryChunk): Promise<number> {
    const count = chunk.messages.length;
    const body = Buffer.from(JSON.stringify(chunk.messages));
    const hash = createHash("sha256").update(body).digest("hex").slice(0, 32);
    // A deleted agent's history is purged, never written again: checked before the blob, so none is left behind,
    // and again with the row, locking the agent's, so a purge cannot come between.
    if (!await this.live(agent, this.db)) throw new Error(`Agent ${agent} is deleted; its history is not written`);
    await this.storage.writeBlob(this.key(agent, { start: chunk.start, count, hash }), body);
    return underClaim(this.db, claim, async sql => {
      if (!await this.live(agent, sql, true)) throw new Error(`Agent ${agent} is deleted; its history is not written`);
      await sql.query("insert into agent_history_index (agent, indexed) values ($1, 0) on conflict (agent) do nothing", [agent]);
      const indexed: number = (await sql.query("select indexed from agent_history_index where agent = $1 for update", [agent])).rows[0].indexed;
      if (indexed !== chunk.start || !count) return indexed;
      await sql.query("insert into agent_history_chunks (agent, start, count, bytes, turns, hash) values ($1, $2, $3, $4, $5, $6)", [agent, chunk.start, count, body.length, chunk.turns, hash]);
      await sql.query("update agent_history_index set indexed = $2 where agent = $1", [agent, chunk.start + count]);
      return chunk.start + count;
    });
  }

  /** Delete the agent's chunks and index, for an agent being purged. */
  async remove(agent: string, sql: Sql) {
    await this.storage.removeBlobs(`sessions/${agent}/history/`);
    await sql.query("delete from agent_history_chunks where agent = $1", [agent]);
    await sql.query("delete from agent_history_index where agent = $1", [agent]);
  }

  /**
   * The page of whole turns ending at `before` (default: the newest message), of at least `limit`
   * messages where the history has them and about PAGE_BYTES at most. `tail` is what the chunks do
   * not have yet: the running agent's backlog.
   */
  async page(agent: string, { before, limit }: { before?: number; limit: number }, tail?: Pick<Backlog, "from" | "messages" | "turns">): Promise<HistoryPage> {
    const indexed = (await this.indexed(agent)) ?? 0;
    // Chunks below the tail; any the running agent has written since it answered are in its tail too.
    const below = tail ? tail.from : indexed;
    const total = tail ? tail.from + tail.messages.length : indexed;
    const end = Math.min(before ?? total, total);
    const pieces: Piece[] = [];
    if (tail && end > tail.from) {
      // One piece per turn, newest first, as chunks are: a page's size is counted a turn at a time.
      const messages = tail.messages.slice(0, end - tail.from);
      const turns = boundaries(tail.from, messages, tail.turns);
      const starts = [...new Set([tail.from, ...turns])];
      for (let index = starts.length - 1; index >= 0; index--) {
        const part = messages.slice(starts[index] - tail.from, (starts[index + 1] ?? end) - tail.from);
        pieces.push({ start: starts[index], count: part.length, bytes: part.reduce((sum, message) => sum + JSON.stringify(message).length, 0), turns: turns.includes(starts[index]) ? [starts[index]] : [], messages: part });
      }
    }
    let cursor = Math.min(end, below);
    const more = async () => {
      if (cursor <= 0) return false;
      const { rows } = await this.db.query("select start, count, bytes, turns, hash from agent_history_chunks where agent = $1 and start < $2 order by start desc limit $3", [agent, cursor, ROWS]);
      for (const row of rows as Row[]) pieces.push({ ...row, turns: row.turns.filter(turn => turn < end) });
      cursor = rows.length === ROWS ? rows.at(-1).start : 0;
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
      // One turn larger than a page: the page starts inside it, at a chunk.
      if (bytes > PAGE_BYTES && previous === undefined) { start = piece.start; split = true; break; }
    }
    start ??= previous ?? (pieces.length ? pieces.at(-1)!.start : end);
    const needed = pieces.filter(piece => piece.count > 0 && piece.start + piece.count > start! && piece.start < end);
    const loaded = await mapLimit(needed, READS, async piece => piece.messages ?? this.read(agent, piece as Row));
    const entries: HistoryEntry[] = [];
    needed.forEach((piece, index) => loaded[index].forEach((message, offset) => {
      const at = piece.start + offset;
      if (at >= start! && at < end) entries.push({ index: at, message });
    }));
    entries.sort((a, b) => a.index - b.index);
    return { entries, next: start > 0 ? start : null, total, ...(split ? { split: true as const } : {}) };
  }

  private async read(agent: string, row: Row): Promise<AgentMessage[]> {
    const stored = await this.storage.readBlob(this.key(agent, row));
    if (!stored) throw new Error(`History chunk ${row.start} of ${agent} is missing`);
    return JSON.parse(Buffer.from(stored).toString("utf8"));
  }
}

/** `work` over `items`, at most `limit` at once; results in order. */
async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const index = next++; results[index] = await work(items[index]); } }));
  return results;
}
