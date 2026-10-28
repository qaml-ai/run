import { mcpSignupAttribution } from "./admin-mcp.ts";
import { MCP_CLIENT_LABELS } from "./mcp-client-kind.ts";
import type { Db } from "./db.ts";
import { adminWindow, counted, modelCall, n, SELF_SERVE, snapshot, utcDate, windowDates, windowOf, type AdminWindow } from "./admin-accounts.ts";
import { keptSignupSource } from "./signup-source.ts";

/**
 * How a source is known: the MCP plugin whose sign-in made the account, the `ref` of the link that opened the console,
 * the site the browser came from, neither of those (`direct`), or nothing kept (`not_captured`: made before sources
 * were kept, or by an operator).
 */
export type AdminSourceKind = "plugin" | "ref" | "referrer" | "direct" | "not_captured";
export interface AdminSource {
  source: string; kind: AdminSourceKind; signups: number; made_agent: number; activated: number;
  active_two_days: number; paying: number; median_days_to_first_run: number | null;
}
export interface AdminAcquisition {
  schema_version: 1;
  range: AdminWindow;
  generated_at: string;
  sources: AdminSource[];
  total: AdminSource;
  /** Every UTC date, oldest first; counts follow the same order as sources. */
  daily: { date: string; counts: number[] }[];
  /** When the first account with a kept source was made: accounts before it are Not captured. Null before any. */
  recorded_since: string | null;
}

const blank = (source: string, kind: AdminSourceKind): AdminSource => ({ source, kind, signups: 0, made_agent: 0, activated: 0, active_two_days: 0, paying: 0, median_days_to_first_run: null });

/** Where an account came from: its plugin, when its first OAuth grant came within an hour of signup; else its kept source (src/signup-source.ts). */
function sourceOf(plugin: keyof typeof MCP_CLIENT_LABELS | undefined, kept: unknown): [string, AdminSourceKind] {
  if (plugin) return [MCP_CLIENT_LABELS[plugin], "plugin"];
  const source = keptSignupSource(kept);
  if (!source) return ["Not captured", "not_captured"];
  if (source.ref) return [source.ref, "ref"];
  if (source.referrer) return [source.referrer, "referrer"];
  return ["Direct", "direct"];
}

/**
 * The window's outside self-serve sign-ups by where they came from, with their lifetime usage, all from the runtime's
 * own tables in one snapshot, as camelBot counts its sign-ups by `signup_ref`. Nothing is asked of the journey store.
 */
export async function adminAcquisition(options: { days: number | string; now?: number; db: Db; internalDomains?: string[] }): Promise<AdminAcquisition> {
  const now = options.now ?? Date.now(), window = adminWindow(options.days, now);
  const { accounts, plugins, since } = await snapshot(options.db, async sql => {
    const accounts = await sql.query(`
      select t.id, t.created_at, t.signup_source,
        exists (select 1 from agents a where a.tenant = t.id) as made_agent,
        u.active_days, u.first_day,
        exists (select 1 from credit_ledger l where l.tenant = t.id and l.kind = 'purchase' and l.amount > 0) as paying
      from tenants t
      left join lateral (select count(distinct u.day) as active_days, min(u.day)::text as first_day
        from usage u where u.tenant = t.id and u.responses > 0 and ${modelCall()}) u on true
      where t.created_at >= $2 and t.created_at < $3 and ${SELF_SERVE} and ${counted("$1::text[]")}`,
    [options.internalDomains ?? [], window.from, window.until]);
    const plugins = await mcpSignupAttribution(sql, window.from, window.until, options.internalDomains);
    const since = (await sql.query("select min(created_at) as at from tenants where signup_source is not null")).rows[0]?.at;
    return { accounts: accounts.rows, plugins: new Map(plugins.map(row => [row.tenant, row.kind])), since };
  });

  const sources = new Map<string, AdminSource>();
  const daily = new Map(windowDates(window).map(date => [date, new Map<string, number>()]));
  const waits = new Map<AdminSource, number[]>(), total = blank("All", "direct");
  for (const account of accounts) {
    const [label, kind] = sourceOf(plugins.get(account.id), account.signup_source);
    const key = `${kind}:${label}`;
    const row = sources.get(key) ?? blank(label, kind);
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
  }
  for (const [row, list] of waits) {
    list.sort((a, b) => a - b);
    row.median_days_to_first_run = (list[Math.floor((list.length - 1) / 2)] + list[Math.floor(list.length / 2)]) / 2;
  }
  const ranked = [...sources].sort((a, b) => b[1].signups - a[1].signups || a[0].localeCompare(b[0]));
  return {
    schema_version: 1, range: windowOf(window), generated_at: new Date(now).toISOString(),
    sources: ranked.map(([, row]) => row), total,
    daily: [...daily].map(([date, counts]) => ({ date, counts: ranked.map(([key]) => counts.get(key) ?? 0) })),
    recorded_since: since == null ? null : new Date(n(since)).toISOString(),
  };
}
