import {
  accountName, adminWindow, counted, liveAgent, MODEL_CALL, modelCall, n, NAME_COLUMNS, SELF_SERVE, snapshot, utcDate, windowDates, windowOf,
  type AdminAccountName, type AdminCompare, type AdminWindow,
} from "./admin-accounts.ts";
import type { Db } from "./db.ts";

/** A UTC day's model responses: self-serve accounts', admin tenants' (camelBot, say) and everyone else's (operator-made, staff, erased). */
export interface AdminUsageDay { date: string; self_serve: number; operator: number; other: number }
/** A model's responses and cost in the window, across every account and across self-serve accounts. Costs are USD. */
export interface AdminModelRow { model: string; responses: number; accounts: number; cost: number; self_serve_responses: number; self_serve_accounts: number }
/** A model live agents are set to use now. */
export interface AdminConfiguredModel { model: string; agents: number; accounts: number; self_serve_agents: number; self_serve_accounts: number }
/** How many live agents use something (web search, MCP servers, a schedule...). */
export interface AdminFeature { key: string; label: string; agents: number; self_serve_agents: number }
/** Something accounts set up (a channel type, their own model keys, webhooks...). */
export interface AdminIntegration { key: string; label: string; accounts: number; self_serve_accounts: number }
/** An account's use in the window. `staff`: not counted (the operator's own, or being erased). Amounts are micro-USD, costs USD. */
export interface AdminUsageAccount extends AdminAccountName {
  staff: boolean; deleted: boolean; agents: number; responses: number; cost: number; platform_cost: number;
  active_days: number; last_active: string | null; models: string[]; balance: number | null; purchased: number;
}
/** An agent's model calls in the window. `kind`: an agent, a stateless run's session, or a child a delegate call made. */
export interface AdminTopAgent {
  agent: string; name: string; model: string; kind: "agent" | "run" | "child"; deleted: boolean;
  account: AdminAccountName & { staff: boolean };
  responses: number; end_users: number; active_days: number; last_at: string;
}
export interface AdminUsage {
  schema_version: 1;
  range: AdminWindow;
  generated_at: string;
  tiles: {
    /** Self-serve accounts that did work (got a model response). */
    active_accounts: AdminCompare;
    responses: AdminCompare;
    self_serve_responses: AdminCompare;
    /** Distinct agents a model answered, from model attempts. */
    agents_ran: AdminCompare;
    self_serve_agents_ran: AdminCompare;
    /**
     * Distinct end users a model answered for: the `subject` of calls metered by end-user credits (src/end-user-credits.ts),
     * which is how camelBot meters its people. Calls without end-user credits name no end user.
     */
    end_users: AdminCompare;
    self_serve_end_users: AdminCompare;
    live_agents: number;
    self_serve_live_agents: number;
  };
  daily: AdminUsageDay[];
  /**
   * When per-agent figures begin (agents_ran, end_users, `agents`): the first model attempt recorded (src/model-attempts.ts,
   * since runtime 0.10.0). Before it they were not kept, so a window reaching back further counts only from then.
   */
  attempts_since: string | null;
  models: AdminModelRow[];
  configured_models: AdminConfiguredModel[];
  features: AdminFeature[];
  integrations: AdminIntegration[];
  /** The MCP clients (Claude, ChatGPT...) accounts connected to the hosted MCP endpoint, by the name they registered. */
  mcp_clients: { client: string; accounts: number }[];
  accounts: AdminUsageAccount[];
  agents: AdminTopAgent[];
}

const TOP_MODELS = 15;
const TOP_ACCOUNTS = 100;
const TOP_AGENTS = 25;

/** What live agents use, over `h` (the header as jsonb) and `a` (the agent). */
const FEATURES: { key: string; label: string; sql: string }[] = [
  { key: "x_search", label: "X search", sql: "h->'sources'->'builtins' ? 'x_search'" },
  { key: "web_search", label: "Web search", sql: "h->'sources'->'builtins' ? 'web_search'" },
  { key: "web_fetch", label: "Reads web pages", sql: "h->'sources'->'builtins' ? 'web_fetch'" },
  { key: "mcp", label: "MCP servers", sql: "jsonb_array_length(coalesce(h->'sources'->'mcpServers', '[]')) > 0" },
  { key: "openapi", label: "OpenAPI tools", sql: "jsonb_array_length(coalesce(h->'sources'->'openApi', '[]')) > 0" },
  { key: "app_tools", label: "Their app's own tools", sql: "jsonb_array_length(coalesce(h->'definitions', '[]')) > 0" },
  { key: "schedules", label: "Runs on a schedule", sql: "exists (select 1 from schedules s where s.agent = a.id)" },
  { key: "channel", label: "Answers a channel", sql: "exists (select 1 from channel_agents c where c.agent = a.id)" },
  { key: "sub_agents", label: "Starts sub-agents", sql: "h->'sources'->'builtins' ?| array['delegate', 'agents']" },
  { key: "ask_user", label: "Asks a person", sql: "h->'sources'->'builtins' ? 'ask_user' or h->'sources'->'humanInput' is not null" },
  { key: "images", label: "Makes images", sql: "h->'sources'->'builtins' ? 'generate_image'" },
  { key: "definition", label: "Made from a definition", sql: "h->'definition' is not null" },
  { key: "no_code_mode", label: "Code mode off", sql: "h->'config'->>'codeMode' = 'false'" },
];

/** What accounts set up, each a query of the accounts (`tenant`) that have it. */
const INTEGRATIONS: { key: string; label: string; sql: string }[] = [
  { key: "discord-managed", label: "Discord (managed Camel app)", sql: "select tenant from channels where channel->>'type' = 'discord-managed'" },
  { key: "discord", label: "Discord (own bot)", sql: "select tenant from channels where channel->>'type' = 'discord'" },
  { key: "slack", label: "Slack", sql: "select tenant from channels where channel->>'type' = 'slack'" },
  { key: "telegram", label: "Telegram", sql: "select tenant from channels where channel->>'type' = 'telegram'" },
  { key: "email", label: "Email", sql: "select tenant from channels where channel->>'type' = 'email'" },
  { key: "github", label: "GitHub", sql: "select tenant from channels where channel->>'type' = 'github'" },
  { key: "webhook", label: "Inbound webhook", sql: "select tenant from channels where channel->>'type' = 'webhook'" },
  { key: "provider_keys", label: "Their own model keys", sql: "select tenant from provider_keys" },
  { key: "model_providers", label: "Their own model server", sql: "select tenant from model_providers" },
  { key: "mcp_clients", label: "Connected an MCP client", sql: "select tenant from oauth_grants" },
  { key: "webhooks", label: "Run webhooks", sql: "select tenant from webhook_endpoints" },
  { key: "end_user_credits", label: "Meters their own users", sql: "select tenant from end_user_settings where enabled" },
  { key: "volumes", label: "Volumes", sql: "select tenant from volumes where purged_at is null" },
  { key: "voice", label: "Voice calls", sql: "select tenant from voice_sessions" },
];

/**
 * Who uses the runtime and how (the admin site's Usage tab, GET /api/usage): model responses by day and by model, the
 * models live agents are set to, what agents use, what accounts set up, and the top accounts and agents. Read-only.
 * Admin tenants (`operator`, camelBot among them) are kept apart from self-serve accounts, so each can be read alone.
 */
export async function adminUsage(db: Db, options: { days: number | string; now?: number; internalDomains?: string[] }): Promise<AdminUsage> {
  const now = options.now ?? Date.now();
  const window = adminWindow(options.days, now);
  const domains = options.internalDomains ?? [];
  const selfServe = `(t.id is not null and ${SELF_SERVE} and ${counted("$1::text[]")})`;
  const from = utcDate(window.from), previousFrom = utcDate(window.previousFrom), until = utcDate(window.until);
  const [daily, tiles, attempts, models, configured, features, integrations, clients, accounts, agents, first] = await snapshot(db, sql => Promise.all([
    sql.query(`
      select to_char(u.day, 'YYYY-MM-DD') as date, coalesce(sum(u.responses) filter (where ${selfServe}), 0) as self_serve,
        coalesce(sum(u.responses) filter (where t.id is null), 0) as operator, coalesce(sum(u.responses) filter (where t.id is not null and not ${selfServe}), 0) as other
      from usage u left join tenants t on t.id = u.tenant
      where u.day >= $2::date and u.day < $3::date and ${MODEL_CALL}
      group by u.day`, [domains, from, until]),
    sql.query(`
      select u.day >= $2::date as current, count(distinct u.tenant) filter (where ${selfServe} and u.responses > 0) as active_accounts,
        coalesce(sum(u.responses), 0) as responses, coalesce(sum(u.responses) filter (where ${selfServe}), 0) as self_serve_responses
      from usage u left join tenants t on t.id = u.tenant
      where u.day >= $3::date and u.day < $4::date and ${MODEL_CALL}
      group by 1`, [domains, from, previousFrom, until]),
    sql.query(`
      select m.started_at >= $2 as current, count(distinct m.agent) as agents, count(distinct m.agent) filter (where ${selfServe}) as self_serve_agents,
        count(distinct (m.tenant, m.end_user)) filter (where m.end_user is not null) as end_users,
        count(distinct (m.tenant, m.end_user)) filter (where m.end_user is not null and ${selfServe}) as self_serve_end_users
      from model_attempts m left join tenants t on t.id = m.tenant
      where m.started_at >= $3 and m.started_at < $4 and m.kind = 'response'
      group by 1`, [domains, window.from, window.previousFrom, window.until]),
    sql.query(`
      select u.model, sum(u.responses) as responses, count(distinct u.tenant) filter (where u.responses > 0) as accounts, sum(u.cost) as cost,
        coalesce(sum(u.responses) filter (where ${selfServe}), 0) as self_serve_responses,
        count(distinct u.tenant) filter (where ${selfServe} and u.responses > 0) as self_serve_accounts
      from usage u left join tenants t on t.id = u.tenant
      where u.day >= $2::date and u.day < $3::date and ${MODEL_CALL}
      group by u.model having sum(u.responses) > 0`, [domains, from, until]),
    sql.query(`
      select a.model, count(*) as agents, count(distinct a.tenant) as accounts,
        count(*) filter (where ${selfServe}) as self_serve_agents, count(distinct a.tenant) filter (where ${selfServe}) as self_serve_accounts
      from agents a left join tenants t on t.id = a.tenant
      where ${liveAgent("$2")}
      group by a.model order by count(*) desc`, [domains, now]),
    sql.query(`
      select count(*) as agents, count(*) filter (where self_serve) as self_serve_agents,
        ${FEATURES.map(feature => `count(*) filter (where ${feature.sql}) as "${feature.key}", count(*) filter (where self_serve and (${feature.sql})) as "ss_${feature.key}"`).join(",\n        ")}
      from (select a.id, a.header::jsonb as h, ${selfServe} as self_serve from agents a left join tenants t on t.id = a.tenant where ${liveAgent("$2")}) a`, [domains, now]),
    sql.query(`
      select key, count(*) as accounts, count(*) filter (where ${selfServe}) as self_serve_accounts from (
        ${INTEGRATIONS.map((integration, index) => `select distinct ${index} as key, x.tenant from (${integration.sql}) x`).join("\n        union all ")}
      ) i left join tenants t on t.id = i.tenant
      where t.id is null or not exists (select 1 from account_deletions d where d.tenant = t.id)
      group by key`, [domains]),
    sql.query(`
      select g.client_name as client, count(distinct g.tenant) as accounts from oauth_grants g
      group by g.client_name order by count(distinct g.tenant) desc, g.client_name limit 12`),
    sql.query(`
      with used as (
        select u.tenant, coalesce(sum(u.responses) filter (where ${MODEL_CALL}), 0) as responses, sum(u.cost) as cost, sum(u.platform_cost) as platform_cost,
          count(distinct u.day) filter (where u.responses > 0) as active_days, max(u.day) filter (where u.responses > 0) as last_day
        from usage u where u.day >= $2::date and u.day < $3::date group by u.tenant)
      select used.*, to_char(used.last_day, 'YYYY-MM-DD') as last_active, ${NAME_COLUMNS}, ${selfServe} as counted,
        exists (select 1 from account_deletions d where d.tenant = used.tenant) as deleted,
        (select count(*) from agents a where a.tenant = used.tenant and ${liveAgent("$4")}) as agents,
        array(select u2.model from usage u2 where u2.tenant = used.tenant and u2.day >= $2::date and u2.day < $3::date and ${modelCall("u2")}
          group by u2.model order by sum(u2.responses) desc limit 3) as models,
        c.balance, coalesce(c.purchased, 0) as purchased
      from used left join tenants t on t.id = used.tenant left join credit_accounts c on c.tenant = used.tenant
      where used.responses > 0 or used.cost > 0
      order by used.responses desc, used.cost desc limit ${TOP_ACCOUNTS}`, [domains, from, until, now]),
    sql.query(`
      with ran as (
        select m.tenant, m.agent, count(*) as responses, count(distinct m.end_user) as end_users,
          count(distinct (to_timestamp(m.started_at / 1000.0) at time zone 'UTC')::date) as active_days, max(m.started_at) as last_at
        from model_attempts m where m.started_at >= $2 and m.started_at < $3 and m.kind = 'response'
        group by m.tenant, m.agent order by count(*) desc limit ${TOP_AGENTS})
      select ran.*, a.name, a.model, a.revoked or a.purged_at is not null as deleted,
        case when a.header->'run' is not null then 'run' when a.header->'parent' is not null then 'child' else 'agent' end as kind,
        ${NAME_COLUMNS}, ${selfServe} as counted
      from ran left join agents a on a.id = ran.agent left join tenants t on t.id = ran.tenant
      order by ran.responses desc`, [domains, window.from, window.until]),
    sql.query("select min(started_at) as first from model_attempts"),
  ]));

  const byDate = new Map(daily.rows.map(row => [row.date, row]));
  const compare = (rows: Record<string, unknown>[], key: string): AdminCompare =>
    ({ current: n(rows.find(row => row.current === true)?.[key]), previous: n(rows.find(row => row.current === false)?.[key]) });
  const f = features.rows[0] ?? {};
  const byKey = new Map(integrations.rows.map(row => [Number(row.key), row]));
  const name = (tenant: string, row: Record<string, any>) => ({ ...accountName(tenant, row as never), staff: row.known && !row.counted && !!row.sign_in });
  return {
    schema_version: 1, range: windowOf(window), generated_at: new Date(now).toISOString(),
    tiles: {
      active_accounts: compare(tiles.rows, "active_accounts"), responses: compare(tiles.rows, "responses"), self_serve_responses: compare(tiles.rows, "self_serve_responses"),
      agents_ran: compare(attempts.rows, "agents"), self_serve_agents_ran: compare(attempts.rows, "self_serve_agents"), end_users: compare(attempts.rows, "end_users"),
      self_serve_end_users: compare(attempts.rows, "self_serve_end_users"),
      live_agents: n(f.agents), self_serve_live_agents: n(f.self_serve_agents),
    },
    daily: windowDates(window).map(date => {
      const row = byDate.get(date);
      return { date, self_serve: n(row?.self_serve), operator: n(row?.operator), other: n(row?.other) };
    }),
    attempts_since: first.rows[0].first === null ? null : new Date(n(first.rows[0].first)).toISOString(),
    models: models.rows.map(row => ({
      model: row.model, responses: n(row.responses), accounts: n(row.accounts), cost: n(row.cost), self_serve_responses: n(row.self_serve_responses), self_serve_accounts: n(row.self_serve_accounts),
    })).sort((a, b) => b.responses - a.responses).slice(0, TOP_MODELS),
    configured_models: configured.rows.slice(0, TOP_MODELS).map(row => ({
      model: row.model, agents: n(row.agents), accounts: n(row.accounts), self_serve_agents: n(row.self_serve_agents), self_serve_accounts: n(row.self_serve_accounts),
    })),
    features: FEATURES.map(feature => ({ key: feature.key, label: feature.label, agents: n(f[feature.key]), self_serve_agents: n(f[`ss_${feature.key}`]) })),
    integrations: INTEGRATIONS.map((integration, index) => ({
      key: integration.key, label: integration.label, accounts: n(byKey.get(index)?.accounts), self_serve_accounts: n(byKey.get(index)?.self_serve_accounts),
    })),
    mcp_clients: clients.rows.map(row => ({ client: String(row.client), accounts: n(row.accounts) })),
    accounts: accounts.rows.map(row => ({
      ...name(row.tenant, row), deleted: row.deleted, agents: n(row.agents), responses: n(row.responses), cost: n(row.cost), platform_cost: n(row.platform_cost),
      active_days: n(row.active_days), last_active: row.last_active, models: row.models ?? [],
      balance: row.balance === null ? null : n(row.balance), purchased: n(row.purchased),
    })),
    agents: agents.rows.map(row => ({
      agent: row.agent, name: row.name ?? row.agent, model: row.model ?? "", kind: row.kind ?? "agent", deleted: row.deleted !== false,
      account: name(row.tenant, row), responses: n(row.responses), end_users: n(row.end_users), active_days: n(row.active_days),
      last_at: new Date(n(row.last_at)).toISOString(),
    })),
  };
}

/** One of an account's agents, as the drill-down shows it: what it is set up with, and its model calls in the window. */
export interface AdminAccountAgent {
  agent: string; name: string; type: string; model: string; definition: string | null;
  builtins: string[]; mcp_servers: string[]; openapi: number; app_tools: number; code_mode: boolean;
  schedules: number; channel: string | null; responses: number; end_users: number; last_at: string | null;
  /** The start of its system prompt with what looks like a credential hidden (`maskSecrets`), at most ADMIN_PROMPT_CHARS characters, and how long that is whole. */
  system_prompt: string; system_prompt_length: number;
}
export interface AdminAccountDetail {
  schema_version: 1;
  range: AdminWindow;
  generated_at: string;
  account: AdminAccountName & {
    staff: boolean; deleted: boolean; billing: "prepaid" | "none" | null;
    /** Micro-USD: what is left, what was bought (net of refunds), and what was given free (grants and credits an operator added). */
    balance: number; purchased: number; granted: number;
  };
  usage: { responses: number; cost: number; platform_cost: number; active_days: number; models: { model: string; responses: number; cost: number }[] };
  daily: { date: string; responses: number }[];
  /** Live agents, the most used first (at most ADMIN_ACCOUNT_AGENTS). */
  agents: AdminAccountAgent[];
  live_agents: number;
  channels: { type: string; name: string }[];
  counts: { api_keys: number; definitions: number; volumes: number; schedules: number };
  /** Providers it keeps its own key for, and the MCP clients it connected. */
  provider_keys: string[];
  mcp_clients: string[];
}

export const ADMIN_PROMPT_CHARS = 1500;
export const ADMIN_ACCOUNT_AGENTS = 50;

/**
 * Text with what looks like a credential hidden: keys and tokens people paste into a system prompt (providers', GitHub's,
 * Slack's, Discord's, AWS's, Stripe's, this runtime's own, webhook secrets, bearer tokens, JWTs and private keys). Each
 * keeps its first few characters, so it is clear what was there. A pattern can miss a secret: the excerpt is still
 * customer text, shown to admins only.
 */
export function maskSecrets(text: string) {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private key hidden]")
    .replace(/\b(?:sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|whsec_[A-Za-z0-9+/=]{16,}|art_[0-9a-f]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|[MN][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,})/g,
      secret => `${secret.slice(0, 4)}…[hidden]`)
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, "$1[hidden]");
}

/** An MCP server's host only: its address can carry a credential in its path or query. */
function hostOf(url: unknown) {
  try { return typeof url === "string" ? new URL(url).host : "?"; } catch { return "?"; }
}

/**
 * One account, for the Usage tab's drill-down (GET /api/account): who it is, its credit, its model use in the window, and
 * its live agents with how each is set up, including the start of its system prompt. Read-only; undefined for an account
 * with no `tenants` row and nothing in the runtime (no agents, no usage).
 */
export async function adminAccount(db: Db, tenant: string, options: { days: number | string; now?: number; internalDomains?: string[] }): Promise<AdminAccountDetail | undefined> {
  const now = options.now ?? Date.now();
  const window = adminWindow(options.days, now);
  const domains = options.internalDomains ?? [];
  const from = utcDate(window.from), until = utcDate(window.until);
  const [account, credit, models, daily, agents, channels, counts, keys, clients] = await snapshot(db, sql => Promise.all([
    sql.query(`
      select ${NAME_COLUMNS}, t.billing, ${`(${SELF_SERVE} and ${counted("$2::text[]")})`} as counted,
        exists (select 1 from account_deletions d where d.tenant = $1) as deleted
      from (select $1::text as id) x left join tenants t on t.id = x.id`, [tenant, domains]),
    sql.query(`
      select coalesce((select balance from credit_accounts where tenant = $1), 0) as balance, coalesce((select purchased from credit_accounts where tenant = $1), 0) as purchased,
        coalesce((select sum(amount) from credit_ledger where tenant = $1 and kind in ('grant', 'adjustment') and amount > 0), 0) as granted`, [tenant]),
    sql.query(`
      select u.model, sum(u.responses) as responses, sum(u.cost) as cost, sum(u.platform_cost) as platform_cost, count(distinct u.day) filter (where u.responses > 0) as days
      from usage u where u.tenant = $1 and u.day >= $2::date and u.day < $3::date group by u.model`, [tenant, from, until]),
    sql.query(`
      select to_char(u.day, 'YYYY-MM-DD') as date, sum(u.responses) as responses from usage u
      where u.tenant = $1 and u.day >= $2::date and u.day < $3::date and ${MODEL_CALL} group by u.day`, [tenant, from, until]),
    sql.query(`
      with ran as (
        select m.agent, count(*) as responses, count(distinct m.end_user) as end_users, max(m.started_at) as last_at
        from model_attempts m where m.tenant = $1 and m.started_at >= $2 and m.started_at < $3 and m.kind = 'response' group by m.agent)
      select a.id, a.name, a.type, a.model, a.header::jsonb as h, coalesce(ran.responses, 0) as responses, coalesce(ran.end_users, 0) as end_users, ran.last_at,
        (select count(*) from schedules s where s.agent = a.id) as schedules,
        (select c.channel->>'type' from channel_agents ca join channels c on c.id = ca.channel where ca.agent = a.id limit 1) as channel,
        count(*) over () as total
      from agents a left join ran on ran.agent = a.id
      where a.tenant = $1 and ${liveAgent("$4")}
      order by coalesce(ran.responses, 0) desc, a.id limit ${ADMIN_ACCOUNT_AGENTS}`, [tenant, window.from, window.until, now]),
    sql.query("select channel->>'type' as type, channel->>'name' as name from channels where tenant = $1 order by created_at", [tenant]),
    sql.query(`
      select (select count(*) from api_tokens where tenant = $1) as api_keys, (select count(*) from definitions where tenant = $1) as definitions,
        (select count(*) from volumes where tenant = $1 and purged_at is null) as volumes, (select count(*) from schedules where tenant = $1) as schedules`, [tenant]),
    sql.query("select provider from provider_keys where tenant = $1 order by provider", [tenant]),
    sql.query("select distinct client_name from oauth_grants where tenant = $1 order by client_name", [tenant]),
  ]));
  const row = account.rows[0];
  const modelRows = models.rows.filter(model => !/^(compaction|transcription|image|computer):|\/web_search$|^xai\/x_search$|^firecrawl\/web_fetch$|^runtime\/tool_search$/.test(model.model));
  if (!row.known && !agents.rows.length && !models.rows.length) return undefined;
  const byDate = new Map(daily.rows.map(day => [day.date, n(day.responses)]));
  const c = credit.rows[0];
  return {
    schema_version: 1, range: windowOf(window), generated_at: new Date(now).toISOString(),
    account: {
      ...accountName(tenant, row), staff: row.known && !row.counted && !!row.sign_in, deleted: row.deleted, billing: row.billing ?? null,
      balance: n(c.balance), purchased: n(c.purchased), granted: n(c.granted),
    },
    usage: {
      responses: modelRows.reduce((sum, model) => sum + n(model.responses), 0),
      cost: models.rows.reduce((sum, model) => sum + n(model.cost), 0), platform_cost: models.rows.reduce((sum, model) => sum + n(model.platform_cost), 0),
      active_days: new Set(daily.rows.filter(day => n(day.responses) > 0).map(day => day.date)).size,
      models: modelRows.map(model => ({ model: model.model, responses: n(model.responses), cost: n(model.cost) })).sort((a, b) => b.responses - a.responses),
    },
    daily: windowDates(window).map(date => ({ date, responses: byDate.get(date) ?? 0 })),
    agents: agents.rows.map(agent => {
      // Secrets are hidden before the excerpt is cut, so none is cut short of its pattern and shown in part.
      const h = agent.h ?? {}, prompt = typeof h.config?.systemPrompt === "string" ? maskSecrets(h.config.systemPrompt) : "";
      return {
        agent: agent.id, name: agent.name, type: agent.type, model: agent.model, definition: h.definition?.id ?? null,
        builtins: Array.isArray(h.sources?.builtins) ? h.sources.builtins.filter((name: unknown) => typeof name === "string") : [],
        mcp_servers: Array.isArray(h.sources?.mcpServers) ? h.sources.mcpServers.map((server: { url?: unknown }) => hostOf(server?.url)) : [],
        openapi: Array.isArray(h.sources?.openApi) ? h.sources.openApi.length : 0, app_tools: Array.isArray(h.definitions) ? h.definitions.length : 0,
        code_mode: h.config?.codeMode !== false, schedules: n(agent.schedules), channel: agent.channel ?? null,
        responses: n(agent.responses), end_users: n(agent.end_users), last_at: agent.last_at === null ? null : new Date(n(agent.last_at)).toISOString(),
        system_prompt: prompt.slice(0, ADMIN_PROMPT_CHARS), system_prompt_length: prompt.length,
      };
    }),
    live_agents: n(agents.rows[0]?.total),
    channels: channels.rows.map(channel => ({ type: String(channel.type), name: String(channel.name ?? "") })),
    counts: { api_keys: n(counts.rows[0].api_keys), definitions: n(counts.rows[0].definitions), volumes: n(counts.rows[0].volumes), schedules: n(counts.rows[0].schedules) },
    provider_keys: keys.rows.map(key => String(key.provider)),
    mcp_clients: clients.rows.map(client => String(client.client_name)),
  };
}
