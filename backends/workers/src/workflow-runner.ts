// The workflow runner (docs/design/swarm-workflows.md, Part 1; docs/design/workflow-step-snapshots.md): the journal,
// the step driver, revisions, the budget ledger and the one alarm, over the SQLite of the object that owns a workflow
// (WorkflowObject, workflow-object.ts). Effects run behind `EffectExecutor`.
//
// A step:
// 1. takes the results that landed since the last step (in landing order) as this step's batch;
// 2. asks the sandbox (exchange protocol 3) to restore the VM from its snapshot, or without one to start it again from
//    the revision's table and replay the revision's earlier batches, and to apply the batch and run the script until
//    it waits again;
// 3. checks the effects the script issued against the journal (a replay must issue the revision's effects in order;
//    a new effect must be new);
// 4. commits, in one transaction: the batch as delivered, the new effects as `pending`, the logs, the new snapshot
//    (or none past the cap) and the workflow's state;
// 5. only then starts effects. A crash before 4 leaves nothing: the step runs again from the same snapshot with the
//    same batch. A crash between 4 and 5 leaves `pending` rows not marked started, which `wake()` or the alarm's sweep
//    starts; the executor dedupes a start by `key:attempt`.
//
// A workflow is not edited (docs/design/workflow-simplification.md): to change one, its owner aborts it and starts a new
// one, and finished agent()/job() results with the same arguments come from the owner's result cache (`ResultCache`,
// workflow-results.ts) instead of running again.
import type { IssuedEffect, WorkflowBatch, WorkflowFaultCode, WorkflowSandbox, WorkflowStepOutcome, WorkflowStepRequest } from "../codemode/workflow-protocol.ts";
import { WORKFLOW_STEP_PROTOCOL } from "../codemode/workflow-protocol.ts";

/**
 * The runner's own version, on every journal row it writes (a runner rolled back past a row's version faults) and on
 * `workflow_state`, where a workflow from an older runner that has not ended is ended once (`upgrade`). 2: gate(),
 * sleep() and phase() were removed, and so was live editing (docs/design/workflow-simplification.md).
 */
export const WORKFLOW_RUNNER_VERSION = 2;
export const WORKFLOW_LIMITS = Object.freeze({
  /** DO SQLite caps a value at 2 MB; snapshots are stored in rows of at most this. */
  snapshotChunkBytes: 1024 * 1024,
  /** A gzipped snapshot over this is not kept: the next step replays from the journal. */
  snapshotCapBytes: 8 * 1024 * 1024,
  /** A result the guest gets inline, as JSON; a larger one must be a handle (`EffectOutcome.handle`). */
  inlineResultBytes: 8 * 1024,
  /** Effects one workflow may journal in phase 1 (design: 2,000 until 10,000 is measured to fit). */
  effects: 2_000,
  /** The step-rate guard: steps in any hour, past which steps wait for the window to move. */
  stepsPerHour: 5_000,
  /** How often the alarm asks the executor after effects that have not landed. */
  sweepMs: 5 * 60_000,
  /** Agents running at once: by default, and at most. */
  concurrency: 8, maxConcurrency: 64,
  /** Jobs (`job()`, `push()`) running at once: by default, and at most (the capacity limiter bounds it by the tenant's too). */
  jobConcurrency: 8, maxJobConcurrency: 64,
  /** A workflow paused for its payer's credit tries again on its own: first after this long, doubling to `payerRetryMaxMs`. */
  payerRetryMs: 5 * 60_000, payerRetryMaxMs: 30 * 60_000,
  /** A payer that stays without credit this long ends the workflow (`payer_gave_up`) instead of being tried forever. */
  payerGiveUpMs: 7 * 86_400_000,
  /** A workflow paused for the tenant's running-workflows limit tries to open again this often. */
  capacityRetryMs: 60_000,
  /** The newest events and log lines a workflow keeps, and one log line's length. */
  keptEvents: 10_000, keptLogs: 10_000, logChars: 4_096,
});

export interface StartedEffect { key: string; attempt: number; kind: string; args: unknown }

/**
 * Runs `agent`, `job`, `commit` and `push` effects. Results come back through `WorkflowRunner.land()`.
 * The real agent executor is the delegation path with the workflow as the child's owner; it comes with the owner model.
 */
export interface EffectExecutor {
  /**
   * Start `effect`. Called after its row is committed, and possibly again for the same `key:attempt` after a restart:
   * a second start of one already started must not start it twice.
   */
  start(effect: StartedEffect): Promise<void>;
  /** Stop a started effect that has not landed (abort, or a pause that stops children). */
  cancel?(effect: StartedEffect): Promise<void>;
  /** The sweep asks after a started effect that has not landed: its outcome if it ended, else undefined. */
  poll?(effect: StartedEffect): Promise<{ outcome: EffectOutcome; usage?: EffectUsage } | undefined>;
  /** On every wake (a restart, an alarm): pick up what the executor itself left half done. */
  recover?(): Promise<void>;
  /** The workflow was aborted: stop everything it started (after `cancel` for each running effect). */
  abort?(): Promise<void>;
}

export type EffectOutcome =
  | { ok: true; value: unknown }
  /** A result body kept elsewhere; the guest gets `{ $handle: ref, bytes, sha256 }`. */
  | { ok: true; handle: { ref: string; bytes: number; sha256: string } }
  /** Failed: the script gets `null`, and the item records why. */
  | { ok: false; error: string }
  /**
   * Refused (a 402, a tenant cap, the child's share of the budget): not a failure, and never shown to the script. The
   * workflow pauses with `code` (`payer_exhausted` by default, or `budget_exhausted`); resume re-issues the effect.
   */
  | { refused: string; code?: "payer_exhausted" | "budget_exhausted"; spent?: number };

/** One effect's cost, for the ledger. */
export interface EffectUsage { costUsd: number; model?: string; inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; durationMs?: number }

export interface WorkflowStorage {
  sql: SqlStorage;
  transactionSync<T>(fn: () => T): T;
}

export type WorkflowStatus = "running" | "paused" | "completed" | "failed" | "aborted" | "budget_exhausted";
/** Why a workflow is paused. A script's fault is not a pause: it ends the workflow (`fault`). */
export type PauseReason = "user" | "payer_exhausted" | "capacity_refused";
/** Pauses that go on by themselves (`resume_at`, the alarm): the payer's credit and the account's workflow limit. */
const SELF_RESUMING = new Set<string>(["payer_exhausted", "capacity_refused"]);
const TERMINAL = new Set<WorkflowStatus>(["completed", "failed", "aborted"]);

export interface WorkflowSummary {
  tenant?: string;
  status: WorkflowStatus;
  pauseReason?: PauseReason;
  step: number;
  result?: unknown;
  error?: string;
  fault?: { code: WorkflowFaultCode; message: string };
  budget: { usd: number | null };
  concurrency: number;
  jobConcurrency: number;
  spent: { usd: number; calls: number; inputTokens: number; cachedInputTokens: number; outputTokens: number };
  counts: Record<string, number>;
  throttledUntil?: number;
  createdAt: number;
  updatedAt: number;
}

/** What `init` creates a workflow with. `seed` and `startedAt` fix its `random()` and its clock's start. */
export interface WorkflowInit {
  code: string; seed: number; startedAt: number; budgetUsd?: number | null; concurrency?: number; jobConcurrency?: number;
  /** Who the workflow belongs to, fixed at create: it bills `tenant` (in `bucket`), attributed to `endUser`. */
  tenant?: string; bucket?: string; endUser?: string;
}

/** A sandbox stub without a `step` method is a sandbox Worker from before protocol 3. */
export function stepUnsupported(error: unknown) {
  return error instanceof Error && /\bstep\b/.test(error.message) && /(not a function|does not (implement|have)|no such method|undefined)/i.test(error.message);
}

/** A caller's mistake (an unknown key, a bad state), as opposed to a failure of the runner. */
export class WorkflowError extends Error {
  readonly status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}

/**
 * A `WorkflowError` as the workflow object's RPC methods answer it: a value, not a throw, so a caller's mistake (an
 * ended workflow aborted, an unknown workflow read) is not logged as the object's uncaught error. `refusedOf` turns it
 * back into the `WorkflowError` on the caller's side.
 */
export type WorkflowRefusal = { refused: { error: string; status: number } };
export async function refusable<T>(run: () => T | Promise<T>): Promise<T | WorkflowRefusal> {
  try { return await run(); }
  catch (error) { if (error instanceof WorkflowError) return { refused: { error: error.message, status: error.status } }; throw error; }
}
export function refusedOf<T>(value: T | WorkflowRefusal): T {
  if (value && typeof value === "object" && "refused" in value && value.refused && typeof value.refused === "object") throw new WorkflowError(value.refused.error, value.refused.status);
  return value as T;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS workflow_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), seed INTEGER NOT NULL, started_at INTEGER NOT NULL,
    status TEXT NOT NULL, pause_reason TEXT, revision INTEGER NOT NULL, step INTEGER NOT NULL, phase TEXT,
    result TEXT, error TEXT, fault_code TEXT, budget_usd REAL, concurrency INTEGER NOT NULL, job_concurrency INTEGER,
    throttled_until INTEGER, swept_at INTEGER, tenant TEXT, bucket TEXT, end_user TEXT, capacity_open INTEGER NOT NULL DEFAULT 0, renewed_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL, code TEXT, resume_at INTEGER, resume_tries INTEGER NOT NULL DEFAULT 0, payer_since INTEGER)`,
  // `phase`, `options` and `due_at` are no longer written (gate(), sleep() and phase() were removed); a contract
  // migration drops them. key/attempt is an effect's identity; `current` marks the attempt that counts. `ord` is the order rows were
  // journaled in; a replay reproduces the order of a revision's `script` rows. `landed` orders results into batches;
  // `delivered_step` is the step whose batch held the result (0: a revision's table took it).
  `CREATE TABLE IF NOT EXISTS workflow_effects (
    key TEXT NOT NULL, attempt INTEGER NOT NULL, current INTEGER NOT NULL, ord INTEGER NOT NULL UNIQUE, origin TEXT NOT NULL,
    revision INTEGER NOT NULL, kind TEXT NOT NULL, args TEXT NOT NULL, options TEXT, phase TEXT, status TEXT NOT NULL,
    started INTEGER NOT NULL DEFAULT 0, started_at INTEGER, due_at INTEGER, lease TEXT, cancel_sent INTEGER NOT NULL DEFAULT 0, cancel_attempts INTEGER NOT NULL DEFAULT 0, cancel_next_at INTEGER, start_failures INTEGER NOT NULL DEFAULT 0, ok INTEGER, result TEXT, reason TEXT, landed INTEGER UNIQUE,
    issued_step INTEGER NOT NULL, delivered_step INTEGER, seen_revision INTEGER NOT NULL, issued_at INTEGER NOT NULL, ended_at INTEGER,
    version INTEGER NOT NULL, cached_from TEXT, cache_key TEXT, PRIMARY KEY (key, attempt))`,
  `CREATE INDEX IF NOT EXISTS workflow_effects_current ON workflow_effects (current, status, kind)`,
  `CREATE INDEX IF NOT EXISTS workflow_effects_landed ON workflow_effects (delivered_step, landed)`,
  `CREATE INDEX IF NOT EXISTS workflow_effects_step ON workflow_effects (issued_step, ord)`,
  `CREATE TABLE IF NOT EXISTS workflow_steps (
    step INTEGER PRIMARY KEY, revision INTEGER NOT NULL, at INTEGER NOT NULL, results INTEGER NOT NULL, issued INTEGER NOT NULL,
    replayed INTEGER NOT NULL, polls INTEGER NOT NULL, snapshot_bytes INTEGER NOT NULL, ms REAL NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS workflow_steps_at ON workflow_steps (at)`,
  `CREATE TABLE IF NOT EXISTS workflow_snapshot (
    id INTEGER PRIMARY KEY CHECK (id = 1), step INTEGER NOT NULL, revision INTEGER NOT NULL, fingerprint TEXT NOT NULL, bytes INTEGER NOT NULL, chunks INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS workflow_snapshot_chunks (chunk INTEGER PRIMARY KEY, data BLOB NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS workflow_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, step INTEGER NOT NULL, phase TEXT, text TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS workflow_ledger (
    key TEXT NOT NULL, attempt INTEGER NOT NULL, cost_usd REAL NOT NULL, model TEXT, input_tokens INTEGER NOT NULL, cached_input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL, duration_ms INTEGER, at INTEGER NOT NULL, PRIMARY KEY (key, attempt))`,
  `CREATE TABLE IF NOT EXISTS workflow_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, type TEXT NOT NULL, data TEXT)`,
];

type Row = Record<string, SqlStorageValue>;
const bytesOf = (value: SqlStorageValue) => value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
const text = (value: SqlStorageValue) => value === null || value === undefined ? undefined : String(value);
const EXECUTED = new Set(["agent", "job", "commit", "push"]);
/** The executed kinds as an SQL list: every one is swept, and keeps the sweep's alarm armed, until it lands. */
const EXECUTED_SQL = [...EXECUTED].map(kind => `'${kind}'`).join(", ");
/** The effects that hold a capacity slot while they run, and which kind: an agent a child's, a job or push a job's. */
const SLOTTED: Record<string, "child" | "job"> = { agent: "child", job: "job", push: "job" };
export const slotKind = (kind: string) => SLOTTED[kind];
/** Executed effects that ended without landing whose work has not been told to stop yet. */
const UNCANCELLED = "status IN ('cancelled', 'aborted') AND started = 1 AND cancel_sent = 0 AND kind IN ('agent', 'job', 'push')";
/** A cancel that keeps failing is tried this many times, a minute apart and doubling to an hour, then given up. */
const CANCEL_ATTEMPTS = 8, CANCEL_FIRST_RETRY_MS = 60_000, CANCEL_MAX_RETRY_MS = 3_600_000;

/**
 * The tenant's capacity limiter (WorkflowCapacity), as the runner uses it: one slot per running agent, leased and
 * renewed. Opened at the first step, renewed on the alarm from open to close whether or not slots are held, released
 * as effects end, closed when the workflow ends. A slot granted later arrives through `capacityGranted` (or the next
 * renew's `held`), and the effect it was for then starts.
 */
export interface CapacitySeam {
  leaseMs: number;
  open(concurrency: number, jobConcurrency: number): Promise<{ ok: true } | { ok: false; message: string }>;
  acquire(key: string, kind: "child" | "job"): Promise<{ granted: true; lease: string } | { granted: false }>;
  release(lease: string): Promise<void>;
  /** The leases held (grants whose wake was missed among them), or a refusal: the limiter dropped this workflow. */
  renew(): Promise<{ ok: true; held: { key: string; lease: string; kind: "child" | "job" }[] } | { ok: false; message: string }>;
  close(): Promise<void>;
}

/**
 * The owner's result cache (workflow-results.ts, docs/design/workflow-simplification.md "Cut 1"): a finished agent() or
 * job() result keyed by its kind and arguments, reused by a later workflow of the same owner instead of running again.
 * Storage failures throw so an unlanded effect can retry.
 */
export interface ResultCache {
  /**
   * The cache key of an effect of `kind` with canonical `args` as it is about to start (for one that reads files,
   * with the source's version now), and the result stored under it, if any. The key is kept on the effect: its result
   * is offered under the key it was looked up with, never one made after it ran, so a result is only ever found again
   * on the version it could have read (the version is part of the key).
   */
  lookup(kind: string, args: string, effect: { key: string; attempt: number }): Promise<{ key: string; hit?: { value: unknown; source: string } }>;
  /** Retain a cacheable result before journaling its landing and cleaning up its source branch. */
  landed(effect: { key: string; attempt: number; kind: string; args: string; value: unknown; cacheKey: string }): void | Promise<void>;
}
/** Kinds whose `ok` results are reused (`commit`, `push` change a repo or a branch: effects, not results). */
const CACHEABLE = new Set(["agent", "job"]);
/** Whether an effect's result may come from, or go to, the cache: an agent or job that did not opt out (`nocache: true`). */
export function cacheable(kind: string, args: string) {
  if (!CACHEABLE.has(kind)) return false;
  try { return (JSON.parse(args) as { nocache?: unknown } | null)?.nocache !== true; } catch { return false; }
}

export interface RunnerOptions {
  capacity?: CapacitySeam;
  results?: ResultCache;
  snapshotCap?: number;
  now?: () => number;
  /** The object's one alarm: `set(at)` arms it, `set(null)` clears it. */
  alarm?: { set(at: number | null): void | Promise<void> };
  /**
   * A status was written, inside the transaction that wrote it (synchronous; it must not await): the object stages what
   * the owner hears of it there, so the status and its ending commit together (workflow-endings.ts).
   */
  onStatus?(status: WorkflowStatus): void;
}

export class WorkflowRunner {
  private readonly sql: SqlStorage;
  private readonly storage: WorkflowStorage;
  private readonly sandbox: WorkflowSandbox;
  private readonly executor: EffectExecutor;
  private readonly options: RunnerOptions;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(storage: WorkflowStorage, sandbox: WorkflowSandbox, executor: EffectExecutor, options: RunnerOptions = {}) {
    this.storage = storage;
    this.sandbox = sandbox;
    this.executor = executor;
    this.options = options;
    this.sql = storage.sql;
    for (const statement of SCHEMA) this.sql.exec(statement);
    // A workflow made before jobs had no job_concurrency (null reads as the default).
    if (!this.sql.exec("SELECT 1 FROM pragma_table_info('workflow_state') WHERE name = 'job_concurrency'").toArray().length)
      this.sql.exec("ALTER TABLE workflow_state ADD COLUMN job_concurrency INTEGER");
    // A workflow made before cancels were retried with backoff had neither column (no attempts yet, none scheduled).
    for (const [column, type] of [["cancel_attempts", "INTEGER NOT NULL DEFAULT 0"], ["cancel_next_at", "INTEGER"], ["cached_from", "TEXT"], ["cache_key", "TEXT"]] as const)
      if (!this.sql.exec("SELECT 1 FROM pragma_table_info('workflow_effects') WHERE name = ?", column).toArray().length)
        this.sql.exec(`ALTER TABLE workflow_effects ADD COLUMN ${column} ${type}`);
    // The script on the state row, and the self-resume of a paused workflow (a workflow from before these columns is
    // ended by the version upgrade on its first touch).
    for (const [column, type] of [["code", "TEXT"], ["resume_at", "INTEGER"], ["resume_tries", "INTEGER NOT NULL DEFAULT 0"], ["payer_since", "INTEGER"]] as const)
      if (!this.sql.exec("SELECT 1 FROM pragma_table_info('workflow_state') WHERE name = ?", column).toArray().length)
        this.sql.exec(`ALTER TABLE workflow_state ADD COLUMN ${column} ${type}`);
  }

  private now() { return (this.options.now ?? Date.now)(); }

  /** Create the workflow unless it exists; its first step runs on `wake()`. */
  init(workflow: WorkflowInit) {
    const concurrency = workflow.concurrency ?? WORKFLOW_LIMITS.concurrency;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > WORKFLOW_LIMITS.maxConcurrency)
      throw new WorkflowError(`concurrency must be an integer from 1 to ${WORKFLOW_LIMITS.maxConcurrency}`, 400);
    const jobConcurrency = workflow.jobConcurrency ?? WORKFLOW_LIMITS.jobConcurrency;
    if (!Number.isInteger(jobConcurrency) || jobConcurrency < 1 || jobConcurrency > WORKFLOW_LIMITS.maxJobConcurrency)
      throw new WorkflowError(`jobConcurrency must be an integer from 1 to ${WORKFLOW_LIMITS.maxJobConcurrency}`, 400);
    if (workflow.budgetUsd !== undefined && workflow.budgetUsd !== null && !(workflow.budgetUsd >= 0)) throw new WorkflowError("budgetUsd must be at least 0", 400);
    if (typeof workflow.code !== "string" || !workflow.code.trim()) throw new WorkflowError("A workflow needs a script", 400);
    const at = this.now();
    this.storage.transactionSync(() => {
      if (this.sql.exec("SELECT 1 FROM workflow_state WHERE id = 1").toArray().length) return;
      this.sql.exec(
        `INSERT INTO workflow_state (id, seed, started_at, status, revision, step, budget_usd, concurrency, job_concurrency, tenant, bucket, end_user, created_at, updated_at, version, code)
         VALUES (1, ?, ?, 'running', 1, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        workflow.seed >>> 0, workflow.startedAt, workflow.budgetUsd ?? null, concurrency, jobConcurrency, workflow.tenant ?? null, workflow.bucket ?? null, workflow.endUser ?? null, at, at, WORKFLOW_RUNNER_VERSION, workflow.code,
      );
      this.event("created", { concurrency, jobConcurrency, budgetUsd: workflow.budgetUsd ?? null });
    });
  }

  private state() {
    const row = this.sql.exec("SELECT * FROM workflow_state WHERE id = 1").toArray()[0];
    if (!row) throw new WorkflowError("No workflow", 404);
    return row;
  }

  get(): WorkflowSummary {
    const row = this.state();
    const spent = this.sql.exec(
      "SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(cached_input_tokens), 0) AS cached, COALESCE(SUM(output_tokens), 0) AS output FROM workflow_ledger",
    ).one();
    const counts: Record<string, number> = {};
    for (const count of this.sql.exec("SELECT status, started, COUNT(*) AS n FROM workflow_effects WHERE current = 1 GROUP BY status, started")) {
      const name = count.status === "pending" ? (count.started ? "running" : "pending") : count.status as string;
      counts[name] = (counts[name] ?? 0) + Number(count.n);
    }
    // Of the finished, how many came from the owner's result cache (no run, no cost).
    const cached = Number(this.sql.exec("SELECT COUNT(*) AS n FROM workflow_effects WHERE current = 1 AND cached_from IS NOT NULL").one().n);
    if (cached) counts.cached = cached;
    const summary: WorkflowSummary = {
      status: row.status as WorkflowStatus, step: Number(row.step),
      budget: { usd: row.budget_usd === null ? null : Number(row.budget_usd) }, concurrency: Number(row.concurrency), jobConcurrency: Number(row.job_concurrency ?? WORKFLOW_LIMITS.jobConcurrency),
      spent: { usd: Number(spent.usd), calls: Number(spent.calls), inputTokens: Number(spent.input), cachedInputTokens: Number(spent.cached), outputTokens: Number(spent.output) },
      counts, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    };
    if (row.tenant !== null) summary.tenant = row.tenant as string;
    if (row.pause_reason !== null) summary.pauseReason = row.pause_reason as PauseReason;
    if (row.result !== null) summary.result = JSON.parse(row.result as string);
    if (row.fault_code !== null) summary.fault = { code: row.fault_code as WorkflowFaultCode, message: row.error as string };
    else if (row.error !== null) summary.error = row.error as string;
    if (row.throttled_until !== null && Number(row.throttled_until) > this.now()) summary.throttledUntil = Number(row.throttled_until);
    return summary;
  }

  /** The journal's effects (current attempts unless `attempts`), by journal order, a page at a time. */
  items(query: { after?: number; limit?: number; status?: string; kind?: string; attempts?: boolean } = {}) {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const where = ["e.ord > ?"], params: unknown[] = [query.after ?? 0];
    if (!query.attempts) where.push("e.current = 1");
    if (query.status === "running") where.push("e.status = 'pending' AND e.started = 1");
    else if (query.status === "pending") where.push("e.status = 'pending' AND e.started = 0");
    else if (query.status) { where.push("e.status = ?"); params.push(query.status); }
    if (query.kind) { where.push("e.kind = ?"); params.push(query.kind); }
    const rows = this.sql.exec(
      `SELECT e.*, l.cost_usd, l.model FROM workflow_effects e LEFT JOIN workflow_ledger l ON l.key = e.key AND l.attempt = e.attempt
       WHERE ${where.join(" AND ")} ORDER BY e.ord LIMIT ?`,
      ...params, limit + 1,
    ).toArray();
    const items = rows.slice(0, limit).map(row => ({
      key: row.key as string, attempt: Number(row.attempt), current: row.current === 1, kind: row.kind as string,
      // A result reused from the owner's cache says so, and where it came from (`workflow:key:attempt`).
      origin: row.cached_from === null || row.cached_from === undefined ? row.origin as string : "cache", ...(row.cached_from ? { cachedFrom: row.cached_from as string } : {}),
      status: row.status === "pending" && row.started === 1 ? "running" : row.status as string,
      args: JSON.parse(row.args as string),
      result: row.result === null ? undefined : JSON.parse(row.result as string), reason: text(row.reason),
      issuedAt: Number(row.issued_at), endedAt: row.ended_at === null ? undefined : Number(row.ended_at),
      costUsd: row.cost_usd === null ? undefined : Number(row.cost_usd), model: text(row.model), ord: Number(row.ord),
    }));
    return { items, next: rows.length > limit ? items.at(-1)!.ord : undefined };
  }

  events(query: { after?: number; limit?: number } = {}) {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const rows = this.sql.exec("SELECT seq, at, type, data FROM workflow_events WHERE seq > ? ORDER BY seq LIMIT ?", query.after ?? 0, limit).toArray();
    return rows.map(row => ({ seq: Number(row.seq), at: Number(row.at), type: row.type as string, data: row.data === null ? undefined : JSON.parse(row.data as string) }));
  }

  logs() {
    return this.sql.exec("SELECT step, text FROM workflow_log ORDER BY seq").toArray();
  }

  private event(type: string, data?: unknown) {
    this.sql.exec("INSERT INTO workflow_events (at, type, data) VALUES (?, ?, ?)", this.now(), type, data === undefined ? null : JSON.stringify(data));
    // The newest `keptEvents` stay; older ones go, a few at a time.
    this.sql.exec("DELETE FROM workflow_events WHERE seq <= (SELECT MAX(seq) FROM workflow_events) - ?", WORKFLOW_LIMITS.keptEvents);
  }

  private setStatus(status: WorkflowStatus, reason: PauseReason | null = null) {
    this.sql.exec("UPDATE workflow_state SET status = ?, pause_reason = ?, updated_at = ? WHERE id = 1", status, reason, this.now());
    // Paused for the payer's credit or the tenant's workflow limit: it tries again on its own (`alarm`), the payer's
    // later each time it is refused again, so nothing waits on a resume nobody may send.
    if (status === "paused" && reason !== null && SELF_RESUMING.has(reason)) {
      const tries = Number(this.sql.exec("SELECT resume_tries AS n FROM workflow_state WHERE id = 1").one().n);
      if (reason === "payer_exhausted") this.sql.exec("UPDATE workflow_state SET payer_since = COALESCE(payer_since, ?) WHERE id = 1", this.now());
      const delay = reason !== "payer_exhausted" ? WORKFLOW_LIMITS.capacityRetryMs : Math.min(WORKFLOW_LIMITS.payerRetryMaxMs, WORKFLOW_LIMITS.payerRetryMs * 2 ** tries);
      this.sql.exec("UPDATE workflow_state SET resume_at = ? WHERE id = 1", this.now() + delay);
    } else this.sql.exec("UPDATE workflow_state SET resume_at = NULL WHERE id = 1");
    this.options.onStatus?.(status);
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = async () => { await this.upgrade(); return work(); };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /**
   * A workflow from an older runner (WORKFLOW_RUNNER_VERSION 1, before gate(), sleep() and phase() were removed) that
   * has not ended ends failed with `runtime_upgraded` the first time it is touched, as fail() ends one. No workflow was
   * running at that deploy, so nothing older is carried forward.
   */
  private async upgrade() {
    const state = this.sql.exec("SELECT status, version FROM workflow_state WHERE id = 1").toArray()[0];
    if (!state || Number(state.version) >= WORKFLOW_RUNNER_VERSION) return;
    const ended = TERMINAL.has(state.status as WorkflowStatus);
    this.storage.transactionSync(() => {
      if (!ended) {
        const message = "This workflow was started on an older runtime: start the workflow again";
        this.sql.exec("UPDATE workflow_effects SET status = 'cancelled', reason = ?, ended_at = ? WHERE current = 1 AND status = 'pending'", message, this.now());
        this.dropSnapshot();
        this.sql.exec("UPDATE workflow_state SET error = ?, fault_code = 'runtime_upgraded' WHERE id = 1", message);
        this.setStatus("failed");
        this.event("failed", { code: "runtime_upgraded", error: message });
      }
      this.sql.exec("UPDATE workflow_state SET version = ? WHERE id = 1", WORKFLOW_RUNNER_VERSION);
    });
    if (ended) return;
    await this.cancelEnded();
    await this.executor.abort?.();
    await this.capacityHousekeeping();
    await this.arm();
  }

  /** After a start or a restart: start what was committed but not started, run due steps, arm the alarm. */
  wake(): Promise<void> {
    return this.serial(async () => { await this.advance(true); });
  }

  /** Who the workflow belongs to, as created. */
  identity() {
    const row = this.state();
    return { tenant: text(row.tenant), bucket: text(row.bucket), endUser: text(row.end_user) };
  }

  /** Returns whether something it tried failed and was left for later (a cancel). */
  private async advance(recover = false): Promise<boolean> {
    // The alarm comes no sooner than a second from now, thirty after a failure: a step that keeps failing on every
    // landing, or a child that will not cancel, is retried with backoff, not at once.
    const now = this.now();
    let failed = true;
    try {
      // An ended workflow has nothing to recover: its executor was aborted, and a recover would start children again.
      if (recover && !TERMINAL.has(this.state().status as WorkflowStatus)) await this.executor.recover?.();
      await this.capacityHousekeeping();
      // Effects held from before (a resume, a raised budget, a failed start, a slot granted) first; then each step's new ones.
      await this.startHeld();
      while (await this.step()) await this.startHeld();
      const uncancelled = await this.cancelEnded();
      await this.capacityHousekeeping();
      failed = uncancelled;
      return failed;
    } finally { await this.arm(now + (failed ? 30_000 : 1_000)); }
  }

  /** Effect `key:attempt` ended. A second landing, or one for a superseded attempt, is ignored. */
  land(key: string, attempt: number, outcome: EffectOutcome, usage?: EffectUsage): Promise<void> {
    return this.serial(async () => {
      await this.cacheLanding(key, attempt, outcome);
      this.record(key, attempt, outcome, usage);
      await this.advance();
    });
  }

  /**
   * Record effect `key:attempt`'s ending: its cost in the ledger and its outcome on the effect, in one transaction.
   * The ledger row is idempotent on `key:attempt` (a redelivered ending is charged once) and is written whatever the
   * effect's state: an ending that arrives after the workflow ended, or after the effect was cancelled or superseded,
   * is still charged; only its delivery to the script is skipped. A refusal's `spent` is its cost when no usage comes.
   */
  private record(key: string, attempt: number, outcome: EffectOutcome, usage?: EffectUsage) {
    const row = this.sql.exec("SELECT status, current, kind, args, cached_from, cache_key FROM workflow_effects WHERE key = ? AND attempt = ?", key, attempt).toArray()[0];
    if (!row) throw new WorkflowError(`Effect ${key}:${attempt} is not in the journal`, 404);
    const at = this.now();
    const cost = usage ?? ("refused" in outcome && outcome.spent !== undefined ? { costUsd: outcome.spent } : undefined);
    const charge = () => {
      if (!cost) return;
      this.sql.exec(
        "INSERT OR IGNORE INTO workflow_ledger (key, attempt, cost_usd, model, input_tokens, cached_input_tokens, output_tokens, duration_ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        key, attempt, cost.costUsd, cost.model ?? null, cost.inputTokens ?? 0, cost.cachedInputTokens ?? 0, cost.outputTokens ?? 0, cost.durationMs ?? null, at,
      );
    };
    let value: string | undefined;
    if ("ok" in outcome) {
      if (!outcome.ok) value = JSON.stringify({ message: outcome.error });
      else if ("handle" in outcome) value = JSON.stringify({ $handle: outcome.handle.ref, bytes: outcome.handle.bytes, sha256: outcome.handle.sha256 });
      else {
        value = JSON.stringify(outcome.value ?? null);
        const bytes = new TextEncoder().encode(value).byteLength;
        if (bytes > WORKFLOW_LIMITS.inlineResultBytes) {
          // The executor's mistake, refused loudly; what the child cost is still charged.
          this.storage.transactionSync(charge);
          throw new WorkflowError(`Effect ${key}'s result is ${bytes} bytes; over ${WORKFLOW_LIMITS.inlineResultBytes} it must be landed as a handle`, 400);
        }
      }
    }
    const delivered = this.storage.transactionSync(() => {
      charge();
      if (row.status !== "pending" || row.current !== 1) return false;
      if ("refused" in outcome) {
        this.sql.exec("UPDATE workflow_effects SET status = 'refused', reason = ?, ended_at = ? WHERE key = ? AND attempt = ?", outcome.refused, at, key, attempt);
        const status = this.state().status as WorkflowStatus, code = outcome.code ?? "payer_exhausted";
        if (status === "running") {
          if (code === "budget_exhausted") this.setStatus("budget_exhausted");
          else this.setStatus("paused", "payer_exhausted");
        }
        this.event(code, { key, attempt, reason: outcome.refused });
        return false;
      }
      this.sql.exec(
        "UPDATE workflow_effects SET status = ?, ok = ?, result = ?, reason = ?, ended_at = ?, landed = (SELECT COALESCE(MAX(landed), 0) + 1 FROM workflow_effects) WHERE key = ? AND attempt = ?",
        outcome.ok ? "done" : "failed", outcome.ok ? 1 : 0, value, outcome.ok ? null : (outcome as { error: string }).error, at, key, attempt,
      );
      // A run that got through after a payer's refusals (the probe goOn sent): its payer has credit again, so the
      // effects still refused follow it now.
      if (row.cached_from === null && this.state().payer_since !== null && this.state().status === "running") {
        this.sql.exec("UPDATE workflow_state SET payer_since = NULL WHERE id = 1");
        for (const refused of this.sql.exec("SELECT key FROM workflow_effects WHERE current = 1 AND status = 'refused' ORDER BY ord").toArray()) this.nextAttempt(refused.key as string, "reissue");
      }
      return true;
    });
  }

  private async cacheLanding(key: string, attempt: number, outcome: EffectOutcome) {
    const row = this.sql.exec("SELECT status, current, kind, args, cached_from, cache_key FROM workflow_effects WHERE key = ? AND attempt = ?", key, attempt).toArray()[0];
    if (row?.status === 'pending' && row.current === 1 && "ok" in outcome && outcome.ok && "value" in outcome && row.cached_from === null && typeof row.cache_key === "string" && cacheable(row.kind as string, row.args as string))
      await this.options.results?.landed({ key, attempt, kind: row.kind as string, args: row.args as string, value: outcome.value, cacheKey: row.cache_key });
  }

  /**
   * The capacity lease's life: open it before the first agent starts; give back the slots of effects that ended; close
   * it once the workflow has ended. An open the limiter refuses (too many running workflows) pauses the workflow.
   */
  private async capacityHousekeeping() {
    const capacity = this.options.capacity;
    if (!capacity) return;
    const state = this.state();
    if (state.capacity_open) {
      for (const row of this.sql.exec("SELECT key, attempt, lease FROM workflow_effects WHERE lease IS NOT NULL AND NOT (status = 'pending' AND current = 1)").toArray()) {
        await capacity.release(row.lease as string);
        this.sql.exec("UPDATE workflow_effects SET lease = NULL WHERE key = ? AND attempt = ?", row.key, row.attempt);
      }
      if (TERMINAL.has(state.status as WorkflowStatus)) {
        await capacity.close();
        this.sql.exec("UPDATE workflow_state SET capacity_open = 0, renewed_at = NULL WHERE id = 1");
      }
      return;
    }
    if (state.status !== "running") return;
    const opened = await capacity.open(Number(state.concurrency), Number(state.job_concurrency ?? WORKFLOW_LIMITS.jobConcurrency));
    this.storage.transactionSync(() => {
      if (opened.ok) this.sql.exec("UPDATE workflow_state SET capacity_open = 1, renewed_at = ? WHERE id = 1", this.now());
      else { this.setStatus("paused", "capacity_refused"); this.event("capacity_refused", { message: opened.message }); }
    });
  }

  /**
   * Stop the children of effects that ended without landing (the script ended, the workflow was aborted, a pause
   * stopped them). Marked in the journal first, stopped after the commit, once each, so a crash between the two
   * stops them on the next advance.
   */
  private async cancelEnded(): Promise<boolean> {
    let failed = false;
    const now = this.now();
    const due = this.sql.exec(`SELECT key, attempt, kind, args, cancel_attempts FROM workflow_effects WHERE ${UNCANCELLED} AND (cancel_next_at IS NULL OR cancel_next_at <= ?) ORDER BY ord`, now).toArray();
    for (const row of due) {
      try {
        await this.executor.cancel?.(this.started(row));
        this.sql.exec("UPDATE workflow_effects SET cancel_sent = 1, cancel_next_at = NULL WHERE key = ? AND attempt = ?", row.key, row.attempt);
      } catch (error) {
        // Tried again later, a minute apart and doubling to an hour, while the others go on; given up after
        // CANCEL_ATTEMPTS, recorded, so an ended workflow's alarm does not wake for it forever.
        failed = true;
        const message = error instanceof Error ? error.message : String(error);
        const attempts = Number(row.cancel_attempts) + 1;
        console.error(`Workflow effect ${row.key}:${row.attempt} was not cancelled (attempt ${attempts})`, error);
        this.storage.transactionSync(() => {
          if (attempts >= CANCEL_ATTEMPTS) {
            this.sql.exec("UPDATE workflow_effects SET cancel_sent = 1, cancel_attempts = ?, cancel_next_at = NULL, reason = ? WHERE key = ? AND attempt = ?",
              attempts, `cancel gave up after ${attempts} attempts: ${message}`, row.key, row.attempt);
            this.event("cancel_gave_up", { key: row.key, attempt: Number(row.attempt), attempts, error: message });
            return;
          }
          if (attempts === 1) this.event("cancel_failed", { key: row.key, attempt: Number(row.attempt), error: message });
          this.sql.exec("UPDATE workflow_effects SET cancel_attempts = ?, cancel_next_at = ?, reason = ? WHERE key = ? AND attempt = ?",
            attempts, now + Math.min(CANCEL_MAX_RETRY_MS, CANCEL_FIRST_RETRY_MS * 2 ** (attempts - 1)), `not cancelled yet: ${message}`, row.key, row.attempt);
        });
      }
    }
    return failed;
  }

  /** Slots the limiter granted (a wake, or a renew's `held`): each goes to its effect, or straight back if it has none. */
  private async assignGrants(grants: { key: string; lease: string; kind?: "child" | "job" }[]) {
    for (const grant of grants) {
      const row = this.sql.exec("SELECT attempt, lease, kind FROM workflow_effects WHERE key = ? AND current = 1 AND status = 'pending'", grant.key).toArray()
        .filter(row => slotKind(row.kind as string) !== undefined && (grant.kind === undefined || slotKind(row.kind as string) === grant.kind))[0];
      if (row && (row.lease === null || row.lease === grant.lease)) this.sql.exec("UPDATE workflow_effects SET lease = ? WHERE key = ? AND attempt = ?", grant.lease, grant.key, row.attempt);
      else if (!row) await this.options.capacity?.release(grant.lease);
    }
  }

  /** The limiter's wake: slots it granted to effects that waited for one. */
  capacityGranted(grants: { key: string; lease: string; kind?: "child" | "job" }[]): Promise<void> {
    return this.serial(async () => {
      await this.assignGrants(grants);
      await this.advance();
    });
  }

  /** Start committed effects not started yet, within the budget and the concurrency. */
  private async startHeld() {
    const row = this.state();
    if (row.status !== "running") return;
    const held = this.sql.exec("SELECT key, attempt, kind, args, lease, start_failures FROM workflow_effects WHERE current = 1 AND status = 'pending' AND started = 0 ORDER BY ord").toArray();
    if (!held.length) return;
    const budget = row.budget_usd === null ? null : Number(row.budget_usd);
    const runningOf = (slot: "child" | "job") => Number(this.sql.exec(
      `SELECT COUNT(*) AS n FROM workflow_effects WHERE current = 1 AND status = 'pending' AND started = 1 AND kind IN (${slot === "child" ? "'agent'" : "'job', 'push'"})`).one().n);
    const running = { child: runningOf("child"), job: runningOf("job") };
    const caps = { child: Number(row.concurrency), job: Number(row.job_concurrency ?? WORKFLOW_LIMITS.jobConcurrency) };
    for (const effect of held) {
      // The owner's cache first: a hit lands at once, at no cost, without a slot or a child.
      if (this.options.results && cacheable(effect.kind as string, effect.args as string) && await this.fromCache(effect)) continue;
      const slot = slotKind(effect.kind as string);
      if (slot) {
        if (budget !== null) {
          const spent = Number(this.sql.exec("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM workflow_ledger").one().usd);
          if (spent >= budget) {
            this.storage.transactionSync(() => { this.setStatus("budget_exhausted"); this.event("budget_exhausted", { spentUsd: spent, budgetUsd: budget }); });
            return;
          }
        }
        if (running[slot] >= caps[slot]) continue;
        if (this.options.capacity && !row.capacity_open) continue;
        if (this.options.capacity && effect.lease === null) {
          const granted = await this.options.capacity.acquire(effect.key as string, slot);
          // Not granted: it waits in the limiter's queue, and its grant starts it later.
          if (!granted.granted) continue;
          this.sql.exec("UPDATE workflow_effects SET lease = ? WHERE key = ? AND attempt = ?", granted.lease, effect.key, effect.attempt);
        }
        running[slot]++;
      }
      if (EXECUTED.has(effect.kind as string)) {
        try { await this.executor.start(this.started(effect)); }
        catch (error) {
          // The effect stays journaled and unstarted; the alarm's sweep (armed while any is unstarted) and every later
          // landing or wake try it again. Recorded, and the other effects still start.
          if (slot) running[slot]--;
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Workflow effect ${effect.key}:${effect.attempt} did not start`, error);
          this.storage.transactionSync(() => {
            // Recorded once per effect; the count says how often it was tried.
            if (Number(effect.start_failures) === 0) this.event("start_failed", { key: effect.key, attempt: Number(effect.attempt), error: message });
            this.sql.exec("UPDATE workflow_effects SET start_failures = start_failures + 1, reason = ? WHERE key = ? AND attempt = ?", `did not start: ${message}`, effect.key, effect.attempt);
          });
          continue;
        }
      }
      this.sql.exec("UPDATE workflow_effects SET started = 1, started_at = ?, reason = NULL WHERE key = ? AND attempt = ?", this.now(), effect.key, effect.attempt);
    }
  }

  /**
   * An effect answered from the owner's cache: journaled with where its result came from and landed in one
   * transaction, charged nothing. A lookup that fails is a miss (logged): the effect runs.
   */
  private async fromCache(effect: Row): Promise<boolean> {
    const found = await this.options.results!.lookup(effect.kind as string, effect.args as string, { key: effect.key as string, attempt: Number(effect.attempt) });
    const hit = found.hit;
    // One transaction: marked from the cache, and landed. A crash leaves it unstarted (looked up again) or landed.
    return this.storage.transactionSync(() => {
      if (!hit) {
        this.sql.exec("UPDATE workflow_effects SET cache_key = ? WHERE key = ? AND attempt = ? AND status = 'pending'", found.key, effect.key, effect.attempt);
        return false;
      }
      this.sql.exec("UPDATE workflow_effects SET cached_from = ?, cache_key = ?, started = 1, started_at = ? WHERE key = ? AND attempt = ? AND status = 'pending'", hit.source, found.key, this.now(), effect.key, effect.attempt);
      this.event("effect_cached", { key: effect.key, source: hit.source });
      // No usage: a hit writes no ledger row (it cost nothing, and is no call). A real ending for the same key:attempt
      // that still arrives (a run started before a crash) is charged in full by its own row.
      this.record(effect.key as string, Number(effect.attempt), { ok: true, value: hit.value });
      // A payer's probe answered from the cache proves nothing about its credit: the next refused effect is the probe
      // (until one starts for real, which lands and brings the rest; with none left, the payer's stop is over).
      if (this.state().payer_since !== null) {
        const next = this.sql.exec("SELECT key FROM workflow_effects WHERE current = 1 AND status = 'refused' ORDER BY ord LIMIT 1").toArray()[0];
        if (next) this.nextAttempt(next.key as string, "reissue");
        else this.sql.exec("UPDATE workflow_state SET payer_since = NULL WHERE id = 1");
      }
      return true;
    });
  }

  private started(row: Row): StartedEffect {
    return { key: row.key as string, attempt: Number(row.attempt), kind: row.kind as string, args: JSON.parse(row.args as string) };
  }

  /** Run one step if one is due. Returns whether it ran and the workflow still runs. */
  private async step(): Promise<boolean> {
    const state = this.state();
    if (state.status !== "running") return false;
    const at = this.now();
    if (state.throttled_until !== null && Number(state.throttled_until) > at) return false;
    const step = Number(state.step) + 1;
    // One script, from the first step (revisions were removed with editing): 1 is the only revision.
    const revision = { revision: 1, start_step: 1, at: Number(state.started_at) };
    const rebuild = revision.start_step === step;
    const results = this.sql.exec(
      "SELECT key, attempt, ok, result, kind, args FROM workflow_effects WHERE current = 1 AND delivered_step IS NULL AND landed IS NOT NULL ORDER BY landed",
    ).toArray();
    if (!rebuild && results.length === 0) return false;
    const recent = this.sql.exec("SELECT COUNT(*) AS n, MIN(at) AS first FROM workflow_steps WHERE at > ?", at - 3_600_000).one();
    if (Number(recent.n) >= WORKFLOW_LIMITS.stepsPerHour) {
      const until = Number(recent.first) + 3_600_000;
      this.storage.transactionSync(() => {
        this.sql.exec("UPDATE workflow_state SET throttled_until = ? WHERE id = 1", until);
        this.event("throttled", { steps: Number(recent.n), until });
      });
      return false;
    }
    const newest = Number(this.sql.exec("SELECT COALESCE(MAX(version), 0) AS v FROM workflow_effects").one().v);
    if (newest > WORKFLOW_RUNNER_VERSION) {
      this.storage.transactionSync(() => this.fault({ code: "journal_version", message: `The journal has rows from runner version ${newest}; this runner is version ${WORKFLOW_RUNNER_VERSION}` }));
      return false;
    }
    const started = performance.now();
    const deliver: WorkflowBatch | undefined = results.length ? { at, results: results.map(row => ({ key: row.key as string, ok: row.ok === 1, value: row.result as string, kind: row.kind as string, args: row.args as string })) } : undefined;
    const request: WorkflowStepRequest = {
      protocol: WORKFLOW_STEP_PROTOCOL, code: state.code as string, seed: Number(state.seed), startedAt: Number(state.started_at),
      snapshotCap: this.options.snapshotCap ?? WORKFLOW_LIMITS.snapshotCapBytes, deliver,
    };
    const fromJournal = () => {
      delete request.restore;
      request.beganAt = revision.at;
      if (!rebuild) request.replay = this.batches(revision.start_step, step - 1);
    };
    const snapshot = rebuild ? undefined : this.loadSnapshot(step - 1, revision.revision);
    if (snapshot) request.restore = snapshot;
    else fromJournal();
    let outcome = await this.call(request);
    if (outcome.kind === "refused") {
      const message = outcome.message;
      this.storage.transactionSync(() => this.event("snapshot_refused", { step, message }));
      fromJournal();
      outcome = await this.call(request);
      if (outcome.kind === "refused") throw new Error(`The sandbox refused a replay: ${outcome.message}`);
    }
    const ran = outcome;
    const fresh = ran.issued.filter(effect => !effect.replayed && !effect.reused);
    const total = Number(this.sql.exec("SELECT COUNT(*) AS n FROM workflow_effects").one().n);
    const fault = ran.fault ?? this.check(ran.issued, revision.start_step, step)
      ?? (total + fresh.length > WORKFLOW_LIMITS.effects ? { code: "effect_limit" as const, message: `A workflow journals at most ${WORKFLOW_LIMITS.effects} effects` } : undefined);
    const ms = performance.now() - started;
    return this.storage.transactionSync(() => {
      const current = this.state();
      if (Number(current.step) !== step - 1 || current.revision !== state.revision) throw new Error(`Step ${step} raced another change: the workflow is at step ${current.step}, revision ${current.revision}`);
      // A faulted step ends the workflow, failed with the fault: nothing fixes a script in place (start a new one).
      if (fault) { this.fault(fault); return false; }
      for (const row of results) this.sql.exec("UPDATE workflow_effects SET delivered_step = ? WHERE key = ? AND attempt = ?", step, row.key, row.attempt);
      this.sql.exec("INSERT INTO workflow_steps (step, revision, at, results, issued, replayed, polls, snapshot_bytes, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        step, revision.revision, at, results.length, fresh.length, ran.replayed ? 1 : 0, ran.polls, ran.snapshotBytes, ms);
      this.sql.exec("UPDATE workflow_state SET step = ?, updated_at = ? WHERE id = 1", step, at);
      let ord = Number(this.sql.exec("SELECT COALESCE(MAX(ord), 0) AS ord FROM workflow_effects").one().ord);
      for (const effect of fresh) {
        const before = this.sql.exec("SELECT attempt FROM workflow_effects WHERE key = ? AND current = 1", effect.key).toArray()[0];
        if (before) this.sql.exec("UPDATE workflow_effects SET current = 0 WHERE key = ? AND current = 1", effect.key);
        this.sql.exec(
          `INSERT INTO workflow_effects (key, attempt, current, ord, origin, revision, kind, args, status, reason, started, issued_step, seen_revision, issued_at, ended_at, version)
           VALUES (?, ?, 1, ?, 'script', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
          effect.key, before ? Number(before.attempt) + 1 : 1, ++ord, revision.revision, effect.kind, effect.args,
          // Issued in the step the script ended in: journaled, never started.
          ran.done ? "cancelled" : "pending", ran.done ? "the script ended before it was awaited" : null,
          step, revision.revision, at, ran.done ? at : null, WORKFLOW_RUNNER_VERSION,
        );
      }
      for (const log of ran.logs) this.sql.exec("INSERT INTO workflow_log (step, text) VALUES (?, ?)", step, log.text.slice(0, WORKFLOW_LIMITS.logChars));
      if (ran.logs.length) this.sql.exec("DELETE FROM workflow_log WHERE seq <= (SELECT MAX(seq) FROM workflow_log) - ?", WORKFLOW_LIMITS.keptLogs);
      if (ran.done) {
        // Effects still out when the script ended are not needed any more: running children are stopped after the
        // commit (cancelEnded), and their slots given back.
        this.sql.exec("UPDATE workflow_effects SET status = 'cancelled', reason = 'the script ended', ended_at = ? WHERE current = 1 AND status = 'pending'", at);
        this.dropSnapshot();
        const done = ran.done;
        this.sql.exec("UPDATE workflow_state SET result = ?, error = ?, fault_code = NULL WHERE id = 1", done.ok ? (done.value ?? null) : null, done.ok ? null : done.error);
        this.setStatus(done.ok ? "completed" : "failed");
        this.event(done.ok ? "completed" : "failed", { step });
        return false;
      }
      if (ran.snapshot) this.storeSnapshot(step, revision.revision, ran.fingerprint, ran.snapshot);
      else {
        this.dropSnapshot();
        this.event("snapshot_dropped", { step, bytes: ran.snapshotBytes, rawBytes: ran.snapshotRawBytes });
      }
      return true;
    });
  }

  /**
   * The script went wrong: the workflow ends `failed` with the fault (its code and message), what is still out is
   * cancelled (stopped after the commit, cancelEnded) as on an abort. Nothing fixes a script in place: the owner starts
   * a new workflow, whose finished results come from the cache.
   */
  private fault(fault: { code: WorkflowFaultCode; message: string }) {
    this.dropSnapshot();
    this.sql.exec("UPDATE workflow_effects SET status = 'cancelled', reason = ?, due_at = NULL, ended_at = ? WHERE current = 1 AND status = 'pending'", `the script faulted (${fault.code})`, this.now());
    this.sql.exec("UPDATE workflow_state SET error = ?, fault_code = ? WHERE id = 1", fault.message, fault.code);
    this.setStatus("failed");
    this.event("fault", fault);
  }

  /**
   * A replay issues exactly the revision's journaled effects, in journal order; a new effect is never one the journal
   * already holds as a live current attempt. Anything else means the script depends on something it did not journal.
   */
  private check(issued: IssuedEffect[], startStep: number, step: number): { code: WorkflowFaultCode; message: string } | undefined {
    if (issued.some(effect => effect.replayed)) {
      const replayed = issued.filter(effect => effect.replayed && !effect.reused);
      const journal = this.sql.exec("SELECT key, kind, args FROM workflow_effects WHERE origin = 'script' AND issued_step >= ? AND issued_step < ? ORDER BY ord", startStep, step).toArray();
      for (let i = 0; i < Math.max(journal.length, replayed.length); i++) {
        const want = journal[i], got = replayed[i];
        if (!want || !got || want.key !== got.key || want.kind !== got.kind || want.args !== got.args)
          return { code: "nondeterministic_script", message: `On replay the script's effect ${i + 1} is ${got ? `${got.kind} ${got.key}` : "missing"}, but the journal's is ${want ? `${want.kind} ${want.key}` : "missing"}` };
      }
    }
    for (const effect of issued.filter(effect => !effect.replayed && !effect.reused)) {
      const row = this.sql.exec("SELECT status FROM workflow_effects WHERE key = ? AND current = 1", effect.key).toArray()[0];
      if (row && row.status !== "aborted" && row.status !== "refused" && row.status !== "cancelled")
        return { code: "nondeterministic_script", message: `The script issued ${effect.kind} ${effect.key} again, which the journal already has` };
    }
    return undefined;
  }

  private async call(request: WorkflowStepRequest): Promise<WorkflowStepOutcome> {
    try { return await this.sandbox.step(request); }
    catch (error) {
      if (stepUnsupported(error)) throw new Error(`The sandbox Worker does not speak workflow step protocol ${WORKFLOW_STEP_PROTOCOL}: the workflow runner and the sandbox Worker run different versions`);
      throw error;
    }
  }

  /** The batches of steps `from` through `through`, as first delivered. */
  private batches(from: number, through: number): WorkflowBatch[] {
    const steps = this.sql.exec("SELECT step, at FROM workflow_steps WHERE step >= ? AND step <= ? AND results > 0 ORDER BY step", from, through).toArray();
    const rows = this.sql.exec("SELECT key, ok, result, kind, args, delivered_step FROM workflow_effects WHERE delivered_step >= ? AND delivered_step <= ? ORDER BY delivered_step, landed", from, through).toArray();
    const byStep = new Map<number, WorkflowBatch>(steps.map(row => [Number(row.step), { at: Number(row.at), results: [] }]));
    for (const row of rows) byStep.get(Number(row.delivered_step))?.results.push({ key: row.key as string, ok: row.ok === 1, value: row.result as string, kind: row.kind as string, args: row.args as string });
    return [...byStep.values()];
  }

  private loadSnapshot(step: number, revision: number): Uint8Array | undefined {
    const head = this.sql.exec("SELECT step, revision, bytes FROM workflow_snapshot WHERE id = 1").toArray()[0];
    if (!head || Number(head.step) !== step || Number(head.revision) !== revision) return undefined;
    const out = new Uint8Array(Number(head.bytes));
    let offset = 0;
    for (const row of this.sql.exec("SELECT data FROM workflow_snapshot_chunks ORDER BY chunk")) {
      const data = bytesOf(row.data);
      out.set(data, offset);
      offset += data.byteLength;
    }
    if (offset !== out.byteLength) throw new Error(`The stored snapshot has ${offset} of its ${out.byteLength} bytes`);
    return out;
  }

  private storeSnapshot(step: number, revision: number, fingerprint: string, bytes: Uint8Array) {
    this.sql.exec("DELETE FROM workflow_snapshot_chunks");
    let chunks = 0;
    for (let offset = 0; offset < bytes.byteLength; offset += WORKFLOW_LIMITS.snapshotChunkBytes)
      this.sql.exec("INSERT INTO workflow_snapshot_chunks (chunk, data) VALUES (?, ?)", chunks++, bytes.subarray(offset, offset + WORKFLOW_LIMITS.snapshotChunkBytes));
    this.sql.exec("INSERT OR REPLACE INTO workflow_snapshot (id, step, revision, fingerprint, bytes, chunks) VALUES (1, ?, ?, ?, ?, ?)", step, revision, fingerprint, bytes.byteLength, chunks);
  }

  private dropSnapshot() {
    this.sql.exec("DELETE FROM workflow_snapshot_chunks");
    this.sql.exec("DELETE FROM workflow_snapshot");
  }

  /** A new attempt of `key`, pending and not started; the old attempt stops counting. */
  private nextAttempt(key: string, origin: "reissue") {
    const row = this.sql.exec("SELECT * FROM workflow_effects WHERE key = ? AND current = 1", key).one();
    const state = this.state();
    const ord = Number(this.sql.exec("SELECT COALESCE(MAX(ord), 0) AS ord FROM workflow_effects").one().ord) + 1;
    this.sql.exec("UPDATE workflow_effects SET current = 0 WHERE key = ? AND current = 1", key);
    const at = this.now();
    this.sql.exec(
      `INSERT INTO workflow_effects (key, attempt, current, ord, origin, revision, kind, args, status, started, issued_step, seen_revision, issued_at, version)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
      key, Number(row.attempt) + 1, ord, origin, Number(state.revision), row.kind, row.args,
      Number(state.step) + 1, Number(state.revision), at, WORKFLOW_RUNNER_VERSION,
    );
  }

  /** No new effects start until resume. With `children: "abort"` running agents stop too, and are re-issued on resume. */
  pause(options: { children?: "abort" } = {}): Promise<void> {
    return this.serial(async () => {
      const status = this.state().status as WorkflowStatus;
      if (status !== "running") throw new WorkflowError(`A ${status} workflow cannot be paused`);
      const stopping = options.children === "abort"
        ? this.sql.exec("SELECT key, attempt, kind, args FROM workflow_effects WHERE current = 1 AND status = 'pending' AND started = 1 AND kind = 'agent'").toArray() : [];
      this.storage.transactionSync(() => {
        this.setStatus("paused", "user");
        for (const row of stopping) this.sql.exec("UPDATE workflow_effects SET status = 'aborted', reason = 'paused', ended_at = ? WHERE key = ? AND attempt = ?", this.now(), row.key, row.attempt);
        this.event("paused", { children: options.children ?? "keep", stopped: stopping.length });
      });
      await this.cancelEnded();
      await this.capacityHousekeeping();
      await this.arm();
    });
  }

  /** Go on after a pause: re-issue refused and aborted effects under their next attempt. An ended workflow does not resume. */
  resume(): Promise<void> {
    return this.serial(async () => {
      const state = this.state(), status = state.status as WorkflowStatus;
      if (TERMINAL.has(status)) throw new WorkflowError(`A ${status} workflow cannot be resumed: start a new one (finished results are reused)`);
      this.storage.transactionSync(() => {
        this.goOn(false);
        this.event("resumed", {});
      });
      await this.advance();
    });
  }

  /** Re-issue what a stop refused or aborted, and run again (`selfResumed`: the alarm's own try, counted for its backoff). */
  private goOn(selfResumed: boolean) {
    const payer = selfResumed && this.state().pause_reason === "payer_exhausted";
    // The alarm's own try after a payer refusal re-issues one refused effect, a probe: the rest follow once it is admitted
    // (record), so a payer that stays without credit makes one new child (or job snapshot) per try, not one per effect.
    const again = this.sql.exec(`SELECT key FROM workflow_effects WHERE current = 1 AND status IN ('refused', 'aborted') ORDER BY ord${payer ? " LIMIT 1" : ""}`).toArray();
    for (const row of again) this.nextAttempt(row.key as string, "reissue");
    this.sql.exec("UPDATE workflow_state SET resume_tries = ? WHERE id = 1", selfResumed ? Number(this.state().resume_tries) + 1 : 0);
    if (!selfResumed) this.sql.exec("UPDATE workflow_state SET payer_since = NULL WHERE id = 1");
    this.setStatus("running");
  }

  /** Stop the workflow for good: running effects are cancelled, the journal and ledger stay readable. */
  /**
   * End the workflow as failed for a reason outside its script (it cannot run where it is): what is still out is
   * cancelled, and it ends once, with `error`, rather than retrying on every alarm.
   */
  fail(error: string, code: string): Promise<void> {
    return this.serial(async () => {
      const status = this.state().status as WorkflowStatus;
      if (TERMINAL.has(status)) return;
      this.storage.transactionSync(() => {
        this.sql.exec("UPDATE workflow_effects SET status = 'cancelled', reason = ?, ended_at = ? WHERE current = 1 AND status = 'pending'", error, this.now());
        this.dropSnapshot();
        this.sql.exec("UPDATE workflow_state SET error = ?, fault_code = NULL WHERE id = 1", error);
        this.setStatus("failed");
        this.event("failed", { code, error });
      });
      await this.advance();
      await this.executor.abort?.();
    });
  }

  abort(): Promise<void> {
    return this.serial(async () => {
      const status = this.state().status as WorkflowStatus;
      if (TERMINAL.has(status)) throw new WorkflowError(`A ${status} workflow cannot be aborted`);
      const live = this.sql.exec("SELECT key, attempt, kind, args, started FROM workflow_effects WHERE current = 1 AND status = 'pending'").toArray();
      this.storage.transactionSync(() => {
        this.sql.exec("UPDATE workflow_effects SET status = 'aborted', reason = 'workflow aborted', ended_at = ? WHERE current = 1 AND status = 'pending'", this.now());
        this.dropSnapshot();
        this.setStatus("aborted");
        this.event("aborted", { cancelled: live.length });
      });
      await this.cancelEnded();
      await this.executor.abort?.();
      await this.capacityHousekeeping();
      await this.arm();
    });
  }

  /** Raise or lower the cap (`null`: none). Below what is spent the workflow is `budget_exhausted`; above, it goes on. */
  setBudget(usd: number | null): Promise<void> {
    return this.serial(async () => {
      if (usd !== null && !(usd >= 0)) throw new WorkflowError("budget.usd must be at least 0", 400);
      const status = this.state().status as WorkflowStatus;
      const spent = Number(this.sql.exec("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM workflow_ledger").one().usd);
      this.storage.transactionSync(() => {
        this.sql.exec("UPDATE workflow_state SET budget_usd = ?, updated_at = ? WHERE id = 1", usd, this.now());
        this.event("budget", { usd, spentUsd: spent });
        if (usd !== null && spent >= usd && status === "running") {
          this.setStatus("budget_exhausted");
          this.event("budget_exhausted", { spentUsd: spent, budgetUsd: usd });
        } else if (status === "budget_exhausted" && (usd === null || spent < usd)) {
          // Effects refused for the budget (a child's share ran out) go again under their next attempt.
          for (const row of this.sql.exec("SELECT key FROM workflow_effects WHERE current = 1 AND status = 'refused'").toArray()) this.nextAttempt(row.key as string, "reissue");
          this.setStatus("running");
        }
      });
      await this.advance();
    });
  }

  /**
   * The object's one alarm: a step window that has moved lets steps run again, the capacity lease is renewed, and the sweep starts what a crash left
   * unstarted and asks the executor after effects that have not landed. Each concern is isolated: one that throws is
   * recorded and the others still run, and the alarm is armed again whatever happens, never sooner than a second from
   * now (thirty after a failure), so a concern that keeps failing cannot spin the object.
   */
  alarm(): Promise<{ failed: boolean }> {
    return this.serial(async () => {
      const now = this.now();
      let failed = false;
      const isolated = async (concern: string, work: () => unknown) => {
        try { await work(); }
        catch (error) {
          failed = true;
          console.error(`Workflow alarm: ${concern} failed`, error);
          try { this.storage.transactionSync(() => this.event("alarm_failed", { concern, error: error instanceof Error ? error.message : String(error) })); }
          catch { /* the event is best effort; the failure is logged above */ }
        }
      };
      try {
        const state = this.state();
        if (TERMINAL.has(state.status as WorkflowStatus)) {
          // An ended workflow's alarm finishes what the end left: children not yet cancelled, the capacity lease.
          await isolated("cancel", async () => { if (await this.cancelEnded()) failed = true; });
          await isolated("capacity", () => this.capacityHousekeeping());
          return { failed };
        }
        if (state.throttled_until !== null && Number(state.throttled_until) <= now) this.sql.exec("UPDATE workflow_state SET throttled_until = NULL WHERE id = 1");
        // The capacity lease is renewed from open to close, slots held or not: a workflow that only waits keeps its place.
        const capacity = this.options.capacity;
        if (capacity && state.capacity_open && now - Number(state.renewed_at ?? 0) >= capacity.leaseMs / 2) {
          await isolated("capacity renew", async () => {
            const renewed = await capacity.renew();
            if (renewed.ok) await this.assignGrants(renewed.held);
            else this.storage.transactionSync(() => {
              this.sql.exec("UPDATE workflow_state SET capacity_open = 0 WHERE id = 1");
              const status = this.state().status;
              if (status === "running") this.setStatus("paused", "capacity_refused");
              this.event("capacity_refused", { message: renewed.message });
            });
            this.sql.exec("UPDATE workflow_state SET renewed_at = ? WHERE id = 1", now);
          });
        }
        // Paused for the payer's credit or the tenant's workflow limit: it tries again on its own when its time comes.
        // Refused again, it pauses again (later each time for the payer), so nothing waits on a resume nobody sends.
        if (state.status === "paused" && state.resume_at !== null && Number(state.resume_at) <= now && SELF_RESUMING.has(state.pause_reason as string)) {
          await isolated("self-resume", () => {
            this.storage.transactionSync(() => {
              if (state.pause_reason === "payer_exhausted" && state.payer_since !== null && now - Number(state.payer_since) >= WORKFLOW_LIMITS.payerGiveUpMs)
                this.fault({ code: "payer_gave_up", message: `Its payer had no credit for ${Math.round(WORKFLOW_LIMITS.payerGiveUpMs / 86_400_000)} days: start it again once there is credit; finished results are reused` });
              else { this.goOn(true); this.event("resumed", { by: "alarm", after: state.pause_reason }); }
            });
          });
        }
        const live = state.status === "running";
        if (live && (state.swept_at === null || now - Number(state.swept_at) >= WORKFLOW_LIMITS.sweepMs)) {
          this.sql.exec("UPDATE workflow_state SET swept_at = ? WHERE id = 1", now);
          if (this.executor.poll) {
            const stale = this.sql.exec(
              `SELECT key, attempt, kind, args FROM workflow_effects WHERE current = 1 AND status = 'pending' AND started = 1 AND kind IN (${EXECUTED_SQL}) AND started_at <= ?`,
              now - WORKFLOW_LIMITS.sweepMs,
            ).toArray();
            for (const row of stale) {
              await isolated(`poll ${row.key}`, async () => {
                const ended = await this.executor.poll!(this.started(row));
                if (ended) { await this.cacheLanding(row.key as string, Number(row.attempt), ended.outcome); this.record(row.key as string, Number(row.attempt), ended.outcome, ended.usage); }
              });
            }
          }
        }
        await isolated("steps", async () => { if (await this.advance(true)) failed = true; });
        return { failed };
      } finally {
        await this.arm(now + (failed ? 30_000 : 1_000));
      }
    });
  }

  /**
   * The earliest of the next step window, capacity renew and sweep; none once the workflow has ended and given its
   * capacity back. The sweep runs only while the workflow runs: a paused one wakes for its renew, not every five minutes.
   */
  nextAlarm(): number | null {
    const state = this.state();
    const capacity = this.options.capacity && state.capacity_open ? this.options.capacity : undefined;
    const candidates: number[] = [];
    // A work item the end (or a pause) did not manage to stop yet: when its next cancel is due (its own backoff).
    const cancel = this.sql.exec(`SELECT MIN(COALESCE(cancel_next_at, 0)) AS at FROM workflow_effects WHERE ${UNCANCELLED}`).one().at;
    if (cancel !== null) candidates.push(Math.max(Number(cancel), this.now()));
    if (TERMINAL.has(state.status as WorkflowStatus)) {
      if (capacity) candidates.push(this.now() + 30_000);
      return candidates.length ? Math.min(...candidates) : null;
    }
    if (state.throttled_until !== null) candidates.push(Number(state.throttled_until));
    if (state.status === "running") {
      // A result landed but its step did not run (the step failed): try again (arm's floor spaces the tries out).
      // While the step window is full, the window's end (above) is when to try.
      const throttled = state.throttled_until !== null && Number(state.throttled_until) > this.now();
      if (!throttled && this.sql.exec("SELECT 1 FROM workflow_effects WHERE current = 1 AND delivered_step IS NULL AND landed IS NOT NULL LIMIT 1").toArray().length) candidates.push(this.now());
      const unlanded = this.sql.exec(`SELECT 1 FROM workflow_effects WHERE current = 1 AND status = 'pending' AND (kind IN (${EXECUTED_SQL}) OR started = 0) LIMIT 1`).toArray().length > 0;
      if (unlanded) candidates.push((state.swept_at === null ? this.now() : Number(state.swept_at)) + WORKFLOW_LIMITS.sweepMs);
    }
    if (capacity) candidates.push(Number(state.renewed_at ?? this.now()) + capacity.leaseMs / 2);
    // A pause that resumes itself (the payer's credit, the workflow limit): when it tries again.
    if (state.status === "paused" && state.resume_at !== null) candidates.push(Number(state.resume_at));
    return candidates.length ? Math.min(...candidates) : null;
  }

  /** Arm the alarm for `nextAlarm()`, no sooner than `notBefore`. */
  private async arm(notBefore?: number) {
    const next = this.nextAlarm();
    await this.options.alarm?.set(next === null || notBefore === undefined ? next : Math.max(next, notBefore));
  }
}
