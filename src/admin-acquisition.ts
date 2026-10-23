import { mcpSignupAttribution } from "./admin-mcp.ts";
import { MCP_CLIENT_LABELS } from "./mcp-client-kind.ts";
import type { Db } from "./db.ts";
import { adminWindow, counted, modelCall, n, SELF_SERVE, snapshot, utcDate, windowDates, windowOf, type AdminWindow } from "./admin-accounts.ts";
import { adminReport, type AdminReportSource } from "./admin-report.ts";

export interface AdminSource {
  source: string; medium: string | null; signups: number; made_agent: number; activated: number;
  active_two_days: number; paying: number; median_days_to_first_run: number | null;
}
export interface AdminAcquisition {
  schema_version: 1;
  range: AdminWindow;
  generated_at: string;
  /** Availability of source reports; local signup and usage counts remain available in every state. */
  status: "ok" | "not_configured" | "unavailable";
  tracked_signups: number;
  sources: AdminSource[];
  total: AdminSource;
  /** Every UTC date, oldest first; counts follow the same order as sources. */
  daily: { date: string; counts: number[] }[];
  campaigns: { campaign: string; signups: number }[];
  landing_pages: { path: string; signups: number }[];
  /** Some sources could not be read. Those accounts remain in Not captured, never dropped from totals. */
  truncated: boolean;
  coverage: { first_event_at: string | null; last_event_at: string | null };
}

export const ADMIN_ACQUISITION_PAGES = 20;
const PAGING_MS = 15_000;
type JourneyItem = {
  account_ref?: string;
  acquisition?: { source: string | null; medium: string | null; campaign: string | null; landing_path: string | null; landing_host?: string | null; capture_quality: string };
};
const blank = (source: string, medium: string | null = null): AdminSource => ({ source, medium, signups: 0, made_agent: 0, activated: 0, active_two_days: 0, paying: 0, median_days_to_first_run: null });

/** Only the configured sales host is a sales-page source. Older reports without a host keep their referral label. */
function salesPage(seen: JourneyItem["acquisition"], source: AdminReportSource | undefined): string | undefined {
  if (!seen?.landing_host || !seen.landing_path?.startsWith("/") || seen.landing_path.startsWith("//") || /[?#]/.test(seen.landing_path) || !source) return;
  const host = new URL(source.url).hostname.replace(/^www\./, "");
  if (seen.landing_host.toLowerCase().replace(/^www\./, "") !== host) return;
  return `${host}${seen.landing_path}`;
}

/** Local outside signup cohort and lifetime usage, joined to first-touch attribution by opaque account ref.
 * Reports may omit accounts because of consent, age, a delivery delay or pagination. Missing is never Direct.
 * Plugin acquisition uses the first OAuth grant within an hour, including accounts without journey records.
 */
export async function adminAcquisition(source: AdminReportSource | undefined, options: { days: number | string; now?: number; fetch?: typeof fetch; db: Db; internalDomains?: string[] }): Promise<AdminAcquisition> {
  const now = options.now ?? Date.now(), window = adminWindow(options.days, now);
  const { accounts, plugins } = await snapshot(options.db, async sql => {
    const accounts = await sql.query(`
      select t.id, t.created_at, j.account_ref,
        exists (select 1 from agents a where a.tenant = t.id) as made_agent,
        u.active_days, u.first_day,
        exists (select 1 from credit_ledger l where l.tenant = t.id and l.kind = 'purchase' and l.amount > 0) as paying
      from tenants t left join journey_accounts j on j.tenant = t.id
      left join lateral (select count(distinct u.day) as active_days, min(u.day)::text as first_day
        from usage u where u.tenant = t.id and u.responses > 0 and ${modelCall()}) u on true
      where t.created_at >= $2 and t.created_at < $3 and ${SELF_SERVE} and ${counted("$1::text[]")}`,
    [options.internalDomains ?? [], window.from, window.until]);
    const plugins = await mcpSignupAttribution(sql, window.from, window.until, options.internalDomains);
    return { accounts: accounts.rows, plugins: new Map(plugins.map(row => [row.tenant, row.kind])) };
  });
  const items = new Map<string, JourneyItem>();
  let cursor: string | undefined, status: AdminAcquisition["status"] = "ok", pages = 0;
  let coverage: AdminAcquisition["coverage"] = { first_event_at: null, last_event_at: null };
  const deadline = Date.now() + PAGING_MS;
  do {
    const answer = await adminReport({ schema_version: 1, kind: "journeys", start_date: window.start_date, end_date: window.end_date, time_zone: "UTC", ...(cursor ? { cursor } : {}) }, source, options.fetch);
    if (answer.status !== 200) {
      if (answer.reason) console.error(JSON.stringify({ type: "admin_acquisition_failed", error: answer.reason }));
      status = answer.status === 503 ? "not_configured" : "unavailable";
      items.clear();
      break;
    }
    const body = answer.body as { items?: JourneyItem[]; next_cursor?: string | null; coverage?: AdminAcquisition["coverage"] };
    coverage = { first_event_at: body.coverage?.first_event_at ?? null, last_event_at: body.coverage?.last_event_at ?? null };
    for (const item of Array.isArray(body.items) ? body.items : []) {
      if (item.account_ref && !items.has(item.account_ref)) items.set(item.account_ref, item);
    }
    cursor = typeof body.next_cursor === "string" && body.next_cursor ? body.next_cursor : undefined;
  } while (cursor && ++pages < ADMIN_ACQUISITION_PAGES && Date.now() < deadline);

  const sources = new Map<string, AdminSource>(), campaigns = new Map<string, number>(), landing = new Map<string, number>();
  const daily = new Map(windowDates(window).map(date => [date, new Map<string, number>()]));
  const waits = new Map<AdminSource, number[]>(), total = blank("All");
  let tracked = 0;
  for (const account of accounts) {
    const item = items.get(account.account_ref), seen = item?.acquisition, plugin = plugins.get(account.id);
    if (item) tracked++;
    const page = salesPage(seen, source);
    const label = plugin ? MCP_CLIENT_LABELS[plugin] : seen?.capture_quality === "not_applicable" ? "No browser (API or MCP)" : page || seen?.source || "Not captured";
    const medium = plugin || page || seen?.capture_quality === "not_applicable" ? null : seen?.medium || null;
    const key = JSON.stringify([label, medium]);
    const row = sources.get(key) ?? blank(label, medium);
    sources.set(key, row);
    for (const target of [row, total]) {
      target.signups++;
      if (account.made_agent || n(account.active_days)) target.made_agent++;
      if (n(account.active_days)) target.activated++;
      if (n(account.active_days) >= 2) target.active_two_days++;
      if (account.paying) target.paying++;
      if (account.first_day) {
        const days = Math.max(0, (Date.parse(account.first_day) - Date.parse(utcDate(n(account.created_at)))) / 86_400_000);
        const list = waits.get(target) ?? [];
        list.push(days); waits.set(target, list);
      }
    }
    const day = daily.get(utcDate(n(account.created_at)))!;
    day.set(key, (day.get(key) ?? 0) + 1);
    if (seen?.campaign) campaigns.set(seen.campaign, (campaigns.get(seen.campaign) ?? 0) + 1);
    if (seen?.landing_path) landing.set(seen.landing_path, (landing.get(seen.landing_path) ?? 0) + 1);
  }
  for (const [row, list] of waits) {
    list.sort((a, b) => a - b);
    row.median_days_to_first_run = (list[Math.floor((list.length - 1) / 2)] + list[Math.floor(list.length / 2)]) / 2;
  }
  const ranked = [...sources].sort((a, b) => b[1].signups - a[1].signups || a[0].localeCompare(b[0]));
  const top = (map: Map<string, number>) => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10);
  return {
    schema_version: 1, range: windowOf(window), generated_at: new Date(now).toISOString(), status,
    tracked_signups: tracked, sources: ranked.map(([, row]) => row), total,
    daily: [...daily].map(([date, counts]) => ({ date, counts: ranked.map(([key]) => counts.get(key) ?? 0) })),
    campaigns: top(campaigns).map(([campaign, signups]) => ({ campaign, signups })),
    landing_pages: top(landing).map(([path, signups]) => ({ path, signups })),
    truncated: status === "ok" && !!cursor, coverage,
  };
}
