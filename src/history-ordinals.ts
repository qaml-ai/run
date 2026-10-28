import { transaction, type Db, type Sql } from "./db.ts";
import { FILL_CODES, FILL_DEFAULT_ENTRIES, FILL_MAX_ENTRIES, fillOrdinals, type FillCode, type FillResult } from "./pi-durable/ordinals.ts";

/**
 * The operator's walk that places every agent's history entries by ordinal (pi-durable/ordinals.ts), and its coverage:
 * POST /v1/operations/history-ordinals and GET /v1/operations/history-ordinals-coverage. Both walk the `agents` table in
 * id order, a batch at a time (read-only, statement timeouts, a few indexed probes per agent), for a time budget, and
 * answer a cursor to go on from that carries the counts. The fill places the batch's unplaced agents one at a time
 * (`fillOrdinals`, each under its session's metadata lock); a dry run (the default) writes nothing.
 */
export const ORDINAL_BUCKETS = [
  /** Placed, with every session entry since: history reads find their messages by ordinal. */
  "placed",
  /** Pi storage with entries, never placed (sessions from before ordinals). */
  "unplaced",
  /** Placed, but with entries written since that were not (by a release before ordinals, during the deploy): placed again by the fill. */
  "stale",
  /** No Pi storage, or none with entries: nothing to place. */
  "no_journal",
] as const;
export type OrdinalBucket = typeof ORDINAL_BUCKETS[number];
/** The counts that must be 0 before history reads rely on ordinals alone. */
export const ORDINAL_GATE: readonly OrdinalBucket[] = ["unplaced", "stale"];

export const ORDINAL_BATCH = 500;
export const ORDINAL_BUDGET_MS = 20_000;
const MAX_BUDGET_MS = 25_000;
const STATEMENT_TIMEOUT_MS = 20_000;
export const ORDINAL_EXAMPLES = 20;
/** Fill results a call answers at most (`current` ones are counted, not listed). */
export const ORDINAL_RESULTS = 500;

/**
 * One batch's agents after $1 (purged ones left out), with their session's ordinal state and newest session entry:
 * per-agent index probes (the metadata row, and the newest entry by `pi_entries_conversation`).
 */
const AGENTS = `select a.id, m.session_id is not null as pi, m.history_next, m.history_last_id,
    (select e.id from pi_durable_entries e where e.session_id = a.id and e.conversation_id = 1 order by e.id desc limit 1) as last_id
  from agents a left join pi_durable_metadata m on m.session_id = a.id
  where a.id > $1 and a.purged_at is null order by a.id limit $2`;
type AgentRow = { id: string; pi: boolean; history_next: number | null; history_last_id: string | null; last_id: string | null };

const bucketOf = (row: AgentRow): OrdinalBucket => !row.pi ? "no_journal" : row.history_next === null ? "unplaced"
  : row.last_id !== null && Number(row.history_last_id ?? 0) < Number(row.last_id) ? "stale" : "placed";

/** One batch of agents after `after`, each in its bucket, in its own read-only transaction. */
export async function ordinalBatch(db: Db, after: string, size: number, statementTimeoutMs = STATEMENT_TIMEOUT_MS): Promise<{ agents: string[]; buckets: Map<string, OrdinalBucket> }> {
  const rows = await transaction(db, async (sql: Sql) => {
    await sql.query("set transaction isolation level repeatable read, read only");
    await sql.query(`set local statement_timeout = ${Math.max(1, Math.floor(statementTimeoutMs))}`);
    return (await sql.query<AgentRow>(AGENTS, [after, size])).rows;
  });
  return { agents: rows.map(row => row.id), buckets: new Map(rows.map(row => [row.id, bucketOf(row)])) };
}

type Counts = Record<OrdinalBucket | "agents_total", number>;
export class OrdinalCursorError extends Error {}

interface Walk { v: 1; kind: "coverage" | "fill"; after: string; dryRun: boolean; maxEntries: number; counts: Counts; fills: Record<FillCode, number>; examples: Partial<Record<OrdinalBucket, string[]>>; started: number; spent: number; calls: number }

const encode = (state: Walk) => Buffer.from(JSON.stringify(state)).toString("base64url");
function decode(cursor: string, kind: Walk["kind"]): Walk {
  let state: Walk;
  try { state = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new OrdinalCursorError("cursor is not one this endpoint gave"); }
  const ok = state && state.v === 1 && state.kind === kind && typeof state.after === "string" && typeof state.dryRun === "boolean"
    && Number.isSafeInteger(state.maxEntries) && state.maxEntries > 0 && state.maxEntries <= FILL_MAX_ENTRIES
    && Number.isFinite(state.started) && Number.isFinite(state.spent) && Number.isInteger(state.calls)
    && state.counts && [...ORDINAL_BUCKETS, "agents_total"].every(name => Number.isInteger(state.counts[name as keyof Counts]))
    && state.fills && FILL_CODES.every(code => Number.isInteger(state.fills[code])) && state.examples && typeof state.examples === "object"
    && Object.entries(state.examples).every(([name, ids]) => (ORDINAL_BUCKETS as readonly string[]).includes(name) && Array.isArray(ids) && ids.length <= ORDINAL_EXAMPLES && ids.every(id => typeof id === "string"));
  if (!ok) throw new OrdinalCursorError("cursor is not one this endpoint gave");
  return state;
}

export interface OrdinalWalk {
  /** Whether every agent has been walked; if not, `next` goes on from where this call stopped. */
  complete: boolean;
  next: string | null;
  /** By bucket, as each agent was found before any fill (a fill's own results are in `fills`). */
  counts: Counts;
  /** Whether the gate's counts are 0, and which are not. Final only when complete, and for a fill: as found, before it placed them. */
  gate: { ready: boolean; blocking: OrdinalBucket[] };
  examples: Partial<Record<OrdinalBucket, string[]>>;
  /** A fill's: whether it is a dry run, its entry bound, its results so far by code, and this call's results but `current`. */
  dryRun?: boolean;
  maxEntries?: number;
  fills?: Record<FillCode, number>;
  results?: FillResult[];
  generatedAt: string;
  durationMs: number;
  totalDurationMs: number;
  calls: number;
}

/**
 * Walk from `cursor` (or the start) for `budgetMs`, counting agents by bucket; `fill` places each unplaced or stale one
 * (`fillOrdinals`) as it goes. A call stopped by its budget inside a batch goes on, next time, after the last agent it took.
 */
export async function ordinalWalk(db: Db, options: {
  cursor?: string; fill?: { dryRun?: boolean; maxEntries?: number }; budgetMs?: number; batch?: number; statementTimeoutMs?: number; now?: () => number;
  /** Place one agent (default: `fillOrdinals`). */
  place?: (agent: string, options: { dryRun: boolean; maxEntries: number }) => Promise<FillResult>;
}): Promise<OrdinalWalk> {
  const now = options.now ?? Date.now, started = now();
  const kind = options.fill ? "fill" : "coverage";
  const budget = Math.min(MAX_BUDGET_MS, Math.max(1, options.budgetMs ?? ORDINAL_BUDGET_MS));
  const dryRun = options.fill?.dryRun ?? true;
  const maxEntries = Math.min(FILL_MAX_ENTRIES, Math.max(1, options.fill?.maxEntries ?? FILL_DEFAULT_ENTRIES));
  const state: Walk = options.cursor ? decode(options.cursor, kind) : {
    v: 1, kind, after: "", dryRun, maxEntries, counts: Object.fromEntries([...ORDINAL_BUCKETS, "agents_total"].map(name => [name, 0])) as Counts,
    fills: Object.fromEntries(FILL_CODES.map(code => [code, 0])) as Record<FillCode, number>, examples: {}, started, spent: 0, calls: 0,
  };
  if (options.fill && state.dryRun !== dryRun) throw new OrdinalCursorError(`this cursor is a ${state.dryRun ? "dry run's" : "fill's"}; call with dryRun ${state.dryRun}`);
  if (options.fill?.maxEntries !== undefined) state.maxEntries = maxEntries;
  const place = options.place ?? ((agent, fill) => fillOrdinals(db, agent, { ...fill, ...(options.statementTimeoutMs ? { statementTimeoutMs: options.statementTimeoutMs } : {}) }));
  const results: FillResult[] = [];
  const size = options.batch ?? ORDINAL_BATCH;
  let complete = false, stopped = false;
  // At least one agent per call, so every call moves the walk on.
  while (!complete && !stopped) {
    const batch = await ordinalBatch(db, state.after, size, options.statementTimeoutMs);
    for (const [index, agent] of batch.agents.entries()) {
      const bucket = batch.buckets.get(agent)!;
      state.counts.agents_total++;
      state.counts[bucket]++;
      if (bucket !== "placed" && bucket !== "no_journal") {
        const examples = state.examples[bucket] ??= [];
        if (examples.length < ORDINAL_EXAMPLES) examples.push(agent);
      }
      const filling = options.fill && (bucket === "unplaced" || bucket === "stale");
      if (filling) {
        let result: FillResult;
        try { result = await place(agent, { dryRun: state.dryRun, maxEntries: state.maxEntries }); }
        catch (error) { result = { agent, code: "failed", error: error instanceof Error ? error.message : String(error) }; }
        state.fills[result.code]++;
        if (result.code !== "current" && results.length < ORDINAL_RESULTS) results.push(result);
      }
      state.after = agent;
      if (filling && index < batch.agents.length - 1 && now() - started >= budget) { stopped = true; break; }
    }
    if (stopped) break;
    if (batch.agents.length < size) complete = true;
    else if (now() - started >= budget) stopped = true;
  }
  const durationMs = now() - started;
  state.spent += durationMs;
  state.calls++;
  const blocking = ORDINAL_GATE.filter(name => state.counts[name] > 0);
  return {
    complete, next: complete ? null : encode(state), counts: state.counts, gate: { ready: complete && !blocking.length, blocking }, examples: state.examples,
    ...(options.fill ? { dryRun: state.dryRun, maxEntries: state.maxEntries, fills: state.fills, results } : {}),
    generatedAt: new Date(state.started).toISOString(), durationMs, totalDurationMs: state.spent, calls: state.calls,
  };
}
