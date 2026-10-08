import type { Sql } from "./db.ts";

/** Calendar dates (YYYY-MM-DD), both included, in an IANA time zone. */
export interface AdminRange { start_date: string; end_date: string; time_zone: string }
/**
 * How far first runs are known. `full`: for the whole range. `partial`: from `since` on, which is within the range
 * (days wholly before it are null). `none`: the range ends before `since`. `unavailable`: journey events are off, so
 * no first run is being recorded. `since` is when journey events were first on, where a count is given or `none`.
 */
export interface AdminActivationCoverage { status: "full" | "partial" | "none" | "unavailable"; since: string | null }
export interface AdminSignalsDay { date: string; signups: number; activations: number | null; payments: number; amount_minor: number }
export interface AdminSignals {
  schema_version: 1;
  range: AdminRange;
  generated_at: string;
  /** `activations` is null where first runs are not known (`activation_coverage`): never a zero that was not counted. */
  summary: { signups: number; activations: number | null; payments: number; paying_accounts: number; amount_minor: number; currency: "USD" };
  daily: AdminSignalsDay[];
  activation_coverage: AdminActivationCoverage;
}

/** A range the site refuses, as the journey store's reports name it (`invalid_date`, `invalid_range`, `invalid_time_zone`, `range_too_long`). */
export class AdminRangeError extends Error {
  status: 400 | 422;
  constructor(status: 400 | 422, code: string) { super(code); this.status = status; }
}

/** The time zone a request's dates are in when it names none. */
export const ADMIN_TIME_ZONE = "America/Chicago";
export const ADMIN_MAX_DAYS = 366;
const DAY_MS = 86_400_000;
/** A purchase's ledger amount is micro-USD (pricing.ts, MICROS); a cent is this many. */
const CENT = 10_000;

function dateFormat(timeZone: unknown) {
  if (typeof timeZone !== "string" || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(timeZone)) throw new AdminRangeError(400, "invalid_time_zone");
  // en-CA writes YYYY-MM-DD, which sorts as dates do.
  try { return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }); }
  catch { throw new AdminRangeError(400, "invalid_time_zone"); }
}

/** Today's date in the zone. */
export function adminToday(timeZone = ADMIN_TIME_ZONE, now = Date.now()) {
  return dateFormat(timeZone).format(now);
}

function calendarDate(value: unknown) {
  const time = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new AdminRangeError(400, "invalid_date");
  return time;
}

/**
 * The instant each calendar day of the range starts in its zone, and the instant after its last day ends: one more
 * boundary than there are days. The journey store's reports cut days the same way, so the two agree on what a day is.
 */
export function adminDays(range: AdminRange): { dates: string[]; boundaries: number[] } {
  const format = dateFormat(range.time_zone);
  const start = calendarDate(range.start_date), end = calendarDate(range.end_date);
  if (end < start) throw new AdminRangeError(400, "invalid_range");
  const days = Math.round((end - start) / DAY_MS) + 1;
  if (days > ADMIN_MAX_DAYS) throw new AdminRangeError(422, "range_too_long");
  const label = (utc: number) => new Date(utc).toISOString().slice(0, 10);
  // A day starts at the first instant whose local date is that day. Local dates never go backwards, so search for
  // it: this is right across daylight-saving changes, including zones whose clocks skip midnight itself.
  const startOf = (date: string, utc: number) => {
    let low = utc - 15 * 3_600_000, high = utc + 15 * 3_600_000;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (format.format(middle) >= date) high = middle; else low = middle + 1;
    }
    return low;
  };
  const dates = Array.from({ length: days }, (_, day) => label(start + day * DAY_MS));
  return { dates, boundaries: [...dates, label(end + DAY_MS)].map((date, day) => startOf(date, start + day * DAY_MS)) };
}

// The accounts counted: not being or already erased (an erased account's ledger entries outlive its row), and not the
// operator's own staff as far as journey events know them (journey_accounts.internal; nobody is known while they are off).
const COUNTED = `not exists (select 1 from account_deletions d where d.tenant = t.id)
  and not exists (select 1 from journey_accounts j where j.tenant = t.id and j.internal)`;

/**
 * Sign-ups, first runs and credit purchases in a range of calendar days, in total and by day, for the team's admin
 * site (src/admin-site.ts, GET /api/product-signals). Read-only, from this runtime's own tables:
 *
 * - a sign-up is a tenant someone made for themselves (GitHub, Google or email), counted on the day it was made;
 *   tenants an operator made (POST /v1/tenants) are not sign-ups;
 * - a payment is a `purchase` entry of the credit ledger (a checkout or an automatic top-up), at its full amount,
 *   whatever was refunded later, in cents;
 * - an activation is an account's first completed run, which only journey events record (src/journey.ts,
 *   `run_first_execution_completed`): of accounts made while they were on, whose browsers did not refuse to be
 *   measured. `tracking` says whether they are on now. Where it is not known the count is null, not zero.
 */
export async function adminSignals(db: Sql, options: { range: AdminRange; tracking: boolean; now?: number }): Promise<AdminSignals> {
  const { dates, boundaries } = adminDays(options.range);
  const from = boundaries[0], until = boundaries.at(-1)!, starts = boundaries.slice(0, -1);
  // width_bucket numbers the days from 1, by the instant each starts.
  const [signups, payments, paying, activations, state] = await Promise.all([
    db.query(`
      select width_bucket(t.created_at, $1::bigint[]) as day, count(*) as count from tenants t
      where t.created_at >= $2 and t.created_at < $3 and (t.github_id is not null or t.github is not null or t.google_sub is not null or t.email_signup) and ${COUNTED}
      group by 1`, [starts, from, until]),
    db.query(`
      select width_bucket(l.created_at, $1::bigint[]) as day, count(*) as count, sum(l.amount) as amount from credit_ledger l join tenants t on t.id = l.tenant
      where l.kind = 'purchase' and l.created_at >= $2 and l.created_at < $3 and ${COUNTED}
      group by 1`, [starts, from, until]),
    db.query(`
      select count(distinct l.tenant) as count from credit_ledger l join tenants t on t.id = l.tenant
      where l.kind = 'purchase' and l.created_at >= $1 and l.created_at < $2 and ${COUNTED}`, [from, until]),
    db.query(`
      select width_bucket(m.at, $1::bigint[]) as day, count(*) as count from journey_milestones m join journey_accounts a on a.account_ref = m.account_ref
      where m.name = 'run_first_execution_completed' and m.at >= $2 and m.at < $3 and not a.internal
        and not exists (select 1 from account_deletions d where d.tenant = a.tenant)
      group by 1`, [starts, from, until]),
    db.query("select enabled_at from journey_state"),
  ]);
  const enabled = options.tracking && state.rows[0] ? Number(state.rows[0].enabled_at) : undefined;
  const coverage: AdminActivationCoverage = enabled === undefined ? { status: "unavailable", since: null }
    : { status: until <= enabled ? "none" : from >= enabled ? "full" : "partial", since: new Date(enabled).toISOString() };
  const known = coverage.status === "full" || coverage.status === "partial";
  // A day's first runs are known once journey events were on for any of it.
  const daily: AdminSignalsDay[] = dates.map((date, day) => ({ date, signups: 0, activations: known && boundaries[day + 1] > enabled! ? 0 : null, payments: 0, amount_minor: 0 }));
  let micros = 0;
  for (const row of signups.rows) daily[row.day - 1].signups = Number(row.count);
  for (const row of payments.rows) {
    const day = daily[row.day - 1];
    day.payments = Number(row.count);
    day.amount_minor = Math.round(Number(row.amount) / CENT);
    micros += Number(row.amount);
  }
  for (const row of activations.rows) {
    const day = daily[row.day - 1];
    if (day.activations !== null) day.activations = Number(row.count);
  }
  const sum = (count: (day: AdminSignalsDay) => number) => daily.reduce((total, day) => total + count(day), 0);
  return {
    schema_version: 1,
    range: { start_date: options.range.start_date, end_date: options.range.end_date, time_zone: options.range.time_zone },
    generated_at: new Date(options.now ?? Date.now()).toISOString(),
    summary: {
      signups: sum(day => day.signups), activations: known ? sum(day => day.activations ?? 0) : null,
      payments: sum(day => day.payments), paying_accounts: Number(paying.rows[0].count), amount_minor: Math.round(micros / CENT), currency: "USD",
    },
    daily,
    activation_coverage: coverage,
  };
}
