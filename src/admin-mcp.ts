import { adminWindow, counted, modelCall, SELF_SERVE, snapshot, utcDate, windowDates, windowOf, type AdminWindow } from "./admin-accounts.ts";
import type { Db, Sql } from "./db.ts";
import { MCP_CLIENT_KINDS, MCP_CLIENT_LABELS, mcpGrantKind, type McpClientKind } from "./mcp-client-kind.ts";

/** First retained grant only; later connections must not rewrite acquisition. No schema change is needed. */
export async function mcpSignupAttribution(sql: Sql, from: number, until: number, domains: string[] = []) {
  const result = await sql.query(`
    select t.id as tenant, j.account_ref, t.created_at, g.client_name, g.client_id
    from tenants t
    join lateral (select * from oauth_grants where tenant = t.id order by created_at, id limit 1) g
      on g.created_at >= t.created_at and g.created_at <= t.created_at + 3600000
    left join journey_accounts j on j.tenant = t.id
    where t.created_at >= $2 and t.created_at < $3 and ${SELF_SERVE} and ${counted("$1::text[]")}`,
  [domains, from, until]);
  return result.rows.map(row => ({ tenant: row.tenant as string, account_ref: row.account_ref as string | null,
    date: utcDate(Number(row.created_at)), kind: mcpGrantKind(row.client_name, row.client_id) }));
}

export interface AdminMcp {
  schema_version: 1;
  range: AdminWindow;
  generated_at: string;
  daily: { date: string; kind: McpClientKind; signups: number; token_active_accounts: number }[];
  weekly: { week: string; kind: McpClientKind; token_active_accounts: number }[];
  funnel: { kind: McpClientKind; label: string; authorized: number; made_agent: number; ran_turn: number; came_back: number }[];
  limitations: string[];
}

/** Read-only plugin acquisition and token activity; all dates are UTC, staff/deleted accounts excluded. */
export async function adminMcp(db: Db, options: { days: number | string; now?: number; internalDomains?: string[] }): Promise<AdminMcp> {
  const now = options.now ?? Date.now(), window = adminWindow(options.days, now), domains = options.internalDomains ?? [];
  const [signups, grants, progression] = await snapshot(db, sql => Promise.all([
    mcpSignupAttribution(sql, window.from, window.until, domains),
    sql.query(`select g.tenant, g.client_name, g.client_id, g.used_at,
        to_char(date_trunc('week', to_timestamp(g.used_at / 1000.0) at time zone 'UTC'), 'YYYY-MM-DD') as week
      from oauth_grants g join tenants t on t.id = g.tenant
      where g.used_at >= $2 and g.used_at < $3 and ${SELF_SERVE} and ${counted("$1::text[]")}`,
    [domains, window.from, Math.min(window.until, now + 1)]),
    sql.query(`select t.id as tenant,
        exists (select 1 from agents a where a.tenant = t.id) as made_agent,
        (select min(u.day) from usage u where u.tenant = t.id and u.responses > 0 and ${modelCall()} and u.day >= (to_timestamp(t.created_at / 1000.0) at time zone 'UTC')::date and u.day <= $4::date) as first_run,
        (select max(u.day) from usage u where u.tenant = t.id and u.responses > 0 and ${modelCall()} and u.day <= $4::date) as last_run,
        array(select distinct on (g.client_id) g.client_id from oauth_grants g where g.tenant = t.id and g.created_at <= $5 order by g.client_id) as client_ids,
        array(select distinct on (g.client_id) g.client_name from oauth_grants g where g.tenant = t.id and g.created_at <= $5 order by g.client_id) as client_names
      from tenants t where t.created_at >= $2 and t.created_at < $3 and ${SELF_SERVE} and ${counted("$1::text[]")}`,
    [domains, window.from, window.until, utcDate(now), now]),
  ]));
  const daily = windowDates(window).flatMap(date => MCP_CLIENT_KINDS.map(kind => ({ date, kind, signups: 0, token_active_accounts: 0 })));
  const byDay = new Map(daily.map(row => [`${row.date}/${row.kind}`, row]));
  for (const row of signups) byDay.get(`${row.date}/${row.kind}`)!.signups++;
  const days = new Map<string, Set<string>>(), weeks = new Map<string, Set<string>>();
  for (const row of grants.rows) {
    const kind = mcpGrantKind(row.client_name, row.client_id), day = `${utcDate(Number(row.used_at))}/${kind}`, week = `${row.week}/${kind}`;
    if (!days.has(day)) days.set(day, new Set());
    if (!weeks.has(week)) weeks.set(week, new Set());
    days.get(day)!.add(row.tenant); weeks.get(week)!.add(row.tenant);
  }
  for (const [key, tenants] of days) byDay.get(key)!.token_active_accounts = tenants.size;
  const weekLabels = [...new Set(windowDates(window).map(date => {
    const day = new Date(`${date}T00:00:00Z`); day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7); return utcDate(day.getTime());
  }))];
  const funnel = MCP_CLIENT_KINDS.map(kind => ({ kind, label: MCP_CLIENT_LABELS[kind], authorized: 0, made_agent: 0, ran_turn: 0, came_back: 0 }));
  for (const row of progression.rows) {
    const kinds = new Set<McpClientKind>((row.client_ids as string[]).map((id, i) => mcpGrantKind(row.client_names[i], id)));
    for (const kind of kinds) {
      const f = funnel.find(f => f.kind === kind)!;
      f.authorized++;
      // Model usage proves an agent existed even if it has since been removed.
      if (row.made_agent || row.first_run) f.made_agent++;
      if (row.first_run) f.ran_turn++;
      if (row.first_run && new Date(row.last_run).getTime() > new Date(row.first_run).getTime()) f.came_back++;
    }
  }
  return { schema_version: 1, range: windowOf(window), generated_at: new Date(now).toISOString(), daily,
    weekly: weekLabels.flatMap(week => MCP_CLIENT_KINDS.map(kind => ({ week, kind, token_active_accounts: weeks.get(`${week}/${kind}`)?.size ?? 0 }))), funnel,
    limitations: [
      "Activity is the latest token issuance or refresh in each retained OAuth grant, not MCP request activity. Earlier days are lost when used_at advances; counts can decrease. Weeks are Monday UTC, clipped to the selected window.",
      "No stored per-call record identifies the incoming OAuth plugin, so MCP tool-call counts are unavailable.",
      "Sign-ups use the first retained grant within one hour of account creation. Revoked grants are deleted, so attribution and authorization counts can be lost. Registration names and redirect hosts are client-declared, not verified vendor identity.",
      "The funnel includes accounts signed up in the window that authorized each kind by now, even after their first hour. Agent creation and model-response usage are account-wide, not proof of work through that plugin. Return means a model response on a day after the first response; an account can appear under multiple kinds.",
    ] };
}
