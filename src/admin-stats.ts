import type { Sql } from "./db.ts";

/** One UTC day of the platform: sign-ups that day, and the tenants that used models and what they used. */
export interface AdminDay { day: string; signups: number; activeTenants: number; responses: number; cost: number; platformCost: number }
/** A recent sign-up and how far it got. Amounts are micro-USD, as in the credit ledger; costs are USD. */
export interface AdminSignup {
  tenant: string; github: string | null; googleEmail: string | null; signIn: "github" | "google" | "email" | "operator" | null;
  createdAt: number; deleted: boolean; tokens: number; agents: number; responses: number; cost: number; balance: number; purchased: number;
}
export interface AdminStats {
  days: number;
  signups: { total: number; last24h: number; last7d: number; last30d: number; deleted: number; github: number; google: number; email: number; operator: number };
  /** Of the live self-serve tenants, how many got to each step. */
  activation: { tenants: number; withToken: number; withAgent: number; withUsage: number; purchased: number };
  agents: { live: number; tenants: number };
  purchases: { count: number; buyers: number; amount: number };
  daily: AdminDay[];
  recent: AdminSignup[];
}

const DAY_MS = 86_400_000;

/**
 * Every tenant, for the team's admin site (src/admin-site.ts, GET /api/stats): sign-ups (self-serve tenants, the `tenants`
 * table; admin tenants live in the tenants file), how far they got, and model usage across all tenants, per UTC day
 * as `usage` keeps it. Read-only.
 */
export async function adminStats(db: Sql, options: { days: number; recent: number; now?: number }): Promise<AdminStats> {
  const now = options.now ?? Date.now();
  const since = new Date(now - (options.days - 1) * DAY_MS).toISOString().slice(0, 10);
  const today = new Date(now).toISOString().slice(0, 10);
  const [signups, activation, agents, purchases, daily, recent] = await Promise.all([
    db.query(`
      select count(*) total,
        count(*) filter (where t.created_at > $1) last24h, count(*) filter (where t.created_at > $2) last7d, count(*) filter (where t.created_at > $3) last30d,
        count(d.tenant) deleted,
        count(*) filter (where d.tenant is null and (t.github_id is not null or t.github is not null)) github,
        count(*) filter (where d.tenant is null and t.google_sub is not null) google,
        count(*) filter (where d.tenant is null and t.email_signup) email
      from tenants t left join account_deletions d on d.tenant = t.id`, [now - DAY_MS, now - 7 * DAY_MS, now - 30 * DAY_MS]),
    db.query(`
      select count(*) tenants,
        count(*) filter (where exists (select 1 from api_tokens k where k.tenant = t.id)) with_token,
        count(*) filter (where exists (select 1 from agents a where a.tenant = t.id)) with_agent,
        count(*) filter (where exists (select 1 from usage u where u.tenant = t.id and u.responses > 0)) with_usage,
        count(*) filter (where exists (select 1 from credit_accounts c where c.tenant = t.id and c.purchased > 0)) purchased
      from tenants t where not exists (select 1 from account_deletions d where d.tenant = t.id)`),
    db.query("select count(*) live, count(distinct tenant) tenants from agents where not revoked"),
    db.query("select count(*) count, count(distinct tenant) buyers, coalesce(sum(amount), 0) amount from credit_ledger where kind = 'purchase'"),
    db.query(`
      select to_char(series.day, 'YYYY-MM-DD') as day,
        (select count(*) from tenants t where t.created_at >= extract(epoch from series.day) * 1000 and t.created_at < extract(epoch from series.day) * 1000 + $3) signups,
        count(distinct u.tenant) filter (where u.responses > 0) active_tenants,
        coalesce(sum(u.responses), 0) responses, coalesce(sum(u.cost), 0) cost, coalesce(sum(u.platform_cost), 0) platform_cost
      from generate_series($1::date, $2::date, interval '1 day') as series(day) left join usage u on u.day = series.day::date
      group by series.day order by series.day`, [since, today, DAY_MS]),
    db.query(`
      select t.id, t.github, t.google_email, (t.github_id is not null or t.github is not null) as by_github, t.google_sub is not null as by_google, t.email_signup as by_email, t.created_at, d.tenant is not null as deleted,
        (select count(*) from api_tokens k where k.tenant = t.id) tokens,
        (select count(*) from agents a where a.tenant = t.id and not a.revoked) agents,
        (select coalesce(sum(responses), 0) from usage u where u.tenant = t.id) responses,
        (select coalesce(sum(cost), 0) from usage u where u.tenant = t.id) cost,
        coalesce(c.balance, 0) balance, coalesce(c.purchased, 0) purchased
      from tenants t left join account_deletions d on d.tenant = t.id left join credit_accounts c on c.tenant = t.id
      order by t.created_at desc limit $1`, [options.recent]),
  ]);
  const n = (value: unknown) => Number(value ?? 0);
  const s = signups.rows[0], a = activation.rows[0];
  return {
    days: options.days,
    signups: {
      total: n(s.total), last24h: n(s.last24h), last7d: n(s.last7d), last30d: n(s.last30d), deleted: n(s.deleted),
      github: n(s.github), google: n(s.google), email: n(s.email), operator: n(s.total) - n(s.deleted) - n(s.github) - n(s.google) - n(s.email),
    },
    activation: { tenants: n(a.tenants), withToken: n(a.with_token), withAgent: n(a.with_agent), withUsage: n(a.with_usage), purchased: n(a.purchased) },
    agents: { live: n(agents.rows[0].live), tenants: n(agents.rows[0].tenants) },
    purchases: { count: n(purchases.rows[0].count), buyers: n(purchases.rows[0].buyers), amount: n(purchases.rows[0].amount) },
    daily: daily.rows.map(row => ({ day: row.day, signups: n(row.signups), activeTenants: n(row.active_tenants), responses: n(row.responses), cost: n(row.cost), platformCost: n(row.platform_cost) })),
    // A deleted account's identity columns are cleared at once (account-deletion.ts), so it shows by id only.
    recent: recent.rows.map(row => ({
      tenant: row.id, github: row.github, googleEmail: row.google_email,
      signIn: row.deleted ? null : row.by_github ? "github" : row.by_google ? "google" : row.by_email ? "email" : "operator",
      createdAt: n(row.created_at), deleted: row.deleted, tokens: n(row.tokens), agents: n(row.agents),
      responses: n(row.responses), cost: n(row.cost), balance: n(row.balance), purchased: n(row.purchased),
    })),
  };
}
