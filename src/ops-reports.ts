import { adminTrend } from "./admin-signals.ts";
import { transaction, type Db, type Sql } from "./db.ts";

/**
 * The rows the team's operations endpoint answers (src/ops-mcp.ts): counts, names, times, dollars and bytes, read-only,
 * from this runtime's own tables. Every query names its columns (never `select *`) and its filters, so a tool answers
 * what it says it answers and nothing else: no prompts, messages, transcripts, tokens, secrets or sessions, and no
 * account identities beyond the tenant id.
 *
 * Amounts are what the tables keep: the credit ledger and the credit accounts hold integer micro-USD (1 USD =
 * 1,000,000), so `usd` is that divided to dollars. Days are UTC, as `usage` keeps them (`usage.day`), and as an
 * instant is turned into one here (`created_at`, milliseconds).
 */

const DAY_MS = 86_400_000;
/** However many days a tool asks for, it gets no more: a year of days is what an answer can chart. */
export const MAX_DAYS = 365;
/** Micro-USD in a dollar (migrations/007_credit.sql). */
const MICROS = 1_000_000;

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const usd = (micros: unknown) => Math.round(Number(micros ?? 0)) / MICROS;
const count = (value: unknown) => Number(value ?? 0);
/** A UTC day and the day after it, as dates, for a range of `days` that ends today. */
function range(days: number, now = Date.now()) {
  const today = utcDay(now);
  const since = utcDay(now - (days - 1) * DAY_MS);
  return { since, today, tomorrow: utcDay(now + DAY_MS) };
}
/** A range's start as an instant, and the instant after its last day: the two bounds a millisecond column is cut by. */
function instants(days: number, now = Date.now()) {
  const start = Date.parse(`${utcDay(now - (days - 1) * DAY_MS)}T00:00:00Z`);
  return { from: start, until: start + days * DAY_MS };
}

/** An account someone made for themselves: GitHub, Google or email. Tenants an operator made are not sign-ups. */
const SELF_SERVE = "(t.github_id is not null or t.github is not null or t.google_sub is not null or t.email_signup)";
/** Live: not being erased, and never erased (a deleted tenant's ledger rows outlive its row). */
const LIVE = "not exists (select 1 from account_deletions d where d.tenant = t.id)";

/** Sign-ups by UTC day and how they signed up, for the team's growth chart. Nobody's name or address. */
export async function signupsDaily(db: Sql, options: { days: number; now?: number }) {
  const { since, today } = range(options.days, options.now);
  const { rows } = await db.query(`
    select to_char(s.day, 'YYYY-MM-DD') as day,
      count(t.id) as total,
      count(t.id) filter (where t.github_id is not null or t.github is not null) as github,
      count(t.id) filter (where t.google_sub is not null) as google,
      count(t.id) filter (where t.email_signup) as email
    from generate_series($1::date, $2::date, interval '1 day') as s(day)
    left join tenants t on t.created_at >= extract(epoch from s.day) * 1000 and t.created_at < extract(epoch from s.day + interval '1 day') * 1000
      and ${SELF_SERVE} and ${LIVE}
    group by s.day order by s.day`, [since, today]);
  return { rows: rows.map(row => ({ day: row.day, signups: count(row.total), github: count(row.github), google: count(row.google), email: count(row.email) })) };
}

/** Recent accounts and how far each got: tokens, agents, responses, dollars. The tenant id, never the person. */
export async function accounts(db: Sql, options: { days: number; limit: number; now?: number }) {
  const { from } = instants(options.days, options.now);
  const { rows } = await db.query(`
    select t.id, t.created_at, d.tenant is not null as deleted,
      (t.github_id is not null or t.github is not null) as by_github, t.google_sub is not null as by_google, t.email_signup as by_email,
      (select count(*) from api_tokens k where k.tenant = t.id) as tokens,
      (select count(*) from agents a where a.tenant = t.id and not a.revoked) as agents,
      (select count(*) from agents a where a.tenant = t.id and a.revoked) as revoked_agents,
      (select count(*) from schedules s where s.tenant = t.id) as schedules,
      (select coalesce(sum(u.responses), 0) from usage u where u.tenant = t.id) as responses,
      (select coalesce(sum(u.cost), 0) from usage u where u.tenant = t.id) as cost,
      coalesce(c.balance, 0) as balance, coalesce(c.purchased, 0) as purchased
    from tenants t left join account_deletions d on d.tenant = t.id left join credit_accounts c on c.tenant = t.id
    where t.created_at >= $1 and t.created_at < $2
    order by t.created_at desc limit $3`, [from, from + options.days * DAY_MS, options.limit]);
  return {
    rows: rows.map(row => ({
      tenant: row.id, created_at: new Date(Number(row.created_at)).toISOString(), sign_in: row.deleted ? null
        : row.by_github ? "github" : row.by_google ? "google" : row.by_email ? "email" : "operator",
      deleted: row.deleted, tokens: count(row.tokens), agents: count(row.agents), revoked_agents: count(row.revoked_agents),
      schedules: count(row.schedules), responses: count(row.responses), cost_usd: Number(row.cost ?? 0),
      balance_usd: usd(row.balance), purchased_usd: usd(row.purchased),
    })),
  };
}

/** Of the live self-serve accounts, how many got to each step: a token, an agent, a response, a purchase. */
export async function activation(db: Sql) {
  const { rows } = await db.query(`
    select count(*) as tenants,
      count(*) filter (where exists (select 1 from api_tokens k where k.tenant = t.id)) as with_token,
      count(*) filter (where exists (select 1 from agents a where a.tenant = t.id and not a.revoked)) as with_agent,
      count(*) filter (where exists (select 1 from usage u where u.tenant = t.id and u.responses > 0)) as with_usage,
      count(*) filter (where exists (select 1 from credit_accounts c where c.tenant = t.id and c.purchased > 0)) as purchased
    from tenants t where ${LIVE} and ${SELF_SERVE}`);
  const row = rows[0] ?? {};
  return { rows: [{
    tenants: count(row.tenants), with_token: count(row.with_token), with_agent: count(row.with_agent),
    with_usage: count(row.with_usage), purchased: count(row.purchased),
  }] };
}

/** Live and revoked agents, by tenant, most first; and the platform's totals. */
export async function agents(db: Sql, options: { limit: number }) {
  const [{ rows }, totals] = await Promise.all([
    db.query(`
      select tenant, count(*) filter (where not revoked) as live, count(*) filter (where revoked) as revoked
      from agents group by tenant order by count(*) filter (where not revoked) desc, tenant limit $1`, [options.limit]),
    db.query("select count(*) filter (where not revoked) as live, count(*) filter (where revoked) as revoked, count(distinct tenant) as tenants from agents"),
  ]);
  return {
    rows: rows.map(row => ({ tenant: row.tenant, live: count(row.live), revoked: count(row.revoked) })),
    totals: { live: count(totals.rows[0]?.live), revoked: count(totals.rows[0]?.revoked), tenants: count(totals.rows[0]?.tenants) },
  };
}

/** Model use by UTC day across every tenant: responses, tokens, dollars, and the part on the platform's own keys. */
export async function usageDaily(db: Sql, options: { days: number; now?: number }) {
  const { since, today } = range(options.days, options.now);
  const { rows } = await db.query(`
    select to_char(s.day, 'YYYY-MM-DD') as day,
      coalesce(sum(u.responses), 0) as responses,
      count(distinct u.tenant) filter (where u.responses > 0) as active_tenants,
      coalesce(sum(u.input), 0) as input, coalesce(sum(u.output), 0) as output,
      coalesce(sum(u.cache_read), 0) as cache_read, coalesce(sum(u.cache_write), 0) as cache_write,
      coalesce(sum(u.cost), 0) as cost, coalesce(sum(u.platform_cost), 0) as platform_cost,
      coalesce(sum(u.platform_responses), 0) as platform_responses
    from generate_series($1::date, $2::date, interval '1 day') as s(day)
    left join usage u on u.day = s.day::date
    group by s.day order by s.day`, [since, today]);
  return {
    rows: rows.map(row => ({
      day: row.day, responses: count(row.responses), active_tenants: count(row.active_tenants),
      input_tokens: count(row.input), output_tokens: count(row.output),
      cache_read_tokens: count(row.cache_read), cache_write_tokens: count(row.cache_write),
      cost_usd: Number(row.cost ?? 0), platform_cost_usd: Number(row.platform_cost ?? 0), platform_responses: count(row.platform_responses),
    })),
  };
}

/** Which models were used in the range, most dollars first: responses and tokens, across tenants. */
export async function usageModels(db: Sql, options: { days: number; limit: number; now?: number }) {
  const { since, today } = range(options.days, options.now);
  const { rows } = await db.query(`
    select model, sum(responses) as responses, sum(input) as input, sum(output) as output, sum(cache_read) as cache_read,
      sum(cache_write) as cache_write, sum(cost) as cost, count(distinct tenant) as tenants
    from usage where day >= $1::date and day <= $2::date
    group by model order by sum(cost) desc, model limit $3`, [since, today, options.limit]);
  return {
    rows: rows.map(row => ({
      model: row.model, responses: count(row.responses), input_tokens: count(row.input), output_tokens: count(row.output),
      cache_read_tokens: count(row.cache_read), cache_write_tokens: count(row.cache_write), cost_usd: Number(row.cost ?? 0), tenants: count(row.tenants),
    })),
  };
}

/** The credit ledger by UTC day and kind (grants, purchases, usage, storage, adjustments, refunds), in dollars. */
export async function spend(db: Sql, options: { days: number; now?: number }) {
  const { since, today } = range(options.days, options.now);
  const { rows } = await db.query(`
    select to_char(s.day, 'YYYY-MM-DD') as day, k.kind, count(l.id) as entries, coalesce(sum(l.amount), 0) as micros
    from generate_series($1::date, $2::date, interval '1 day') as s(day)
    cross join (values ('grant'), ('purchase'), ('usage'), ('storage'), ('adjustment'), ('refund')) as k(kind)
    left join credit_ledger l on l.kind = k.kind
      and l.created_at >= extract(epoch from s.day) * 1000 and l.created_at < extract(epoch from s.day + interval '1 day') * 1000
    group by s.day, k.kind order by s.day, k.kind`, [since, today]);
  return { rows: rows.map(row => ({ day: row.day, kind: row.kind, entries: count(row.entries), amount_usd: usd(row.micros) })) };
}

/** Who holds credit: the largest balances, and the platform's totals. Money in dollars. */
export async function balances(db: Sql, options: { limit: number }) {
  const [{ rows }, totals] = await Promise.all([
    db.query("select tenant, balance, purchased from credit_accounts order by balance desc, tenant limit $1", [options.limit]),
    db.query("select count(*) as accounts, coalesce(sum(balance), 0) as balance, coalesce(sum(purchased), 0) as purchased from credit_accounts"),
  ]);
  return {
    rows: rows.map(row => ({ tenant: row.tenant, balance_usd: usd(row.balance), purchased_usd: usd(row.purchased) })),
    totals: { accounts: count(totals.rows[0]?.accounts), balance_usd: usd(totals.rows[0]?.balance), purchased_usd: usd(totals.rows[0]?.purchased) },
  };
}

/** What Storage holds, by kind of owner, and the largest owners (ids only: an agent's or a volume's). */
export async function storage(db: Sql, options: { limit: number }) {
  const [{ rows: kinds }, { rows: owners }] = await Promise.all([
    db.query("select kind, count(*) as owners, coalesce(sum(bytes), 0) as bytes from storage_usage group by kind order by sum(bytes) desc"),
    db.query("select kind, owner, bytes from storage_usage order by bytes desc limit $1", [options.limit]),
  ]);
  return {
    rows: kinds.map(row => ({ kind: row.kind, owners: count(row.owners), bytes: count(row.bytes) })),
    largest: owners.map(row => ({ kind: row.kind, owner: row.owner, bytes: count(row.bytes) })),
  };
}

/** OAuth grants given, by UTC day and resource ('agents' at /mcp, 'ops' at the team's endpoint), and which clients hold them. */
export async function oauthGrants(db: Sql, options: { days: number; now?: number }) {
  const { since, today } = range(options.days, options.now);
  const [{ rows }, { rows: clients }, { rows: totals }] = await Promise.all([
    db.query(`
      select to_char(s.day, 'YYYY-MM-DD') as day, k.resource, count(g.id) as grants
      from generate_series($1::date, $2::date, interval '1 day') as s(day)
      cross join (values ('agents'), ('ops')) as k(resource)
      left join oauth_grants g on g.resource = k.resource
        and g.created_at >= extract(epoch from s.day) * 1000 and g.created_at < extract(epoch from s.day + interval '1 day') * 1000
      group by s.day, k.resource order by s.day, k.resource`, [since, today]),
    db.query("select client_name, resource, count(*) as grants, max(used_at) as used_at from oauth_grants group by client_name, resource order by count(*) desc limit 25"),
    db.query("select resource, count(*) as grants, count(distinct tenant) as tenants from oauth_grants group by resource order by resource"),
  ]);
  return {
    rows: rows.map(row => ({ day: row.day, resource: row.resource, grants: count(row.grants) })),
    // A client's name is one it chose: camelRun has not verified it.
    clients: clients.map(row => ({ client_name: row.client_name, resource: row.resource, grants: count(row.grants), last_used_at: row.used_at === null ? null : new Date(Number(row.used_at)).toISOString() })),
    totals: totals.map(row => ({ resource: row.resource, grants: count(row.grants), tenants: count(row.tenants) })),
  };
}

/** Sign-ups and returning active accounts by UTC day (src/admin-signals.ts, adminTrend), the same as the admin site's chart. */
export async function trend(db: Sql, options: { days: number; now?: number }) {
  const result = await adminTrend(db, { days: options.days, ...(options.now !== undefined ? { now: options.now } : {}) });
  return {
    rows: result.daily.map(day => ({ day: day.date, signups: day.signups, returning_active: day.returning_active })),
    incomplete_day: result.incomplete_date,
  };
}

/** Whether the database answers, how long it took, and the platform's size: tenants, live agents, ops grants. */
export async function health(db: Db) {
  const started = Date.now();
  const size = await transaction(db, async sql => {
    await sql.query("set transaction isolation level repeatable read, read only");
    return sql.query(`select
      (select count(*) from tenants t where ${LIVE}) as tenants,
      (select count(*) from agents where not revoked) as agents,
      (select count(*) from oauth_grants where resource = 'ops') as ops_grants`);
  });
  return {
    rows: [{
      check: "database", ok: true, ms: Date.now() - started,
      tenants: count(size.rows[0]?.tenants), agents: count(size.rows[0]?.agents), ops_grants: count(size.rows[0]?.ops_grants),
    }],
  };
}
