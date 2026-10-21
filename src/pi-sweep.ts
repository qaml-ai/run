import type { Db } from "./db.ts";
import { transaction } from "./db.ts";
import { clock } from "./node-context.ts";
import { safeError } from "./metrics.ts";

/** Off, a report of what migrating each legacy agent would do, or migrating them. */
export type PiSweepMode = "off" | "dry-run" | "on";
const RANK: Record<PiSweepMode, number> = { off: 0, "dry-run": 1, on: 2 };
export const PI_SWEEP_MODES = Object.keys(RANK) as PiSweepMode[];

/** An agent the sweep takes next, as the database saw it then. */
export interface PiSweepCandidate { id: string; tenant: string; pendingRuns: boolean; owned: boolean }
/** What came of one agent: `outcome` (migrated, would_migrate, skipped_<why>, ...) and ids or sizes. */
export interface PiSweepResult { outcome: string; detail?: Record<string, unknown> }

export interface PiSweepOptions {
  db: Db;
  /** The node's AGENT_PI_SWEEP: the most the operator's mode may do here. */
  setting: PiSweepMode;
  /** One agent: open it so it is imported (or, dry, say what that would find). ClientSessions.piSweepAgent. */
  sweep(candidate: PiSweepCandidate, dryRun: boolean): Promise<PiSweepResult>;
  /** Why this node should not take an agent now (short of memory, its pool waiting, full, leaving), or undefined. */
  busy(): Promise<string | undefined>;
  /** Between agents. */
  paceMs: number;
  /** After a pass reaches the end, before the next starts from the beginning. */
  repassMs: number;
  /** While off or paused, how often the operator's mode is read again: how soon turning it on takes effect. */
  pollMs?: number;
  /** The first and longest wait while `busy` says no; it doubles in between. */
  backoffMs?: [number, number];
}

/**
 * The Pi migration sweep: retained agents not yet on Pi durable are opened one at a time, so each migrates as its next
 * open would, then let go. Every node with AGENT_PI_SWEEP set runs one, one agent at a time; nodes take agents from a
 * shared cursor (the `pi_sweep` row), so none is taken twice in a pass, and a restart goes on where the fleet was. The
 * operator's mode (`control`) is read before each agent: setting it off stops every node within an agent's time.
 * Logs: `pi_sweep_agent` per agent, `pi_sweep_progress` each minute (with what is left), `pi_sweep_backoff`, and
 * `pi_sweep_pass_done`.
 */
export class PiSweep {
  private stopped = false;
  private wake?: () => void;
  private running?: Promise<void>;
  private counts: Record<string, number> = {};
  private countsMode?: PiSweepMode;
  private totals = { bytes: 0, contextBytes: 0, noSystem: 0 };
  private lastProgress = 0;
  private lastBackoff = new Map<string, number>();

  private readonly options: PiSweepOptions;

  constructor(options: PiSweepOptions) { this.options = options; }

  start() {
    if (this.options.setting === "off" || this.running) return;
    this.running = this.loop().catch(error => console.error(JSON.stringify({ type: "pi_sweep_failed", error: safeError(error) })));
  }

  /** Stop after the agent in hand, if any. */
  async stop() {
    this.stopped = true;
    this.wake?.();
    await this.running;
  }

  /** A wait that `stop` cuts short. */
  private wait(ms: number) {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>(resolve => {
      const timer = clock().setTimeout(() => { this.wake = undefined; resolve(); }, ms);
      this.wake = () => { clock().clearTimeout(timer); this.wake = undefined; resolve(); };
    });
  }

  private async loop() {
    const { pollMs = 10_000, backoffMs: [first, longest] = [5_000, 60_000] } = this.options;
    let backoff = first, failures = 0;
    while (!this.stopped) {
      let busy: string | undefined, next: Awaited<ReturnType<PiSweep["next"]>> | undefined;
      try { busy = await this.options.busy(); if (!busy) next = await this.next(); }
      catch (error) {
        busy = "error";
        this.note("pi_sweep_backoff", "error", { reason: "error", error: safeError(error) });
      }
      if (busy || !next) {
        if (busy !== "error") this.note("pi_sweep_backoff", busy!, { reason: busy, waitMs: backoff });
        await this.wait(backoff);
        backoff = Math.min(longest, backoff * 2);
        continue;
      }
      backoff = first;
      if (this.stopped) break;
      if (next.state === "idle") { await this.wait(pollMs); continue; }
      if (next.state === "finished") {
        console.log(JSON.stringify({ type: "pi_sweep_pass_done", mode: next.mode, remaining: await this.remaining() }));
        await this.wait(pollMs);
        continue;
      }
      const dryRun = next.mode === "dry-run";
      // Each mode's counts on their own: a dry run's are its report.
      if (next.mode !== this.countsMode) { this.counts = {}; this.totals = { bytes: 0, contextBytes: 0, noSystem: 0 }; this.countsMode = next.mode; }
      const started = clock().monotonic();
      let result: PiSweepResult;
      try { result = await this.options.sweep(next.candidate, dryRun); failures = 0; }
      catch (error) { result = { outcome: "failed", detail: { error: safeError(error) } }; failures++; }
      this.counts[result.outcome] = (this.counts[result.outcome] ?? 0) + 1;
      // What the imports would write (a dry run measures it), and how many make their system message from listed tools.
      const detail = result.detail ?? {};
      for (const key of ["bytes", "contextBytes"] as const) if (typeof detail[key] === "number") this.totals[key] += detail[key] as number;
      if (detail.system === false) this.totals.noSystem++;
      console.log(JSON.stringify({ type: "pi_sweep_agent", mode: next.mode, agent: next.candidate.id, tenant: next.candidate.tenant,
        outcome: result.outcome, ms: Math.round(clock().monotonic() - started), ...result.detail }));
      if (clock().now() - this.lastProgress >= 60_000) {
        this.lastProgress = clock().now();
        console.log(JSON.stringify({ type: "pi_sweep_progress", mode: next.mode, outcomes: this.counts, ...this.totals, remaining: await this.remaining() }));
      }
      // Failing one after another (storage or the database in trouble): the longest wait, then on.
      if (failures >= 5) {
        console.log(JSON.stringify({ type: "pi_sweep_backoff", reason: "failures", failures, waitMs: longest }));
        failures = 0;
        await this.wait(longest);
      }
      await this.wait(this.options.paceMs);
    }
  }

  /** A line at most once a minute per `key`. */
  private note(type: string, key: string, fields: Record<string, unknown>) {
    const now = clock().now();
    if (now - (this.lastBackoff.get(key) ?? 0) < 60_000) return;
    this.lastBackoff.set(key, now);
    console.log(JSON.stringify({ type, ...fields }));
  }

  /** Agents kept and not yet on Pi, migrating or not. */
  async remaining() {
    try { return Number((await this.options.db.query(`select count(*) as count from agents a where ${LEGACY}`, [clock().now()])).rows[0].count); }
    catch { return undefined; }
  }

  /**
   * The next agent for this node, its cursor moved past it under the row's lock so no other node takes it this pass:
   * idle while the mode is off (or a pass finished less than `repassMs` ago), finished when the pass found none left.
   */
  private next(): Promise<{ state: "idle" } | { state: "finished"; mode: PiSweepMode } | { state: "agent"; mode: PiSweepMode; candidate: PiSweepCandidate }> {
    return transaction(this.options.db, async sql => {
      const control = (await sql.query<{ mode: PiSweepMode; dry_run_cursor: string; on_cursor: string; dry_run_finished_at: string | null; on_finished_at: string | null }>(
        "select mode, dry_run_cursor, on_cursor, dry_run_finished_at, on_finished_at from pi_sweep where id for update")).rows[0];
      const mode = effectiveMode(this.options.setting, control?.mode ?? "off");
      if (mode === "off") return { state: "idle" as const };
      const column = mode === "on" ? "on" : "dry_run";
      const finished = control[`${column}_finished_at`];
      const now = clock().now();
      if (finished !== null && now - Number(finished) < this.options.repassMs) return { state: "idle" as const };
      const cursor = finished !== null ? "" : control[`${column}_cursor`];
      const row = (await sql.query<{ id: string; tenant: string; pending_runs: boolean; owned: boolean }>(`
        select a.id, a.tenant, a.pending_runs,
          exists (select 1 from actor_owners o join runtime_nodes n on n.node = o.node and n.session = o.session and n.expires_at > now() where o.actor = a.id) as owned
        from agents a where ${LEGACY} and a.id > $2 order by a.id limit 1`, [now, cursor])).rows[0];
      if (!row) {
        await sql.query(`update pi_sweep set ${column}_cursor = '', ${column}_finished_at = $1, updated_at = $1 where id`, [now]);
        return { state: "finished" as const, mode };
      }
      await sql.query(`update pi_sweep set ${column}_cursor = $1, ${column}_finished_at = null, updated_at = $2 where id`, [row.id, now]);
      return { state: "agent" as const, mode, candidate: { id: row.id, tenant: row.tenant, pendingRuns: row.pending_runs, owned: row.owned } };
    });
  }
}

/** Kept agents with no Pi host document: what the sweep walks. `$1` is now. Pi stores document kinds as JSON text. */
const LEGACY = `not a.revoked and a.purged_at is null and (a.expires_at is null or a.expires_at > $1)
  and not exists (select 1 from pi_durable_documents d where d.session_id = a.id and d.kind = '"camel.host.snapshot"')`;

/** What a node runs: the operator's mode, but no more than its own setting allows. */
export function effectiveMode(setting: PiSweepMode, operator: PiSweepMode): PiSweepMode {
  return RANK[setting] <= RANK[operator] ? setting : operator;
}

/** The operator's view and control (GET and PUT /v1/operations/pi-sweep). */
export class PiSweepControl {
  private readonly db: Db;
  private readonly setting: PiSweepMode;

  constructor(db: Db, setting: PiSweepMode) { this.db = db; this.setting = setting; }

  async status() {
    const row = (await this.db.query("select mode, dry_run_cursor, on_cursor, dry_run_finished_at, on_finished_at, updated_at from pi_sweep where id")).rows[0];
    const remaining = Number((await this.db.query(`select count(*) as count from agents a where ${LEGACY}`, [clock().now()])).rows[0].count);
    const at = (value: string | null) => value === null ? null : new Date(Number(value)).toISOString();
    return {
      setting: this.setting, mode: row.mode as PiSweepMode, effective: effectiveMode(this.setting, row.mode), remaining,
      dryRun: { cursor: row.dry_run_cursor || null, finishedAt: at(row.dry_run_finished_at) },
      on: { cursor: row.on_cursor || null, finishedAt: at(row.on_finished_at) },
    };
  }

  /** Set the operator's mode; `restart` starts both passes again from the first agent. */
  async set(mode: PiSweepMode, restart = false) {
    await this.db.query(`update pi_sweep set mode = $1, updated_at = $2${restart ? ", dry_run_cursor = '', on_cursor = '', dry_run_finished_at = null, on_finished_at = null" : ""} where id`, [mode, clock().now()]);
    return this.status();
  }
}

/**
 * Why a node should take no agent now, or undefined: it is leaving, a database request is waiting for a connection,
 * its recent turns waited past `maxFirstRequestMs` for their first model request (p95 of TimeToFirstRequestMs, the
 * runtime's own part of a turn's latency: loads, journal reads and commits, which an import competes with), its resident
 * memory is past AGENT_MEMORY_HIGH_BYTES (`memoryHigh`), it is full, or its container memory is past `maxMemoryBytes`.
 * Live traffic comes first.
 */
export async function piSweepGate(node: { leaving: boolean; dbWaiting: number; firstRequestP95?: number; maxFirstRequestMs?: number; memoryHigh: boolean; full: boolean; maxMemoryBytes?: number; memoryBytes(): Promise<number> }) {
  if (node.leaving) return "leaving";
  if (node.dbWaiting > 0) return "db_waiting";
  if (node.maxFirstRequestMs && node.firstRequestP95 !== undefined && node.firstRequestP95 > node.maxFirstRequestMs) return "turn_latency";
  if (node.memoryHigh) return "memory_high";
  if (node.full) return "node_full";
  if (node.maxMemoryBytes && await node.memoryBytes() > node.maxMemoryBytes) return "memory";
  return undefined;
}
