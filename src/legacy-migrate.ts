import type { Db } from "./db.ts";
import { FULL_HISTORY_READ_BYTES } from "./history-pages.ts";
import { LEGACY_COVERAGE_GATE, legacyBatch, type LegacyLogLister } from "./legacy-coverage.ts";
import type { LegacyConversion, LegacyKind } from "./pi-durable/legacy-migrate.ts";

/**
 * Convert every agent legacy coverage finds (src/legacy-coverage.ts, its gate's buckets) to the current history format,
 * with the legacy readers one last time (pi-durable/legacy-migrate.ts), so the gate reads 0 and the readers can go.
 * The platform operator's (POST /v1/operations/legacy-migrate).
 *
 * It walks agents in id order as coverage does, a batch at a time (read-only, statement timeouts), and converts the
 * agents of the batch that coverage would count, one at a time (`migrate`: ClientSessions.migrateLegacy), each with
 * a result code. A call walks for a time budget and answers a cursor to go on from, which carries the counts and the
 * mode: a dry run's cursor goes on as a dry run. A dry run (the default) writes nothing.
 */
export const LEGACY_AGENT_CODES = [
  /** Converted (`kind` says from what), or, in a dry run, would be. */
  "migrated", "would_migrate",
  /** Nothing to convert: its history is current already, or it has none. */
  "current",
  /** Held by a node (loaded, loading, or claimed by a live node), or with runs open or queued: left for a later call. */
  "skipped_hosted", "skipped_busy",
  /** Deleted, revoked or purged since the batch read it. */
  "skipped_gone",
  /** Its stored history is past `maxBytes`: not read. */
  "too_large",
  /** The converter could not tell what its history is, or it is not whole (`error` says why): left as it is, for a person. */
  "review",
  /** Converting failed (`error`); a later call tries again. */
  "failed",
] as const;
export type LegacyAgentCode = typeof LEGACY_AGENT_CODES[number];
export type LegacyAgentResult = { agent: string; code: LegacyAgentCode; bytes?: number; error?: string } & Partial<LegacyConversion>;

/** The most stored bytes an agent's conversion reads by default, and at most (the history index's full-read bound). */
export const LEGACY_MIGRATE_DEFAULT_BYTES = 16 * 1024 * 1024;
export const LEGACY_MIGRATE_MAX_BYTES = FULL_HISTORY_READ_BYTES;
/** Agents per batch read; only those coverage counts are converted. */
export const LEGACY_MIGRATE_BATCH = 500;
export const LEGACY_MIGRATE_BUDGET_MS = 20_000;
const MAX_BUDGET_MS = 25_000;
/** Results a call answers at most (agents with `current` are counted, not listed). */
export const LEGACY_MIGRATE_RESULTS = 500;

export interface LegacyMigration {
  complete: boolean;
  next: string | null;
  dryRun: boolean;
  maxBytes: number;
  /** The walk's results so far, by code, and the conversions (or would-be ones) by kind. */
  counts: Record<LegacyAgentCode, number>;
  kinds: Partial<Record<LegacyKind, number>>;
  /** This call's results, but `current`, up to LEGACY_MIGRATE_RESULTS. */
  results: LegacyAgentResult[];
  generatedAt: string;
  durationMs: number;
  totalDurationMs: number;
  calls: number;
}

interface State { v: 1; after: string; dryRun: boolean; maxBytes: number; counts: Record<LegacyAgentCode, number>; kinds: Partial<Record<LegacyKind, number>>; started: number; spent: number; calls: number }
export class LegacyMigrateCursorError extends Error {}

const encode = (state: State) => Buffer.from(JSON.stringify(state)).toString("base64url");
function decode(cursor: string): State {
  let state: State;
  try { state = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { throw new LegacyMigrateCursorError("cursor is not one this endpoint gave"); }
  const ok = state && state.v === 1 && typeof state.after === "string" && typeof state.dryRun === "boolean" && Number.isSafeInteger(state.maxBytes)
    && Number.isFinite(state.started) && Number.isFinite(state.spent) && Number.isInteger(state.calls)
    && state.counts && LEGACY_AGENT_CODES.every(code => Number.isInteger(state.counts[code])) && state.kinds && typeof state.kinds === "object";
  if (!ok) throw new LegacyMigrateCursorError("cursor is not one this endpoint gave");
  return state;
}

/**
 * Walk from `cursor` (or the start) for `budgetMs`: each batch's agents in a gate bucket are converted (`migrate`), in
 * id order. A call stopped by its budget inside a batch goes on, next time, after the last agent it took.
 */
export async function legacyMigrate(db: Db, options: {
  cursor?: string; dryRun?: boolean; maxBytes?: number; budgetMs?: number; batch?: number; statementTimeoutMs?: number; now?: () => number;
  lister: LegacyLogLister;
  migrate(agent: string, options: { dryRun: boolean; maxBytes: number }): Promise<LegacyAgentResult>;
}): Promise<LegacyMigration> {
  const now = options.now ?? Date.now, started = now();
  const budget = Math.min(MAX_BUDGET_MS, Math.max(1, options.budgetMs ?? LEGACY_MIGRATE_BUDGET_MS));
  const dryRun = options.dryRun ?? true;
  const maxBytes = Math.min(LEGACY_MIGRATE_MAX_BYTES, Math.max(1, options.maxBytes ?? LEGACY_MIGRATE_DEFAULT_BYTES));
  const state: State = options.cursor ? decode(options.cursor)
    : { v: 1, after: "", dryRun, maxBytes, counts: Object.fromEntries(LEGACY_AGENT_CODES.map(code => [code, 0])) as State["counts"], kinds: {}, started, spent: 0, calls: 0 };
  if (state.dryRun !== dryRun) throw new LegacyMigrateCursorError(`this cursor is a ${state.dryRun ? "dry run's" : "migration's"}; call with dryRun ${state.dryRun}`);
  if (options.maxBytes !== undefined) state.maxBytes = maxBytes;
  const results: LegacyAgentResult[] = [];
  const size = options.batch ?? LEGACY_MIGRATE_BATCH;
  let complete = false, stopped = false;
  // At least one agent per call, so every call moves the walk on.
  while (!complete && !stopped) {
    const batch = await legacyBatch(db, state.after, size, { lister: options.lister, ...(options.statementTimeoutMs ? { statementTimeoutMs: options.statementTimeoutMs } : {}) });
    const flagged = new Set(LEGACY_COVERAGE_GATE.flatMap(name => batch.buckets[name]));
    for (const [index, agent] of batch.agents.entries()) {
      if (flagged.has(agent)) {
        const result = await options.migrate(agent, { dryRun, maxBytes: state.maxBytes });
        state.counts[result.code]++;
        if (result.kind && (result.code === "migrated" || result.code === "would_migrate")) state.kinds[result.kind] = (state.kinds[result.kind] ?? 0) + 1;
        if (result.code !== "current" && results.length < LEGACY_MIGRATE_RESULTS) results.push(result);
      }
      state.after = agent;
      if (flagged.has(agent) && index < batch.agents.length - 1 && now() - started >= budget) { stopped = true; break; }
    }
    if (stopped) break;
    if (batch.agents.length < size) complete = true;
    else if (now() - started >= budget) stopped = true;
  }
  const durationMs = now() - started;
  state.spent += durationMs;
  state.calls++;
  return {
    complete, next: complete ? null : encode(state), dryRun, maxBytes: state.maxBytes, counts: state.counts, kinds: state.kinds, results,
    generatedAt: new Date(state.started).toISOString(), durationMs, totalDurationMs: state.spent, calls: state.calls,
  };
}
