import { transaction, type Db, type Sql } from "./db.ts";
import { HttpError } from "./http.ts";
import { MICROS, type UsageTier } from "./pricing.ts";
import type { Ownership } from "./ownership.ts";

/**
 * How many agents a tenant may have busy at once, across the fleet, and why: its entry's own
 * `maxAgents` (`tenant`), the usage tier of a prepaid tenant (`tier`, with the next tier up), or the
 * deployment's AGENT_MAX_AGENTS_PER_TENANT (`default`).
 */
export type BusyLimit =
  | { limit: number; source: "tenant" | "default" }
  | { limit: number; source: "tier"; tier: string; paid: number; next?: { tier: string; paid: number; limit: number } };

/** The 429 for a tenant at its busy-agent limit: it names the limit, its tier, and what buying credit unlocks next. */
export function busyLimitError(limit: BusyLimit, busy: number) {
  const dollars = (amount: number) => `$${(amount / MICROS).toFixed(2).replace(/\.00$/, "")}`;
  const why = limit.source === "tier" ? `the most its usage tier (${limit.tier}) allows` : "the most this account allows";
  const next = limit.source === "tier" && limit.next
    ? ` ${dollars(Math.max(0, limit.next.paid - limit.paid))} more of credit unlocks ${limit.next.tier}: ${limit.next.limit} busy agents (it applies once the account has paid ${dollars(limit.next.paid)} in total).` : "";
  return new HttpError(429, `This account has ${busy} agents busy, ${why}; retry when one finishes.${next}`, "BUSY_AGENT_LIMIT", { busyAgents: { busy, ...limit } });
}

/**
 * Agents busy with runs, counted per tenant across every node: an agent is busy from the
 * moment a run of it is accepted until it has none open (queued or running). Each busy agent
 * has a row in `busy_agents` naming the node session that holds it; rows count only while that
 * session's heartbeat is live, so a node that dies or fences itself stops counting when its
 * actors become free to take over, with no cleanup needed.
 *
 * Taking a slot runs in one transaction under a per-tenant advisory lock: it counts the tenant's
 * live rows, reads its limit (and so its tier, from what it has paid, in the same transaction:
 * a payment applies to the next start), and inserts. Two nodes starting agents at once queue on
 * the lock, so the limit is never exceeded by new work. Only work accepted before (runs a node
 * takes over from one that was lost or drained) takes a slot regardless, and so does an agent
 * already busy when its tenant's limit drops; both can put a tenant over until they finish.
 */
export class BusyAgents {
  private readonly db: Db;
  private readonly ownership: Ownership;
  private readonly limitFor: (tenant: string, sql: Sql) => Promise<BusyLimit>;

  constructor(options: { db: Db; ownership: Ownership; limitFor: (tenant: string, sql: Sql) => Promise<BusyLimit> }) {
    this.db = options.db;
    this.ownership = options.ownership;
    this.limitFor = options.limitFor;
  }

  /**
   * Count `agent` as busy for `tenant` on this node. Returns the 429 to answer instead when the
   * tenant is at its limit, unless `force` (work accepted before) takes the slot regardless.
   */
  async hold(tenant: string, agent: string, force = false): Promise<HttpError | undefined> {
    const node = this.ownership.node;
    const session = this.ownership.sessionId;
    return transaction(this.db, async sql => {
      await sql.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`busy-agents:${tenant}`]);
      // Rows of node sessions that are gone stop counting; dropping them here keeps the table to live ones.
      await sql.query(`delete from busy_agents b where tenant = $1 and not exists (
        select 1 from runtime_nodes n where n.node = b.node and n.session = b.session and n.expires_at > now())`, [tenant]);
      if (!force) {
        const busy = Number((await sql.query("select count(*) as busy from busy_agents where tenant = $1 and agent <> $2", [tenant, agent])).rows[0].busy);
        const limit = await this.limitFor(tenant, sql);
        if (busy >= limit.limit) {
          // A usage tier's limit is the plan working as sold, not an operator's limit to raise: it is logged apart, outside the quota alarm.
          console.log(JSON.stringify({ type: limit.source === "tier" ? "busy_limit_reached" : "quota_rejected", level: "info", tenant, agent, limit: "busyAgents", value: limit.limit, source: limit.source, ...(limit.source === "tier" ? { tier: limit.tier } : {}), status: 429 }));
          return busyLimitError(limit, busy);
        }
      }
      const { rowCount } = await sql.query(`
        insert into busy_agents (agent, tenant, node, session)
        select $1, $2, $3, $4 where exists (select 1 from runtime_nodes where node = $3 and session = $4 and expires_at > now())
        on conflict (agent) do update set tenant = excluded.tenant, node = excluded.node, session = excluded.session`, [agent, tenant, node, session]);
      if (!rowCount) throw new HttpError(503, "This node's heartbeat lapsed; retry");
      return undefined;
    });
  }

  /**
   * The 429 `hold` would answer for a new busy agent of `tenant` now, without taking a slot: a stateless run checks this
   * before it makes anything, and `hold` still decides when the run is accepted.
   */
  async check(tenant: string): Promise<HttpError | undefined> {
    const [busy, limit] = await Promise.all([busyCount(this.db, tenant), this.limitFor(tenant, this.db)]);
    return busy >= limit.limit ? busyLimitError(limit, busy) : undefined;
  }

  /** `agent` is no longer busy here. */
  async release(agent: string) {
    await this.db.query("delete from busy_agents where agent = $1 and node = $2", [agent, this.ownership.node]);
  }
}

/** How many agents `tenant` has busy across the fleet now. */
export async function busyCount(sql: Sql, tenant: string) {
  const { rows } = await sql.query(`
    select count(*) as busy from busy_agents b join runtime_nodes n on n.node = b.node and n.session = b.session
    where b.tenant = $1 and n.expires_at > now()`, [tenant]);
  return Number(rows[0].busy);
}

/** The tier entry for `paid`, as `BusyLimit` reports it. */
export function tierLimit(tier: UsageTier, next: UsageTier | undefined, paid: number): BusyLimit {
  return { limit: tier.busyAgents, source: "tier", tier: tier.name, paid, ...(next ? { next: { tier: next.name, paid: next.paid, limit: next.busyAgents } } : {}) };
}
