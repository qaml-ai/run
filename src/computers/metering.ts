import { randomUUID } from "node:crypto";
import type { Accounts } from "../accounts.ts";
import { transaction, transactionOn, type Db, type Sql } from "../db.ts";
import { creditError, type EndUserCredits } from "../end-user-credits.ts";
import { leaseCost, MICROS } from "../pricing.ts";
import { isBrowserProvider } from "./providers.ts";

/** Leases accrued in one sweep, those charged longest ago first. */
const SWEEP_LEASES = 1000;

export type LeaseRow = { id: string; tenant: string; agent: string; connection: string; provider: string; hold: string | null; end_user: string | null };

/**
 * What a lease on the platform's keys costs. The tenant pays per second from credit, in a transaction that also moves
 * `metered_until`, read under the row's lock, so a retried or concurrent accrual has nothing left to charge. Its end
 * user, where the tenant meters them, has the whole lease held at its start (a refusal refuses the start) and pays once,
 * when it stops, what the tenant was charged. A lease on any other key has `platform` false and never comes here.
 */
export class LeaseMeter {
  readonly options: {
    db: Db;
    accounts: Pick<Accounts, "billing" | "recordUsageIn" | "usageCommitted">;
    endUsers?: Pick<EndUserCredits, "reserve" | "extend" | "settleHold" | "release" | "renew">;
    /** Who pays for the agent's current run, where the tenant meters its end users. */
    payer?(agent: string): { id: string; bucket: string } | undefined;
    now(): number;
  };
  constructor(options: LeaseMeter["options"]) { this.options = options; }

  /** Micro-USD per hour of a lease on `provider`. */
  price(provider: string) {
    const { computerHour, browserHour } = this.options.accounts.billing.pricing;
    return isBrowserProvider(provider) ? browserHour : computerHour;
  }

  /** Hold all `seconds` of a lease for the agent's end user: a 402 END_USER_CREDIT if they can't cover it, undefined if nobody is metered. */
  async hold(tenant: string, agent: string, priceHour: number, seconds: number) {
    const { endUsers, payer } = this.options;
    const user = payer?.(agent);
    if (!endUsers || !user) return undefined;
    const id = randomUUID(), want = Math.ceil(seconds * priceHour / 3600);
    const reserved = await endUsers.reserve(tenant, user.id, user.bucket, { id, want, min: want }, this.options.now());
    if (!reserved) return undefined;
    if (reserved.refused) throw creditError(reserved.refused);
    return { id, endUser: user.id, bucket: user.bucket };
  }

  /**
   * Charge an active lease up to now, or its expiry if sooner: whole seconds, the last one rounded up when `closing`,
   * which also moves it to `closing` in the same transaction, so time after that is never charged, even while its
   * cleanup fails and retries. With `client`, on that connection (one that holds a lock, so this needs no second one
   * from the pool), answering the tenant charged for the caller to pass to `usageCommitted` once it lets go of it.
   */
  async accrue(lease: string, closing = false, client?: Sql) {
    const work = async (sql: Sql) => {
      const row = (await sql.query("select * from computer_leases where id=$1 and platform for update", [lease])).rows[0];
      if (!row || row.state !== "active" || row.metered_until === null) return undefined;
      const now = this.options.now();
      const elapsed = Math.max(0, Math.min(now, Number(row.expires_at)) - Number(row.metered_until));
      const seconds = (closing ? Math.ceil : Math.floor)(elapsed / 1000);
      if (seconds > 0) {
        const before = Number(row.metered_seconds), price = Number(row.price_hour);
        const amount = leaseCost(before + seconds, price) - leaseCost(before, price);
        const kind = isBrowserProvider(row.provider) ? "browser" as const : "computer" as const;
        await sql.query("update computer_leases set metered_until=metered_until+$2::bigint, metered_seconds=metered_seconds+$3 where id=$1", [lease, seconds * 1000, seconds]);
        await this.options.accounts.recordUsageIn(sql, row.tenant, row.agent, { provider: row.provider, model: kind, kind, usage: { cost: { total: amount / MICROS } }, platform: true, seconds, timestamp: now });
      }
      if (closing) await sql.query("update computer_leases set state='closing',cleanup_at=$2 where id=$1", [lease, now]);
      return seconds > 0 ? row.tenant as string : undefined;
    };
    if (client) return transactionOn(client, work);
    const charged = await transaction(this.options.db, work);
    if (charged) await this.options.accounts.usageCommitted(charged);
    return undefined;
  }

  /** Hold `seconds` more of a running lease for its end user; false if they can't cover it. */
  async extendHold(lease: { id: string; tenant: string; hold: string | null; end_user: string | null; bucket: string | null; price_hour: unknown }, seconds: number) {
    const { endUsers } = this.options;
    if (!lease.hold || !endUsers) return true;
    const want = Math.ceil(seconds * Number(lease.price_hour) / 3600);
    return !(await endUsers.extend(lease.tenant, lease.end_user!, lease.bucket!, lease.hold, want, this.options.now())).refused;
  }

  /** Post what a stopped lease cost its end user and let go of the rest of the hold, once: the ledger key is the lease's. */
  async settle(lease: string) {
    const row = (await this.options.db.query("select * from computer_leases where id=$1 and hold is not null and state not in ('starting','active')", [lease])).rows[0];
    const { endUsers } = this.options;
    if (!row || !endUsers) return;
    const raw = leaseCost(Number(row.metered_seconds), Number(row.price_hour ?? 0));
    const call = isBrowserProvider(row.provider) ? "browser" : "computer";
    if (raw > 0) await endUsers.settleHold(row.tenant, row.end_user, row.bucket, row.hold, raw, `${call}:${row.id}`, { call, agent: row.agent, provider: row.provider, lease: row.id }, this.options.now());
    else await endUsers.release(row.hold);
    await this.options.db.query("update computer_leases set hold=null where id=$1", [lease]);
  }

  /**
   * Accrue every active lease, keep their holds, stop those of a tenant whose credit is now spent (`stop`, which may
   * wait for a command in flight, so only after every lease is charged), and settle leases that stopped without
   * settling. A failure is left for the next sweep, which catches up: charges follow `metered_until`, not the clock.
   */
  async sweep(stop: (lease: LeaseRow) => Promise<void>) {
    const { db, accounts, endUsers } = this.options;
    const { rows } = await db.query(`select id,tenant,agent,connection,provider,hold,end_user from computer_leases where platform and state='active' and metered_until is not null order by metered_until limit ${SWEEP_LEASES}`);
    const failed = (lease: string) => console.error(JSON.stringify({ type: "computer_meter_failed", lease }));
    for (const lease of rows as LeaseRow[]) {
      try {
        await this.accrue(lease.id);
        if (lease.hold && endUsers) await endUsers.renew(lease.tenant, lease.end_user!, lease.hold, this.options.now());
      } catch { failed(lease.id); }
    }
    const limits = new Map<string, boolean>();
    for (const lease of rows as LeaseRow[]) {
      try {
        if (!limits.has(lease.tenant)) limits.set(lease.tenant, !!await accounts.billing.creditLimit(lease.tenant));
        if (!limits.get(lease.tenant)) continue;
        console.error(JSON.stringify({ type: "computer_credit_stop", tenant: lease.tenant, agent: lease.agent, lease: lease.id }));
        await stop(lease);
      } catch { failed(lease.id); }
    }
    for (const { id } of (await db.query("select id from computer_leases where hold is not null and state not in ('starting','active') limit 100")).rows) {
      try { await this.settle(id); } catch { failed(id); }
    }
  }
}
