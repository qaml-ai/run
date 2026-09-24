import { transaction, type Db } from "./db.ts";
import type { LogTail, TailRow } from "../shared/storage.ts";

const UNIQUE_VIOLATION = "23505";

/**
 * Logs' hot tails in `log_records`. An append is one multi-row insert, fenced in
 * the same statement: it locks the actor's ownership row (FOR SHARE) and inserts
 * only while that row still names the claim's session and epoch. A takeover
 * updates the row, so it waits for an append in flight, and an append that waited
 * for a takeover sees the new owner and inserts nothing.
 *
 * A compaction holds that lock, and a per-log advisory lock, for the whole move to
 * Storage: no one takes the actor over, or compacts the same log, meanwhile.
 */
export function postgresTail(db: Db): LogTail {
  return {
    async rows(key) {
      return (await db.query("select seq, snapshot, body, blob from log_records where log_key = $1 order by seq", [key])).rows;
    },
    async last(key) {
      return (await db.query("select max(seq) as seq from log_records where log_key = $1", [key])).rows[0].seq ?? undefined;
    },
    async append(key, claim, rows) {
      try {
        const { rowCount } = await db.query(`
          with owner as (select from actor_owners where actor = $2 and session = $3 and epoch = $4 for share)
          insert into log_records (log_key, seq, actor, snapshot, body, blob)
          select $1, r.seq, $2, r.snapshot, r.body, r.blob from unnest($5::bigint[], $6::boolean[], $7::text[], $8::text[]) as r(seq, snapshot, body, blob)
          where $3::uuid is null or exists (select from owner)`,
          [key, claim?.actor ?? null, claim?.session ?? null, claim?.epoch ?? null, ...columns(rows)]);
        return rowCount === rows.length;
      } catch (error) {
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) return false;
        throw error;
      }
    },
    compact(key, claim, fold) {
      return transaction(db, async sql => {
        // A node that hangs mid-compaction must not hold the actor's row for long.
        await sql.query("set local idle_in_transaction_session_timeout = '30s'");
        await sql.query("select pg_advisory_xact_lock(hashtext($1))", [`log:${key}`]);
        if (claim && !(await sql.query("select from actor_owners where actor = $1 and session = $2 and epoch = $3 for share", [claim.actor, claim.session, claim.epoch])).rowCount) return false;
        const { rows } = await sql.query("select seq, snapshot, body, blob from log_records where log_key = $1 order by seq", [key]);
        if (!rows.length) return true;
        const through = await fold(rows);
        await sql.query("delete from log_records where log_key = $1 and seq <= $2", [key, through]);
        return true;
      });
    },
  };
}

function columns(rows: TailRow[]) {
  return [rows.map(row => row.seq), rows.map(row => row.snapshot), rows.map(row => row.body), rows.map(row => row.blob)];
}
