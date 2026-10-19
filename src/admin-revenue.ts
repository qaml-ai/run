import {
  accountName, adminWindow, counted, DAY_MS, n, NAME_COLUMNS, SELF_SERVE, snapshot, staff, startOfUtcDay, utcDate, windowDates, windowOf,
  type AdminAccountName, type AdminCompare, type AdminWindow,
} from "./admin-accounts.ts";
import type { Db } from "./db.ts";

/** A UTC day's credit purchases (checkouts and automatic top-ups, at their full amount) and refunds. Amounts are micro-USD. */
export interface AdminRevenueDay { date: string; purchases: number; amount: number; refunds: number }
export interface AdminRevenueMonth { month: string; amount: number; refunds: number; buyers: number }
/** How much of its free credit an account used, as a share: none, under a quarter, to three quarters, nearly all, all. */
export type AdminFreeCreditBucket = "untouched" | "tried" | "using" | "nearly_out" | "used_up";
export interface AdminFreeCreditAccount extends AdminAccountName {
  /** How it got its free credit: the starting grant for an old enough GitHub account, a verified card, or an operator. */
  via: "github" | "card" | "operator" | "other";
  given: number; used: number; left: number; bucket: AdminFreeCreditBucket;
  purchased: number; responses: number; active_days: number; last_active: string | null;
}
export interface AdminRevenue {
  schema_version: 1;
  range: AdminWindow;
  generated_at: string;
  /** Micro-USD. Staff are not counted; erased accounts' purchases are, being money that came in. */
  tiles: {
    revenue: AdminCompare;
    refunds: AdminCompare;
    buyers: AdminCompare;
    first_purchases: AdminCompare;
    /** Accounts that ever bought credit (net of refunds), and that have automatic top-ups on. */
    paying_accounts: number;
    auto_topup: number;
    /** What accounts hold now: credit bought and not spent, and free credit not spent (free credit counts as spent first). */
    outstanding_purchased: number;
    outstanding_free: number;
  };
  daily: AdminRevenueDay[];
  /** The last 12 calendar months (UTC), oldest first. */
  monthly: AdminRevenueMonth[];
  /**
   * In the window, what paying and free-credit accounts were charged (model calls, agent hours, storage...) and what the
   * providers cost for their calls on the platform's keys (USD).
   */
  spend: { paying_charged: number; paying_provider_cost: number; free_charged: number; free_provider_cost: number };
  free_credit: {
    /** Self-serve accounts given free credit, and what they were given and used, in micro-USD. */
    accounts: number; given: number; used: number;
    buckets: Record<AdminFreeCreditBucket, number>;
    /** Of those given free credit: how many used some, and how many bought credit after. */
    used_any: number; bought: number;
    /** Self-serve accounts with no free credit, and why where the starting-credit decision says. */
    without: number;
    decisions: { eligible: number; ineligible: number; disabled: number; legacy: number; card_unlocked: number };
    /** What the providers cost for accounts that never bought credit, all time (USD): what free credit costs the platform. */
    provider_cost: number;
    /** The accounts, the most used first (at most ADMIN_FREE_CREDIT_ROWS). */
    rows: AdminFreeCreditAccount[];
  };
}

export const ADMIN_FREE_CREDIT_ROWS = 200;
/** Under a cent left is all used. */
const CENT = 10_000;

export function freeCreditBucket(given: number, used: number): AdminFreeCreditBucket {
  if (used < CENT) return "untouched";
  if (given - used < CENT) return "used_up";
  const share = used / given;
  return share < 0.25 ? "tried" : share < 0.75 ? "using" : "nearly_out";
}

/**
 * Money (the admin site's Revenue tab, GET /api/revenue): credit purchases and refunds by day and by month, what accounts
 * hold, what was charged against what the providers cost, and who uses the free credit sign-ups get. Read-only. The
 * balance is one pool and free credit counts as spent first, as the console says when an account is deleted.
 */
export async function adminRevenue(db: Db, options: { days: number | string; now?: number; internalDomains?: string[] }): Promise<AdminRevenue> {
  const now = options.now ?? Date.now();
  const window = adminWindow(options.days, now);
  const domains = options.internalDomains ?? [];
  const notStaff = `(t.id is null or not ${staff("$1::text[]")})`;
  const selfServe = `(${SELF_SERVE} and ${counted("$1::text[]")})`;
  const month = new Date(startOfUtcDay(now));
  const monthsFrom = Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 11, 1);
  const [ledger, monthly, firsts, accounts, spend, free, decisions, freeCost] = await snapshot(db, sql => Promise.all([
    sql.query(`
      select (l.created_at - $2) / ${DAY_MS} as slot, count(*) filter (where l.kind = 'purchase') as purchases,
        coalesce(sum(l.amount) filter (where l.kind = 'purchase'), 0) as amount, coalesce(-sum(l.amount) filter (where l.kind = 'refund'), 0) as refunds,
        array_agg(distinct l.tenant) filter (where l.kind = 'purchase') as buyers
      from credit_ledger l left join tenants t on t.id = l.tenant
      where l.kind in ('purchase', 'refund') and l.created_at >= $2 and l.created_at < $3 and ${notStaff}
      group by 1`, [domains, window.previousFrom, window.until]),
    sql.query(`
      select to_char(date_trunc('month', to_timestamp(l.created_at / 1000.0) at time zone 'UTC'), 'YYYY-MM') as month,
        coalesce(sum(l.amount) filter (where l.kind = 'purchase'), 0) as amount, coalesce(-sum(l.amount) filter (where l.kind = 'refund'), 0) as refunds,
        count(distinct l.tenant) filter (where l.kind = 'purchase') as buyers
      from credit_ledger l left join tenants t on t.id = l.tenant
      where l.kind in ('purchase', 'refund') and l.created_at >= $2 and ${notStaff}
      group by 1`, [domains, monthsFrom]),
    sql.query(`
      select count(*) filter (where f.first >= $2) as current, count(*) filter (where f.first < $2) as previous from (
        select l.tenant, min(l.created_at) as first from credit_ledger l left join tenants t on t.id = l.tenant
        where l.kind = 'purchase' and ${notStaff} group by l.tenant) f
      where f.first >= $3 and f.first < $4`, [domains, window.from, window.previousFrom, window.until]),
    sql.query(`
      select count(*) filter (where c.purchased > 0) as paying,
        coalesce(sum(least(greatest(c.balance, 0), greatest(c.purchased, 0))), 0) as outstanding_purchased,
        coalesce(sum(greatest(c.balance, 0) - least(greatest(c.balance, 0), greatest(c.purchased, 0))), 0) as outstanding_free,
        (select count(distinct a.tenant) from billing_auto_settings a left join tenants t on t.id = a.tenant where a.enabled and a.status = 'on' and ${notStaff}) as auto_topup
      from credit_accounts c join tenants t on t.id = c.tenant
      where t.billing = 'prepaid' and not exists (select 1 from account_deletions d where d.tenant = t.id) and not ${staff("$1::text[]")}`, [domains]),
    sql.query(`
      select coalesce(-sum(l.amount) filter (where c.purchased > 0), 0) as paying_charged, coalesce(-sum(l.amount) filter (where coalesce(c.purchased, 0) <= 0), 0) as free_charged,
        (select coalesce(sum(u.platform_cost) filter (where c2.purchased > 0), 0) from usage u join tenants t on t.id = u.tenant left join credit_accounts c2 on c2.tenant = u.tenant
          where t.billing = 'prepaid' and u.day >= $3::date and u.day < $4::date and ${notStaff}) as paying_provider_cost,
        (select coalesce(sum(u.platform_cost) filter (where coalesce(c2.purchased, 0) <= 0), 0) from usage u join tenants t on t.id = u.tenant left join credit_accounts c2 on c2.tenant = u.tenant
          where t.billing = 'prepaid' and u.day >= $3::date and u.day < $4::date and ${notStaff}) as free_provider_cost
      from credit_ledger l join tenants t on t.id = l.tenant left join credit_accounts c on c.tenant = l.tenant
      where l.kind in ('usage', 'storage') and l.created_at >= $2 and l.created_at < $5 and ${notStaff}`,
      [domains, window.from, utcDate(window.from), utcDate(window.until), window.until]),
    sql.query(`
      with given as (
        select l.tenant, sum(l.amount) as given,
          bool_or(l.kind = 'grant' and l.idempotency_key like 'grant:github:%') as github, bool_or(l.kind = 'grant' and l.idempotency_key like 'grant:card:%') as card,
          bool_or(l.kind = 'adjustment') as operator
        from credit_ledger l where l.kind in ('grant', 'adjustment') and l.amount > 0 group by l.tenant)
      select given.*, ${NAME_COLUMNS}, coalesce(c.balance, 0) as balance, coalesce(c.purchased, 0) as purchased,
        (select coalesce(sum(u.responses), 0) from usage u where u.tenant = t.id) as responses,
        (select count(distinct u.day) from usage u where u.tenant = t.id and u.responses > 0) as active_days,
        (select to_char(max(u.day), 'YYYY-MM-DD') from usage u where u.tenant = t.id and u.responses > 0) as last_active
      from given join tenants t on t.id = given.tenant left join credit_accounts c on c.tenant = t.id
      where t.billing = 'prepaid' and ${selfServe}`, [domains]),
    sql.query(`
      select count(*) filter (where not exists (select 1 from credit_ledger l where l.tenant = t.id and l.kind in ('grant', 'adjustment') and l.amount > 0)) as without,
        count(*) filter (where s.decision = 'eligible') as eligible, count(*) filter (where s.decision = 'ineligible') as ineligible,
        count(*) filter (where s.decision = 'disabled') as disabled, count(*) filter (where s.decision = 'legacy') as legacy,
        count(*) filter (where exists (select 1 from card_checks k where k.tenant = t.id and k.granted)) as card_unlocked
      from tenants t left join starting_credit_decisions s on s.tenant = t.id
      where t.billing = 'prepaid' and ${selfServe}`, [domains]),
    sql.query(`
      select coalesce(sum(u.platform_cost), 0) as cost from usage u join tenants t on t.id = u.tenant left join credit_accounts c on c.tenant = t.id
      where t.billing = 'prepaid' and coalesce(c.purchased, 0) <= 0 and ${selfServe}`, [domains]),
  ]));

  const daily: AdminRevenueDay[] = windowDates(window).map(date => ({ date, purchases: 0, amount: 0, refunds: 0 }));
  const sums = { current: { amount: 0, refunds: 0, buyers: new Set<string>() }, previous: { amount: 0, refunds: 0, buyers: new Set<string>() } };
  for (const row of ledger.rows) {
    const slot = n(row.slot) - window.days, period = slot < 0 ? sums.previous : sums.current;
    period.amount += n(row.amount);
    period.refunds += n(row.refunds);
    for (const buyer of row.buyers ?? []) period.buyers.add(buyer);
    if (slot >= 0) Object.assign(daily[slot], { purchases: n(row.purchases), amount: n(row.amount), refunds: n(row.refunds) });
  }
  const byMonth = new Map(monthly.rows.map(row => [row.month, row]));
  const months = Array.from({ length: 12 }, (_, index) => {
    const start = new Date(monthsFrom);
    start.setUTCMonth(start.getUTCMonth() + index);
    const label = start.toISOString().slice(0, 7), row = byMonth.get(label);
    return { month: label, amount: n(row?.amount), refunds: n(row?.refunds), buyers: n(row?.buyers) };
  });

  const rows: AdminFreeCreditAccount[] = free.rows.map(row => {
    const given = n(row.given), balance = Math.max(0, n(row.balance)), purchasedLeft = Math.min(balance, Math.max(0, n(row.purchased)));
    const left = Math.min(given, balance - purchasedLeft), used = Math.max(0, given - left);
    return {
      ...accountName(row.tenant, row), via: row.github ? "github" : row.card ? "card" : row.operator ? "operator" : "other",
      given, used, left, bucket: freeCreditBucket(given, used), purchased: n(row.purchased),
      responses: n(row.responses), active_days: n(row.active_days), last_active: row.last_active ?? null,
    };
  });
  const buckets: Record<AdminFreeCreditBucket, number> = { untouched: 0, tried: 0, using: 0, nearly_out: 0, used_up: 0 };
  for (const row of rows) buckets[row.bucket]++;
  const d = decisions.rows[0], a = accounts.rows[0], s = spend.rows[0], f = firsts.rows[0];
  return {
    schema_version: 1, range: windowOf(window), generated_at: new Date(now).toISOString(),
    tiles: {
      revenue: { current: sums.current.amount, previous: sums.previous.amount },
      refunds: { current: sums.current.refunds, previous: sums.previous.refunds },
      buyers: { current: sums.current.buyers.size, previous: sums.previous.buyers.size },
      first_purchases: { current: n(f.current), previous: n(f.previous) },
      paying_accounts: n(a.paying), auto_topup: n(a.auto_topup), outstanding_purchased: n(a.outstanding_purchased), outstanding_free: n(a.outstanding_free),
    },
    daily, monthly: months,
    spend: { paying_charged: n(s.paying_charged), paying_provider_cost: n(s.paying_provider_cost), free_charged: n(s.free_charged), free_provider_cost: n(s.free_provider_cost) },
    free_credit: {
      accounts: rows.length, given: rows.reduce((sum, row) => sum + row.given, 0), used: rows.reduce((sum, row) => sum + row.used, 0), buckets,
      used_any: rows.length - buckets.untouched, bought: rows.filter(row => row.purchased > 0).length,
      without: n(d.without),
      decisions: { eligible: n(d.eligible), ineligible: n(d.ineligible), disabled: n(d.disabled), legacy: n(d.legacy), card_unlocked: n(d.card_unlocked) },
      provider_cost: n(freeCost.rows[0].cost),
      rows: rows.sort((x, y) => y.used - x.used || y.responses - x.responses).slice(0, ADMIN_FREE_CREDIT_ROWS),
    },
  };
}
