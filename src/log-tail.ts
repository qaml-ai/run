import { databaseUnavailable, transaction, type Db, type Sql } from "./db.ts";
import type { LogTail, TailRow } from "../shared/storage.ts";
import type { CommitEffect } from "../shared/append-log.ts";
import { LostClaim, underClaim, type Claim } from "./ownership.ts";
import { clock } from "./node-context.ts";
import { buggify } from "./buggify.ts";
import { reachable } from "./assert.ts";

/**
 * Logs' hot tails in `log_records`. An append is one multi-row insert, fenced in
 * the same statement: it locks the actor's ownership row (FOR SHARE) and inserts
 * only while that row still names the claim's session and epoch. A takeover
 * updates the row, so it waits for an append in flight, and an append that waited
 * for a takeover sees the new owner and inserts nothing.
 *
 * A compaction holds that lock, and a per-log advisory lock, for the whole move to
 * Storage: no one takes the actor over, or compacts the same log, meanwhile.
 *
 * An append is idempotent: rows already there with the same content count as
 * written, so an append whose connection dropped may be repeated. Its effects
 * (`CommitEffect`) commit in its transaction, while it holds that lock, only
 * when it inserts the rows: a repeat that finds them there runs none again. While the
 * database is unreachable (a failover) it is repeated for up to `retryMs`, so a
 * durable flush waits the outage out instead of failing the turn or session that
 * made it. The fence still holds: a node that lost the actor meanwhile inserts
 * nothing, and its rows already there do not count.
 *
 * Every write needs a claim. `unfenced` lets tests write logs no actor owns.
 */
export function postgresTail(db: Db, options: { retryMs?: number; unfenced?: boolean } = {}): LogTail {
  const required = (claim: Claim | undefined, key: string) => {
    if (!claim && !options.unfenced) throw new Error(`A write to ${key} needs its owner's claim`);
  };
  return {
    async rows(key) {
      return (await db.query("select seq, snapshot, body, blob from log_records where log_key = $1 order by seq", [key])).rows;
    },
    async last(key) {
      return (await db.query("select max(seq) as seq from log_records where log_key = $1", [key])).rows[0].seq ?? undefined;
    },
    async append(key, claim, rows, effects = []) {
      required(claim, key);
      const deadline = Date.now() + (options.retryMs ?? 0);
      const append = () => !effects.length ? insert(db, key, claim, rows).then(result => result.written) : transaction(db, async sql => {
        const result = await insert(sql, key, claim, rows);
        if (result.written && result.inserted) for (const effect of effects) await effect(sql);
        return result.written;
      });
      for (let delay = 100; ; delay = Math.min(delay * 2, 2_000)) {
        try {
          const written = await append();
          // Written, and the answer lost on the way back: the append is repeated, and finds its rows there.
          if (written && buggify("tail.append.lost_ack")) throw Object.assign(new Error("Connection terminated (BUGGIFY: the append's answer was lost)"), { code: "ECONNRESET" });
          return written;
        } catch (error) {
          if (!databaseUnavailable(error) || Date.now() + delay > deadline) throw error;
          reachable("a tail append was repeated while the database was unavailable");
          await clock().sleep(delay);
        }
      }
    },
    compact(key, claim, fold) {
      required(claim, key);
      return transaction(db, async sql => {
        // idle_in_transaction_session_timeout (set on the role, migration 004) bounds a node that hangs here.
        await sql.query("select pg_advisory_xact_lock(hashtext($1))", [`log:${key}`]);
        if (claim && !(await sql.query("select from actor_owners where actor = $1 and session = $2 and epoch = $3 for share", [claim.actor, claim.session, claim.epoch])).rowCount) return false;
        const { rows } = await sql.query("select seq, snapshot, body, blob from log_records where log_key = $1 order by seq", [key]);
        if (!rows.length) return true;
        const through = await fold(rows);
        await sql.query("delete from log_records where log_key = $1 and seq <= $2", [key, through]);
        return true;
      });
    },
    async whileHeld(key, claim, work) {
      required(claim, key);
      try { await underClaim(db, claim, work); return true; }
      catch (error) { if (error instanceof LostClaim) return false; throw error; }
    },
  };
}

/**
 * Insert rows under the claim. Rows present before this statement count when they
 * match exactly (this writer's own earlier attempt); any other row at one of these
 * sequence numbers, or a claim that is no longer current, makes the append fail,
 * and then it inserts none of its rows: a failed append never leaves a later record
 * without an earlier one. Whether every row is written, and whether this statement
 * inserted them.
 */
async function insert(db: Sql, key: string, claim: Claim | undefined, rows: TailRow[]) {
  const { rows: [result] } = await db.query(`
    with owner as (select from actor_owners where actor = $2 and session = $3 and epoch = $4 for share),
    held as (select $3::uuid is null or exists (select from owner) as ok),
    r as (select * from unnest($5::bigint[], $6::boolean[], $7::text[], $8::text[]) as r(seq, snapshot, body, blob)),
    taken as (select exists (select from r join log_records l on l.log_key = $1 and l.seq = r.seq
      and not (l.snapshot = r.snapshot and l.body is not distinct from r.body and l.blob is not distinct from r.blob)) as yes),
    inserted as (
      insert into log_records (log_key, seq, actor, snapshot, body, blob)
      select $1, r.seq, $2, r.snapshot, r.body, r.blob from r where (select ok from held) and not (select yes from taken)
      on conflict (log_key, seq) do nothing
      returning seq)
    select (select ok from held) as ok, (select count(*) from inserted)::int as inserted, (select count(*) from inserted)::int + (select count(*) from r join log_records l
      on l.log_key = $1 and l.seq = r.seq and l.snapshot = r.snapshot and l.body is not distinct from r.body and l.blob is not distinct from r.blob)::int as written`,
    [key, claim?.actor ?? null, claim?.session ?? null, claim?.epoch ?? null, ...columns(rows)]);
  return { written: result.ok && result.written === rows.length, inserted: result.inserted > 0 };
}

function columns(rows: TailRow[]) {
  return [rows.map(row => row.seq), rows.map(row => row.snapshot), rows.map(row => row.body), rows.map(row => row.blob)];
}

/** Drop a deleted actor's tail rows (and those of `keys`, its logs, written without a claim); nothing reads its logs again. */
export async function deleteTail(db: Sql, actor: string, keys: string[] = []) {
  await db.query("delete from log_records where actor = $1 or log_key = any($2::text[])", [actor, keys]);
}

/**
 * Drop tail rows of revoked or expired agents and deleted volumes that no live
 * node holds: rows a node left when it died before unloading them.
 */
export async function sweepTails(db: Db) {
  const { rowCount } = await db.query(`
    delete from log_records r
    where (exists (select 1 from agents a where a.id = r.actor and (a.revoked or a.expires_at <= $1))
        or exists (select 1 from volumes v where v.id = r.actor and v.deleted_at is not null))
      and not exists (select 1 from actor_owners o join runtime_nodes n on n.node = o.node and n.session = o.session and n.expires_at > now() where o.actor = r.actor)`, [Date.now()]);
  return rowCount ?? 0;
}
