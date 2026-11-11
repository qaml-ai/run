// The workflow runner (docs/design/swarm-workflows.md, Part 1; docs/design/workflow-step-snapshots.md): the journal,
// the step driver, revisions, timers, gates, the budget ledger and the one alarm, over the SQLite of the object that
// owns a workflow (WorkflowObject, workflow-object.ts). Effects other than timers run behind `EffectExecutor`.
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
// A revision (an edit, or a resume that reruns keys) starts the VM again with a table of what the journal has: the
// script's effects whose keys the journal holds are answered from it, so only what changed runs again.
import type { IssuedEffect, WorkflowBatch, WorkflowFaultCode, WorkflowSandbox, WorkflowStepOutcome, WorkflowStepRequest } from "../codemode/workflow-protocol.ts";
import { WORKFLOW_STEP_PROTOCOL } from "../codemode/workflow-protocol.ts";

/** The runner's own version, on every journal row it writes: a runner rolled back past a row's version faults. */
export const WORKFLOW_RUNNER_VERSION = 1;
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
  /** An edit that issues more new effects than this share of the journal's finished ones waits for a confirm. */
  rerunConfirmPercent: 25,
  /** A gate's default expiry. */
  gateSeconds: 7 * 86_400,
  /** The newest events and log lines a workflow keeps, and one log line's length. */
  keptEvents: 10_000, keptLogs: 10_000, logChars: 4_096,
});

export interface StartedEffect { key: string; attempt: number; kind: string; args: unknown; options: unknown; phase: string | undefined }

/**
 * Runs `agent` and `gate` effects (timers are the runner's own). Results come back through `WorkflowRunner.land()`.
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
  /** A result body kept elsewhere (the workflow's volume); the guest gets `{ $handle: ref, bytes, sha256 }`. */
  | { ok: true; handle: { ref: string; bytes: number; sha256: string } }
  /** Failed: the script gets `null`, and the item records why. */
  | { ok: false; error: string }
  /**
   * Refused (a 402, a tenant cap, the child's share of the budget): not a failure, and never shown to the script. The
   * workflow pauses with `code` (`payer_exhausted` by default, or `budget_exhausted`); resume re-issues the effect.
   */
  | { refused: string; code?: "payer_exhausted" | "budget_exhausted" };

/** One effect's cost, for the ledger. */
export interface EffectUsage { costUsd: number; model?: string; inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; durationMs?: number }

export interface WorkflowStorage {
  sql: SqlStorage;
  transactionSync<T>(fn: () => T): T;
}

export type WorkflowStatus = "running" | "waiting" | "paused" | "completed" | "failed" | "aborted" | "budget_exhausted";
export type PauseReason = "user" | "payer_exhausted" | "confirm_rerun" | "waiting_on_gate" | "capacity_refused" | WorkflowFaultCode;
const TERMINAL = new Set<WorkflowStatus>(["completed", "failed", "aborted"]);

export interface WorkflowSummary {
  tenant?: string;
  status: WorkflowStatus;
  pauseReason?: PauseReason;
  revision: number;
  step: number;
  phase?: string;
  result?: unknown;
  error?: string;
  fault?: { code: WorkflowFaultCode; message: string };
  budget: { usd: number | null };
  concurrency: number;
  spent: { usd: number; calls: number; inputTokens: number; cachedInputTokens: number; outputTokens: number };
  counts: Record<string, number>;
  throttledUntil?: number;
  createdAt: number;
  updatedAt: number;
}

/** What `init` creates a workflow with. `seed` and `startedAt` fix its `random()` and its clock's start. */
export interface WorkflowInit {
  code: string; seed: number; startedAt: number; budgetUsd?: number | null; concurrency?: number;
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

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS workflow_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), seed INTEGER NOT NULL, started_at INTEGER NOT NULL,
    status TEXT NOT NULL, pause_reason TEXT, revision INTEGER NOT NULL, step INTEGER NOT NULL, phase TEXT,
    result TEXT, error TEXT, fault_code TEXT, budget_usd REAL, concurrency INTEGER NOT NULL,
    throttled_until INTEGER, swept_at INTEGER, tenant TEXT, bucket TEXT, end_user TEXT, capacity_open INTEGER NOT NULL DEFAULT 0, renewed_at INTEGER,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL)`,
  // A revision is a script and what the journal held when it began (its table): an edit, or a rerun of exact keys.
  `CREATE TABLE IF NOT EXISTS workflow_revisions (
    revision INTEGER PRIMARY KEY, kind TEXT NOT NULL, code TEXT NOT NULL, reason TEXT, at INTEGER NOT NULL, start_step INTEGER NOT NULL,
    rerun_confirm_percent INTEGER NOT NULL, confirmed INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS workflow_revision_table (
    revision INTEGER NOT NULL, key TEXT NOT NULL, attempt INTEGER NOT NULL, settled INTEGER NOT NULL, PRIMARY KEY (revision, key))`,
  // key/attempt is an effect's identity; `current` marks the attempt that counts. `ord` is the order rows were
  // journaled in; a replay reproduces the order of a revision's `script` rows. `landed` orders results into batches;
  // `delivered_step` is the step whose batch held the result (0: a revision's table took it).
  `CREATE TABLE IF NOT EXISTS workflow_effects (
    key TEXT NOT NULL, attempt INTEGER NOT NULL, current INTEGER NOT NULL, ord INTEGER NOT NULL UNIQUE, origin TEXT NOT NULL,
    revision INTEGER NOT NULL, kind TEXT NOT NULL, args TEXT NOT NULL, options TEXT, phase TEXT, status TEXT NOT NULL,
    started INTEGER NOT NULL DEFAULT 0, started_at INTEGER, due_at INTEGER, lease TEXT, cancel_sent INTEGER NOT NULL DEFAULT 0, start_failures INTEGER NOT NULL DEFAULT 0, ok INTEGER, result TEXT, reason TEXT, landed INTEGER UNIQUE,
    issued_step INTEGER NOT NULL, delivered_step INTEGER, seen_revision INTEGER NOT NULL, issued_at INTEGER NOT NULL, ended_at INTEGER,
    version INTEGER NOT NULL, PRIMARY KEY (key, attempt))`,
  `CREATE INDEX IF NOT EXISTS workflow_effects_current ON workflow_effects (current, status, kind)`,
  `CREATE INDEX IF NOT EXISTS workflow_effects_landed ON workflow_effects (delivered_step, landed)`,
  `CREATE INDEX IF NOT EXISTS workflow_effects_due ON workflow_effects (due_at) WHERE due_at IS NOT NULL`,
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
const EXECUTED = new Set(["agent", "gate"]);

/**
 * The tenant's capacity limiter (WorkflowCapacity), as the runner uses it: one slot per running agent, leased and
 * renewed. Opened at the first step, renewed on the alarm from open to close whether or not slots are held, released
 * as effects end, closed when the workflow ends. A slot granted later arrives through `capacityGranted` (or the next
 * renew's `held`), and the effect it was for then starts.
 */
export interface CapacitySeam {
  leaseMs: number;
  open(concurrency: number): Promise<{ ok: true } | { ok: false; message: string }>;
  acquire(key: string): Promise<{ granted: true; lease: string } | { granted: false }>;
  release(lease: string): Promise<void>;
  /** The leases held (grants whose wake was missed among them), or a refusal: the limiter dropped this workflow. */
  renew(): Promise<{ ok: true; held: { key: string; lease: string }[] } | { ok: false; message: string }>;
  close(): Promise<void>;
}

export interface RunnerOptions {
  capacity?: CapacitySeam;
  snapshotCap?: number;
  now?: () => number;
  /** The object's one alarm: `set(at)` arms it, `set(null)` clears it. */
  alarm?: { set(at: number | null): void | Promise<void> };
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
  }

  private now() { return (this.options.now ?? Date.now)(); }

  /** Create the workflow unless it exists; its first step runs on `wake()`. */
  init(workflow: WorkflowInit) {
    const concurrency = workflow.concurrency ?? WORKFLOW_LIMITS.concurrency;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > WORKFLOW_LIMITS.maxConcurrency)
      throw new WorkflowError(`concurrency must be an integer from 1 to ${WORKFLOW_LIMITS.maxConcurrency}`, 400);
    if (workflow.budgetUsd !== undefined && workflow.budgetUsd !== null && !(workflow.budgetUsd >= 0)) throw new WorkflowError("budgetUsd must be at least 0", 400);
    if (typeof workflow.code !== "string" || !workflow.code.trim()) throw new WorkflowError("A workflow needs a script", 400);
    const at = this.now();
    this.storage.transactionSync(() => {
      if (this.sql.exec("SELECT 1 FROM workflow_state WHERE id = 1").toArray().length) return;
      this.sql.exec(
        `INSERT INTO workflow_state (id, seed, started_at, status, revision, step, budget_usd, concurrency, tenant, bucket, end_user, created_at, updated_at, version)
         VALUES (1, ?, ?, 'running', 1, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
        workflow.seed >>> 0, workflow.startedAt, workflow.budgetUsd ?? null, concurrency, workflow.tenant ?? null, workflow.bucket ?? null, workflow.endUser ?? null, at, at, WORKFLOW_RUNNER_VERSION,
      );
      this.sql.exec("INSERT INTO workflow_revisions (revision, kind, code, at, start_step, rerun_confirm_percent, confirmed) VALUES (1, 'start', ?, ?, 1, 100, 1)", workflow.code, workflow.startedAt);
      this.event("created", { concurrency, budgetUsd: workflow.budgetUsd ?? null });
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
    const summary: WorkflowSummary = {
      status: row.status as WorkflowStatus, revision: Number(row.revision), step: Number(row.step),
      budget: { usd: row.budget_usd === null ? null : Number(row.budget_usd) }, concurrency: Number(row.concurrency),
      spent: { usd: Number(spent.usd), calls: Number(spent.calls), inputTokens: Number(spent.input), cachedInputTokens: Number(spent.cached), outputTokens: Number(spent.output) },
      counts, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    };
    if (row.tenant !== null) summary.tenant = row.tenant as string;
    if (row.pause_reason !== null) summary.pauseReason = row.pause_reason as PauseReason;
    if (row.phase !== null) summary.phase = row.phase as string;
    if (row.result !== null) summary.result = JSON.parse(row.result as string);
    if (row.fault_code !== null) summary.fault = { code: row.fault_code as WorkflowFaultCode, message: row.error as string };
    else if (row.error !== null) summary.error = row.error as string;
    if (row.throttled_until !== null && Number(row.throttled_until) > this.now()) summary.throttledUntil = Number(row.throttled_until);
    return summary;
  }

  /** The journal's effects (current attempts unless `attempts`), by journal order, a page at a time. */
  items(query: { after?: number; limit?: number; status?: string; phase?: string; kind?: string; attempts?: boolean } = {}) {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const where = ["e.ord > ?"], params: unknown[] = [query.after ?? 0];
    if (!query.attempts) where.push("e.current = 1");
    if (query.status === "running") where.push("e.status = 'pending' AND e.started = 1");
    else if (query.status === "pending") where.push("e.status = 'pending' AND e.started = 0");
    else if (query.status) { where.push("e.status = ?"); params.push(query.status); }
    if (query.phase) { where.push("e.phase = ?"); params.push(query.phase); }
    if (query.kind) { where.push("e.kind = ?"); params.push(query.kind); }
    const rows = this.sql.exec(
      `SELECT e.*, l.cost_usd, l.model FROM workflow_effects e LEFT JOIN workflow_ledger l ON l.key = e.key AND l.attempt = e.attempt
       WHERE ${where.join(" AND ")} ORDER BY e.ord LIMIT ?`,
      ...params, limit + 1,
    ).toArray();
    const items = rows.slice(0, limit).map(row => ({
      key: row.key as string, attempt: Number(row.attempt), current: row.current === 1, kind: row.kind as string, origin: row.origin as string,
      status: row.status === "pending" && row.started === 1 ? "running" : row.status as string,
      phase: text(row.phase), revision: Number(row.revision), seenRevision: Number(row.seen_revision), args: JSON.parse(row.args as string),
      result: row.result === null ? undefined : JSON.parse(row.result as string), reason: text(row.reason),
      issuedAt: Number(row.issued_at), endedAt: row.ended_at === null ? undefined : Number(row.ended_at),
      costUsd: row.cost_usd === null ? undefined : Number(row.cost_usd), model: text(row.model), ord: Number(row.ord),
    }));
    return { items, next: rows.length > limit ? items.at(-1)!.ord : undefined };
  }

  /**
   * A revision's key diff: keys it took from the journal (`kept`), keys it issued new (`issued`, which ran or will
   * run), and current keys it has not reached yet (`unseen`; they run again only if the script still asks for them).
   */
  diff(revision?: number) {
    const target = revision ?? Number(this.state().revision);
    const keys = (sql: string, ...params: unknown[]) => this.sql.exec(sql, ...params).toArray().map(row => row.key as string);
    return {
      revision: target,
      reason: text(this.sql.exec("SELECT reason FROM workflow_revisions WHERE revision = ?", target).toArray()[0]?.reason ?? null),
      kept: keys("SELECT t.key FROM workflow_revision_table t JOIN workflow_effects e ON e.key = t.key AND e.current = 1 WHERE t.revision = ? AND e.seen_revision >= ? ORDER BY e.ord LIMIT 1000", target, target),
      issued: keys("SELECT key FROM workflow_effects WHERE revision = ? AND origin = 'script' AND issued_step >= (SELECT start_step FROM workflow_revisions WHERE revision = ?) ORDER BY ord LIMIT 1000", target, target),
      unseen: keys("SELECT key FROM workflow_effects WHERE current = 1 AND seen_revision < ? ORDER BY ord LIMIT 1000", target),
    };
  }

  events(query: { after?: number; limit?: number } = {}) {
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const rows = this.sql.exec("SELECT seq, at, type, data FROM workflow_events WHERE seq > ? ORDER BY seq LIMIT ?", query.after ?? 0, limit).toArray();
    return rows.map(row => ({ seq: Number(row.seq), at: Number(row.at), type: row.type as string, data: row.data === null ? undefined : JSON.parse(row.data as string) }));
  }

  logs() {
    return this.sql.exec("SELECT step, phase, text FROM workflow_log ORDER BY seq").toArray();
  }

  private event(type: string, data?: unknown) {
    this.sql.exec("INSERT INTO workflow_events (at, type, data) VALUES (?, ?, ?)", this.now(), type, data === undefined ? null : JSON.stringify(data));
    // The newest `keptEvents` stay; older ones go, a few at a time.
    this.sql.exec("DELETE FROM workflow_events WHERE seq <= (SELECT MAX(seq) FROM workflow_events) - ?", WORKFLOW_LIMITS.keptEvents);
  }

  private setStatus(status: WorkflowStatus, reason: PauseReason | null = null) {
    this.sql.exec("UPDATE workflow_state SET status = ?, pause_reason = ?, updated_at = ? WHERE id = 1", status, reason, this.now());
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** After a start or a restart: start what was committed but not started, run due steps, arm the alarm. */
  wake(): Promise<void> {
    return this.serial(() => this.advance(true));
  }

  /** Who the workflow belongs to, as created. */
  identity() {
    const row = this.state();
    return { tenant: text(row.tenant), bucket: text(row.bucket), endUser: text(row.end_user) };
  }

  private async advance(recover = false) {
    try {
      if (recover) await this.executor.recover?.();
      await this.capacityHousekeeping();
      // Effects held from before (a resume, a raised budget, a failed start, a slot granted) first; then each step's new ones.
      await this.startHeld();
      while (await this.step()) await this.startHeld();
      await this.cancelEnded();
      await this.capacityHousekeeping();
    } finally { await this.arm(); }
  }

  /** Effect `key:attempt` ended. A second landing, or one for a superseded attempt, is ignored. */
  land(key: string, attempt: number, outcome: EffectOutcome, usage?: EffectUsage): Promise<void> {
    return this.serial(async () => {
      this.record(key, attempt, outcome, usage);
      await this.advance();
    });
  }

  private record(key: string, attempt: number, outcome: EffectOutcome, usage?: EffectUsage) {
    const row = this.sql.exec("SELECT status, current FROM workflow_effects WHERE key = ? AND attempt = ?", key, attempt).toArray()[0];
    if (!row) throw new WorkflowError(`Effect ${key}:${attempt} is not in the journal`, 404);
    const at = this.now();
    let value: string | undefined;
    if ("ok" in outcome) {
      if (!outcome.ok) value = JSON.stringify({ message: outcome.error });
      else if ("handle" in outcome) value = JSON.stringify({ $handle: outcome.handle.ref, bytes: outcome.handle.bytes, sha256: outcome.handle.sha256 });
      else {
        value = JSON.stringify(outcome.value ?? null);
        const bytes = new TextEncoder().encode(value).byteLength;
        if (bytes > WORKFLOW_LIMITS.inlineResultBytes) throw new WorkflowError(`Effect ${key}'s result is ${bytes} bytes; over ${WORKFLOW_LIMITS.inlineResultBytes} it must be landed as a handle`, 400);
      }
    }
    this.storage.transactionSync(() => {
      if (usage) {
        this.sql.exec(
          "INSERT OR IGNORE INTO workflow_ledger (key, attempt, cost_usd, model, input_tokens, cached_input_tokens, output_tokens, duration_ms, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          key, attempt, usage.costUsd, usage.model ?? null, usage.inputTokens ?? 0, usage.cachedInputTokens ?? 0, usage.outputTokens ?? 0, usage.durationMs ?? null, at,
        );
      }
      if (row.status !== "pending" || row.current !== 1) return;
      if ("refused" in outcome) {
        this.sql.exec("UPDATE workflow_effects SET status = 'refused', reason = ?, ended_at = ? WHERE key = ? AND attempt = ?", outcome.refused, at, key, attempt);
        const status = this.state().status as WorkflowStatus, code = outcome.code ?? "payer_exhausted";
        if (status === "running" || status === "waiting") {
          if (code === "budget_exhausted") this.setStatus("budget_exhausted");
          else this.setStatus("paused", "payer_exhausted");
        }
        this.event(code, { key, attempt, reason: outcome.refused });
        return;
      }
      this.sql.exec(
        "UPDATE workflow_effects SET status = ?, ok = ?, result = ?, reason = ?, due_at = NULL, ended_at = ?, landed = (SELECT COALESCE(MAX(landed), 0) + 1 FROM workflow_effects) WHERE key = ? AND attempt = ?",
        outcome.ok ? "done" : "failed", outcome.ok ? 1 : 0, value, outcome.ok ? null : (outcome as { error: string }).error, at, key, attempt,
      );
      this.refreshLiveness();
    });
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
    if (state.status !== "running" && state.status !== "waiting") return;
    const opened = await capacity.open(Number(state.concurrency));
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
  private async cancelEnded() {
    for (const row of this.sql.exec("SELECT key, attempt, kind, args, options, phase FROM workflow_effects WHERE status IN ('cancelled', 'aborted') AND started = 1 AND cancel_sent = 0 AND kind IN ('agent', 'gate')").toArray()) {
      await this.executor.cancel?.(this.started(row));
      this.sql.exec("UPDATE workflow_effects SET cancel_sent = 1 WHERE key = ? AND attempt = ?", row.key, row.attempt);
    }
  }

  /** Slots the limiter granted (a wake, or a renew's `held`): each goes to its effect, or straight back if it has none. */
  private async assignGrants(grants: { key: string; lease: string }[]) {
    for (const grant of grants) {
      const row = this.sql.exec("SELECT attempt, lease FROM workflow_effects WHERE key = ? AND current = 1 AND status = 'pending' AND kind = 'agent'", grant.key).toArray()[0];
      if (row && (row.lease === null || row.lease === grant.lease)) this.sql.exec("UPDATE workflow_effects SET lease = ? WHERE key = ? AND attempt = ?", grant.lease, grant.key, row.attempt);
      else if (!row) await this.options.capacity?.release(grant.lease);
    }
  }

  /** The limiter's wake: slots it granted to effects that waited for one. */
  capacityGranted(grants: { key: string; lease: string }[]): Promise<void> {
    return this.serial(async () => {
      await this.assignGrants(grants);
      await this.advance();
    });
  }

  /** `running` while an agent runs or a result waits for its step; `waiting` while only timers and gates are open. */
  private refreshLiveness() {
    const status = this.state().status as WorkflowStatus;
    if (status !== "running" && status !== "waiting") return;
    const busy = this.sql.exec(
      `SELECT 1 FROM workflow_effects WHERE current = 1 AND ((status = 'pending' AND kind = 'agent') OR (delivered_step IS NULL AND landed IS NOT NULL)) LIMIT 1`,
    ).toArray().length > 0;
    const next: WorkflowStatus = busy ? "running" : "waiting";
    if (next !== status) this.setStatus(next);
  }

  /** Start committed effects not started yet, within the budget and the concurrency. */
  private async startHeld() {
    const row = this.state();
    if (row.status !== "running" && row.status !== "waiting") return;
    const held = this.sql.exec("SELECT key, attempt, kind, args, options, phase, lease, start_failures FROM workflow_effects WHERE current = 1 AND status = 'pending' AND started = 0 ORDER BY ord").toArray();
    if (!held.length) return;
    const budget = row.budget_usd === null ? null : Number(row.budget_usd);
    let running = Number(this.sql.exec("SELECT COUNT(*) AS n FROM workflow_effects WHERE current = 1 AND status = 'pending' AND started = 1 AND kind = 'agent'").one().n);
    for (const effect of held) {
      if (effect.kind === "agent") {
        if (budget !== null) {
          const spent = Number(this.sql.exec("SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM workflow_ledger").one().usd);
          if (spent >= budget) {
            this.storage.transactionSync(() => { this.setStatus("budget_exhausted"); this.event("budget_exhausted", { spentUsd: spent, budgetUsd: budget }); });
            return;
          }
        }
        if (running >= Number(row.concurrency)) continue;
        if (this.options.capacity && !row.capacity_open) continue;
        if (this.options.capacity && effect.lease === null) {
          const slot = await this.options.capacity.acquire(effect.key as string);
          // Not granted: it waits in the limiter's queue, and its grant starts it later.
          if (!slot.granted) continue;
          this.sql.exec("UPDATE workflow_effects SET lease = ? WHERE key = ? AND attempt = ?", slot.lease, effect.key, effect.attempt);
        }
        running++;
      }
      if (EXECUTED.has(effect.kind as string)) {
        try { await this.executor.start(this.started(effect)); }
        catch (error) {
          // The effect stays journaled and unstarted; the alarm's sweep (armed while any is unstarted) and every later
          // landing or wake try it again. Recorded, and the other effects still start.
          if (effect.kind === "agent") running--;
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

  private started(row: Row): StartedEffect {
    return { key: row.key as string, attempt: Number(row.attempt), kind: row.kind as string, args: JSON.parse(row.args as string), options: row.options === null ? undefined : JSON.parse(row.options as string), phase: text(row.phase) };
  }

  /** Run one step if one is due. Returns whether it ran and the workflow still runs. */
  private async step(): Promise<boolean> {
    const state = this.state();
    if (state.status !== "running" && state.status !== "waiting") return false;
    const at = this.now();
    if (state.throttled_until !== null && Number(state.throttled_until) > at) return false;
    const step = Number(state.step) + 1;
    const revision = this.sql.exec("SELECT * FROM workflow_revisions WHERE revision = ?", state.revision).one();
    const rebuild = Number(revision.start_step) === step;
    const results = this.sql.exec(
      "SELECT key, attempt, ok, result FROM workflow_effects WHERE current = 1 AND delivered_step IS NULL AND landed IS NOT NULL ORDER BY landed",
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
    const deliver: WorkflowBatch | undefined = results.length ? { at, results: results.map(row => ({ key: row.key as string, ok: row.ok === 1, value: row.result as string })) } : undefined;
    const request: WorkflowStepRequest = {
      protocol: WORKFLOW_STEP_PROTOCOL, code: revision.code as string, seed: Number(state.seed), startedAt: Number(state.started_at),
      snapshotCap: this.options.snapshotCap ?? WORKFLOW_LIMITS.snapshotCapBytes, deliver,
    };
    const fromJournal = () => {
      delete request.restore;
      const table = this.table(Number(revision.revision));
      if (table.length) request.table = table;
      request.beganAt = Number(revision.at);
      if (!rebuild) request.replay = this.batches(Number(revision.start_step), step - 1);
    };
    const snapshot = rebuild ? undefined : this.loadSnapshot(step - 1, Number(revision.revision));
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
    const fault = ran.fault ?? this.check(ran.issued, Number(revision.start_step), step)
      ?? (total + fresh.length > WORKFLOW_LIMITS.effects ? { code: "effect_limit" as const, message: `A workflow journals at most ${WORKFLOW_LIMITS.effects} effects` } : undefined);
    const ms = performance.now() - started;
    return this.storage.transactionSync(() => {
      const current = this.state();
      if (Number(current.step) !== step - 1 || current.revision !== state.revision) throw new Error(`Step ${step} raced another change: the workflow is at step ${current.step}, revision ${current.revision}`);
      // A faulted step commits nothing but the fault: its batch stays undelivered, so a resume (or the edit that fixes
      // the script, whose table takes the batch) runs it again.
      if (fault) { this.fault(fault); return false; }
      for (const row of results) this.sql.exec("UPDATE workflow_effects SET delivered_step = ? WHERE key = ? AND attempt = ?", step, row.key, row.attempt);
      this.sql.exec("INSERT INTO workflow_steps (step, revision, at, results, issued, replayed, polls, snapshot_bytes, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        step, revision.revision, at, results.length, fresh.length, ran.replayed ? 1 : 0, ran.polls, ran.snapshotBytes, ms);
      this.sql.exec("UPDATE workflow_state SET step = ?, phase = COALESCE(?, phase), updated_at = ? WHERE id = 1", step, ran.phase ?? null, at);
      let ord = Number(this.sql.exec("SELECT COALESCE(MAX(ord), 0) AS ord FROM workflow_effects").one().ord);
      for (const effect of fresh) {
        const before = this.sql.exec("SELECT attempt FROM workflow_effects WHERE key = ? AND current = 1", effect.key).toArray()[0];
        if (before) this.sql.exec("UPDATE workflow_effects SET current = 0 WHERE key = ? AND current = 1", effect.key);
        this.sql.exec(
          `INSERT INTO workflow_effects (key, attempt, current, ord, origin, revision, kind, args, options, phase, status, reason, started, due_at, issued_step, seen_revision, issued_at, ended_at, version)
           VALUES (?, ?, 1, ?, 'script', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
          effect.key, before ? Number(before.attempt) + 1 : 1, ++ord, revision.revision, effect.kind, effect.args, effect.options ?? null, effect.phase ?? null,
          // Issued in the step the script ended in: journaled, never started.
          ran.done ? "cancelled" : "pending", ran.done ? "the script ended before it was awaited" : null,
          ran.done ? null : dueAt(effect.kind, effect.args, effect.options ?? null, at), step, revision.revision, at, ran.done ? at : null, WORKFLOW_RUNNER_VERSION,
        );
      }
      for (const effect of ran.issued) if (effect.reused) this.sql.exec("UPDATE workflow_effects SET seen_revision = ? WHERE key = ? AND current = 1", revision.revision, effect.key);
      for (const log of ran.logs) this.sql.exec("INSERT INTO workflow_log (step, phase, text) VALUES (?, ?, ?)", step, log.phase ?? null, log.text.slice(0, WORKFLOW_LIMITS.logChars));
      if (ran.logs.length) this.sql.exec("DELETE FROM workflow_log WHERE seq <= (SELECT MAX(seq) FROM workflow_log) - ?", WORKFLOW_LIMITS.keptLogs);
      if (ran.done) {
        // Effects still out when the script ended are not needed any more: running children are stopped after the
        // commit (cancelEnded), and their slots given back.
        this.sql.exec("UPDATE workflow_effects SET status = 'cancelled', reason = 'the script ended', due_at = NULL, ended_at = ? WHERE current = 1 AND status = 'pending'", at);
        this.dropSnapshot();
        const done = ran.done;
        this.sql.exec("UPDATE workflow_state SET result = ?, error = ?, fault_code = NULL WHERE id = 1", done.ok ? (done.value ?? null) : null, done.ok ? null : done.error);
        this.setStatus(done.ok ? "completed" : "failed");
        this.event(done.ok ? "completed" : "failed", { step });
        return false;
      }
      if (ran.snapshot) this.storeSnapshot(step, Number(revision.revision), ran.fingerprint, ran.snapshot);
      else {
        this.dropSnapshot();
        this.event("snapshot_dropped", { step, bytes: ran.snapshotBytes, rawBytes: ran.snapshotRawBytes });
      }
      this.refreshLiveness();
      // An edit that issues many new effects waits for a confirm (resume) before they start.
      if (!revision.confirmed) {
        const issued = Number(this.sql.exec("SELECT COUNT(*) AS n FROM workflow_effects WHERE revision = ? AND origin = 'script' AND current = 1 AND issued_step >= ?", revision.revision, revision.start_step).one().n);
        const finished = Number(this.sql.exec("SELECT COUNT(*) AS n FROM workflow_revision_table WHERE revision = ? AND settled = 1", revision.revision).one().n);
        if (finished > 0 && issued * 100 > Number(revision.rerun_confirm_percent) * finished) {
          this.setStatus("paused", "confirm_rerun");
          this.event("confirm_rerun", { revision: revision.revision, issued, finished, percent: Number(revision.rerun_confirm_percent) });
          return false;
        }
      }
      return true;
    });
  }

  private fault(fault: { code: WorkflowFaultCode; message: string }) {
    this.dropSnapshot();
    this.sql.exec("UPDATE workflow_state SET error = ?, fault_code = ? WHERE id = 1", fault.message, fault.code);
    this.setStatus("paused", fault.code);
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

  /** A revision's table: what the journal held when it began, settled values or pending keys. */
  private table(revision: number): NonNullable<WorkflowStepRequest["table"]> {
    return this.sql.exec(
      "SELECT t.key, t.settled, e.ok, e.result FROM workflow_revision_table t JOIN workflow_effects e ON e.key = t.key AND e.attempt = t.attempt WHERE t.revision = ? ORDER BY e.ord",
      revision,
    ).toArray().map(row => row.settled === 1 ? { key: row.key as string, ok: row.ok === 1, value: row.result as string } : { key: row.key as string });
  }

  /** The batches of steps `from` through `through`, as first delivered. */
  private batches(from: number, through: number): WorkflowBatch[] {
    const steps = this.sql.exec("SELECT step, at FROM workflow_steps WHERE step >= ? AND step <= ? AND results > 0 ORDER BY step", from, through).toArray();
    const rows = this.sql.exec("SELECT key, ok, result, delivered_step FROM workflow_effects WHERE delivered_step >= ? AND delivered_step <= ? ORDER BY delivered_step, landed", from, through).toArray();
    const byStep = new Map<number, WorkflowBatch>(steps.map(row => [Number(row.step), { at: Number(row.at), results: [] }]));
    for (const row of rows) byStep.get(Number(row.delivered_step))?.results.push({ key: row.key as string, ok: row.ok === 1, value: row.result as string });
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

  /**
   * Begin a new revision of `code`: the journal's live effects become its table (settled ones answer the script,
   * pending ones it waits for), results not yet delivered are taken by the table, and the next step starts the VM
   * again from it.
   */
  private revise(kind: "edit" | "rerun", code: string, reason: string | null, percent: number, confirmed: boolean) {
    const state = this.state();
    const revision = Number(state.revision) + 1, startStep = Number(state.step) + 1, at = this.now();
    this.sql.exec("UPDATE workflow_effects SET delivered_step = 0 WHERE current = 1 AND delivered_step IS NULL AND landed IS NOT NULL");
    this.sql.exec(
      `INSERT INTO workflow_revision_table (revision, key, attempt, settled)
       SELECT ?, key, attempt, CASE WHEN status IN ('done', 'failed') THEN 1 ELSE 0 END FROM workflow_effects WHERE current = 1 AND status IN ('pending', 'done', 'failed')`,
      revision,
    );
    this.sql.exec("INSERT INTO workflow_revisions (revision, kind, code, reason, at, start_step, rerun_confirm_percent, confirmed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      revision, kind, code, reason, at, startStep, percent, confirmed ? 1 : 0);
    this.sql.exec("UPDATE workflow_state SET revision = ?, result = NULL, error = NULL, fault_code = NULL, updated_at = ? WHERE id = 1", revision, at);
    this.dropSnapshot();
    return revision;
  }

  /** A new attempt of `key`, pending and not started; the old attempt stops counting. */
  private nextAttempt(key: string, origin: "rerun" | "reissue") {
    const row = this.sql.exec("SELECT * FROM workflow_effects WHERE key = ? AND current = 1", key).one();
    const state = this.state();
    const ord = Number(this.sql.exec("SELECT COALESCE(MAX(ord), 0) AS ord FROM workflow_effects").one().ord) + 1;
    this.sql.exec("UPDATE workflow_effects SET current = 0 WHERE key = ? AND current = 1", key);
    const at = this.now();
    this.sql.exec(
      `INSERT INTO workflow_effects (key, attempt, current, ord, origin, revision, kind, args, options, phase, status, started, due_at, issued_step, seen_revision, issued_at, version)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`,
      key, Number(row.attempt) + 1, ord, origin, Number(state.revision), row.kind, row.args, row.options, row.phase,
      dueAt(row.kind as string, row.args as string, row.options as string | null, at), Number(state.step) + 1, Number(state.revision), at, WORKFLOW_RUNNER_VERSION,
    );
  }

  /** No new effects start until resume. With `children: "abort"` running agents stop too, and are re-issued on resume. */
  pause(options: { children?: "abort" } = {}): Promise<void> {
    return this.serial(async () => {
      const status = this.state().status as WorkflowStatus;
      if (status !== "running" && status !== "waiting") throw new WorkflowError(`A ${status} workflow cannot be paused`);
      const stopping = options.children === "abort"
        ? this.sql.exec("SELECT key, attempt, kind, args, options, phase FROM workflow_effects WHERE current = 1 AND status = 'pending' AND started = 1 AND kind = 'agent'").toArray() : [];
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

  /**
   * Go on: re-issue refused and aborted effects under their next attempt, rerun `rerun`'s exact keys (a new revision,
   * so the script sees their new results), and confirm a held edit.
   */
  resume(options: { rerun?: string[] } = {}): Promise<{ revision: number }> {
    return this.serial(async () => {
      const state = this.state(), status = state.status as WorkflowStatus;
      const rerun = [...new Set(options.rerun ?? [])];
      if (status === "aborted") throw new WorkflowError("An aborted workflow cannot be resumed");
      if ((status === "completed" || status === "failed") && !rerun.length) throw new WorkflowError(`A ${status} workflow resumes only to rerun keys`);
      for (const key of rerun) {
        const row = this.sql.exec("SELECT status FROM workflow_effects WHERE key = ? AND current = 1", key).toArray()[0];
        if (!row) throw new WorkflowError(`No effect has the key ${JSON.stringify(key)}`, 404);
        if (row.status !== "done" && row.status !== "failed") throw new WorkflowError(`Effect ${key} is ${row.status}; only a finished effect can be rerun`);
      }
      let revision = Number(state.revision);
      this.storage.transactionSync(() => {
        for (const row of this.sql.exec("SELECT key FROM workflow_effects WHERE current = 1 AND status IN ('refused', 'aborted')").toArray()) this.nextAttempt(row.key as string, "reissue");
        if (rerun.length) {
          for (const key of rerun) this.nextAttempt(key, "rerun");
          const code = this.sql.exec("SELECT code FROM workflow_revisions WHERE revision = ?", revision).one().code as string;
          revision = this.revise("rerun", code, `rerun ${rerun.join(", ")}`, 100, true);
        }
        if (state.pause_reason === "confirm_rerun") this.sql.exec("UPDATE workflow_revisions SET confirmed = 1 WHERE revision = ?", revision);
        if (state.fault_code !== null) this.sql.exec("UPDATE workflow_state SET error = NULL, fault_code = NULL WHERE id = 1");
        this.setStatus("running");
        this.refreshLiveness();
        this.event("resumed", { revision, rerun });
      });
      await this.advance();
      return { revision };
    });
  }

  /** A new revision of the script. Effects whose keys it still asks for keep their results; the reason is kept with it. */
  edit(options: { code: string; reason?: string; rerunConfirmPercent?: number }): Promise<{ revision: number }> {
    return this.serial(async () => {
      const percent = options.rerunConfirmPercent ?? WORKFLOW_LIMITS.rerunConfirmPercent;
      if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new WorkflowError("rerunConfirmPercent must be an integer from 0 to 100", 400);
      if (typeof options.code !== "string" || !options.code.trim()) throw new WorkflowError("An edit needs a script", 400);
      const state = this.state(), status = state.status as WorkflowStatus;
      if (status === "aborted") throw new WorkflowError("An aborted workflow cannot be edited");
      let revision = 0;
      this.storage.transactionSync(() => {
        revision = this.revise("edit", options.code, options.reason ?? null, percent, false);
        // An edit is how a fault is fixed, and how a finished workflow goes on; other pauses stay until resume.
        if (status === "completed" || status === "failed" || (status === "paused" && state.fault_code !== null)) this.setStatus("running");
        this.event("edited", { revision, reason: options.reason ?? null, rerunConfirmPercent: percent });
      });
      await this.advance();
      return { revision };
    });
  }

  /** Stop the workflow for good: running effects are cancelled, the journal and ledger stay readable. */
  abort(): Promise<void> {
    return this.serial(async () => {
      const status = this.state().status as WorkflowStatus;
      if (TERMINAL.has(status)) throw new WorkflowError(`A ${status} workflow cannot be aborted`);
      const live = this.sql.exec("SELECT key, attempt, kind, args, options, phase, started FROM workflow_effects WHERE current = 1 AND status = 'pending'").toArray();
      this.storage.transactionSync(() => {
        this.sql.exec("UPDATE workflow_effects SET status = 'aborted', reason = 'workflow aborted', due_at = NULL, ended_at = ? WHERE current = 1 AND status = 'pending'", this.now());
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
        if (usd !== null && spent >= usd && (status === "running" || status === "waiting")) {
          this.setStatus("budget_exhausted");
          this.event("budget_exhausted", { spentUsd: spent, budgetUsd: usd });
        } else if (status === "budget_exhausted" && (usd === null || spent < usd)) {
          // Effects refused for the budget (a child's share ran out) go again under their next attempt.
          for (const row of this.sql.exec("SELECT key FROM workflow_effects WHERE current = 1 AND status = 'refused'").toArray()) this.nextAttempt(row.key as string, "reissue");
          this.setStatus("running");
          this.refreshLiveness();
        }
      });
      await this.advance();
    });
  }

  /**
   * The object's one alarm: due timers land, expired gates take their recommendation or pause the workflow, a step
   * window that has moved lets steps run again, the capacity lease is renewed, and the sweep starts what a crash left
   * unstarted and asks the executor after effects that have not landed. Each concern is isolated: one that throws is
   * recorded and the others still run, and the alarm is armed again whatever happens, never sooner than a second from
   * now (thirty after a failure), so a concern that keeps failing cannot spin the object.
   */
  alarm(): Promise<void> {
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
        if (TERMINAL.has(state.status as WorkflowStatus)) { await isolated("capacity", () => this.capacityHousekeeping()); return; }
        for (const row of this.sql.exec("SELECT key, attempt, kind, args, options FROM workflow_effects WHERE current = 1 AND status = 'pending' AND due_at IS NOT NULL AND due_at <= ? ORDER BY due_at, ord", now).toArray()) {
          await isolated(`${row.kind} ${row.key}`, () => this.expire(row));
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
              if (status === "running" || status === "waiting") this.setStatus("paused", "capacity_refused");
              this.event("capacity_refused", { message: renewed.message });
            });
            this.sql.exec("UPDATE workflow_state SET renewed_at = ? WHERE id = 1", now);
          });
        }
        const live = state.status === "running" || state.status === "waiting";
        if (live && (state.swept_at === null || now - Number(state.swept_at) >= WORKFLOW_LIMITS.sweepMs)) {
          this.sql.exec("UPDATE workflow_state SET swept_at = ? WHERE id = 1", now);
          if (this.executor.poll) {
            const stale = this.sql.exec(
              "SELECT key, attempt, kind, args, options, phase FROM workflow_effects WHERE current = 1 AND status = 'pending' AND started = 1 AND kind IN ('agent', 'gate') AND started_at <= ?",
              now - WORKFLOW_LIMITS.sweepMs,
            ).toArray();
            for (const row of stale) {
              await isolated(`poll ${row.key}`, async () => {
                const ended = await this.executor.poll!(this.started(row));
                if (ended) this.record(row.key as string, Number(row.attempt), ended.outcome, ended.usage);
              });
            }
          }
        }
        await isolated("steps", () => this.advance(true));
      } finally {
        await this.arm(now + (failed ? 30_000 : 1_000));
      }
    });
  }

  /** A due timer lands; an expired gate takes its recommendation, or pauses the workflow. */
  private expire(row: Row) {
    if (row.kind === "sleep") { this.record(row.key as string, Number(row.attempt), { ok: true, value: null }); return; }
    const options = JSON.parse((row.options as string | null) ?? "{}") as { onExpire?: string };
    const args = JSON.parse(row.args as string) as { recommended?: unknown };
    if (options.onExpire === "recommended" && args.recommended !== undefined) {
      this.record(row.key as string, Number(row.attempt), { ok: true, value: args.recommended });
      this.storage.transactionSync(() => this.event("gate_expired", { key: row.key, took: "recommended" }));
      return;
    }
    this.storage.transactionSync(() => {
      this.sql.exec("UPDATE workflow_effects SET due_at = NULL WHERE key = ? AND attempt = ?", row.key, row.attempt);
      const status = this.state().status;
      if (status === "running" || status === "waiting") this.setStatus("paused", "waiting_on_gate");
      this.event("gate_expired", { key: row.key, took: "pause" });
    });
  }

  /**
   * The earliest of the next timer, gate expiry, step window, capacity renew and sweep; none once the workflow has
   * ended and given its capacity back. The sweep runs only while the workflow runs or waits: a paused one wakes for its
   * timers, gates and renew, not every five minutes.
   */
  nextAlarm(): number | null {
    const state = this.state();
    const capacity = this.options.capacity && state.capacity_open ? this.options.capacity : undefined;
    if (TERMINAL.has(state.status as WorkflowStatus)) return capacity ? this.now() + 30_000 : null;
    const candidates: number[] = [];
    const due = this.sql.exec("SELECT MIN(due_at) AS at FROM workflow_effects WHERE current = 1 AND status = 'pending' AND due_at IS NOT NULL").one().at;
    if (due !== null) candidates.push(Number(due));
    if (state.throttled_until !== null) candidates.push(Number(state.throttled_until));
    if (state.status === "running" || state.status === "waiting") {
      // A result landed but its step did not run (the step failed): try again (arm's floor spaces the tries out).
      // While the step window is full, the window's end (above) is when to try.
      const throttled = state.throttled_until !== null && Number(state.throttled_until) > this.now();
      if (!throttled && this.sql.exec("SELECT 1 FROM workflow_effects WHERE current = 1 AND delivered_step IS NULL AND landed IS NOT NULL LIMIT 1").toArray().length) candidates.push(this.now());
      const unlanded = this.sql.exec("SELECT 1 FROM workflow_effects WHERE current = 1 AND status = 'pending' AND (kind IN ('agent', 'gate') OR started = 0) LIMIT 1").toArray().length > 0;
      if (unlanded) candidates.push((state.swept_at === null ? this.now() : Number(state.swept_at)) + WORKFLOW_LIMITS.sweepMs);
    }
    if (capacity) candidates.push(Number(state.renewed_at ?? this.now()) + capacity.leaseMs / 2);
    return candidates.length ? Math.min(...candidates) : null;
  }

  /** Arm the alarm for `nextAlarm()`, no sooner than `notBefore`. */
  private async arm(notBefore?: number) {
    const next = this.nextAlarm();
    await this.options.alarm?.set(next === null || notBefore === undefined ? next : Math.max(next, notBefore));
  }
}

/** When a timer fires, or a gate expires; null for other effects. */
function dueAt(kind: string, args: string, options: string | null, at: number): number | null {
  if (kind === "sleep") return at + (JSON.parse(args) as { seconds: number }).seconds * 1000;
  if (kind === "gate") return at + ((options === null ? undefined : (JSON.parse(options) as { expiresInSeconds?: number }).expiresInSeconds) ?? WORKFLOW_LIMITS.gateSeconds) * 1000;
  return null;
}
