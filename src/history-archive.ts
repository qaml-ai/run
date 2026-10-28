import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { EntryId, StorageWrite } from "@earendil-works/pi-durable";
import type { Storage } from "../shared/storage.ts";
import { transaction, type Db, type Sql } from "./db.ts";
import { ARCHIVE_KIND } from "./pi-durable/ordinals.ts";
import { placedExtent } from "./history-pages.ts";
import { archiveEntries, SESSION_CONVERSATION_ID as conversationId } from "./pi-durable/seed.ts";
import { PostgresPiStorage } from "./pi-durable/storage.ts";

/**
 * The one-time move of history from before an agent's journal (the history index's chunks: retired host transcripts,
 * imports, forks before archive entries) into its Pi storage, as `camel.history.archive` entries placed at their
 * ordinals (plans/thin-host-slimdown-2.md §6.1 H3): POST /v1/operations/history-archive, then the index goes.
 *
 * It walks the `agents` table in id order, a batch at a time (read-only, statement timeouts), and moves each agent whose
 * first placed message is past 0, a chunk at a time: a chunk is read from Storage (about 1 MB), split per turn and
 * committed in one Pi commit, so memory holds one chunk and a stop leaves whole chunks moved (a chunk already moved,
 * whose first message an archive entry holds, is skipped: the move is resumable and idempotent). Agents a live node
 * holds, or with runs open, are skipped for a later call. A dry run (the default) reads chunk rows only.
 */
export const ARCHIVE_BUCKETS = [
  /** Every message is in Pi storage (its first placed message is 0), or it has no history. */
  "archived",
  /** Messages before the first placed one, which the index's chunks hold: to move. */
  "pending",
  /** Messages before the first placed one that the index's chunks do not hold (a gap): for a person. */
  "short",
  /** Not placed by ordinal yet (the ordinal fill's): its first placed message is not known. */
  "unplaced",
  /** No Pi storage. */
  "no_journal",
] as const;
export type ArchiveBucket = typeof ARCHIVE_BUCKETS[number];
export const ARCHIVE_GATE: readonly ArchiveBucket[] = ["pending", "short", "unplaced"];

/** `moved`: chunks were moved or duplicate archive entries removed (`duplicates`), and Pi storage holds it all now. */
export const ARCHIVE_CODES = ["moved", "would_move", "current", "skipped_busy", "short", "unplaced", "no_journal", "failed"] as const;
export type ArchiveCode = typeof ARCHIVE_CODES[number];
export type ArchiveResult = { agent: string; code: ArchiveCode; chunks?: number; messages?: number; bytes?: number; duplicates?: number; error?: string };

/** An agent's archive entries that repeat another's place (two moves of one chunk at once): all but the first of each. */
const DUPLICATES = `select id from (select id, row_number() over (partition by msg_from order by id) as n from pi_durable_entries
    where session_id = $1 and msg_from is not null and msg_count > 0 and substr(record, 1, 200) like '%"kind":"${ARCHIVE_KIND}"%') d where n > 1`;

/** Remove an agent's duplicate archive entries, under its metadata lock (its commits wait); how many. */
async function removeDuplicates(db: Db, agent: string): Promise<number> {
  return transaction(db, async sql => {
    await sql.query("select 1 from pi_durable_metadata where session_id = $1 for update", [agent]);
    const ids = (await sql.query<{ id: number }>(DUPLICATES, [agent])).rows.map(row => row.id);
    if (!ids.length) return 0;
    await sql.query("delete from pi_durable_entries where session_id = $1 and id = any($2::bigint[])", [agent, ids]);
    await sql.query("delete from pi_durable_record_ids where session_id = $1 and id = any($2::bigint[])", [agent, ids]);
    return ids.length;
  });
}

const BATCH = 500;
const BUDGET_MS = 20_000;
const MAX_BUDGET_MS = 25_000;
const STATEMENT_TIMEOUT_MS = 20_000;
const EXAMPLES = 20;
const RESULTS = 500;

/** A chunk row; `count` clipped to the first placed message, `stored` its blob's (whole) count. */
type ChunkRow = { start: number; count: number; stored: number; bytes: number; turns: number[]; hash: string };

/** Agents after $1 (purged ones left out). */
const AGENTS = "select a.id from agents a where a.id > $1 and a.purged_at is null order by a.id limit $2";

/** The index's chunks before `placed`, clipped there, in order; and whether they hold every message before it. */
async function chunksBefore(sql: Pick<Db, "query">, agent: string, placed: number): Promise<{ rows: ChunkRow[]; whole: boolean }> {
  const rows = (await sql.query<ChunkRow>("select start, count, bytes, turns, hash from agent_history_chunks where agent = $1 and start < $2 order by start", [agent, placed])).rows
    .map(row => ({ ...row, stored: row.count, count: Math.min(row.count, placed - row.start) }));
  let at = 0;
  for (const row of rows) { if (row.start !== at) return { rows, whole: false }; at = row.start + row.count; }
  return { rows, whole: at === placed };
}

/** Where an agent stands: its journal's first message, and whether archive entries hold all before it. */
async function bucketOf(db: Db, agent: string): Promise<{ bucket: ArchiveBucket; journal?: number }> {
  const extent = await placedExtent(db, agent);
  if (!extent) return { bucket: "no_journal" };
  if (extent.history_next === null) return { bucket: "unplaced" };
  if (extent.archived === extent.journal) return { bucket: "archived" };
  return { bucket: (await chunksBefore(db, agent, extent.journal)).whole ? "pending" : "short", journal: extent.journal };
}

/** Whether a live node holds the agent, or it has runs open or Pi tasks unfinished (as reclaim's check). */
async function busy(sql: Pick<Db, "query">, agent: string): Promise<boolean> {
  const { rows: [row] } = await sql.query(`select
    exists (select 1 from actor_owners o join runtime_nodes n on n.node = o.node and n.session = o.session
      where o.actor = $1 and n.expires_at > clock_timestamp()) as owned,
    coalesce((select pending_runs from agents where id = $1), false) as pending,
    exists (select 1 from pi_durable_tasks where session_id = $1 and status <> 'terminal') as tasks`, [agent]);
  return row.owned || row.pending || row.tasks;
}

/**
 * Move one agent's history before its first placed message into its Pi storage, a chunk per commit, until done or
 * `deadline`. Chunks whose first message an archive entry holds already are skipped.
 */
export async function archiveAgent(db: Db, storage: Storage, agent: string, options: { dryRun: boolean; deadline?: number; now?: () => number }): Promise<ArchiveResult> {
  // One move of an agent at a time, across nodes: two would both find a chunk unmoved and both move it.
  const lock = await db.connect();
  try {
    if (!(await lock.query<{ held: boolean }>("select pg_try_advisory_lock(hashtext('history-archive:' || $1)) as held", [agent])).rows[0].held) return { agent, code: "skipped_busy" };
    try { return await archiveLocked(db, storage, agent, options); }
    finally { await lock.query("select pg_advisory_unlock(hashtext('history-archive:' || $1))", [agent]); }
  } finally { lock.release(); }
}

async function archiveLocked(db: Db, storage: Storage, agent: string, options: { dryRun: boolean; deadline?: number; now?: () => number }): Promise<ArchiveResult> {
  const now = options.now ?? Date.now;
  const duplicates = options.dryRun ? (await db.query(DUPLICATES, [agent])).rowCount ?? 0 : await removeDuplicates(db, agent);
  const extra = duplicates ? { duplicates } : {};
  const { bucket, journal: placed } = await bucketOf(db, agent);
  if (bucket !== "pending" && bucket !== "short") return { agent, code: bucket === "archived" ? duplicates ? options.dryRun ? "would_move" : "moved" : "current" : bucket, ...extra };
  const { rows, whole } = await chunksBefore(db, agent, placed!);
  if (!whole) return { agent, code: "short", chunks: rows.length, ...extra };
  const bytes = rows.reduce((sum, chunk) => sum + chunk.bytes, 0);
  if (options.dryRun) return { agent, code: "would_move", chunks: rows.length, messages: placed, bytes, ...extra };
  if (await busy(db, agent)) return { agent, code: "skipped_busy" };
  const pi = await PostgresPiStorage.open(db, agent);
  let moved = 0, stoppedAt: number | undefined;
  try {
    for (const chunk of rows) {
      if (options.deadline !== undefined && now() >= options.deadline) { stoppedAt = chunk.start; break; }
      // Moved already (a call that stopped after it): its first message is an archive entry's.
      const held = (await db.query("select 1 from pi_durable_entries where session_id = $1 and msg_from = $2 and msg_count > 0 limit 1", [agent, chunk.start])).rowCount;
      if (held) continue;
      const stored = await storage.readBlob(`sessions/${agent}/history/${chunk.start}-${chunk.stored}-${chunk.hash}`);
      if (!stored) throw new Error(`History chunk ${chunk.start} of ${agent} is missing`);
      const body = Buffer.from(stored);
      if (createHash("sha256").update(body).digest("hex").slice(0, 32) !== chunk.hash) throw new Error(`History chunk ${chunk.start} of ${agent} does not match its hash`);
      const messages = (JSON.parse(body.toString("utf8")) as AgentMessage[]).slice(0, chunk.count);
      const writes: StorageWrite[] = [];
      for (const data of archiveEntries(messages, chunk.turns, chunk.start)) {
        writes.push({ type: "entry", value: { id: await pi.mintId<EntryId>(), conversationId, kind: ARCHIVE_KIND, data: JSON.parse(JSON.stringify(data)) } });
      }
      await pi.commit(writes, () => {}, context);
      moved++;
    }
  } finally { await pi.close(context); }
  if (stoppedAt !== undefined) return { agent, code: "failed", chunks: moved, messages: placed, bytes, ...extra, error: `stopped by the call's budget at message ${stoppedAt}; the next call goes on` };
  // Every chunk moved: archive entries must now hold every message before the journal's, or something else is wrong.
  const after = await bucketOf(db, agent);
  if (after.bucket !== "archived") return { agent, code: "failed", chunks: moved, messages: placed, bytes, ...extra, error: `after the move the agent is ${after.bucket}, not archived` };
  return { agent, code: moved || duplicates ? "moved" : "current", chunks: moved, messages: placed, bytes, ...extra };
}

type Counts = Record<ArchiveBucket | "agents_total", number>;
export class ArchiveCursorError extends Error {}
interface Walk { v: 1; kind: "coverage" | "move"; after: string; dryRun: boolean; counts: Counts; moves: Record<ArchiveCode, number>; examples: Partial<Record<ArchiveBucket, string[]>>; started: number; spent: number; calls: number }

const encode = (state: Walk) => Buffer.from(JSON.stringify(state)).toString("base64url");
function decode(cursor: string, kind: Walk["kind"]): Walk {
  let state: Walk;
  try { state = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new ArchiveCursorError("cursor is not one this endpoint gave"); }
  const ok = state && state.v === 1 && state.kind === kind && typeof state.after === "string" && typeof state.dryRun === "boolean"
    && Number.isFinite(state.started) && Number.isFinite(state.spent) && Number.isInteger(state.calls)
    && state.counts && [...ARCHIVE_BUCKETS, "agents_total"].every(name => Number.isInteger(state.counts[name as keyof Counts]))
    && state.moves && ARCHIVE_CODES.every(code => Number.isInteger(state.moves[code])) && state.examples && typeof state.examples === "object";
  if (!ok) throw new ArchiveCursorError("cursor is not one this endpoint gave");
  return state;
}

export interface ArchiveWalk {
  complete: boolean;
  next: string | null;
  counts: Counts;
  gate: { ready: boolean; blocking: ArchiveBucket[] };
  examples: Partial<Record<ArchiveBucket, string[]>>;
  dryRun?: boolean;
  moves?: Record<ArchiveCode, number>;
  results?: ArchiveResult[];
  generatedAt: string;
  durationMs: number;
  totalDurationMs: number;
  calls: number;
}

/**
 * Walk from `cursor` for `budgetMs`, counting agents by bucket (as found, before any move); `move` moves each pending
 * agent's history (`archiveAgent`) as it goes. An agent the budget stops mid-way is taken again by the next call.
 */
export async function archiveWalk(db: Db, storage: Storage, options: { cursor?: string; move?: { dryRun?: boolean }; budgetMs?: number; batch?: number; statementTimeoutMs?: number; now?: () => number }): Promise<ArchiveWalk> {
  const now = options.now ?? Date.now, started = now();
  const kind = options.move ? "move" : "coverage";
  const budget = Math.min(MAX_BUDGET_MS, Math.max(1, options.budgetMs ?? BUDGET_MS));
  const dryRun = options.move?.dryRun ?? true;
  const state: Walk = options.cursor ? decode(options.cursor, kind) : {
    v: 1, kind, after: "", dryRun, counts: Object.fromEntries([...ARCHIVE_BUCKETS, "agents_total"].map(name => [name, 0])) as Counts,
    moves: Object.fromEntries(ARCHIVE_CODES.map(code => [code, 0])) as Record<ArchiveCode, number>, examples: {}, started, spent: 0, calls: 0,
  };
  if (options.move && state.dryRun !== dryRun) throw new ArchiveCursorError(`this cursor is a ${state.dryRun ? "dry run's" : "move's"}; call with dryRun ${state.dryRun}`);
  const results: ArchiveResult[] = [];
  const size = options.batch ?? BATCH;
  const deadline = started + budget;
  let complete = false, stopped = false;
  while (!complete && !stopped) {
    const rows = await transaction(db, async (sql: Sql) => {
      await sql.query("set transaction isolation level repeatable read, read only");
      await sql.query(`set local statement_timeout = ${Math.max(1, Math.floor(options.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS))}`);
      return (await sql.query<{ id: string }>(AGENTS, [state.after, size])).rows;
    });
    for (const row of rows) {
      const { bucket } = await bucketOf(db, row.id);
      let taken = true;
      if (options.move && bucket === "pending") {
        let result: ArchiveResult;
        try { result = await archiveAgent(db, storage, row.id, { dryRun: state.dryRun, deadline, now }); }
        catch (error) { result = { agent: row.id, code: "failed", error: error instanceof Error ? error.message : String(error) }; }
        // Stopped by the budget mid-way: the next call takes the agent again, so it is not counted yet.
        if (result.code === "failed" && result.error?.startsWith("stopped by the call's budget")) { taken = false; stopped = true; }
        else {
          state.moves[result.code]++;
          if (results.length < RESULTS) results.push(result);
        }
      }
      if (!taken) break;
      state.counts.agents_total++;
      state.counts[bucket]++;
      if (bucket !== "archived" && bucket !== "no_journal") {
        const examples = state.examples[bucket] ??= [];
        if (examples.length < EXAMPLES) examples.push(row.id);
      }
      state.after = row.id;
      if (now() >= deadline) { stopped = true; break; }
    }
    if (stopped) break;
    if (rows.length < size) complete = true;
  }
  const durationMs = now() - started;
  state.spent += durationMs;
  state.calls++;
  const blocking = ARCHIVE_GATE.filter(name => state.counts[name] > 0);
  return {
    complete, next: complete ? null : encode(state), counts: state.counts, gate: { ready: complete && !blocking.length, blocking }, examples: state.examples,
    ...(options.move ? { dryRun: state.dryRun, moves: state.moves, results } : {}),
    generatedAt: new Date(state.started).toISOString(), durationMs, totalDurationMs: state.spent, calls: state.calls,
  };
}
