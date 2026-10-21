import { transaction, type Db, type Sql } from "../db.ts";

/** Stage 1 only. IDs, native history, compactions, documents and the live context are never removed. */
const obsolete = `with head as (
  select coalesce(head, id) as start from pi_durable_entries
  where session_id = $1 and conversation_id = 1 and head is not null order by id desc limit 1
)
select e.id, octet_length(e.record) as bytes from pi_durable_entries e, head
where e.session_id = $1 and e.conversation_id = 1 and e.id < head.start
  and (e.record::jsonb)->>'kind' in ('camel.legacy.context', 'camel.context.message', 'pi.system')`;

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
export async function reclaimSession(db: Db, session: string, apply = false): Promise<ReclaimSession> {
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
        ? `with obsolete as (${obsolete}), removed as (
            delete from pi_durable_entries e using obsolete o where e.session_id = $1 and e.id = o.id returning o.bytes
          ) select count(*) as rows, coalesce(sum(bytes), 0) as bytes from removed`
        : `select count(*) as rows, coalesce(sum(bytes), 0) as bytes from (${obsolete}) obsolete`;
      const { rows: [counts] } = await sql.query(query, [session]);
      return { ...result, rows: Number(counts.rows), bytes: Number(counts.bytes) };
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
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) throw new Error("--limit must be a positive integer");
  const totals = { type: "reclaim_total", mode: options.apply ? "apply" : "dry-run", sessions: 0, skipped: 0, rows: 0, bytes: 0 };
  let after = "";
  while (totals.sessions < (options.limit ?? Infinity)) {
    const size = Math.min(100, (options.limit ?? Infinity) - totals.sessions);
    const { rows } = await db.query(`select m.session_id from pi_durable_metadata m
      where m.session_id > $1 and ($2::text is null or m.session_id = $2)
        and exists (select 1 from (${obsolete.replaceAll("$1", "m.session_id")}) obsolete)
      order by m.session_id limit $3`, [after, options.session ?? null, size]);
    if (!rows.length) break;
    for (const { session_id: session } of rows) {
      const row = await reclaimSession(db, session, options.apply);
      log(row);
      totals.sessions++; totals.rows += row.rows; totals.bytes += row.bytes;
      if (row.skipped_reason) totals.skipped++;
      after = session;
    }
  }
  return totals;
}
