// The workflow runner's core (docs/design/swarm-workflows.md, "Execution"; docs/design/workflow-step-snapshots.md):
// the journal, the step driver and snapshot storage, in the SQLite of the object that owns a workflow. It has no route
// and no Durable Object of its own yet; the workflow object will hold one runner. Effects run behind `EffectExecutor`.
//
// A step:
// 1. takes the results that landed since the last step (in landing order) as this step's batch;
// 2. asks the sandbox (exchange protocol 3) to restore the VM from its snapshot, or without one to replay every
//    earlier step's batch, and to apply the batch and run the script until it waits again;
// 3. checks the effects the script issued against the journal (a replay must issue the journal's effects, in order;
//    new effects must be new);
// 4. commits, in one transaction: the batch as delivered, the new effects as `pending`, the logs, the new snapshot
//    (or none past the cap) and the workflow's state;
// 5. only then starts the new effects. A crash before 4 leaves nothing: the step runs again from the same snapshot
//    with the same batch. A crash between 4 and 5 leaves `pending` rows not marked started, which `wake()` starts;
//    the executor dedupes a start by `key:attempt`.
import type { IssuedEffect, WorkflowBatch, WorkflowFaultCode, WorkflowSandbox, WorkflowStepOutcome, WorkflowStepRequest } from "../codemode/workflow-protocol.ts";
import { WORKFLOW_STEP_PROTOCOL } from "../codemode/workflow-protocol.ts";

/** The runner's own version, on every journal row it writes: a runner rolled back past a row's version faults. */
export const WORKFLOW_RUNNER_VERSION = 1;
/** DO SQLite caps a value at 2 MB; snapshots are stored in rows of at most this. */
export const SNAPSHOT_CHUNK_BYTES = 1024 * 1024;
/** A gzipped snapshot over this is not kept: the next step replays from the journal. */
export const SNAPSHOT_CAP_BYTES = 8 * 1024 * 1024;
/** A result the guest gets inline, as JSON; a larger one must be a handle (`EffectOutcome.handle`). */
export const INLINE_RESULT_BYTES = 8 * 1024;

export interface StartedEffect { key: string; attempt: number; kind: string; args: unknown; phase: string | undefined }

/** Starts effects. Results come back through `WorkflowRunner.land()`. */
export interface EffectExecutor {
  /**
   * Start `effect`. Called after its row is committed, and possibly again for the same `key:attempt` after a restart:
   * a second start of one already started must not start it twice.
   */
  start(effect: StartedEffect): Promise<void>;
}

export type EffectOutcome =
  | { ok: true; value: unknown }
  /** A result body kept elsewhere (the workflow's volume); the guest gets `{ $handle: ref, bytes, sha256 }`. */
  | { ok: true; handle: { ref: string; bytes: number; sha256: string } }
  | { ok: false; error: string };

export interface WorkflowStorage {
  sql: SqlStorage;
  transactionSync<T>(fn: () => T): T;
}

export type WorkflowStatus = "running" | "done" | "failed" | "faulted";

export interface WorkflowState {
  status: WorkflowStatus;
  step: number;
  phase: string | undefined;
  result?: unknown;
  error?: string;
  fault?: { code: WorkflowFaultCode; message: string };
}

/** What `init` creates a workflow with. `seed` and `startedAt` fix its `random()` and its clock's start. */
export interface WorkflowInit { code: string; seed: number; startedAt: number }

/** A sandbox stub without a `step` method is a sandbox Worker from before protocol 3. */
export function stepUnsupported(error: unknown) {
  return error instanceof Error && /\bstep\b/.test(error.message) && /(not a function|does not (implement|have)|no such method|undefined)/i.test(error.message);
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS workflow_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), code TEXT NOT NULL, seed INTEGER NOT NULL, started_at INTEGER NOT NULL,
    status TEXT NOT NULL, step INTEGER NOT NULL, phase TEXT, result TEXT, error TEXT, fault_code TEXT, version INTEGER NOT NULL)`,
  // key/attempt is an effect's identity: a rerun is a new attempt (later phases). `ord` is the order the script issued
  // effects in, which a replay must reproduce. `landed` orders results into batches; `delivered_step` is the step
  // whose batch held the result.
  `CREATE TABLE IF NOT EXISTS workflow_effects (
    key TEXT NOT NULL, attempt INTEGER NOT NULL, ord INTEGER NOT NULL UNIQUE, kind TEXT NOT NULL, args TEXT NOT NULL, phase TEXT,
    status TEXT NOT NULL, started INTEGER NOT NULL DEFAULT 0, ok INTEGER, result TEXT, landed INTEGER UNIQUE,
    issued_step INTEGER NOT NULL, delivered_step INTEGER, issued_at INTEGER NOT NULL, ended_at INTEGER, version INTEGER NOT NULL,
    PRIMARY KEY (key, attempt))`,
  `CREATE INDEX IF NOT EXISTS workflow_effects_status ON workflow_effects (status, landed)`,
  `CREATE INDEX IF NOT EXISTS workflow_effects_delivered ON workflow_effects (delivered_step, landed)`,
  `CREATE TABLE IF NOT EXISTS workflow_steps (
    step INTEGER PRIMARY KEY, at INTEGER NOT NULL, results INTEGER NOT NULL, issued INTEGER NOT NULL, replayed INTEGER NOT NULL,
    polls INTEGER NOT NULL, snapshot_bytes INTEGER NOT NULL, ms REAL NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS workflow_snapshot (
    id INTEGER PRIMARY KEY CHECK (id = 1), step INTEGER NOT NULL, fingerprint TEXT NOT NULL, bytes INTEGER NOT NULL, chunks INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS workflow_snapshot_chunks (chunk INTEGER PRIMARY KEY, data BLOB NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS workflow_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, step INTEGER NOT NULL, phase TEXT, text TEXT NOT NULL)`,
];

type Row = Record<string, SqlStorageValue>;
const bytesOf = (value: SqlStorageValue) => value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);

export class WorkflowRunner {
  private readonly sql: SqlStorage;
  private readonly storage: WorkflowStorage;
  private readonly sandbox: WorkflowSandbox;
  private readonly executor: EffectExecutor;
  private readonly options: { snapshotCap?: number; now?: () => number };
  private queue: Promise<unknown> = Promise.resolve();
  /** Refusals and replays, for the host's telemetry. */
  readonly events: { step: number; kind: "refused" | "replayed" | "snapshot_dropped"; message: string }[] = [];

  constructor(storage: WorkflowStorage, sandbox: WorkflowSandbox, executor: EffectExecutor, options: { snapshotCap?: number; now?: () => number } = {}) {
    this.storage = storage;
    this.sandbox = sandbox;
    this.executor = executor;
    this.options = options;
    this.sql = storage.sql;
    for (const statement of SCHEMA) this.sql.exec(statement);
  }

  /** Create the workflow unless it exists; its first step runs on `wake()`. */
  init(workflow: WorkflowInit) {
    this.sql.exec(
      "INSERT OR IGNORE INTO workflow_state (id, code, seed, started_at, status, step, version) VALUES (1, ?, ?, ?, 'running', 0, ?)",
      workflow.code, workflow.seed >>> 0, workflow.startedAt, WORKFLOW_RUNNER_VERSION,
    );
  }

  state(): WorkflowState {
    const row = this.sql.exec("SELECT status, step, phase, result, error, fault_code FROM workflow_state WHERE id = 1").toArray()[0];
    if (!row) throw new Error("No workflow");
    const state: WorkflowState = { status: row.status as WorkflowStatus, step: Number(row.step), phase: (row.phase as string | null) ?? undefined };
    if (row.result !== null) state.result = row.result === undefined ? undefined : JSON.parse(row.result as string);
    if (row.error !== null) state.error = row.error as string;
    if (row.fault_code !== null) state.fault = { code: row.fault_code as WorkflowFaultCode, message: row.error as string };
    return state;
  }

  effects() {
    return this.sql.exec("SELECT key, attempt, kind, status, phase, ord, delivered_step FROM workflow_effects ORDER BY ord").toArray();
  }

  logs() {
    return this.sql.exec("SELECT step, phase, text FROM workflow_log ORDER BY seq").toArray();
  }

  /**
   * After a start or a restart: start every effect committed but not known to have started, then run the steps that
   * landed results are waiting for.
   */
  wake(): Promise<void> {
    return this.serial(async () => {
      for (const row of this.sql.exec("SELECT key, attempt, kind, args, phase FROM workflow_effects WHERE status = 'pending' AND started = 0 ORDER BY ord").toArray())
        await this.begin(row);
      await this.pump();
    });
  }

  /** Effect `key:attempt` ended. A second landing of the same attempt is ignored. */
  land(key: string, attempt: number, outcome: EffectOutcome): Promise<void> {
    const row = this.sql.exec("SELECT status FROM workflow_effects WHERE key = ? AND attempt = ?", key, attempt).toArray()[0];
    if (!row) throw new Error(`Effect ${key}:${attempt} is not in the journal`);
    if (row.status !== "pending") return this.queue.then(() => undefined);
    let value: string;
    if (!outcome.ok) value = JSON.stringify({ message: outcome.error });
    else if ("handle" in outcome) value = JSON.stringify({ $handle: outcome.handle.ref, bytes: outcome.handle.bytes, sha256: outcome.handle.sha256 });
    else {
      value = JSON.stringify(outcome.value ?? null);
      const bytes = new TextEncoder().encode(value).byteLength;
      if (bytes > INLINE_RESULT_BYTES) throw new Error(`Effect ${key}'s result is ${bytes} bytes; over ${INLINE_RESULT_BYTES} it must be landed as a handle`);
    }
    this.sql.exec(
      "UPDATE workflow_effects SET status = ?, ok = ?, result = ?, ended_at = ?, landed = (SELECT COALESCE(MAX(landed), 0) + 1 FROM workflow_effects) WHERE key = ? AND attempt = ? AND status = 'pending'",
      outcome.ok ? "done" : "failed", outcome.ok ? 1 : 0, value, this.now(), key, attempt,
    );
    return this.serial(() => this.pump());
  }

  private now() { return (this.options.now ?? Date.now)(); }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async pump() {
    while (await this.step()) { /* one step per landed batch */ }
  }

  private async begin(row: Row) {
    await this.executor.start({ key: row.key as string, attempt: Number(row.attempt), kind: row.kind as string, args: JSON.parse(row.args as string), phase: (row.phase as string | null) ?? undefined });
    this.sql.exec("UPDATE workflow_effects SET started = 1 WHERE key = ? AND attempt = ?", row.key, row.attempt);
  }

  /** Run one step if one is due. Returns whether it ran. */
  private async step(): Promise<boolean> {
    const state = this.sql.exec("SELECT code, seed, started_at, status, step FROM workflow_state WHERE id = 1").toArray()[0];
    if (!state || state.status !== "running") return false;
    const step = Number(state.step) + 1;
    const results = this.sql.exec("SELECT key, attempt, ok, result FROM workflow_effects WHERE delivered_step IS NULL AND landed IS NOT NULL ORDER BY landed").toArray();
    if (step > 1 && results.length === 0) return false;
    const newest = Number(this.sql.exec("SELECT COALESCE(MAX(version), 0) AS v FROM workflow_effects").one().v);
    if (newest > WORKFLOW_RUNNER_VERSION) {
      this.commitEnd(step, "faulted", { code: "journal_version", message: `The journal has rows from runner version ${newest}; this runner is version ${WORKFLOW_RUNNER_VERSION}` });
      return false;
    }
    const started = performance.now();
    const at = this.now();
    const deliver: WorkflowBatch | undefined = step > 1 ? { at, results: results.map(row => ({ key: row.key as string, ok: row.ok === 1, value: row.result as string })) } : undefined;
    const request: WorkflowStepRequest = {
      protocol: WORKFLOW_STEP_PROTOCOL, code: state.code as string, seed: Number(state.seed), startedAt: Number(state.started_at),
      snapshotCap: this.options.snapshotCap ?? SNAPSHOT_CAP_BYTES, deliver,
    };
    const snapshot = this.loadSnapshot(step - 1);
    if (snapshot) request.restore = snapshot;
    else if (step > 1) request.replay = this.batches(step - 1);
    let outcome = await this.call(request);
    if (outcome.kind === "refused") {
      this.events.push({ step, kind: "refused", message: outcome.message });
      delete request.restore;
      request.replay = this.batches(step - 1);
      outcome = await this.call(request);
      if (outcome.kind === "refused") throw new Error(`The sandbox refused a replay: ${outcome.message}`);
    }
    if (outcome.replayed && step > 1) this.events.push({ step, kind: "replayed", message: `replayed ${step - 1} steps` });
    const fault = outcome.fault ?? this.check(outcome.issued, step);
    const fresh = outcome.issued.filter(effect => !effect.replayed);
    let status: WorkflowStatus = "running";
    if (fault) status = "faulted";
    else if (outcome.done) status = outcome.done.ok ? "done" : "failed";
    const ms = performance.now() - started;
    const begun: Row[] = [];
    this.storage.transactionSync(() => {
      const current = Number(this.sql.exec("SELECT step FROM workflow_state WHERE id = 1").one().step);
      if (current !== step - 1) throw new Error(`Step ${step} raced another: the workflow is at step ${current}`);
      for (const row of results) this.sql.exec("UPDATE workflow_effects SET delivered_step = ? WHERE key = ? AND attempt = ?", step, row.key, row.attempt);
      if (!fault) {
        let ord = Number(this.sql.exec("SELECT COALESCE(MAX(ord), 0) AS ord FROM workflow_effects").one().ord);
        for (const effect of fresh) {
          this.sql.exec(
            "INSERT INTO workflow_effects (key, attempt, ord, kind, args, phase, status, issued_step, issued_at, version) VALUES (?, 1, ?, ?, ?, ?, 'pending', ?, ?, ?)",
            effect.key, ++ord, effect.kind, effect.args, effect.phase ?? null, step, at, WORKFLOW_RUNNER_VERSION,
          );
          begun.push({ key: effect.key, attempt: 1, kind: effect.kind, args: effect.args, phase: effect.phase ?? null });
        }
      }
      for (const log of outcome.logs) this.sql.exec("INSERT INTO workflow_log (step, phase, text) VALUES (?, ?, ?)", step, log.phase ?? null, log.text);
      this.sql.exec("INSERT INTO workflow_steps (step, at, results, issued, replayed, polls, snapshot_bytes, ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        step, at, results.length, fresh.length, outcome.replayed ? 1 : 0, outcome.polls, outcome.snapshotBytes, ms);
      if (status === "running" && outcome.snapshot) this.storeSnapshot(step, outcome.fingerprint, outcome.snapshot);
      else this.dropSnapshot();
      const done = outcome.done;
      this.sql.exec(
        "UPDATE workflow_state SET step = ?, status = ?, phase = COALESCE(?, phase), result = ?, error = ?, fault_code = ? WHERE id = 1",
        step, status, outcome.phase ?? null,
        status === "done" && done?.ok ? (done.value ?? null) : null,
        fault ? fault.message : status === "failed" && done && !done.ok ? done.error : null,
        fault ? fault.code : null,
      );
    });
    if (status === "running" && !outcome.snapshot && outcome.snapshotBytes > 0)
      this.events.push({ step, kind: "snapshot_dropped", message: `The snapshot is ${outcome.snapshotBytes} bytes, over the cap; the next step replays` });
    // Started only once committed. A start that fails leaves the row for wake() to start again.
    for (const row of begun) await this.begin(row);
    return status === "running";
  }

  /**
   * A replay issues exactly the journal's effects, in the journal's order; a new effect is never one the journal has.
   * Anything else means the script depends on something it did not journal.
   */
  private check(issued: IssuedEffect[], step: number): { code: WorkflowFaultCode; message: string } | undefined {
    const replayed = issued.filter(effect => effect.replayed);
    if (replayed.length) {
      const journal = this.sql.exec("SELECT key, kind, args FROM workflow_effects WHERE issued_step < ? ORDER BY ord", step).toArray();
      for (let i = 0; i < Math.max(journal.length, replayed.length); i++) {
        const want = journal[i], got = replayed[i];
        if (!want || !got || want.key !== got.key || want.kind !== got.kind || want.args !== got.args)
          return { code: "nondeterministic_script", message: `On replay the script's effect ${i + 1} is ${got ? `${got.kind} ${got.key}` : "missing"}, but the journal's is ${want ? `${want.kind} ${want.key}` : "missing"}` };
      }
    }
    for (const effect of issued.filter(effect => !effect.replayed)) {
      const row = this.sql.exec("SELECT kind FROM workflow_effects WHERE key = ?", effect.key).toArray()[0];
      if (row) return { code: "nondeterministic_script", message: `The script issued ${effect.kind} ${effect.key} again, which the journal already has` };
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

  /** Every step's batch from step 2 through `through`, as first delivered. */
  private batches(through: number): WorkflowBatch[] {
    const steps = this.sql.exec("SELECT step, at FROM workflow_steps WHERE step >= 2 AND step <= ? ORDER BY step", through).toArray();
    const rows = this.sql.exec("SELECT key, ok, result, delivered_step FROM workflow_effects WHERE delivered_step >= 2 AND delivered_step <= ? ORDER BY delivered_step, landed", through).toArray();
    const byStep = new Map<number, WorkflowBatch>(steps.map(row => [Number(row.step), { at: Number(row.at), results: [] }]));
    for (const row of rows) byStep.get(Number(row.delivered_step))!.results.push({ key: row.key as string, ok: row.ok === 1, value: row.result as string });
    return [...byStep.values()];
  }

  private loadSnapshot(step: number): Uint8Array | undefined {
    const head = this.sql.exec("SELECT step, bytes, chunks FROM workflow_snapshot WHERE id = 1").toArray()[0];
    if (!head || Number(head.step) !== step) return undefined;
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

  private storeSnapshot(step: number, fingerprint: string, bytes: Uint8Array) {
    this.sql.exec("DELETE FROM workflow_snapshot_chunks");
    let chunks = 0;
    for (let offset = 0; offset < bytes.byteLength; offset += SNAPSHOT_CHUNK_BYTES)
      this.sql.exec("INSERT INTO workflow_snapshot_chunks (chunk, data) VALUES (?, ?)", chunks++, bytes.subarray(offset, offset + SNAPSHOT_CHUNK_BYTES));
    this.sql.exec("INSERT OR REPLACE INTO workflow_snapshot (id, step, fingerprint, bytes, chunks) VALUES (1, ?, ?, ?, ?)", step, fingerprint, bytes.byteLength, chunks);
  }

  private dropSnapshot() {
    this.sql.exec("DELETE FROM workflow_snapshot_chunks");
    this.sql.exec("DELETE FROM workflow_snapshot");
  }

  private commitEnd(step: number, status: WorkflowStatus, fault: { code: WorkflowFaultCode; message: string }) {
    this.storage.transactionSync(() => {
      this.sql.exec("UPDATE workflow_state SET status = ?, error = ?, fault_code = ? WHERE id = 1 AND step = ?", status, fault.message, fault.code, step - 1);
      this.dropSnapshot();
    });
  }
}
