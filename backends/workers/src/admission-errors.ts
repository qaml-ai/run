// Generated from src/http.ts; only host imports are replaced.
// Run node backends/workers/scripts/reuse-security.mjs --check to check source drift.
import { databaseRetryable } from "./postgres.ts";

export function errorFields(error: unknown): Record<string, unknown> {
  const { details, input, limit } = (error ?? {}) as { details?: Record<string, unknown>; input?: unknown; limit?: unknown };
  return { ...(details && typeof details === "object" ? details : {}), ...(input ? { input } : {}), ...(limit ? { limit } : {}) };
}

export function errorHeaders(error: unknown): Record<string, string> {
  const { retryAfter: after, state } = (error ?? {}) as { retryAfter?: unknown; state?: { limit?: unknown; remaining?: unknown; reset?: unknown } };
  const headers: Record<string, string> = typeof after === "number" && Number.isFinite(after) ? { "Retry-After": String(Math.max(1, Math.ceil(after))) }
    : databaseRetryable(error) ? { "Retry-After": "1" } : {};
  if (typeof state?.limit === "number" && typeof state.remaining === "number" && typeof state.reset === "number") {
    Object.assign(headers, { "X-RateLimit-Limit": String(state.limit), "X-RateLimit-Remaining": String(state.remaining), "X-RateLimit-Reset": String(state.reset) });
  }
  return headers;
}