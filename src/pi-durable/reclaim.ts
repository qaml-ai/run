import { transaction, type Db, type Sql } from "../db.ts";

/**
 * A stored record as jsonb, for its kind and markers. jsonb refuses a NUL (`\u0000`, a binary file's text in a tool result,
 * say), and so does json's `->>`: it becomes `\u0001` first, an escape of the same shape, so the JSON stays valid; the
 * fields read here never hold one.
 */
const json = (column: string) => `(replace(${column}, '\\u0000', '\\u0001')::jsonb)`;

/**
 * What a reclaim stage removes from session $1 (plans/journal-reclaim.md): the entries it selects (`id`, `bytes`), and
 * the documents (`id`) whose revisions and rows go with them. IDs (`pi_durable_record_ids`) are never removed.
 */
interface ReclaimStage { name: string; entries: string; documents?: string }

/** Stage 1 only. IDs, native history, compactions, documents and the live context are never removed. */
const obsolete = `with head as (
  select coalesce(head, id) as start from pi_durable_entries
  where session_id = $1 and conversation_id = 1 and head is not null order by id desc limit 1
)
select e.id, octet_length(e.record) as bytes from pi_durable_entries e, head
where e.session_id = $1 and e.conversation_id = 1 and e.id < head.start
  and ${json("e.record")}->>'kind' in ('camel.legacy.context', 'camel.context.message', 'pi.system')`;

/** Stage 1: context checkpoints superseded by a newer head. */
const CHECKPOINTS: ReclaimStage = { name: "checkpoints", entries: obsolete };

/**
 * Whether session $1's host transcript was retired (its first load on a release without it wrote `camel.host.disabled`
 * with `retired: "journal"`), and its history index holds every message before what its journal holds (its newest base
 * marker's `total`, less the running turn's messages the marker keeps): then nothing reads its host records any more.
 */
const retiredAndIndexed = `exists (select 1 from pi_durable_entries rx where rx.session_id = $1 and rx.conversation_id = 1
    and ${json("rx.record")}->>'kind' = 'camel.host.disabled' and ${json("rx.record")}->'data'->>'retired' = 'journal')
  and exists (select 1 from pi_durable_documents rd
    join lateral (select rr.content from pi_durable_document_revisions rr where rr.session_id = rd.session_id and rr.document_id = rd.id and rr.kind = 'base' order by rr.seq desc limit 1) rr on true
    join pi_durable_entries rm on rm.session_id = rd.session_id and rm.id = (${json("rr.content")}->>'entry')::bigint
    join agent_history_index ri on ri.agent = rd.session_id
    where rd.session_id = $1 and rd.kind = '"camel.history.base"' and rd.retired_at is null
      and ri.indexed >= (${json("rm.record")}->'data'->>'total')::bigint - coalesce(jsonb_array_length(${json("rm.record")}->'data'->'kept'), 0))`;

/**
 * Stage 2: a retired host transcript's own data: its records, its archive (and the archive of imports from before
 * #322), and its snapshot document with every revision. The generation marker (`camel.host.bootstrap`) and the
 * `camel.host.disabled` entry stay, so a release from #374 on still refuses the session as newer.
 */
export const HOST_TRANSCRIPT: ReclaimStage = {
  name: "host_transcript",
  entries: `select he.id, octet_length(he.record) as bytes from pi_durable_entries he
    where he.session_id = $1 and he.conversation_id = 1 and ${json("he.record")}->>'kind' in ('camel.host.record', 'camel.host.archive', 'camel.legacy.record')
      and ${retiredAndIndexed}`,
  documents: `select hd.id, octet_length(hd.record) + coalesce((select sum(octet_length(hr.content)) from pi_durable_document_revisions hr
      where hr.session_id = hd.session_id and hr.document_id = hd.id), 0) as bytes
    from pi_durable_documents hd where hd.session_id = $1 and hd.kind = '"camel.host.snapshot"' and ${retiredAndIndexed}`,
};

export interface ReclaimOptions { apply?: boolean; limit?: number; session?: string }
export interface ReclaimSession {
  type: "reclaim_session"; session: string; rows: number; bytes: number; skipped_reason: string | null;
}

async function busy(sql: Sql, session: string): Promise<string | null> {
  const { rows: [row] } = await sql.query(`select
    exists (select 1 from actor_owners o join runtime_nodes n on n.node = o.node and n.session = o.session
      where o.actor = $1 and n.expires_at > clock_timestamp()) as owned,
    (select pending_runs from agents where id = $1) as pending,
    exists (select 1 from pi_durable_tasks where session_id = $1 and status <> 'terminal') as tasks`, [session]);
  return row.owned ? "live_owner" : row.pending === undefined || row.pending === null ? "missing_agent"
    : row.pending ? "pending_runs" : row.tasks ? "unfinished_task" : null;
}

/** One transaction per session. Called again after discovery so a session that woke meanwhile is skipped. */
export async function reclaimSession(db: Db, session: string, apply = false, stage: ReclaimStage = CHECKPOINTS): Promise<ReclaimSession> {
  const result: ReclaimSession = { type: "reclaim_session", session, rows: 0, bytes: 0, skipped_reason: null };
  try {
    return await transaction(db, async sql => {
      // The post-lock check must see commits since the first check, regardless of the database's default isolation.
      await sql.query(apply ? "set transaction isolation level read committed" : "set transaction isolation level read committed, read only");
      let reason = await busy(sql, session);
      if (reason) return { ...result, skipped_reason: reason };
      if (apply) {
        await sql.query("set local lock_timeout = '250ms'");
        // A never-loaded session may have no claim row. Establish it before locking: acquire() uses this same
        // primary key, so even its first claim must wait. Rollback also removes this row on a skipped session.
        await sql.query("insert into actor_owners (actor, node, session, epoch) values ($1, null, null, 0) on conflict (actor) do nothing", [session]);
        await sql.query("select actor from actor_owners where actor = $1 for update nowait", [session]);
        // Match writers' claim -> metadata/agent lock order. Metadata serializes even unfenced Pi writers;
        // the agent lock holds pending_runs still until commit. All nonterminal tasks are conservatively busy.
        await sql.query("select id from agents where id = $1 for update nowait", [session]);
        await sql.query("select session_id from pi_durable_metadata where session_id = $1 for update nowait", [session]);
        reason = await busy(sql, session);
        if (reason) {
          // No bookkeeping write is kept for a session that became busy during the lock acquisition.
          throw Object.assign(new Error("Session became busy"), { skippedReason: reason });
        }
        await sql.query("set local synchronous_commit = on");
      }
      const query = apply
        ? `with obsolete as (${stage.entries}), removed as (
            delete from pi_durable_entries e using obsolete o where e.session_id = $1 and e.id = o.id returning o.bytes
          ) select count(*) as rows, coalesce(sum(bytes), 0) as bytes from removed`
        : `select count(*) as rows, coalesce(sum(bytes), 0) as bytes from (${stage.entries}) obsolete`;
      // Documents first: their selection may read the entries the next statement removes.
      let documents = { rows: 0, bytes: 0 };
      if (stage.documents) {
        const { rows: [found] } = await sql.query(apply
          ? `with obsolete as (${stage.documents}),
              revisions as (delete from pi_durable_document_revisions r using obsolete o where r.session_id = $1 and r.document_id = o.id),
              removed as (delete from pi_durable_documents d using obsolete o where d.session_id = $1 and d.id = o.id returning o.bytes)
            select count(*) as rows, coalesce(sum(bytes), 0) as bytes from removed`
          : `select count(*) as rows, coalesce(sum(bytes), 0) as bytes from (${stage.documents}) obsolete`, [session]);
        documents = { rows: Number(found.rows), bytes: Number(found.bytes) };
      }
      const { rows: [counts] } = await sql.query(query, [session]);
      return { ...result, rows: Number(counts.rows) + documents.rows, bytes: Number(counts.bytes) + documents.bytes };
    }, { rerun: false });
  } catch (error) {
    const failure = error as { code?: string; skippedReason?: string };
    if (failure.skippedReason) return { ...result, skipped_reason: failure.skippedReason };
    if (failure.code === "55P03") return { ...result, skipped_reason: "locked" };
    throw error;
  }
}

/** Keyset discovery in bounded batches; a repeat run simply finds no more obsolete rows in completed sessions. */
export async function reclaimCheckpoints(db: Db, options: ReclaimOptions = {}, log: (row: ReclaimSession) => void = row => console.log(JSON.stringify(row))) {
  return reclaim(db, CHECKPOINTS, options, log);
}

/** Stage 2 (`HOST_TRANSCRIPT`), as stage 1: dry run unless `apply`, idle sessions only, one transaction each. */
export async function reclaimHostTranscripts(db: Db, options: ReclaimOptions = {}, log: (row: ReclaimSession) => void = row => console.log(JSON.stringify(row))) {
  return reclaim(db, HOST_TRANSCRIPT, options, log);
}

async function reclaim(db: Db, stage: ReclaimStage, options: ReclaimOptions, log: (row: ReclaimSession) => void) {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) throw new Error("--limit must be a positive integer");
  const totals = { type: "reclaim_total", stage: stage.name, mode: options.apply ? "apply" : "dry-run", sessions: 0, skipped: 0, rows: 0, bytes: 0 };
  let after = "";
  while (totals.sessions < (options.limit ?? Infinity)) {
    const size = Math.min(100, (options.limit ?? Infinity) - totals.sessions);
    const { rows } = await db.query(`select m.session_id from pi_durable_metadata m
      where m.session_id > $1 and ($2::text is null or m.session_id = $2)
        and (exists (select 1 from (${stage.entries.replaceAll("$1", "m.session_id")}) obsolete)
          ${stage.documents ? `or exists (select 1 from (${stage.documents.replaceAll("$1", "m.session_id")}) obsolete)` : ""})
      order by m.session_id limit $3`, [after, options.session ?? null, size]);
    if (!rows.length) break;
    for (const { session_id: session } of rows) {
      const row = await reclaimSession(db, session, options.apply, stage);
      log(row);
      totals.sessions++; totals.rows += row.rows; totals.bytes += row.bytes;
      if (row.skipped_reason) totals.skipped++;
      after = session;
    }
  }
  return totals;
}
