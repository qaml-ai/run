// Generated from src/identity.ts + end-user-credits.ts + client-sessions/spend.ts; only host imports are replaced.
// Run node backends/workers/scripts/reuse-security.mjs --check to check source drift.
import { HttpError } from "./errors.ts";

export type AgentIdentity = { subject?: string; context?: Record<string, unknown> };

export function identityInput(params: { subject?: unknown; context?: unknown }): AgentIdentity | undefined {
  const { subject, context } = params;
  if (subject === undefined && context === undefined) return undefined;
  if (subject !== undefined && (typeof subject !== "string" || !subject.trim() || subject.length > 200)) throw new HttpError(400, "subject must be a string of 1–200 characters");
  if (context !== undefined) {
    if (!context || typeof context !== "object" || Array.isArray(context)) throw new HttpError(400, "context must be an object");
    if (Buffer.byteLength(JSON.stringify(context)) > 4096) throw new HttpError(400, "context must be at most 4 KB of JSON");
  }
  return { ...(subject !== undefined ? { subject: subject as string } : {}), ...(context !== undefined ? { context: context as Record<string, unknown> } : {}) };
}

export function actorInput(actor: unknown): string | undefined {
  if (actor === undefined) return undefined;
  if (typeof actor !== "string" || !actor.trim() || actor.length > 200) throw new HttpError(400, "actor must be a string of 1–200 characters");
  return actor;
}

const BUCKET_NAME = /^[A-Za-z0-9_.:@/-]{1,100}$/;

export function bucketInput(value: unknown, what = "bucket"): string {
  if (typeof value !== "string" || !BUCKET_NAME.test(value)) throw new HttpError(400, `${what} must be 1–100 characters of letters, digits and _ . : @ / -`);
  return value;
}

export function spendInput(value: unknown): number | null {
  if (value === null) return null;
  const usd = (value as { usd?: unknown } | undefined)?.usd;
  if (!value || typeof value !== "object" || Object.keys(value).some(key => key !== "usd") || typeof usd !== "number" || !Number.isFinite(usd) || usd < 0 || usd > 1_000_000) {
    throw new HttpError(400, "spendLimit must be {usd} with usd a number from 0 to 1000000, or null");
  }
  return usd;
}