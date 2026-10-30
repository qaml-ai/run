/**
 * Limits people hit, so each can be rechecked against real use: a `limit_hit` line when a limit refuses someone, with
 * the tenant and which limit, never what was refused. One line per tenant, limit and minute on each node, then
 * `limit_hit_repeats` with how many more came that minute (said at the next hit after it ends).
 */
import { errorCode } from "./http.ts";

type Hit = { tenant: string | null; limit: string; status: number; route?: string };

/** The statuses that mean a limit said no: out of credit, too large, too many, out of storage. */
const REFUSALS = new Set([402, 413, 429, 507]);
const said = new WeakSet<object>();
let hits = new Map<string, Hit & { repeats: number }>();
let minute = 0;

export function limitHit(hit: Hit, now = Date.now()) {
  const current = Math.floor(now / 60_000);
  if (current !== minute) {
    for (const seen of hits.values()) if (seen.repeats) console.log(JSON.stringify({ type: "limit_hit_repeats", ...seen }));
    hits = new Map();
    minute = current;
  }
  const key = JSON.stringify([hit.tenant, hit.limit, hit.route]);
  const seen = hits.get(key);
  if (seen) { seen.repeats++; return; }
  hits.set(key, { ...hit, repeats: 0 });
  console.log(JSON.stringify({ type: "limit_hit", ...hit }));
}

/**
 * An error answered or passed on, if a limit's refusal: said as a hit, once however many handlers it passes through.
 * `route` says what was refused, as a route or an operation, never its ids or contents.
 */
export function limitRefused(error: unknown, status: number, tenant: string | undefined, route?: string, now?: number) {
  if (!REFUSALS.has(status) || !error || typeof error !== "object" || said.has(error)) return;
  said.add(error);
  // A rate limit says which of them it is; anything else, by its error code.
  const limit = (error as { limit?: { name?: unknown } }).limit?.name;
  limitHit({ tenant: tenant ?? null, limit: typeof limit === "string" ? limit : errorCode(error, status), status, ...(route ? { route } : {}) }, now);
}
