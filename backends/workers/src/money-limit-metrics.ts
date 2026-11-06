// Generated from src/limit-hits.ts; only host imports and the log sink are replaced.

// Run node backends/workers/scripts/reuse-money-metrics.mjs --check to check source drift.

import { writeMetricLine } from "./money-metrics.ts";

const console = { log: writeMetricLine };

/**
 * Limits people hit, so each can be rechecked against real use: a `limit_hit` line when a limit refuses someone, with
 * the tenant and which limit, and for an end user's credit whose (`endUser`, the tenant's subject) and which bucket and
 * why; never what was refused, nor amounts. One line per tenant, limit and minute on each node, then
 * `limit_hit_repeats` with how many more came that minute (said at the next hit after it ends).
 */
import { errorCode } from "./errors.ts";

type Hit = { tenant: string | null; limit: string; status: number; route?: string; endUser?: string; bucket?: string; reason?: string };

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
  const key = JSON.stringify([hit.tenant, hit.limit, hit.route, hit.endUser, hit.bucket]);
  const seen = hits.get(key);
  if (seen) { seen.repeats++; return; }
  hits.set(key, { ...hit, repeats: 0 });
  console.log(JSON.stringify({ type: "limit_hit", ...hit }));
}

/**
 * An error answered or passed on, if a limit's refusal: said as a hit, once however many handlers it passes through.
 * `route` says what was refused, as a route or an operation, never its ids or contents.
 */
/** An end user's credit refusal's whose, bucket and why (HttpError details of a 402 END_USER_CREDIT), as strings only. */
function creditOf(details: unknown): Pick<Hit, "endUser" | "bucket" | "reason"> {
  if (!details || typeof details !== "object") return {};
  const { endUser, bucket, reason } = details as Record<string, unknown>;
  return { ...(typeof endUser === "string" ? { endUser } : {}), ...(typeof bucket === "string" ? { bucket } : {}), ...(typeof reason === "string" ? { reason } : {}) };
}

/** An end user's credit refusing a model call (as it began, or as it streamed): its line, with whose, which bucket and why. */
export function creditRefused(tenant: string, refused: { endUser?: string; bucket?: string; reason?: string }, route: "model_call" | "model_stream") {
  limitHit({ tenant, limit: "END_USER_CREDIT", status: 402, route, ...creditOf(refused) });
}

export function limitRefused(error: unknown, status: number, tenant: string | undefined, route?: string, now?: number) {
  if (!REFUSALS.has(status) || !error || typeof error !== "object" || said.has(error)) return;
  said.add(error);
  // A rate limit says which of them it is; anything else, by its error code. An end user's credit says whose and where.
  const limit = (error as { limit?: { name?: unknown } }).limit?.name;
  limitHit({ tenant: tenant ?? null, limit: typeof limit === "string" ? limit : errorCode(error, status), status, ...(route ? { route } : {}), ...creditOf((error as { details?: unknown }).details) }, now);
}
