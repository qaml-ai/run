// Test harness for the workflow runner: DO SQLite over node:sqlite, the sandbox Worker in process, a fake effect world
// and a fake clock and alarm. Crash hooks throw `crash:` errors at the boundaries a real process can die at.
import { AlarmWatch } from "./alarm-watch.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import type { WorkflowSandbox, WorkflowStepRequest } from "../codemode/workflow-protocol.ts";
import { serveWorkflowStep } from "../codemode/workflow-vm.ts";
import { WorkflowRunner, type CapacitySeam, type EffectExecutor, type EffectOutcome, type EffectUsage, type StartedEffect, type WorkflowInit } from "../src/workflow-runner.ts";

// The QuickJS build production runs: the one pi-codemode bundles (`cloudflareQuickJSWasm` resolves it from pi-codemode).
const require = createRequire(import.meta.url);
export const PI_QUICKJS = createRequire(import.meta.resolve("@earendil-works/pi-codemode"));
export const WASM_BYTES = readFileSync(PI_QUICKJS.resolve("quickjs-wasi/quickjs.wasm"));
export const WASM = new WebAssembly.Module(WASM_BYTES);

/** DO SQLite's surface over node:sqlite, with `crash` hooks inside a transaction. */
export function storage(db = new DatabaseSync(":memory:"), crash: (where: string) => void = () => {}) {
  const sql = {
    exec(query: string, ...params: unknown[]) {
      const statement = db.prepare(query);
      const rows = /^\s*(SELECT|WITH)/i.test(query) ? statement.all(...params as never[]) : (statement.run(...params as never[]), []);
      return Object.assign(rows, { toArray: () => rows, one: () => { assert.equal(rows.length, 1, query); return rows[0]; } });
    },
  } as unknown as SqlStorage;
  let depth = 0;
  return {
    db,
    sql,
    transactionSync<T>(fn: () => T): T {
      // Like DO storage: a nested transactionSync joins the outer one.
      if (depth) return fn();
      crash("transaction begin");
      db.exec("BEGIN");
      depth++;
      try { const result = fn(); crash("transaction commit"); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
      finally { depth--; }
    },
  };
}

/** The sandbox Worker in process, across a structured-clone boundary as over RPC. */
export function sandbox(crash: (where: string) => void = () => {}, rewrite?: (request: WorkflowStepRequest) => Promise<WorkflowStepRequest>): WorkflowSandbox & { requests: WorkflowStepRequest[] } {
  const requests: WorkflowStepRequest[] = [];
  return {
    requests,
    async step(request) {
      crash("sandbox before");
      const sent = structuredClone(rewrite ? await rewrite(request) : request);
      requests.push(sent);
      const outcome = structuredClone(await serveWorkflowStep(sent, WASM));
      crash("sandbox after");
      return outcome;
    },
  };
}

/** Effects as a fake world runs them: started ones wait in `queue` until the test lands them. Starts dedupe by key:attempt. */
export class World implements EffectExecutor {
  readonly starts = new Map<string, number>();
  readonly cancelled: string[] = [];
  readonly queue: StartedEffect[] = [];
  crash: (where: string) => void = () => {};
  cost = 0;
  /** Keys whose next starts throw, and how many times. */
  readonly failStarts = new Map<string, number>();
  async start(effect: StartedEffect) {
    this.crash("executor start");
    const failing = this.failStarts.get(effect.key) ?? 0;
    if (failing > 0) { this.failStarts.set(effect.key, failing - 1); throw new Error(`could not start ${effect.key}`); }
    const id = `${effect.key}:${effect.attempt}`;
    const count = (this.starts.get(id) ?? 0) + 1;
    this.starts.set(id, count);
    if (count === 1) this.queue.push(effect);
  }
  /** Keys whose next cancels throw, and how many times. */
  readonly failCancels = new Map<string, number>();
  async cancel(effect: StartedEffect) {
    const failing = this.failCancels.get(effect.key) ?? 0;
    if (failing > 0) { this.failCancels.set(effect.key, failing - 1); throw new Error(`could not cancel ${effect.key}`); }
    this.cancelled.push(`${effect.key}:${effect.attempt}`);
    const index = this.queue.findIndex(item => item.key === effect.key && item.attempt === effect.attempt);
    if (index >= 0) this.queue.splice(index, 1);
  }
  /** A gate at its deadline (EffectExecutor.expire): by default nobody answered; a test may say otherwise, or throw. */
  expireHook?: (effect: StartedEffect, take: boolean) => Promise<{ outcome: EffectOutcome } | undefined>;
  readonly expired: { key: string; take: boolean; dueAt?: number }[] = [];
  async expire(effect: StartedEffect, take: boolean) {
    this.expired.push({ key: effect.key, take, dueAt: effect.dueAt });
    return this.expireHook?.(effect, take);
  }
  /** An ending the runner did not record (a crash while landing it) is found by the alarm's sweep, as an outbox redelivers. */
  async poll(effect: StartedEffect) {
    if (this.queue.some(item => item.key === effect.key && item.attempt === effect.attempt)) return undefined;
    return { outcome: this.answer(effect), usage: this.usage() };
  }
  answer(effect: StartedEffect): EffectOutcome {
    if (effect.kind === "gate") return { ok: true, value: (effect.args as { options?: string[] }).options?.[0] ?? "yes" };
    const prompt = (effect.args as { prompt: string }).prompt;
    if (prompt.startsWith("fail")) return { ok: false, error: `could not ${prompt}` };
    if (prompt.startsWith("broke")) return { refused: "out of credit" };
    return { ok: true, value: { answer: `re: ${prompt}`, attempt: effect.attempt } };
  }
  usage(): EffectUsage | undefined { return this.cost ? { costUsd: this.cost, model: "fake/model", inputTokens: 100, cachedInputTokens: 50, outputTokens: 10 } : undefined; }
}

export const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** A workflow over fake storage, clock and alarm; `next()` lands the oldest started effect or fires the alarm. */
/**
 * A tenant capacity limiter with `slots` child slots: past them requests wait in order, and a release grants the next
 * one and wakes the workflow (unless `dropWakes`, when only a renew tells it).
 */
export class FakeCapacity {
  leaseMs = 600_000;
  slots: number;
  dropWakes = false;
  refuseOpen?: string;
  failRenew?: string;
  refuseRenew?: string;
  readonly calls: string[] = [];
  readonly held = new Map<string, string>();
  readonly waiting: string[] = [];
  private next = 0;
  wake: (grants: { key: string; lease: string }[]) => Promise<void> = async () => {};
  constructor(slots: number) { this.slots = slots; }
  seam(): CapacitySeam {
    return {
      leaseMs: this.leaseMs,
      open: async concurrency => { this.calls.push(`open ${concurrency}`); return this.refuseOpen ? { ok: false, message: this.refuseOpen } : { ok: true }; },
      acquire: async (key, kind) => {
        this.calls.push(kind === "job" ? `acquire ${key} job` : `acquire ${key}`);
        const lease = this.held.get(key);
        if (lease) return { granted: true, lease };
        if (this.held.size < this.slots) { const id = `l${++this.next}`; this.held.set(key, id); return { granted: true, lease: id }; }
        if (!this.waiting.includes(key)) this.waiting.push(key);
        return { granted: false };
      },
      release: async lease => {
        this.calls.push(`release ${lease}`);
        for (const [key, id] of this.held) if (id === lease) this.held.delete(key);
        const key = this.waiting.shift();
        if (key === undefined) return;
        const id = `l${++this.next}`;
        this.held.set(key, id);
        if (!this.dropWakes) queueMicrotask(() => void this.wake([{ key, lease: id }]));
      },
      renew: async () => {
        this.calls.push("renew");
        if (this.failRenew) throw new Error(this.failRenew);
        if (this.refuseRenew) return { ok: false, message: this.refuseRenew };
        return { ok: true, held: [...this.held].map(([key, lease]) => ({ key, lease })) };
      },
      close: async () => { this.calls.push("close"); this.held.clear(); this.waiting.splice(0); },
    };
  }
}

export function harness(options: { crashAt?: number; snapshotCap?: number; rewrite?: (request: WorkflowStepRequest) => Promise<WorkflowStepRequest>; db?: DatabaseSync; capacity?: FakeCapacity; onStatus?: (status: string, runner: WorkflowRunner) => void } = {}) {
  let ops = 0;
  const self = {
    crashes: 0, crashed: undefined as string | undefined, clock: 5_000, alarmAt: null as number | null,
    get ops() { return ops; },
  };
  const crash = (where: string) => { if (++ops === options.crashAt) { self.crashed = where; throw new Error(`crash: ${where}`); } };
  const store = storage(options.db, crash);
  const box = sandbox(crash, options.rewrite);
  const world = new World();
  world.crash = crash;
  // Every harness watches its runner's alarm for hot loops (test/alarm-watch.ts).
  const watch = new AlarmWatch("WorkflowRunner");
  const make = () => new WorkflowRunner(store, box, world, { snapshotCap: options.snapshotCap, now: () => self.clock, alarm: { set: at => { watch.armed(at); self.alarmAt = at; } }, capacity: options.capacity?.seam(), ...(options.onStatus ? { onStatus: status => options.onStatus!(status, runner) } : {}) });
  let runner = make();
  if (options.capacity) options.capacity.wake = grants => runner.capacityGranted(grants);
  /** Run `work`; a crash drops the runner, and a new one over the same storage wakes up. */
  const attempt = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
    try { return await work(); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("crash:")) throw error;
      self.crashes++;
      runner = make();
      for (;;) {
        try { await runner.wake(); return undefined; }
        catch (again) { if (!(again instanceof Error) || !again.message.startsWith("crash:")) throw again; self.crashes++; runner = make(); }
      }
    }
  };
  const live = () => ["running", "waiting"].includes(runner.get().status);
  return Object.assign(self, {
    store, box, world, attempt, live,
    get runner() { return runner; },
    /** Create the workflow; a crash during the create is a failed request, which the caller makes again. */
    init: (init: Partial<WorkflowInit> & { code: string }) => {
      try { runner.init({ seed: 42, startedAt: 1_000, ...init }); }
      catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("crash:")) throw error;
        self.crashes++;
        runner = make();
        runner.init({ seed: 42, startedAt: 1_000, ...init });
      }
    },
    wake: () => attempt(() => runner.wake()),
    /** Land the oldest started effect; with none, move the clock to the alarm and fire it. Returns false when nothing can happen. */
    async next(answer?: (effect: StartedEffect) => EffectOutcome | undefined) {
      const effect = world.queue.shift();
      if (effect) {
        watch.external();
        const outcome = answer?.(effect) ?? world.answer(effect);
        await attempt(() => runner.land(effect.key, effect.attempt, outcome, world.usage()));
        return true;
      }
      if (self.alarmAt === null) return false;
      self.clock = Math.max(self.clock, self.alarmAt);
      await watch.fire(self.clock, () => attempt(() => runner.alarm()));
      return true;
    },
    /** Land and fire alarms until the workflow is no longer running or waiting. */
    async run(answer?: (effect: StartedEffect) => EffectOutcome | undefined) {
      for (let guard = 0; live(); guard++) {
        if (guard > 20_000) throw new Error("the workflow does not end");
        if (!(await this.next(answer))) throw new Error(`stuck: nothing to land and no alarm (${JSON.stringify(runner.get())})`);
      }
    },
    snapshot() {
      return {
        summary: (({ createdAt: _c, updatedAt: _u, ...rest }) => rest)(runner.get()),
        items: plain(runner.items({ attempts: true, limit: 500 }).items),
        logs: plain(runner.logs()),
      };
    },
  });
}
