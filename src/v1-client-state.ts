import { createHash } from "node:crypto";
import type { RequestRecord } from "../shared/client-protocol.ts";

/** `resume` continues a turn that waited on human input; the runtime makes it when the last input settles. */
export const RUN_METHODS = ["prompt", "execute", "continue", "resume"];
export const REQUEST_METHODS = [...RUN_METHODS, "status", "abort", "steer", "configure"];

export const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value);

/**
 * Whether an agent is busy, from its request records alone: the one source every view of it (GET /v1/agents/{id}, its
 * state, a `status` request) reads, so they never disagree. Busy while any run is open, running or queued; `activeRun`
 * is the run that has begun, and `queuedRuns` how many wait behind it.
 */
export function activityOf(records: Iterable<RequestRecord>) {
  let activeRun: string | null = null, queuedRuns = 0;
  for (const record of records) {
    if (record.state !== "running" || !RUN_METHODS.includes(record.method)) continue;
    if (record.began) activeRun = record.id; else queuedRuns++;
  }
  return { busy: activeRun !== null || queuedRuns > 0, activeRun, queuedRuns };
}

/** Never-expiring agents have `expiresAt: null`; a bare `<=` would treat null as 0, long expired. */
export const expired = (expiresAt: number | null, now = Date.now()) => expiresAt !== null && expiresAt <= now;
