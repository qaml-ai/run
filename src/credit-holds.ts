import type { Db, Sql } from "./db.ts";
import { transaction } from "./db.ts";
import type { Billing } from "./billing.ts";

/** How long a call's hold lasts without a word from it: a call that streams keeps it (`renew`, `extend`). */
const HOLD_MS = 10 * 60_000;

/**
 * What a prepaid tenant's calls on the platform's keys hold of its credit while they run, as end users' calls hold theirs
 * (end-user-credits.ts): a call is charged when it ends, so without a hold a balance of a cent could start a call of many
 * dollars, which the platform has paid for. Room is the balance, and on free credit what is left of the hour's allowance,
 * less what other calls hold. All of it can be spent. A hold is not a charge: a call's settlement removes it.
 */
export class CreditHolds {
  private readonly db: Db;
  private readonly billing: Billing;
  constructor(db: Db, billing: Billing) { this.db = db; this.billing = billing; }

  private async room(sql: Sql, tenant: string, now: number) {
    await sql.query("delete from credit_holds where tenant = $1 and expires_at <= $2", [tenant, now]);
    const held = Number((await sql.query("select coalesce(sum(amount), 0)::bigint as held from credit_holds where tenant = $1", [tenant])).rows[0].held);
    return Math.max(0, await this.billing.spendable(tenant, sql) - held);
  }

  /** What a tenant could still hold now: the room `reserve` would find. */
  async available(tenant: string, now = Date.now()) {
    const held = Number((await this.db.query("select coalesce(sum(amount), 0)::bigint as held from credit_holds where tenant = $1 and expires_at > $2", [tenant, now])).rows[0].held);
    return Math.max(0, await this.billing.spendable(tenant, this.db) - held);
  }

  /** Hold up to `want` (micro-USD) for call `id`, at least `min`: refused otherwise. `most`: all it could hold, for what the call may ask for. */
  async reserve(tenant: string, id: string, want: number, min: number, now = Date.now()): Promise<{ held: number; most: number } | undefined> {
    return transaction(this.db, async sql => {
      await sql.query("select 1 from credit_accounts where tenant = $1 for update", [tenant]);
      await sql.query("delete from credit_holds where id = $1", [id]);
      const room = await this.room(sql, tenant, now), held = Math.min(want, room);
      if (held < Math.max(1, Math.min(min, want))) return undefined;
      await sql.query("insert into credit_holds (id, tenant, amount, expires_at, created_at) values ($1, $2, $3, $4, $4)", [id, tenant, held, now + HOLD_MS]);
      return { held, most: room };
    });
  }

  /** Up to `want` more for a call as it streams; what it got, 0 when there is no more. */
  async extend(tenant: string, id: string, want: number, now = Date.now()): Promise<number> {
    return transaction(this.db, async sql => {
      await sql.query("select 1 from credit_accounts where tenant = $1 for update", [tenant]);
      const more = Math.min(want, await this.room(sql, tenant, now));
      if (more <= 0) return 0;
      await sql.query(`insert into credit_holds (id, tenant, amount, expires_at, created_at) values ($1, $2, $3, $4, $5)
        on conflict (id) do update set amount = credit_holds.amount + excluded.amount, expires_at = excluded.expires_at`, [id, tenant, more, now + HOLD_MS, now]);
      return more;
    });
  }

  async renew(id: string, now = Date.now()) {
    await this.db.query("update credit_holds set expires_at = $2 where id = $1", [id, now + HOLD_MS]);
  }
}
