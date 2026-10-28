import { transaction, type Db, type Sql } from "./db.ts";
import { json } from "./pi-durable/reclaim.ts";

/**
 * Which live agents still need the readers of retired and legacy history formats (src/pi-durable/retired-host.ts,
 * `HostJournal.retire`, the legacy-log reads in the supervisor, agent host and agent child). The gate's counts must be
 * 0 before those readers are deleted. Read by the platform operator (GET /v1/operations/legacy-coverage).
 *
 * It walks the `agents` table in id order, a batch at a time, with a few indexed probes per agent, and never scans
 * pi_durable_entries as a whole: one call walks for a time budget and answers the counts so far with a cursor to go on
 * from (which carries them), until `complete`. Only agents with an `agents` row count.
 */
export const LEGACY_COVERAGE_BUCKETS = [
  /** Host transcripts never retired: their first load still needs `HostJournal.retire` and `retiredRecords`. */
  "unretired_host_transcripts",
  /**
   * Retired, but the history index does not hold the history before the journal base (no base, no index row, or
   * `indexed` < the base marker's `total` less its `kept`): history reads still use the retired records.
   */
  "retired_index_short",
  /** Pi storage but no journal history (no base document, no history marker): legacy format only, read from the legacy log. */
  "pi_without_journal_history",
  /** No Pi storage, and the legacy log still has hot rows in log_records (folded segments in object storage are not seen). */
  "no_pi_with_legacy_log_rows",
  /** No Pi storage at all: agents never started, or pre-Pi agents whose log folded to object storage. An upper bound of the one above. */
  "agents_without_pi_storage",
] as const;
export type LegacyCoverageBucket = typeof LEGACY_COVERAGE_BUCKETS[number];
type Counts = Record<LegacyCoverageBucket | "agents_total", number>;

/** The counts that must be 0 before the readers go; no_pi_with_legacy_log_rows must be 0 or accepted. */
export const LEGACY_COVERAGE_GATE: readonly LegacyCoverageBucket[] = ["unretired_host_transcripts", "retired_index_short", "pi_without_journal_history"];
export const LEGACY_COVERAGE_EXAMPLES = 20;
/** Agents per batch: each batch is a few statements, each stopped by Postgres after STATEMENT_TIMEOUT_MS. */
export const LEGACY_COVERAGE_BATCH = 500;
const STATEMENT_TIMEOUT_MS = 20_000;
/** How long one call walks by default, and at most: under the load balancer's and the pool's 60 s and 30 s timeouts. */
export const LEGACY_COVERAGE_BUDGET_MS = 20_000;
const MAX_BUDGET_MS = 25_000;

export interface LegacyCoverage {
  /** Whether every agent has been walked; if not, `next` goes on from where this call stopped. */
  complete: boolean;
  next: string | null;
  counts: Counts;
  /** Whether the gate counts are all 0, and which are not; `review` names no_pi_with_legacy_log_rows when it is not 0. Final only when complete. */
  gate: { ready: boolean; blocking: LegacyCoverageBucket[]; review: LegacyCoverageBucket[] };
  /** Up to LEGACY_COVERAGE_EXAMPLES agent ids per nonzero bucket, ids only. */
  examples: Partial<Record<LegacyCoverageBucket, string[]>>;
  /** When the walk began (its first call), how long this call took, and how long the calls so far took together. */
  generatedAt: string;
  durationMs: number;
  totalDurationMs: number;
  calls: number;
}

/** What a cursor carries: where the walk is, and what it has counted. */
interface State { v: 1; after: string; counts: Counts; examples: Partial<Record<LegacyCoverageBucket, string[]>>; started: number; spent: number; calls: number }

export class LegacyCoverageCursorError extends Error {}

const empty = (started: number): State => ({ v: 1, after: "", counts: Object.fromEntries([...LEGACY_COVERAGE_BUCKETS, "agents_total"].map(name => [name, 0])) as Counts, examples: {}, started, spent: 0, calls: 0 });
const encode = (state: State) => Buffer.from(JSON.stringify(state)).toString("base64url");
function decode(cursor: string): State {
  let state: State;
  try { state = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new LegacyCoverageCursorError("cursor is not one this endpoint gave"); }
  const names = [...LEGACY_COVERAGE_BUCKETS, "agents_total"];
  const ok = state && state.v === 1 && typeof state.after === "string" && Number.isFinite(state.started) && Number.isFinite(state.spent) && Number.isInteger(state.calls)
    && state.counts && names.every(name => Number.isInteger(state.counts[name as keyof Counts])) && Object.keys(state.counts).length === names.length
    && state.examples && typeof state.examples === "object" && Object.entries(state.examples).every(([name, ids]) =>
      (LEGACY_COVERAGE_BUCKETS as readonly string[]).includes(name) && Array.isArray(ids) && ids.length <= LEGACY_COVERAGE_EXAMPLES && ids.every(id => typeof id === "string"));
  if (!ok) throw new LegacyCoverageCursorError("cursor is not one this endpoint gave");
  return state;
}

/**
 * How far into an entry's record its kind is looked for. Records are written `{"id":…,"conversationId":…,"kind":…}`
 * first, so the kind is in the first ~60 characters and a message's text, which comes after it, is never matched.
 * `substr` reads only that slice of a TOASTed record.
 */
const prefix = (column: string) => `substr(${column}, 1, 200)`;

// Probes are scalar subqueries with LIMIT 1, not EXISTS: Postgres may answer an EXISTS for a whole batch with one hashed
// scan of its table (all of pi_durable_entries or pi_durable_documents), where these stay per-agent index lookups.

/**
 * One batch's agents after $1, with what each needs probed further. A session's host generation (`camel.host.bootstrap`)
 * is written right after its seed marker, its first entry, by the import that made it, and nothing removes either: the
 * first three entries of conversation 1 hold it if there is one.
 */
const AGENTS = `select a.id, md.session_id is not null as pi,
    md.session_id is not null and exists (select 1 from (select e.record from pi_durable_entries e
      where e.session_id = a.id and e.conversation_id = 1 order by e.id limit 3) f where ${prefix("f.record")} like '%"kind":"camel.host.bootstrap"%') as bootstrap,
    md.session_id is not null and (select true from pi_durable_documents d where d.session_id = a.id and d.kind = '"camel.history.base"' limit 1) is not null as base,
    md.session_id is null and (select true from log_records l where l.log_key = 'sessions/' || a.id || '/transcript' limit 1) is not null as legacy_log
  from agents a left join pi_durable_metadata md on md.session_id = a.id
  where a.id > $1 order by a.id limit $2`;

/**
 * Whether each host session was retired. Retirement sets the host's latest-only snapshot document to `{...value,
 * enabled: false, retired: "journal"}` (its one revision, a base) in the commit that writes the `camel.host.disabled`
 * entry, and nothing writes the document after; a rollback's disabling leaves no `retired`. Reclaim's stage 2 removes
 * the document only from a retired session, so a session without one was retired. One document per session is read:
 * no entries.
 */
const RETIRED = `select s.id, hd.id is null or coalesce((select r.kind = 'base' and r.content like '%"retired":"journal"}'
    from pi_durable_document_revisions r where r.session_id = s.id and r.document_id = hd.id order by r.seq desc limit 1), false) as retired
  from unnest($1::text[]) s(id)
  left join lateral (select d.id from pi_durable_documents d where d.session_id = s.id and d.kind = '"camel.host.snapshot"' order by d.id desc limit 1) hd on true`;

/** Retired sessions whose history index is short of their newest journal base (as reclaim.ts's `retiredAndIndexed`). */
const SHORT = `select s.id from unnest($1::text[]) s(id)
  left join lateral (select (${json("m.record")}->'data'->>'total')::bigint - coalesce(jsonb_array_length(${json("m.record")}->'data'->'kept'), 0) as before_base
    from pi_durable_documents d
    join lateral (select r.content from pi_durable_document_revisions r where r.session_id = d.session_id and r.document_id = d.id
      and r.kind = 'base' order by r.seq desc limit 1) r on true
    join pi_durable_entries m on m.session_id = d.session_id and m.id = (${json("r.content")}->>'entry')::bigint
    where d.session_id = s.id and d.kind = '"camel.history.base"' and d.retired_at is null
    order by d.created_at desc, d.id desc limit 1) b on true
  left join agent_history_index i on i.agent = s.id
  where b.before_base is null or i.indexed is null or i.indexed < b.before_base`;

/**
 * Of Pi sessions with no base document (few), those with no history marker either: their entries' kinds alone are read,
 * newest first (a marker ends every turn), until one is a marker.
 */
const NO_MARKER = `select s.id from unnest($1::text[]) s(id)
  where (select true from pi_durable_entries e where e.session_id = s.id and e.conversation_id = 1
    and ${prefix("e.record")} like '%"kind":"camel.history.marker"%' order by e.id desc limit 1) is null`;

/** One batch of agents after `after`, in its own read-only transaction. */
async function batch(sql: Sql, after: string, size: number, timeoutMs: number) {
  await sql.query("set transaction isolation level repeatable read, read only");
  await sql.query(`set local statement_timeout = ${Math.max(1, Math.floor(timeoutMs))}`);
  const agents = (await sql.query<{ id: string; pi: boolean; bootstrap: boolean; base: boolean; legacy_log: boolean }>(AGENTS, [after, size])).rows;
  const hosts = agents.filter(agent => agent.bootstrap).map(agent => agent.id);
  const retired = hosts.length ? (await sql.query<{ id: string; retired: boolean }>(RETIRED, [hosts])).rows : [];
  const done = retired.filter(row => row.retired).map(row => row.id);
  const short = done.length ? (await sql.query<{ id: string }>(SHORT, [done])).rows.map(row => row.id) : [];
  const baseless = agents.filter(agent => agent.pi && !agent.base).map(agent => agent.id);
  const unmarked = baseless.length ? (await sql.query<{ id: string }>(NO_MARKER, [baseless])).rows.map(row => row.id) : [];
  return {
    agents: agents.map(agent => agent.id),
    buckets: {
      unretired_host_transcripts: retired.filter(row => !row.retired).map(row => row.id),
      retired_index_short: short,
      pi_without_journal_history: unmarked,
      no_pi_with_legacy_log_rows: agents.filter(agent => agent.legacy_log).map(agent => agent.id),
      agents_without_pi_storage: agents.filter(agent => !agent.pi).map(agent => agent.id),
    } satisfies Record<LegacyCoverageBucket, string[]>,
  };
}

/**
 * Walk agents from `cursor` (or the start) for `budgetMs`, batch by batch; each batch is read-only and never writes.
 * The answer's counts are the walk's so far; `next` goes on from where it stopped, null once complete.
 */
export async function legacyCoverage(db: Db, options: { cursor?: string; budgetMs?: number; batch?: number; statementTimeoutMs?: number; now?: () => number } = {}): Promise<LegacyCoverage> {
  const now = options.now ?? Date.now, started = now();
  const budget = Math.min(MAX_BUDGET_MS, Math.max(1, options.budgetMs ?? LEGACY_COVERAGE_BUDGET_MS));
  const state = options.cursor ? decode(options.cursor) : empty(started);
  let complete = false;
  // At least one batch per call, so every call moves the walk on.
  do {
    const size = options.batch ?? LEGACY_COVERAGE_BATCH;
    const found = await transaction(db, sql => batch(sql, state.after, size, options.statementTimeoutMs ?? STATEMENT_TIMEOUT_MS));
    state.counts.agents_total += found.agents.length;
    for (const name of LEGACY_COVERAGE_BUCKETS) {
      state.counts[name] += found.buckets[name].length;
      const examples = [...state.examples[name] ?? [], ...found.buckets[name]].slice(0, LEGACY_COVERAGE_EXAMPLES);
      if (examples.length) state.examples[name] = examples;
    }
    if (found.agents.length < size) complete = true;
    else state.after = found.agents.at(-1)!;
  } while (!complete && now() - started < budget);
  const durationMs = now() - started;
  state.spent += durationMs;
  state.calls++;
  const blocking = LEGACY_COVERAGE_GATE.filter(name => state.counts[name] > 0);
  const review: LegacyCoverageBucket[] = state.counts.no_pi_with_legacy_log_rows > 0 ? ["no_pi_with_legacy_log_rows"] : [];
  return {
    complete, next: complete ? null : encode(state), counts: state.counts, gate: { ready: complete && blocking.length === 0, blocking, review },
    examples: state.examples, generatedAt: new Date(state.started).toISOString(), durationMs, totalDurationMs: state.spent, calls: state.calls,
  };
}

/** The statements a batch runs, for EXPLAIN (docs/operations/pi-durable.md). */
export const LEGACY_COVERAGE_QUERIES = { AGENTS, RETIRED, SHORT, NO_MARKER };
