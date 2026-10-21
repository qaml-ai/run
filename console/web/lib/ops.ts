import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * The ops dashboard's (the admin site's, src/admin-site.ts) access to its own API. The site is served under a path of the
 * runtime's hostname (/ops) or on a hostname of its own; the server says which in the page's `admin-base` meta tag.
 */
export function opsBase() {
  if (typeof document === "undefined") return "";
  return document.querySelector<HTMLMetaElement>('meta[name="admin-base"]')?.content ?? "";
}

export const opsUrl = (path: string) => `${opsBase()}${path}`;

/** Why a figure could not be read: signed out of Access, an API this server does not have yet, no such account, or anything else. */
export type OpsError = "sign_in_required" | "unavailable" | "not_released" | "not_found";

/**
 * Answers already read, by path and refresh: a tab opened again shows what it showed, and two parts of the page asking
 * for the same figures (the header and the Growth tab) share one request. Refresh asks again.
 */
const answers = new Map<string, Promise<unknown>>();
const settled = new Map<string, unknown>();

/** What the header shows: whether anything is loading, and when figures last arrived. */
let activity = { loading: 0, updated: null as number | null };
const listeners = new Set<() => void>();
const emit = (next: Partial<typeof activity>) => {
  activity = { ...activity, ...next };
  for (const listener of listeners) listener();
};
export function useOpsActivity() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => activity, () => activity);
}

/** Forgets every answer (tests start clean). */
export function resetOps() {
  answers.clear();
  settled.clear();
  activity = { loading: 0, updated: null };
}

class OpsFailure extends Error {
  constructor(readonly code: OpsError) { super(code); }
}

function read<T>(key: string, path: string): Promise<T> {
  let answer = answers.get(key) as Promise<T> | undefined;
  if (answer) return answer;
  emit({ loading: activity.loading + 1 });
  answer = fetch(opsUrl(path), { credentials: "same-origin", cache: "no-store" })
    .then(async response => {
      if (response.status === 401) throw new OpsFailure("sign_in_required");
      if (response.status === 404) {
        // An account that is not there, or an API this release of the runtime does not have yet.
        const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
        throw new OpsFailure(body?.error === "account_not_found" ? "not_found" : "not_released");
      }
      if (!response.ok) throw new OpsFailure("unavailable");
      const data = await response.json() as T;
      settled.set(key, data);
      emit({ loading: activity.loading - 1, updated: Date.now() });
      return data;
    })
    .catch(error => {
      // A failure is not kept: the next look asks again.
      answers.delete(key);
      emit({ loading: activity.loading - 1 });
      throw error instanceof OpsFailure ? error : new OpsFailure("unavailable");
    });
  answers.set(key, answer);
  return answer;
}

/**
 * A GET of the site's API, read again when `path` or `refresh` changes. While it reloads the last answer stays (`stale`),
 * so a chart keeps its frame instead of flashing.
 */
export function useOps<T>(path: string | undefined, refresh = 0) {
  const key = path ? `${path}#${refresh}` : "";
  const [state, setState] = useState<{ key: string; data?: T; error?: OpsError }>(() =>
    settled.has(key) ? { key, data: settled.get(key) as T } : { key: "" });
  useEffect(() => {
    if (!path) return;
    if (settled.has(key)) { setState({ key, data: settled.get(key) as T }); return; }
    let live = true;
    read<T>(key, path).then(
      data => { if (live) setState({ key, data }); },
      (error: OpsFailure) => { if (live) setState(previous => ({ key, data: previous.data, error: error.code })); },
    );
    return () => { live = false; };
  }, [key, path]);
  const current = state.key === key;
  // A failure of the figures asked for now hides the ones from before: they would be another range's.
  const error = current ? state.error : undefined;
  const data = error ? undefined : state.data;
  const loading = !!key && !current, stale = loading && data !== undefined;
  /** `state` is what a Panel needs: whether there are figures to show, and why not. */
  return { data, error, loading, stale, state: { ready: data !== undefined, loading, stale, error } };
}

const numberFormat = new Intl.NumberFormat("en-US");
const compactFormat = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
export const count = (value: number) => numberFormat.format(value);
/** 1,284 / 12.9K / 4.2M: for figures that stand alone. */
export const compact = (value: number) => Math.abs(value) < 10_000 ? numberFormat.format(Math.round(value)) : compactFormat.format(value);
/** A count and its noun, singular or plural: "1 account", "3 accounts". */
export const plural = (value: number, one: string, many = `${one}s`) => `${count(value)} ${value === 1 ? one : many}`;

/** USD, with cents under $1,000 and sub-cent amounts shown as such rather than as $0.00. */
export function usd(value: number) {
  if (value !== 0 && Math.abs(value) < 0.01) return value < 0 ? "−<$0.01" : "<$0.01";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2, minimumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2 }).format(value);
}
/** Micro-USD (the credit ledger's unit) as USD. */
export const micros = (value: number) => usd(value / 1_000_000);
export const percent = (part: number, whole: number) => whole ? `${Math.round(part / whole * 100)}%` : "—";

/** A change against the period before, signed, or nothing to say when there was nothing before. */
export function change(current: number, previous: number): { text: string; direction: "up" | "down" | "flat" } | undefined {
  if (!previous && !current) return undefined;
  if (!previous) return { text: "new", direction: "up" };
  const delta = (current - previous) / previous;
  if (Math.abs(delta) < 0.005) return { text: "±0%", direction: "flat" };
  return { text: `${delta > 0 ? "+" : "−"}${Math.round(Math.abs(delta) * 100)}%`, direction: delta > 0 ? "up" : "down" };
}

/** A UTC date (YYYY-MM-DD) as "Mar 14". */
export const day = (date: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00Z`));
/** A UTC date (YYYY-MM-DD) as "Mar 14, 2026". */
export const fullDay = (date: string) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }).format(new Date(`${date.slice(0, 10)}T12:00:00Z`));
/** A UTC month (YYYY-MM) as "Mar" (or "Mar 2026" with `year`). */
export const month = (value: string, year = false) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", ...(year ? { year: "numeric" } : {}) }).format(new Date(`${value}-15T12:00:00Z`));
/** An instant as "Mar 14, 3:05 PM" in the viewer's zone. */
export const when = (iso: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
/** An instant as "3:05 PM" in the viewer's zone. */
export const clock = (at: number) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(at));
/** How long ago an instant or UTC date was, in words. */
export function ago(iso: string | null, now = Date.now()) {
  if (!iso) return "—";
  const ms = now - Date.parse(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (iso.length === 10) {
    const days = Math.round(ms / 86_400_000);
    return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  }
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return minutes <= 1 ? "just now" : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

/** A model id without its provider prefix, and the prefix: "openrouter/openai/gpt-5" is gpt-5 by openai through openrouter. */
export function modelName(model: string) {
  const parts = model.split("/");
  return { name: parts.at(-1) || model, via: parts.slice(0, -1).join("/") };
}

export const TABS = ["growth", "usage", "revenue", "health", "journeys", "mcp"] as const;
export type OpsTab = typeof TABS[number];
export const RANGES = [7, 30, 90] as const;
export type OpsRange = typeof RANGES[number];

/** The page's address: which tab, and how many days, so a view can be linked. */
export function readView(search: string): { tab: OpsTab; days: OpsRange } {
  const params = new URLSearchParams(search);
  const tab = TABS.find(entry => entry === params.get("tab")) ?? "growth";
  const days = RANGES.find(entry => String(entry) === params.get("days")) ?? 30;
  return { tab, days };
}

/** The address for a view: its tab and days, any other parameter kept. */
export function viewSearch(search: string, view: { tab: OpsTab; days: OpsRange }) {
  const params = new URLSearchParams(search);
  params.set("tab", view.tab);
  params.set("days", String(view.days));
  return `?${params}`;
}
