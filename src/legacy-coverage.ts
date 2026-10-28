import { transaction, type Db } from "./db.ts";
import { json } from "./pi-durable/reclaim.ts";

/**
 * Which live agents still need the readers of retired and legacy history formats (src/pi-durable/retired-host.ts,
 * `HostJournal.retire`, the legacy-log reads in the supervisor, agent host and agent child). Every count but the last
 * two should be 0 before those readers are deleted. Read by the platform operator (GET /v1/operations/legacy-coverage).
 *
 * Only agents with an `agents` row count: a deleted agent's leftover rows do not.
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

/** The counts that must be 0 before the readers go; no_pi_with_legacy_log_rows must be 0 or accepted. */
export const LEGACY_COVERAGE_GATE: readonly LegacyCoverageBucket[] = ["unretired_host_transcripts", "retired_index_short", "pi_without_journal_history"];

export interface LegacyCoverage {
  counts: Record<LegacyCoverageBucket | "agents_total", number>;
  /** Whether the gate counts are all 0, and which are not; `review` names no_pi_with_legacy_log_rows when it is not 0. */
  gate: { ready: boolean; blocking: LegacyCoverageBucket[]; review: LegacyCoverageBucket[] };
  /** Up to EXAMPLES agent ids per nonzero bucket, ids only. */
  examples: Partial<Record<LegacyCoverageBucket, string[]>>;
  generatedAt: string;
  durationMs: number;
}

export const LEGACY_COVERAGE_EXAMPLES = 20;
/** How long the read may take before Postgres stops it. */
export const LEGACY_COVERAGE_TIMEOUT_MS = 60_000;
/**
 * How far into an entry's record its kind is looked for. Records are written `{"id":…,"conversationId":…,"kind":…}`
 * first, so the kind is in the first ~60 characters and a message's text, which comes after it, is never matched.
 * `substr` reads only that slice of a TOASTed record, so the scan never reads (or decompresses) a whole one.
 */
const PREFIX = 200;
const KINDS = `'"kind":"(camel\\.host\\.bootstrap|camel\\.host\\.disabled|camel\\.history\\.marker)"'`;

const QUERY = `
with flagged as materialized (
  -- One scan of the session conversations' entries, by their kind alone: the record is read past its first bytes only
  -- for a camel.host.disabled entry (a few per session), below.
  select k.session_id,
    bool_or(k.kind = 'camel.host.bootstrap') as bootstrap,
    bool_or(k.kind = 'camel.history.marker') as marker,
    array_agg(k.id) filter (where k.kind = 'camel.host.disabled') as disabled
  from (select e.session_id, e.id, substring(substr(e.record, 1, ${PREFIX}) from ${KINDS}) as kind
    from pi_durable_entries e
    where e.conversation_id = 1 and substr(e.record, 1, ${PREFIX}) like '%"kind":"camel.h%') k
  where k.kind is not null
  group by k.session_id
),
host as materialized (
  -- Sessions with a host generation, and whether a load since #374 retired it (a disabled entry with retired: "journal";
  -- one without, from a rollback, is not).
  select f.session_id, exists (select 1 from pi_durable_entries d where d.session_id = f.session_id and d.id = any(f.disabled)
      and ${json("d.record")}->'data'->>'retired' = 'journal') as retired
  from flagged f join agents a on a.id = f.session_id
  where f.bootstrap
),
base as (
  -- Each retired session's newest journal base: the history before it must be in the history index.
  select distinct on (d.session_id) d.session_id,
    (${json("m.record")}->'data'->>'total')::bigint - coalesce(jsonb_array_length(${json("m.record")}->'data'->'kept'), 0) as before_base
  from host h
  join pi_durable_documents d on d.session_id = h.session_id and d.kind = '"camel.history.base"' and d.retired_at is null
  join lateral (select r.content from pi_durable_document_revisions r where r.session_id = d.session_id and r.document_id = d.id
    and r.kind = 'base' order by r.seq desc limit 1) r on true
  join pi_durable_entries m on m.session_id = d.session_id and m.id = (${json("r.content")}->>'entry')::bigint
  where h.retired
  order by d.session_id, d.created_at desc, d.id desc
),
bucket (name, id) as (
  select 'unretired_host_transcripts', h.session_id from host h where not h.retired
  union all
  select 'retired_index_short', h.session_id from host h
    left join base b on b.session_id = h.session_id left join agent_history_index i on i.agent = h.session_id
    where h.retired and (b.before_base is null or i.indexed is null or i.indexed < b.before_base)
  union all
  select 'pi_without_journal_history', a.id from agents a join pi_durable_metadata md on md.session_id = a.id
    left join flagged f on f.session_id = a.id
    where not coalesce(f.marker, false)
      and not exists (select 1 from pi_durable_documents d where d.session_id = a.id and d.kind = '"camel.history.base"')
  union all
  select 'no_pi_with_legacy_log_rows', a.id from agents a
    where not exists (select 1 from pi_durable_metadata md where md.session_id = a.id)
      and exists (select 1 from log_records l where l.log_key = 'sessions/' || a.id || '/transcript')
  union all
  select 'agents_without_pi_storage', a.id from agents a
    where not exists (select 1 from pi_durable_metadata md where md.session_id = a.id)
)
select name, count(*)::bigint as count, (array_agg(id order by id))[1:${LEGACY_COVERAGE_EXAMPLES}] as examples from bucket group by name
union all
select 'agents_total', (select count(*) from agents), null`;

/** The counts, read in one read-only transaction that Postgres stops after LEGACY_COVERAGE_TIMEOUT_MS. Never writes. */
export async function legacyCoverage(db: Db, options: { now?: () => number; timeoutMs?: number } = {}): Promise<LegacyCoverage> {
  const now = options.now ?? Date.now, started = now();
  const rows = await transaction(db, async sql => {
    await sql.query("set transaction isolation level repeatable read, read only");
    await sql.query(`set local statement_timeout = ${Math.max(1, Math.floor(options.timeoutMs ?? LEGACY_COVERAGE_TIMEOUT_MS))}`);
    return (await sql.query<{ name: string; count: number; examples: string[] | null }>(QUERY)).rows;
  });
  const counts = Object.fromEntries([...LEGACY_COVERAGE_BUCKETS, "agents_total"].map(name => [name, 0])) as LegacyCoverage["counts"];
  const examples: LegacyCoverage["examples"] = {};
  for (const row of rows) {
    counts[row.name as keyof typeof counts] = Number(row.count);
    if (row.examples?.length) examples[row.name as LegacyCoverageBucket] = row.examples;
  }
  const blocking = LEGACY_COVERAGE_GATE.filter(name => counts[name] > 0);
  const review: LegacyCoverageBucket[] = counts.no_pi_with_legacy_log_rows > 0 ? ["no_pi_with_legacy_log_rows"] : [];
  return { counts, gate: { ready: blocking.length === 0, blocking, review }, examples, generatedAt: new Date(started).toISOString(), durationMs: now() - started };
}
