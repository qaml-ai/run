import { adminWindow, windowOf, type AdminWindow } from "./admin-accounts.ts";
import { adminReport, type AdminReportSource } from "./admin-report.ts";

/** Sign-ups by where they first came from, as the journey store saw them. */
export interface AdminSource { source: string; medium: string | null; signups: number; activated: number; paying: number }
export interface AdminAcquisition {
  schema_version: 1;
  range: AdminWindow;
  generated_at: string;
  /** `not_configured`: no journey store answers reports here. `unavailable`: it could not be asked just now. */
  status: "ok" | "not_configured" | "unavailable";
  /** Sign-ups in the window the store knows of: those whose browser agreed to be measured (or every one, where the operator says so). */
  tracked_signups: number;
  sources: AdminSource[];
  campaigns: { campaign: string; signups: number }[];
  landing_pages: { path: string; signups: number }[];
  /** Whether there were more accounts than were read (ADMIN_ACQUISITION_PAGES pages, or 15 seconds): the counts are then of the first ones. */
  truncated: boolean;
  /** When the store's events begin and end, so a window before them reads as unknown rather than none. */
  coverage: { first_event_at: string | null; last_event_at: string | null };
}

/** How many of the store's pages of accounts (25 each) one answer reads at most, and for how long it asks for more. */
export const ADMIN_ACQUISITION_PAGES = 20;
const PAGING_MS = 15_000;

type JourneyItem = {
  signup_at: string | null; activated_at: string | null; payments: number;
  acquisition: { source: string | null; medium: string | null; campaign: string | null; landing_path: string | null; capture_quality: string };
};

/**
 * Where the window's sign-ups came from (the admin site's Growth tab, GET /api/acquisition), from the journey store's
 * `journeys` report (src/admin-report.ts): each account active in the window, with what the store knows of its first
 * arrival (source, medium, campaign, landing page), across the operator's website and the console. Of those, the accounts
 * that signed up in the window. The runtime itself keeps none of this: it sends it to the store (src/journey.ts).
 */
export async function adminAcquisition(source: AdminReportSource | undefined, options: { days: number | string; now?: number; fetch?: typeof fetch }): Promise<AdminAcquisition> {
  const now = options.now ?? Date.now();
  const window = adminWindow(options.days, now);
  const base = { schema_version: 1 as const, range: windowOf(window), generated_at: new Date(now).toISOString() };
  const empty = { tracked_signups: 0, sources: [], campaigns: [], landing_pages: [], truncated: false, coverage: { first_event_at: null, last_event_at: null } as AdminAcquisition["coverage"] };
  const sources = new Map<string, AdminSource>(), campaigns = new Map<string, number>(), landing = new Map<string, number>();
  let cursor: string | undefined, tracked = 0, coverage = empty.coverage, pages = 0;
  const deadline = Date.now() + PAGING_MS;
  do {
    const answer = await adminReport({ schema_version: 1, kind: "journeys", start_date: window.start_date, end_date: window.end_date, time_zone: "UTC", ...(cursor ? { cursor } : {}) }, source, options.fetch);
    if (answer.status !== 200) {
      if (answer.reason) console.error(JSON.stringify({ type: "admin_acquisition_failed", error: answer.reason }));
      return { ...base, ...empty, status: answer.status === 503 ? "not_configured" : "unavailable" };
    }
    const body = answer.body as { items?: JourneyItem[]; next_cursor?: string | null; coverage?: AdminAcquisition["coverage"] };
    coverage = { first_event_at: body.coverage?.first_event_at ?? null, last_event_at: body.coverage?.last_event_at ?? null };
    for (const item of Array.isArray(body.items) ? body.items : []) {
      const signup = item.signup_at ? Date.parse(item.signup_at) : NaN;
      if (!(signup >= window.from && signup < window.until)) continue;
      tracked++;
      const seen = item.acquisition ?? {} as JourneyItem["acquisition"];
      const label = seen.capture_quality === "not_applicable" ? "No browser (API or MCP)" : seen.source || "Not captured";
      const medium = seen.capture_quality === "not_applicable" ? null : seen.medium || null;
      const key = `${label}\n${medium ?? ""}`;
      const row = sources.get(key) ?? { source: label, medium, signups: 0, activated: 0, paying: 0 };
      row.signups++;
      if (item.activated_at) row.activated++;
      if (item.payments > 0) row.paying++;
      sources.set(key, row);
      if (seen.campaign) campaigns.set(seen.campaign, (campaigns.get(seen.campaign) ?? 0) + 1);
      if (seen.landing_path) landing.set(seen.landing_path, (landing.get(seen.landing_path) ?? 0) + 1);
    }
    cursor = typeof body.next_cursor === "string" ? body.next_cursor : undefined;
  } while (cursor && ++pages < ADMIN_ACQUISITION_PAGES && Date.now() < deadline);
  const top = (map: Map<string, number>) => [...map].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10);
  return {
    ...base, status: "ok", tracked_signups: tracked,
    sources: [...sources.values()].sort((a, b) => b.signups - a.signups || a.source.localeCompare(b.source)),
    campaigns: top(campaigns).map(([campaign, signups]) => ({ campaign, signups })),
    landing_pages: top(landing).map(([path, signups]) => ({ path, signups })),
    truncated: !!cursor, coverage,
  };
}
