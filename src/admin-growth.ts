import { adminWindow, counted, DAY_MS, modelCall, n, SELF_SERVE, SIGN_IN, snapshot, startOfUtcDay, utcDate, windowDates, windowOf, type AdminCompare, type AdminWindow } from "./admin-accounts.ts";
import type { Db } from "./db.ts";

/** A UTC day of sign-ups (by how they signed in) and of accounts that did work, new (made that day) or returning. */
export interface AdminGrowthDay { date: string; signups: number; github: number; google: number; email: number; active_new: number; active_returning: number; accounts: number }
/** A week's sign-ups (Monday, UTC) and how many of them did work in each week since: `active[k]` is week k after it, 0 being its own. */
export interface AdminCohort { week: string; size: number; active: number[] }
/** How far a window's sign-ups got, each step a subset of the one before. */
export interface AdminFunnel { signed_up: number; made_agent: number; ran_model: number; came_back: number }

export interface AdminGrowth {
  schema_version: 1;
  range: AdminWindow;
  generated_at: string;
  /** Live self-serve accounts now. */
  accounts: number;
  tiles: {
    signups: AdminCompare;
    /** Of the window's sign-ups (and the window before's), how many ran a model by now. */
    activated: AdminCompare;
    /** Accounts that did work in the last 7 whole UTC days, and the 7 before those. */
    weekly_active: AdminCompare;
    /** Of those, the accounts made before the 7 days: they came back. */
    weekly_returning: AdminCompare;
  };
  daily: AdminGrowthDay[];
  sign_in: { github: number; google: number; email: number };
  funnel: AdminFunnel;
  previous_funnel: AdminFunnel;
  /** Of the window's sign-ups that ran a model, the median whole days from signing up to the first day they did. */
  median_days_to_first_run: number | null;
  /** The last 12 weeks' sign-ups, oldest first; the newest weeks have fewer weeks since. */
  cohorts: AdminCohort[];
}

export const ADMIN_COHORT_WEEKS = 12;

/**
 * Are we growing, and do people stay (the admin site's Growth tab, GET /api/growth)? Read-only, from this runtime's own
 * tables, by UTC day. Every figure counts the same accounts: self-serve sign-ups that are not erased and not staff
 * (`counted`). An account "did work" on a day its agents got at least one model response then (`usage.responses` of a
 * model call: not a web search, a transcription or images alone), whoever started the run (a person, a schedule or a
 * channel); opening the console is not work.
 */
export async function adminGrowth(db: Db, options: { days: number | string; now?: number; internalDomains?: string[] }): Promise<AdminGrowth> {
  const now = options.now ?? Date.now();
  const window = adminWindow(options.days, now);
  const domains = options.internalDomains ?? [];
  const today = startOfUtcDay(now);
  // Monday of this UTC week (the epoch was a Thursday).
  const week = today - ((Math.floor(today / DAY_MS) + 3) % 7) * DAY_MS;
  const cohortFrom = week - (ADMIN_COHORT_WEEKS - 1) * 7 * DAY_MS;
  const base = `${SELF_SERVE} and ${counted("$1::text[]")}`;
  const signupDay = "(to_timestamp(t.created_at / 1000.0) at time zone 'UTC')::date";
  const [signups, totals, active, weekly, funnels, median, cohorts] = await snapshot(db, sql => Promise.all([
    // By UTC day since the previous window's start: slots below `days` are the previous window.
    sql.query(`
      select (t.created_at - $2) / ${DAY_MS} as slot, ${SIGN_IN} as method, count(*) as count from tenants t
      where t.created_at >= $2 and t.created_at < $3 and ${base}
      group by 1, 2`, [domains, window.previousFrom, window.until]),
    sql.query(`select count(*) as total, count(*) filter (where t.created_at < $2) as before from tenants t where ${base}`, [domains, window.from]),
    sql.query(`
      select to_char(u.day, 'YYYY-MM-DD') as date,
        count(distinct u.tenant) filter (where t.created_at < extract(epoch from u.day) * 1000) as returning,
        count(distinct u.tenant) filter (where t.created_at >= extract(epoch from u.day) * 1000) as new
      from usage u join tenants t on t.id = u.tenant
      where u.day >= $2::date and u.day < $3::date and u.responses > 0 and ${modelCall()} and ${base}
      group by u.day`, [domains, utcDate(window.from), utcDate(window.until)]),
    sql.query(`
      select count(distinct u.tenant) filter (where u.day >= $2::date) as current, count(distinct u.tenant) filter (where u.day < $2::date) as previous,
        count(distinct u.tenant) filter (where u.day >= $2::date and t.created_at < $4) as current_returning,
        count(distinct u.tenant) filter (where u.day < $2::date and t.created_at < $5) as previous_returning
      from usage u join tenants t on t.id = u.tenant
      where u.day >= $3::date and u.day < $6::date and u.responses > 0 and ${modelCall()} and ${base}`,
      [domains, utcDate(today - 7 * DAY_MS), utcDate(today - 14 * DAY_MS), today - 7 * DAY_MS, today - 14 * DAY_MS, utcDate(today)]),
    sql.query(`
      select t.created_at >= $2 as current, count(*) as signed_up,
        count(*) filter (where exists (select 1 from agents a where a.tenant = t.id) or exists (select 1 from usage u where u.tenant = t.id and u.responses > 0 and ${modelCall()})) as made_agent,
        count(*) filter (where exists (select 1 from usage u where u.tenant = t.id and u.responses > 0 and ${modelCall()})) as ran_model,
        count(*) filter (where exists (select 1 from usage u where u.tenant = t.id and u.responses > 0 and ${modelCall()} and u.day > ${signupDay})) as came_back
      from tenants t where t.created_at >= $3 and t.created_at < $4 and ${base}
      group by 1`, [domains, window.from, window.previousFrom, window.until]),
    sql.query(`
      select percentile_cont(0.5) within group (order by f.first - ${signupDay}) as median from tenants t
      join lateral (select min(u.day) as first from usage u where u.tenant = t.id and u.responses > 0 and ${modelCall()}) f on f.first is not null
      where t.created_at >= $2 and t.created_at < $3 and ${base}`, [domains, window.from, window.until]),
    sql.query(`
      with cohort as (
        select t.id, date_trunc('week', to_timestamp(t.created_at / 1000.0) at time zone 'UTC')::date as week from tenants t
        where t.created_at >= $2 and ${base})
      select to_char(c.week, 'YYYY-MM-DD') as week, null as active_week, count(*) as count from cohort c group by c.week
      union all
      select to_char(c.week, 'YYYY-MM-DD'), to_char(date_trunc('week', u.day::timestamp), 'YYYY-MM-DD'), count(distinct u.tenant) from cohort c
      join usage u on u.tenant = c.id where u.responses > 0 and ${modelCall()} and u.day >= $3::date group by c.week, date_trunc('week', u.day::timestamp)`, [domains, cohortFrom, utcDate(cohortFrom)]),
  ]));

  const dates = windowDates(window);
  const before = n(totals.rows[0].before);
  const daily: AdminGrowthDay[] = dates.map(date => ({ date, signups: 0, github: 0, google: 0, email: 0, active_new: 0, active_returning: 0, accounts: 0 }));
  const sign_in = { github: 0, google: 0, email: 0 };
  let previousSignups = 0;
  for (const row of signups.rows) {
    const slot = n(row.slot) - window.days, count = n(row.count), method = row.method as keyof typeof sign_in;
    if (slot < 0) { previousSignups += count; continue; }
    daily[slot].signups += count;
    daily[slot][method] += count;
    sign_in[method] += count;
  }
  const byDate = new Map(daily.map(day => [day.date, day]));
  for (const row of active.rows) {
    const day = byDate.get(row.date);
    if (day) { day.active_new = n(row.new); day.active_returning = n(row.returning); }
  }
  let running = before;
  for (const day of daily) day.accounts = running += day.signups;

  const funnel = (current: boolean): AdminFunnel => {
    const row = funnels.rows.find(row => row.current === current);
    return { signed_up: n(row?.signed_up), made_agent: n(row?.made_agent), ran_model: n(row?.ran_model), came_back: n(row?.came_back) };
  };
  const current = funnel(true), previous = funnel(false);
  const w = weekly.rows[0];
  const medianValue = median.rows[0]?.median;

  const sizes = new Map<string, number>(), activity = new Map<string, Map<string, number>>();
  for (const row of cohorts.rows) {
    if (row.active_week === null) sizes.set(row.week, n(row.count));
    else {
      if (!activity.has(row.week)) activity.set(row.week, new Map());
      activity.get(row.week)!.set(row.active_week, n(row.count));
    }
  }
  const cohortList: AdminCohort[] = Array.from({ length: ADMIN_COHORT_WEEKS }, (_, index) => {
    const start = cohortFrom + index * 7 * DAY_MS, label = utcDate(start);
    const weeks = Math.floor((week - start) / (7 * DAY_MS)) + 1;
    return { week: label, size: sizes.get(label) ?? 0, active: Array.from({ length: weeks }, (_, k) => activity.get(label)?.get(utcDate(start + k * 7 * DAY_MS)) ?? 0) };
  });

  return {
    schema_version: 1, range: windowOf(window), generated_at: new Date(now).toISOString(),
    accounts: n(totals.rows[0].total),
    tiles: {
      signups: { current: daily.reduce((sum, day) => sum + day.signups, 0), previous: previousSignups },
      activated: { current: current.ran_model, previous: previous.ran_model },
      weekly_active: { current: n(w.current), previous: n(w.previous) },
      weekly_returning: { current: n(w.current_returning), previous: n(w.previous_returning) },
    },
    daily, sign_in, funnel: current, previous_funnel: previous,
    median_days_to_first_run: medianValue === null || medianValue === undefined ? null : Number(medianValue),
    cohorts: cohortList,
  };
}
