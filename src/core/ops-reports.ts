import type { Sql } from "./host.ts";

/**
 * The rows the team's operations endpoint answers (src/ops-mcp.ts and backends/workers/src/ops-api.ts): counts, names, times, dollars and bytes, read-only,
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
export const count = (value: unknown) => Number(value ?? 0);
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
export const LIVE = "not exists (select 1 from account_deletions d where d.tenant = t.id)";

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
  const [{ rows }, totals, types] = await Promise.all([
    db.query(`
      select tenant, count(*) filter (where not revoked) as live, count(*) filter (where revoked) as revoked
      from agents group by tenant order by count(*) filter (where not revoked) desc, tenant limit $1`, [options.limit]),
    db.query("select count(*) filter (where not revoked) as live, count(*) filter (where revoked) as revoked, count(distinct tenant) as tenants from agents"),
    // Which kinds of agent the platform runs (a session type, from the agents header).
    db.query("select type, count(*) filter (where not revoked) as live, count(*) filter (where revoked) as revoked from agents group by type order by count(*) filter (where not revoked) desc, type"),
  ]);
  return {
    rows: rows.map(row => ({ tenant: row.tenant, live: count(row.live), revoked: count(row.revoked) })),
    totals: {
      live: count(totals.rows[0]?.live), revoked: count(totals.rows[0]?.revoked), tenants: count(totals.rows[0]?.tenants),
      by_type: types.rows.map(type => ({ type: type.type, live: count(type.live), revoked: count(type.revoked) })),
    },
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

/** How many days of inbound channel messages are kept: `channel_seen` is pruned at 7 (SEEN_DAYS, src/channels.ts). */
export const CHANNEL_SEEN_DAYS = 7;

/**
 * Channels and the traffic through them: by provider how many exist and how many conversations they answer, the
 * inbound messages per UTC day (the last CHANNEL_SEEN_DAYS at most), and the tenants with channels, most used first.
 * Only a channel's provider and counts: never its credentials, its definitions or a message.
 */
export async function channels(db: Sql, options: { days: number; limit: number; now?: number }) {
  const kept = Math.max(1, Math.min(options.days, CHANNEL_SEEN_DAYS));
  const { since, today } = range(kept, options.now);
  const [{ rows: providers }, { rows: daily }, { rows: tenants }, totals] = await Promise.all([
    db.query(`
      select c.channel->>'type' as type, count(distinct c.id) as channels, count(distinct c.tenant) as tenants,
        count(v.conversation) as conversations
      from channels c left join channel_conversations v on v.channel = c.id
      group by 1 order by count(distinct c.id) desc, 1`),
    db.query(`
      select to_char(s.day, 'YYYY-MM-DD') as day, count(se.message) as messages
      from generate_series($1::date, $2::date, interval '1 day') as s(day)
      left join channel_seen se on se.seen_at >= s.day and se.seen_at < s.day + interval '1 day'
      group by s.day order by s.day`, [since, today]),
    db.query(`
      select c.tenant, count(distinct c.id) as channels, count(v.conversation) as conversations
      from channels c left join channel_conversations v on v.channel = c.id
      group by c.tenant order by count(v.conversation) desc, count(distinct c.id) desc, c.tenant limit $1`, [options.limit]),
    db.query(`select
      (select count(*) from channels) as channels,
      (select count(distinct tenant) from channels) as tenants,
      (select count(*) from channel_conversations) as conversations`),
  ]);
  return {
    rows: providers.map(row => ({ type: row.type, channels: count(row.channels), tenants: count(row.tenants), conversations: count(row.conversations) })),
    totals: { channels: count(totals.rows[0]?.channels), tenants: count(totals.rows[0]?.tenants), conversations: count(totals.rows[0]?.conversations) },
    // Inbound messages only as far back as `channel_seen` is kept: seven days, whatever the argument asks for.
    daily: daily.map(row => ({ day: row.day, messages: count(row.messages) })),
    tenants: tenants.map(row => ({ tenant: row.tenant, channels: count(row.channels), conversations: count(row.conversations) })),
  };
}

/**
 * Model use by tenant over the range, most dollars first: responses, tokens, the platform's own keys' part, the days it
 * was active and the models it used; beside them its live agents, credit balance and what that balance buys at the
 * range's daily rate. The tenant id, never the person.
 */
export async function usageTenants(db: Sql, options: { days: number; limit: number; now?: number }) {
  const { since, today } = range(options.days, options.now);
  const { rows } = await db.query(`
    select u.tenant,
      coalesce(sum(u.responses), 0) as responses, coalesce(sum(u.input), 0) as input, coalesce(sum(u.output), 0) as output,
      coalesce(sum(u.cost), 0) as cost, coalesce(sum(u.platform_cost), 0) as platform_cost,
      count(distinct u.day) filter (where u.responses > 0) as active_days,
      to_char(max(u.day) filter (where u.responses > 0), 'YYYY-MM-DD') as last_day,
      count(distinct u.model) as models,
      coalesce(c.balance, 0) as balance, coalesce(c.purchased, 0) as purchased,
      (select count(*) from agents a where a.tenant = u.tenant and not a.revoked) as agents
    from usage u left join credit_accounts c on c.tenant = u.tenant
    where u.day >= $1::date and u.day <= $2::date
    group by u.tenant, c.balance, c.purchased
    order by sum(u.cost) desc, u.tenant limit $3`, [since, today, options.limit]);
  return {
    rows: rows.map(row => {
      const daily = Number(row.cost ?? 0) / Math.max(1, options.days);
      const balance = usd(row.balance);
      return {
        tenant: row.tenant, responses: count(row.responses), input_tokens: count(row.input), output_tokens: count(row.output),
        cost_usd: Number(row.cost ?? 0), platform_cost_usd: Number(row.platform_cost ?? 0),
        active_days: count(row.active_days), last_day: row.last_day,
        models: count(row.models), agents: count(row.agents), balance_usd: balance, purchased_usd: usd(row.purchased),
        daily_usd: Math.round(daily * 100) / 100,
        // At the range's own daily rate: null when it spent nothing, or has nothing to spend.
        runway_days: daily > 0 && balance > 0 ? Math.round(balance / daily) : null,
      };
    }),
  };
}

/**
 * One account in full, by its tenant id: how it signed up and how far it got, what it holds (agents by type, tokens,
 * schedules, channels, volumes, storage, integrations, help requests, checkouts), its use over 30 days and what it
 * can spend. The tenant id alone, never the person: no address, login or message.
 */
export async function tenant(db: Sql, options: { tenant: string; now?: number }) {
  const { since } = range(30, options.now);
  const [{ rows }, { rows: agentTypes }, { rows: channelRows }] = await Promise.all([
    db.query(`
      select t.id, t.created_at, t.billing, t.limits,
        (t.github_id is not null or t.github is not null) as by_github, t.google_sub is not null as by_google, t.email_signup as by_email,
        d.tenant is not null as deleted,
        (select count(*) from api_tokens k where k.tenant = t.id) as tokens,
        (select count(*) from agents a where a.tenant = t.id and not a.revoked) as agents,
        (select count(*) from agents a where a.tenant = t.id and a.revoked) as revoked_agents,
        (select count(*) from schedules s where s.tenant = t.id) as schedules,
        (select count(*) from channels ch where ch.tenant = t.id) as channels,
        (select count(*) from provider_keys p where p.tenant = t.id) as provider_keys,
        (select count(*) from model_providers m where m.tenant = t.id) as model_providers,
        (select count(*) from webhook_endpoints w where w.tenant = t.id) as webhook_endpoints,
        (select count(*) from volumes v where v.tenant = t.id and v.deleted_at is null) as volumes,
        (select coalesce(sum(b.bytes), 0) from storage_usage b where b.kind = 'tenant' and b.owner = t.id) as storage_bytes,
        (select count(*) from help_requests h where h.tenant = t.id) as help_requests,
        (select count(*) from billing_checkouts o where o.tenant = t.id and o.paid_at is not null) as paid_checkouts,
        coalesce(c.balance, 0) as balance, coalesce(c.purchased, 0) as purchased,
        (select coalesce(sum(u.responses), 0) from usage u where u.tenant = t.id and u.day >= $2::date) as responses_30d,
        (select coalesce(sum(u.cost), 0) from usage u where u.tenant = t.id and u.day >= $2::date) as cost_30d,
        (select to_char(max(u.day), 'YYYY-MM-DD') from usage u where u.tenant = t.id and u.responses > 0) as last_active_day
      from tenants t left join account_deletions d on d.tenant = t.id left join credit_accounts c on c.tenant = t.id
      where t.id = $1`, [options.tenant, since]),
    db.query(`
      select type, count(*) filter (where not revoked) as live, count(*) filter (where revoked) as revoked
      from agents where tenant = $1 group by type order by count(*) filter (where not revoked) desc, type`, [options.tenant]),
    db.query(`
      select c.id, c.channel->>'type' as type, (select count(*) from channel_conversations v where v.channel = c.id) as conversations
      from channels c where c.tenant = $1 order by conversations desc, c.id limit 25`, [options.tenant]),
  ]);
  const row = rows[0];
  if (!row) return { rows: [], agents_by_type: [], channels: [] };
  return {
    rows: [{
      tenant: row.id, created_at: new Date(Number(row.created_at)).toISOString(),
      sign_in: row.deleted ? null : row.by_github ? "github" : row.by_google ? "google" : row.by_email ? "email" : "operator",
      deleted: row.deleted, billing: row.billing, limits: row.limits ?? {},
      tokens: count(row.tokens), agents: count(row.agents), revoked_agents: count(row.revoked_agents),
      schedules: count(row.schedules), channels: count(row.channels), volumes: count(row.volumes),
      storage_bytes: count(row.storage_bytes), provider_keys: count(row.provider_keys), model_providers: count(row.model_providers),
      webhook_endpoints: count(row.webhook_endpoints),
      help_requests: count(row.help_requests), paid_checkouts: count(row.paid_checkouts),
      responses_30d: count(row.responses_30d), cost_30d_usd: Number(row.cost_30d ?? 0),
      last_active_day: row.last_active_day,
      balance_usd: usd(row.balance), purchased_usd: usd(row.purchased),
    }],
    agents_by_type: agentTypes.map(type => ({ type: type.type, live: count(type.live), revoked: count(type.revoked) })),
    channels: channelRows.map(channel => ({ id: channel.id, type: channel.type, conversations: count(channel.conversations) })),
  };
}

/**
 * Weekly retention: the accounts made in each of the last `weeks` sign-up weeks (live, from the tenants table) and how
 * many of each had a model response in week 0, 1 and so on. Only a count per cohort: never which account.
 */
export async function retention(db: Sql, options: { weeks: number; now?: number }) {
  const now = options.now ?? Date.now();
  const weeks = Math.max(1, options.weeks);
  const { from } = instants(weeks * 7, now);
  const { rows } = await db.query(`
    with cohorts as (
      select t.id, date_trunc('week', to_timestamp(t.created_at / 1000.0) at time zone 'UTC')::date as week
      from tenants t where ${LIVE} and t.created_at >= $1 and t.created_at < $2
    ), sizes as (select week, count(*) as size from cohorts group by week),
    active as (select distinct tenant, date_trunc('week', day)::date as week from usage where responses > 0 and day >= $4::date)
    select to_char(s.week, 'YYYY-MM-DD') as cohort_week, s.size, o.weeks as week_offset, count(distinct a.tenant) as active
    from sizes s
    cross join generate_series(0, $3::int) as o(weeks)
    left join cohorts c on c.week = s.week
    left join active a on a.tenant = c.id and a.week = s.week + (o.weeks * 7)
    group by s.week, s.size, o.weeks order by s.week desc, o.weeks`, [from, from + weeks * 7 * DAY_MS, weeks - 1, utcDay(from)]);
  const thisWeek = utcDay(now - ((new Date(now).getUTCDay() + 6) % 7) * DAY_MS);
  return {
    rows: rows.map(row => ({
      cohort_week: row.cohort_week, cohort_size: count(row.size), week_offset: count(row.week_offset),
      active: count(row.active), pct: count(row.size) > 0 ? Math.round((count(row.active) / count(row.size)) * 1000) / 1000 : 0,
    })),
    // The week still going: its week 0 is the days so far, not a full week.
    incomplete_week: thisWeek,
  };
}

/**
 * How long accounts take to get anywhere: of the live self-serve accounts made in the range, how many minted a token, got
 * a model response and paid, and the median and 90th percentile hours (a token) or days (a response, a purchase) after
 * they signed up (a day's use counts from the start of that day, so the duration is never negative). A count and a duration,
 * never an account.
 */
export async function timeToValue(db: Sql, options: { days: number; now?: number }) {
  const { from } = instants(options.days, options.now);
  const { rows } = await db.query(`
    with accounts as (
      select t.id, t.created_at,
        (select min(k.created_at) from api_tokens k where k.tenant = t.id) as first_token,
        (select extract(epoch from min(u.day)) * 1000 from usage u where u.tenant = t.id and u.responses > 0) as first_response,
        (select min(o.paid_at) from billing_checkouts o where o.tenant = t.id and o.paid_at is not null) as first_purchase
      from tenants t where ${LIVE} and ${SELF_SERVE} and t.created_at >= $1 and t.created_at < $2
    )
    select count(*) as accounts, count(first_token) as with_token, count(first_response) as with_response,
      count(first_purchase) as with_purchase,
      percentile_cont(0.5) within group (order by greatest(first_token - created_at, 0) / 3600000.0) filter (where first_token is not null) as p50_token_hours,
      percentile_cont(0.9) within group (order by greatest(first_token - created_at, 0) / 3600000.0) filter (where first_token is not null) as p90_token_hours,
      percentile_cont(0.5) within group (order by greatest(first_response - created_at, 0) / 86400000.0) filter (where first_response is not null) as p50_response_days,
      percentile_cont(0.9) within group (order by greatest(first_response - created_at, 0) / 86400000.0) filter (where first_response is not null) as p90_response_days,
      percentile_cont(0.5) within group (order by greatest(first_purchase - created_at, 0) / 86400000.0) filter (where first_purchase is not null) as p50_purchase_days,
      percentile_cont(0.9) within group (order by greatest(first_purchase - created_at, 0) / 86400000.0) filter (where first_purchase is not null) as p90_purchase_days
    from accounts`, [from, from + options.days * DAY_MS]);
  const row = rows[0] ?? {};
  const round = (value: unknown) => (value === null || value === undefined ? null : Math.round(Number(value) * 10) / 10);
  return {
    rows: [{
      accounts: count(row.accounts), with_token: count(row.with_token), with_response: count(row.with_response), with_purchase: count(row.with_purchase),
      p50_token_hours: round(row.p50_token_hours), p90_token_hours: round(row.p90_token_hours),
      p50_response_days: round(row.p50_response_days), p90_response_days: round(row.p90_response_days),
      p50_purchase_days: round(row.p50_purchase_days), p90_purchase_days: round(row.p90_purchase_days),
    }],
  };
}

/**
 * Schedules: the live ones by tenant (recurring, once, due now, the agents they wake), the platform's totals, and how
 * many were created per UTC day. A count: never what a schedule says.
 */
export async function schedules(db: Sql, options: { days: number; limit: number; now?: number }) {
  const now = options.now ?? Date.now();
  const { since, today } = range(options.days, options.now);
  const [{ rows }, { rows: daily }, totals] = await Promise.all([
    db.query(`
      select s.tenant, count(*) as schedules,
        count(*) filter (where s.every_seconds is not null) as recurring,
        count(*) filter (where s.every_seconds is null) as once,
        count(*) filter (where s.due_at <= $1) as due_now,
        count(distinct s.agent) as agents,
        min(s.due_at) filter (where s.due_at > $1) as next_due_at
      from schedules s group by s.tenant order by count(*) desc, s.tenant limit $2`, [now, options.limit]),
    db.query(`
      select to_char(d.day, 'YYYY-MM-DD') as day, count(s.id) as created
      from generate_series($1::date, $2::date, interval '1 day') as d(day)
      left join schedules s on s.created_at >= extract(epoch from d.day) * 1000 and s.created_at < extract(epoch from d.day + interval '1 day') * 1000
      group by d.day order by d.day`, [since, today]),
    db.query(`select count(*) as schedules, count(distinct tenant) as tenants, count(*) filter (where due_at <= $1) as due_now from schedules`, [now]),
  ]);
  return {
    rows: rows.map(row => ({
      tenant: row.tenant, schedules: count(row.schedules), recurring: count(row.recurring), once: count(row.once),
      due_now: count(row.due_now), agents: count(row.agents),
      next_due_at: row.next_due_at === null ? null : new Date(Number(row.next_due_at)).toISOString(),
    })),
    totals: { schedules: count(totals.rows[0]?.schedules), tenants: count(totals.rows[0]?.tenants), due_now: count(totals.rows[0]?.due_now) },
    daily: daily.map(row => ({ day: row.day, created: count(row.created) })),
  };
}

/**
 * What accounts connect to their agents, and how many of each: API tokens, their own provider keys, their own model
 * providers, webhooks, volumes and channels. Counts only: never a token, a key, a URL or a header.
 */
export async function integrations(db: Sql) {
  const [{ rows }, any] = await Promise.all([
    db.query(`
      select 'api_tokens' as integration, count(distinct tenant) as tenants, count(*) as total from api_tokens
      union all select 'provider_keys', count(distinct tenant), count(*) from provider_keys
      union all select 'model_providers', count(distinct tenant), count(*) from model_providers
      union all select 'webhook_endpoints', count(distinct tenant), count(*) from webhook_endpoints
      union all select 'volumes', count(distinct tenant), count(*) from volumes where deleted_at is null
      union all select 'channels', count(distinct tenant), count(*) from channels
      order by tenants desc, integration`),
    db.query(`select count(*) as tenants from (
      select tenant from api_tokens union select tenant from provider_keys union select tenant from model_providers
      union select tenant from webhook_endpoints
      union select tenant from volumes where deleted_at is null union select tenant from channels) as t`),
  ]);
  return {
    rows: rows.map(row => ({ integration: row.integration, tenants: count(row.tenants), total: count(row.total) })),
    totals: { tenants: count(any.rows[0]?.tenants) },
  };
}

/**
 * Help requests: how many people asked for help, per UTC day and delivery, and the totals. The request's own text and
 * its context are never read: this counts rows.
 */
export async function helpRequests(db: Sql, options: { days: number; now?: number }) {
  const { since, today } = range(options.days, options.now);
  const [{ rows }, totals] = await Promise.all([
    db.query(`
      select to_char(d.day, 'YYYY-MM-DD') as day, count(h.id) as requests,
        count(h.id) filter (where h.status = 'delivered') as delivered,
        count(h.id) filter (where h.status = 'failed') as failed,
        count(h.id) filter (where h.status = 'pending') as pending,
        count(distinct h.tenant) as tenants
      from generate_series($1::date, $2::date, interval '1 day') as d(day)
      left join help_requests h on h.created_at >= extract(epoch from d.day) * 1000 and h.created_at < extract(epoch from d.day + interval '1 day') * 1000
      group by d.day order by d.day`, [since, today]),
    db.query(`select count(*) as requests, count(distinct tenant) as tenants from help_requests`),
  ]);
  return {
    // A day's statuses are those requests' status now, not when the day ended.
    rows: rows.map(row => ({ day: row.day, requests: count(row.requests), delivered: count(row.delivered), failed: count(row.failed), pending: count(row.pending), tenants: count(row.tenants) })),
    totals: { requests: count(totals.rows[0]?.requests), tenants: count(totals.rows[0]?.tenants) },
  };
}
