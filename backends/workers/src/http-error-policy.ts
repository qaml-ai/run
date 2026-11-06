// Generated from src/http.ts; only infrastructure imports are adapted.
// Run node backends/workers/scripts/reuse-http.mjs --check to reject source drift.
import { databaseRetryable, databaseUnavailable } from "./postgres-policy.ts";

export function errorFields(error: unknown): Record<string, unknown> {
  const { details, input, limit } = (error ?? {}) as { details?: Record<string, unknown>; input?: unknown; limit?: unknown };
  return { ...(details && typeof details === "object" ? details : {}), ...(input ? { input } : {}), ...(limit ? { limit } : {}) };
}

const STATUS_CODES: Record<number, string> = {
  400: "INVALID_REQUEST", 401: "UNAUTHORIZED", 402: "PAYMENT_REQUIRED", 403: "FORBIDDEN", 404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED",
  409: "CONFLICT", 410: "GONE", 412: "PRECONDITION_FAILED", 413: "TOO_LARGE", 415: "UNSUPPORTED_MEDIA_TYPE", 429: "RATE_LIMITED",
  500: "INTERNAL", 502: "UPSTREAM_ERROR", 503: "UNAVAILABLE", 504: "TIMEOUT",
};

export function errorCode(error: unknown, status: number): string {
  const own = (error as { code?: unknown } | undefined)?.code;
  if (typeof own === "string" && /^[A-Z][A-Z0-9_]+$/.test(own)) return own;
  if (databaseRetryable(error)) return "DATABASE_RETRY";
  const opening = /^([A-Z][A-Z0-9_]{2,}):/.exec((error as Error | undefined)?.message ?? "")?.[1];
  return opening ?? STATUS_CODES[status] ?? (status >= 500 ? "INTERNAL" : "INVALID_REQUEST");
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

export function errorStatus(error: unknown, fallback: number): number {
  const status = (error as { status?: unknown } | undefined)?.status;
  if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) return status;
  return databaseUnavailable(error) || databaseRetryable(error) ? 503 : fallback;
}
