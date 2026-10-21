import {
  accountName, adminWindow, DAY_MS, n, NAME_COLUMNS, snapshot, staff, startOfUtcDay, usageKind, utcDate, windowDates, windowOf,
  type AdminAccountName, type AdminCompare, type AdminUsageKind, type AdminWindow,
} from "./admin-accounts.ts";
import type { Db } from "./db.ts";
import { ON_PI } from "./pi-sweep.ts";

/** A UTC day of what the platform paid providers (USD, on its own keys, with OpenRouter's funding cost), by what it was for. */
export type AdminSpendDay = { date: string } & Record<AdminUsageKind, number>;
/**
 * Whose calls the spend was for. `paying`: accounts that bought credit. `free`: accounts on free credit. `operator`: admin
 * tenants (camelBot, say). `unbilled`: accounts that are not charged (made before prepaid billing, or set so). `staff`: the
 * operator's own people.
 */
export type AdminPayer = "paying" | "free" | "operator" | "unbilled" | "staff";
export interface AdminSpendAccount extends AdminAccountName { payer: AdminPayer; cost: number; responses: number }
/** A check of something that should be quiet. `info` says how much of something there is; it is never a problem. */
export interface AdminCheck { key: string; label: string; status: "ok" | "warn" | "bad" | "info"; value: string; detail: string }
export interface AdminNode { node: string; draining: boolean; actors: number; expires_in_s: number }
export interface AdminHealth {
  schema_version: 1;
  range: AdminWindow;
  generated_at: string;
  spend: {
    window: AdminCompare;
    /** This UTC month so far, a projection of its whole (so far, before today, and the last 7 whole days' average for the days left) and last month's. */
    month_to_date: number; month_projection: number; last_month: number;
    daily: AdminSpendDay[];
    by_payer: Record<AdminPayer, number>;
    by_provider: { provider: string; cost: number; responses: number }[];
    top_accounts: AdminSpendAccount[];
    /** Model responses in the window that ran on accounts' own keys or servers: not the platform's spend. */
    own_key_responses: number;
    platform_responses: number;
  };
  checks: AdminCheck[];
  nodes: AdminNode[];
}

const KINDS: AdminUsageKind[] = ["models", "compaction", "web", "tool_search", "voice", "images"];
const MINUTE = 60_000;

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
const ago = (ms: number) => ms < 2 * 60 * MINUTE ? `${Math.max(1, Math.round(ms / MINUTE))} min` : ms < 2 * DAY_MS ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / DAY_MS)} days`;

/**
 * Is the platform healthy, and what does it spend (the admin site's Health tab, GET /api/health)? Spend is what the
 * platform pays model and tool providers for calls on its own keys (`usage.platform_cost`), never what accounts pay on
 * theirs. The checks read the runtime's own queues and jobs: work that waits longer than it should is the sign of a
 * fault. Read-only.
 */
export async function adminHealth(db: Db, options: { days: number | string; now?: number; internalDomains?: string[] }): Promise<AdminHealth> {
  const now = options.now ?? Date.now();
  const window = adminWindow(options.days, now);
  const domains = options.internalDomains ?? [];
  const today = startOfUtcDay(now), date = new Date(today);
  const monthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1), lastMonthStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1);
  const monthDays = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  const payer = `case when t.id is null then 'operator' when ${staff("$1::text[]")} then 'staff' when t.billing = 'prepaid' and c.purchased > 0 then 'paying'
    when t.billing = 'prepaid' then 'free' else 'unbilled' end`;
  const [daily, spendTotals, month, payers, providers, top, nodes, queues] = await snapshot(db, sql => Promise.all([
    sql.query(`
      select to_char(u.day, 'YYYY-MM-DD') as date, ${usageKind()} as kind, sum(u.platform_cost) as cost from usage u
      where u.day >= $1::date and u.day < $2::date group by 1, 2`, [utcDate(window.from), utcDate(window.until)]),
    sql.query(`
      select coalesce(sum(u.platform_cost) filter (where u.day >= $1::date), 0) as current, coalesce(sum(u.platform_cost) filter (where u.day < $1::date), 0) as previous,
        coalesce(sum(u.platform_responses) filter (where u.day >= $1::date and (${usageKind()}) in ('models', 'compaction')), 0) as platform_responses,
        coalesce(sum(u.responses - u.platform_responses) filter (where u.day >= $1::date and (${usageKind()}) in ('models', 'compaction')), 0) as own_key_responses
      from usage u where u.day >= $2::date and u.day < $3::date`, [utcDate(window.from), utcDate(window.previousFrom), utcDate(window.until)]),
    sql.query(`
      select coalesce(sum(u.platform_cost) filter (where u.day >= $1::date), 0) as month, coalesce(sum(u.platform_cost) filter (where u.day >= $1::date and u.day < $4::date), 0) as before_today,
        coalesce(sum(u.platform_cost) filter (where u.day < $1::date), 0) as last_month,
        coalesce(sum(u.platform_cost) filter (where u.day >= $3::date and u.day < $4::date), 0) as last_7
      from usage u where u.day >= $2::date`, [utcDate(monthStart), utcDate(lastMonthStart), utcDate(today - 7 * DAY_MS), utcDate(today)]),
    sql.query(`
      select ${payer} as payer, sum(u.platform_cost) as cost from usage u left join tenants t on t.id = u.tenant left join credit_accounts c on c.tenant = u.tenant
      where u.day >= $2::date and u.day < $3::date group by 1`, [domains, utcDate(window.from), utcDate(window.until)]),
    sql.query(`
      select split_part(regexp_replace(u.model, '^(compaction|transcription|image):', ''), '/', 1) as provider, sum(u.platform_cost) as cost, sum(u.platform_responses) as responses
      from usage u where u.day >= $1::date and u.day < $2::date group by 1 having sum(u.platform_cost) > 0 or sum(u.platform_responses) > 0
      order by 2 desc`, [utcDate(window.from), utcDate(window.until)]),
    sql.query(`
      with spent as (select u.tenant, sum(u.platform_cost) as cost, sum(u.platform_responses) as responses from usage u
        where u.day >= $2::date and u.day < $3::date group by u.tenant having sum(u.platform_cost) > 0 order by 2 desc limit 10)
      select spent.*, ${NAME_COLUMNS}, ${payer} as payer from spent left join tenants t on t.id = spent.tenant left join credit_accounts c on c.tenant = spent.tenant
      order by spent.cost desc`, [domains, utcDate(window.from), utcDate(window.until)]),
    sql.query(`
      select r.node, r.draining, extract(epoch from r.expires_at - now()) as expires_in, (select count(*) from actor_owners o where o.node = r.node) as actors
      from runtime_nodes r where r.expires_at > now() order by r.node`),
    sql.query(`
      select
        (select count(*) from busy_agents) as busy,
        (select count(*) from schedules) as schedules,
        (select count(*) from schedules where due_at < $1 and (claimed_until is null or claimed_until < now())) as overdue,
        (select min(due_at) from schedules where due_at < $1 and (claimed_until is null or claimed_until < now())) as overdue_since,
        (select count(*) from schedules where failures > 0 or attempts > 0) as failing,
        (select count(*) from agents where resume_failures > 0 and not revoked and purged_at is null) as unresumable,
        (select count(*) from channel_items where due < $1 and (claimed_until is null or claimed_until < now())) as channel_waiting,
        (select min(due) from channel_items where due < $1 and (claimed_until is null or claimed_until < now())) as channel_since,
        (select count(*) from model_attempts where state <> 'settled' and started_at < $2) as unsettled,
        (select min(started_at) from model_attempts where state <> 'settled' and started_at < $2) as unsettled_since,
        (select count(*) from journey_outbox where rejected_at is null and created_at < $2) as journey_waiting,
        (select count(*) from journey_outbox where rejected_at is not null) as journey_rejected,
        (select count(*) from billing_email_outbox where state = 'pending' and due < $2) as mail_waiting,
        (select count(*) from billing_email_outbox where state = 'failed' and created_at > $3) as mail_failed,
        (select count(*) from help_requests where status = 'failed') as help_failed,
        (select count(*) from help_requests where status = 'pending' and created_at < $2) as help_waiting,
        (select count(*) from account_deletions where completed_at is null and requested_at < $2) as deletions_waiting,
        (select to_char(done_day, 'YYYY-MM-DD') from billing_jobs where name = 'storage') as storage_day,
        (select count(*) from webhook_deliveries where attempts > 0) + (select count(*) from usage_webhook_outbox where attempts > 0) as webhooks_retrying,
        (select count(*) from telemetry_exporters where last_error_at is not null and last_error_at > coalesce(last_export_at, 0)) as telemetry_failing,
        (select count(*) from voice_sessions where state <> 'ended') as voice_live,
        (select count(*) from agents a where not a.revoked and a.purged_at is null
          and not ${ON_PI}) as legacy_agents`,
      [now - 10 * MINUTE, now - 60 * MINUTE, now - 7 * DAY_MS]),
  ]));

  const days = new Map<string, AdminSpendDay>(windowDates(window).map(day => [day, { date: day, models: 0, compaction: 0, web: 0, tool_search: 0, voice: 0, images: 0 }]));
  for (const row of daily.rows) {
    const day = days.get(row.date);
    if (day && KINDS.includes(row.kind)) day[row.kind as AdminUsageKind] += n(row.cost);
  }
  const m = month.rows[0];
  const dayOfMonth = date.getUTCDate();
  // Through yesterday, then the last 7 whole days' average for today and every day left.
  const projection = n(m.before_today) + n(m.last_7) / 7 * (monthDays - dayOfMonth + 1);
  const by_payer: Record<AdminPayer, number> = { paying: 0, free: 0, operator: 0, unbilled: 0, staff: 0 };
  for (const row of payers.rows) by_payer[row.payer as AdminPayer] += n(row.cost);

  const q = queues.rows[0];
  const storageDay = q.storage_day as string | null, yesterday = utcDate(today - DAY_MS);
  // Nothing about a node's own data: a check is what an operator should look into.
  const checks: AdminCheck[] = [
    { key: "nodes", label: "Runtime nodes", status: nodes.rows.length ? "ok" : "bad", value: plural(nodes.rows.length, "node"),
      detail: !nodes.rows.length ? "No node holds a lease: none is taking work" : nodes.rows.some(node => node.draining) ? `${plural(nodes.rows.filter(node => node.draining).length, "node")} draining (a deploy is rolling)` : "Every node is taking work" },
    { key: "schedules", label: "Schedules on time", status: n(q.overdue) ? "bad" : "ok", value: n(q.overdue) ? `${plural(n(q.overdue), "late schedule")}` : "On time",
      detail: n(q.overdue) ? `Due more than 10 minutes ago and not picked up, the oldest for ${ago(now - n(q.overdue_since))}` : `${plural(n(q.schedules), "schedule")} waiting for their time` },
    { key: "schedule_failures", label: "Schedule deliveries", status: n(q.failing) ? "warn" : "ok", value: n(q.failing) ? `${plural(n(q.failing), "schedule")} failing` : "Delivering",
      detail: n(q.failing) ? "Their last delivery to the agent failed; they retry, then skip to the next time" : "No schedule's last delivery failed" },
    { key: "agents", label: "Agents resuming", status: n(q.unresumable) ? "warn" : "ok", value: n(q.unresumable) ? `${plural(n(q.unresumable), "agent")} stuck` : "None stuck",
      detail: n(q.unresumable) ? "Agents whose interrupted run failed to resume after a node moved them" : "Every interrupted run resumed" },
    { key: "channels", label: "Channel messages", status: n(q.channel_waiting) > 50 || (n(q.channel_waiting) && now - n(q.channel_since) > 60 * MINUTE) ? "bad" : n(q.channel_waiting) ? "warn" : "ok",
      value: n(q.channel_waiting) ? `${plural(n(q.channel_waiting), "message")} waiting` : "Flowing",
      detail: n(q.channel_waiting) ? `Discord, Slack, email... messages due over 10 minutes ago, the oldest for ${ago(now - n(q.channel_since))}` : "No message to or from a channel is held up" },
    { key: "attempts", label: "Model charges settled", status: n(q.unsettled) ? "warn" : "ok", value: n(q.unsettled) ? `${plural(n(q.unsettled), "call")} unsettled` : "Settled",
      detail: n(q.unsettled) ? `Model calls over an hour old whose final cost the provider has not confirmed, the oldest for ${ago(now - n(q.unsettled_since))}` : "Every model call over an hour old has its final cost" },
    { key: "help", label: "Get Help requests", status: n(q.help_failed) ? "bad" : n(q.help_waiting) ? "warn" : "ok",
      value: n(q.help_failed) ? `${plural(n(q.help_failed), "request")} not delivered` : n(q.help_waiting) ? `${plural(n(q.help_waiting), "request")} waiting` : "Delivered",
      detail: n(q.help_failed) ? "Support requests that could not be mailed to the team: read them in the database" : "People's requests for help reach the support inbox" },
    { key: "billing_mail", label: "Billing mail", status: n(q.mail_failed) ? "warn" : n(q.mail_waiting) ? "warn" : "ok",
      value: n(q.mail_failed) ? `${plural(n(q.mail_failed), "email")} failed this week` : n(q.mail_waiting) ? `${plural(n(q.mail_waiting), "email")} waiting` : "Sending",
      detail: "Receipts, low-balance and confirmation mail" },
    { key: "storage_job", label: "Daily storage charge", status: !storageDay ? "info" : storageDay < yesterday ? "warn" : "ok", value: storageDay ? `Last ran for ${storageDay}` : "Not run yet",
      detail: storageDay && storageDay < yesterday ? "The job that charges for stored files has not run for a day" : "Charges accounts for the files they keep, once a UTC day" },
    { key: "deletions", label: "Account deletions", status: n(q.deletions_waiting) ? "warn" : "ok", value: n(q.deletions_waiting) ? `${plural(n(q.deletions_waiting), "deletion")} unfinished` : "Finished",
      detail: n(q.deletions_waiting) ? "Deletions asked for over an hour ago that have not finished" : "Every deletion asked for has finished" },
    { key: "journey", label: "Journey events", status: n(q.journey_waiting) ? "warn" : n(q.journey_rejected) ? "info" : "ok",
      value: n(q.journey_waiting) ? `${plural(n(q.journey_waiting), "event")} waiting` : n(q.journey_rejected) ? `${plural(n(q.journey_rejected), "event")} refused` : "Delivered",
      detail: n(q.journey_waiting) ? "Analytics events over an hour old the store has not taken" : "Analytics events reach the journey store" },
    { key: "running", label: "Running now", status: "info", value: plural(n(q.busy), "agent"), detail: `${plural(n(q.voice_live), "voice call")} live` },
    { key: "pi_migration", label: "Agents on the legacy engine", status: "info", value: plural(n(q.legacy_agents), "agent"),
      detail: "Kept agents not yet migrated to Pi: each migrates when it next opens, or with the Pi sweep (AGENT_PI_SWEEP)" },
    { key: "webhooks", label: "Customers' webhooks", status: "info", value: n(q.webhooks_retrying) ? `${plural(n(q.webhooks_retrying), "delivery", "deliveries")} retrying` : "Delivering",
      detail: `Retries are usually the customer's endpoint being down. ${plural(n(q.telemetry_failing), "telemetry export")} failing` },
  ];

  return {
    schema_version: 1, range: windowOf(window), generated_at: new Date(now).toISOString(),
    spend: {
      window: { current: n(spendTotals.rows[0].current), previous: n(spendTotals.rows[0].previous) },
      month_to_date: n(m.month), month_projection: projection, last_month: n(m.last_month),
      daily: [...days.values()], by_payer,
      by_provider: providers.rows.map(row => ({ provider: String(row.provider), cost: n(row.cost), responses: n(row.responses) })),
      top_accounts: top.rows.map(row => ({ ...accountName(row.tenant, row), payer: row.payer as AdminPayer, cost: n(row.cost), responses: n(row.responses) })),
      own_key_responses: n(spendTotals.rows[0].own_key_responses), platform_responses: n(spendTotals.rows[0].platform_responses),
    },
    checks,
    nodes: nodes.rows.map(row => ({ node: String(row.node), draining: !!row.draining, actors: n(row.actors), expires_in_s: Math.round(n(row.expires_in)) })),
  };
}
