import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import type { WorkflowSandbox, WorkflowStepRequest } from "../codemode/workflow-protocol.ts";
import {
  canonicalJson, fnv1a64, gunzip, gzip, QUICKJS_WASI_VERSION, QUICKJS_WASM_SHA256, serveWorkflowStep, WORKFLOW_HEAP_BYTES,
} from "../codemode/workflow-vm.ts";
import { SANDBOX_HEAP_BYTES } from "../codemode/exchange.ts";
import { WorkflowRunner, type EffectExecutor, type EffectOutcome, type StartedEffect } from "../src/workflow-runner.ts";

const require = createRequire(import.meta.url);
const WASM_BYTES = readFileSync(require.resolve("quickjs-wasi/quickjs.wasm"));
const WASM = new WebAssembly.Module(WASM_BYTES);

/** DO SQLite's surface over node:sqlite, with `crash` hooks inside a transaction. */
function storage(db = new DatabaseSync(":memory:"), crash: (where: string) => void = () => {}) {
  const sql = {
    exec(query: string, ...params: unknown[]) {
      const statement = db.prepare(query);
      const rows = /^\s*(SELECT|WITH)/i.test(query) ? statement.all(...params as never[]) : (statement.run(...params as never[]), []);
      return Object.assign(rows, {
        toArray: () => rows,
        one: () => { assert.equal(rows.length, 1, query); return rows[0]; },
      });
    },
  } as unknown as SqlStorage;
  return {
    db,
    sql,
    transactionSync<T>(fn: () => T): T {
      crash("transaction begin");
      db.exec("BEGIN");
      try { const result = fn(); crash("transaction commit"); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
  };
}

/** The sandbox Worker in process, across a structured-clone boundary as over RPC. */
function sandbox(crash: (where: string) => void = () => {}, rewrite?: (request: WorkflowStepRequest) => Promise<WorkflowStepRequest>): WorkflowSandbox & { requests: WorkflowStepRequest[] } {
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
class World implements EffectExecutor {
  readonly starts = new Map<string, number>();
  readonly queue: StartedEffect[] = [];
  crash: (where: string) => void = () => {};
  async start(effect: StartedEffect) {
    this.crash("executor start");
    const id = `${effect.key}:${effect.attempt}`;
    const count = (this.starts.get(id) ?? 0) + 1;
    this.starts.set(id, count);
    if (count === 1) this.queue.push(effect);
  }
  answer(effect: StartedEffect): EffectOutcome {
    if (effect.kind === "sleep") return { ok: true, value: null };
    const prompt = (effect.args as { prompt: string }).prompt;
    if (prompt.startsWith("fail")) return { ok: false, error: `could not ${prompt}` };
    return { ok: true, value: { answer: `re: ${prompt}` } };
  }
}

/**
 * Run a workflow to its end, landing started effects one at a time (oldest first). A thrown `crash:` error is a
 * crashed process: the runner is dropped and a new one over the same storage wakes up.
 */
async function drive(code: string, options: { crashAt?: number; snapshotCap?: number; now?: () => number; rewrite?: (request: WorkflowStepRequest) => Promise<WorkflowStepRequest>; seed?: number } = {}) {
  let ops = 0, crashes = 0, crashed: string | undefined;
  const crash = (where: string) => { if (++ops === options.crashAt) { crashed = where; throw new Error(`crash: ${where}`); } };
  const store = storage(undefined, crash);
  const box = sandbox(crash, options.rewrite);
  const world = new World();
  world.crash = crash;
  const make = () => new WorkflowRunner(store, box, world, { snapshotCap: options.snapshotCap, now: options.now ?? (() => 5_000) });
  let runner = make();
  runner.init({ code, seed: options.seed ?? 42, startedAt: 1_000 });
  const attempt = async (work: () => Promise<void>) => {
    for (;;) {
      try { await work(); return; }
      catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("crash:")) throw error;
        crashes++;
        runner = make();
        work = () => runner.wake();
      }
    }
  };
  await attempt(() => runner.wake());
  for (let guard = 0; runner.state().status === "running"; guard++) {
    if (guard > 10_000) throw new Error("the workflow does not end");
    const effect = world.queue.shift();
    if (!effect) { await attempt(() => runner.wake()); if (!world.queue.length && runner.state().status === "running") throw new Error("stuck: nothing pending to land"); continue; }
    await attempt(() => runner.land(effect.key, effect.attempt, world.answer(effect)));
  }
  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  return { state: runner.state(), effects: plain(runner.effects()), logs: plain(runner.logs()), events: runner.events, world, ops, crashes, crashed, box, store, runner };
}

const REVIEW = `
phase("plan");
const plan = await agent("plan the work");
log("planned", plan.answer);
phase("review");
const reviews = await parallel(["a.ts", "b.ts", "c.ts"], file => agent("review " + file, { key: "review:" + file }));
await sleep(1000);
let failure;
try { await agent("fail to deploy"); } catch (error) { failure = error.message + " (" + error.effect + ")"; }
const fix = await agent("fix", { type: "fixer" });
log("fixed");
return { plan: plan.answer, reviews: reviews.map(r => r.answer), fix: fix.answer, failure, t: now(), r: random(), d: Date.now(), m: Math.random() };`;

test("the pinned QuickJS build is the installed one, and host and guest compute the same keys", async () => {
  assert.equal(createHash("sha256").update(WASM_BYTES).digest("hex"), QUICKJS_WASM_SHA256, "update QUICKJS_WASM_SHA256 with quickjs-wasi");
  assert.equal(require("quickjs-wasi/package.json").version, QUICKJS_WASI_VERSION);
  assert.equal(WORKFLOW_HEAP_BYTES, SANDBOX_HEAP_BYTES, "a workflow VM takes one of the sandbox's heap slots");
  const { effects } = await drive(`return await agent("a prompt", { type: "reviewer", files: ["x", { b: 1, a: [2, undefined] }] });`);
  assert.equal(effects[0]!.key, `agent:${fnv1a64(canonicalJson({ prompt: "a prompt", type: "reviewer", files: ["x", { b: 1, a: [2, undefined] }] }))}`);
  const reference = (text: string) => {
    let h = 0xcbf29ce484222325n;
    for (let i = 0; i < text.length; i++) for (const byte of [text.charCodeAt(i) & 0xff, text.charCodeAt(i) >>> 8]) h = ((h ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
    return h.toString(16).padStart(16, "0");
  };
  for (const text of ["", "a", "héllo €𝄞", canonicalJson({ z: 1, a: [null, "x"] })]) assert.equal(fnv1a64(text), reference(text));
});

test("a workflow runs its effects through the executor, with phases, logs, parallel keys, failures and its clock", { timeout: 30_000 }, async () => {
  const { state, effects, logs } = await drive(REVIEW);
  assert.equal(state.status, "done", JSON.stringify(state));
  const result = state.result as Record<string, unknown>;
  assert.deepEqual(result.reviews, ["re: review a.ts", "re: review b.ts", "re: review c.ts"]);
  assert.equal(result.fix, "re: fix");
  assert.match(String(result.failure), /^could not fail to deploy \(agent:[0-9a-f]{16}\)$/);
  assert.equal(result.t, 5_000);
  assert.equal(result.d, 5_000, "Date.now() is the step's clock too");
  assert.deepEqual(effects.map(row => [row.key, row.phase]), [
    [effects[0]!.key, "plan"], ["review:a.ts", "review"], ["review:b.ts", "review"], ["review:c.ts", "review"],
    [effects[4]!.key, "review"], [effects[5]!.key, "review"], [effects[6]!.key, "review"],
  ]);
  assert.deepEqual(logs.map(row => [row.phase, row.text]), [["plan", "planned re: plan the work"], ["review", "fixed"]]);
});

test("a run restored every step ends exactly as one replayed every step, and as one with another build's snapshots", { timeout: 60_000 }, async () => {
  let clock = 2_000;
  const ticking = () => () => clock += 7;
  clock = 2_000;
  const restored = await drive(REVIEW, { now: ticking() });
  clock = 2_000;
  const replayed = await drive(REVIEW, { now: ticking(), snapshotCap: 0 });
  // Every third step's snapshot claims another build: the sandbox refuses it and the runner replays.
  clock = 2_000;
  let restores = 0;
  const foreign = await drive(REVIEW, {
    now: ticking(),
    rewrite: async request => {
      if (!request.restore || ++restores % 3) return request;
      const raw = await gunzip(request.restore);
      const length = new DataView(raw.buffer, raw.byteOffset).getUint32(0, true);
      const header = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + length)));
      header.fingerprint = header.fingerprint.replace("driver 1", "driver 0");
      const head = new TextEncoder().encode(JSON.stringify(header)), out = new Uint8Array(4 + head.byteLength + raw.byteLength - 4 - length);
      new DataView(out.buffer).setUint32(0, head.byteLength, true);
      out.set(head, 4);
      out.set(raw.subarray(4 + length), 4 + head.byteLength);
      return { ...request, restore: await gzip(out) };
    },
  });
  assert.equal(restored.state.status, "done");
  assert.ok(restored.events.every(event => event.kind !== "replayed"), "every step restored");
  assert.ok(replayed.events.filter(event => event.kind === "snapshot_dropped").length >= 5);
  assert.ok(replayed.box.requests.slice(1).every(request => !request.restore && request.replay), "every later step replayed");
  assert.ok(foreign.events.some(event => event.kind === "refused" && /cannot restore into/.test(event.message)), JSON.stringify(foreign.events));
  for (const other of [replayed, foreign]) {
    assert.deepEqual(other.state, restored.state);
    assert.deepEqual(other.effects, restored.effects);
    assert.deepEqual(other.logs, restored.logs);
  }
});

test("a crash at every step boundary leaves the same workflow, each effect journaled and started once", { timeout: 300_000 }, async t => {
  const baseline = await drive(REVIEW);
  assert.equal(baseline.crashes, 0);
  const where = new Set<string>();
  for (let crashAt = 1; crashAt <= baseline.ops; crashAt++) {
    const run = await drive(REVIEW, { crashAt });
    assert.equal(run.crashes, 1, `crash ${crashAt} fired`);
    where.add(run.crashed!);
    assert.deepEqual(run.state, baseline.state, `crash ${crashAt}`);
    assert.deepEqual(run.effects, baseline.effects, `crash ${crashAt}`);
    assert.deepEqual(run.logs, baseline.logs, `crash ${crashAt}: logs once`);
    // The executor saw every effect, at most twice (a restart after the commit starts it again; it deduped).
    assert.deepEqual([...run.world.starts.keys()].sort(), [...baseline.world.starts.keys()].sort());
    assert.ok([...run.world.starts.values()].every(count => count <= 2));
  }
  assert.deepEqual([...where].sort(), ["executor start", "sandbox after", "sandbox before", "transaction begin", "transaction commit"]);
  t.diagnostic(`${baseline.ops} crash points over ${baseline.state.step} steps`);
});

test("faults: keys inside parallel, key conflicts, a stalled script, a journal from a newer runner, the step budget", { timeout: 60_000 }, async () => {
  const unkeyed = await drive(`return await parallel([1, 2], i => agent("review " + i));`);
  assert.equal(unkeyed.state.status, "faulted");
  assert.equal(unkeyed.state.fault?.code, "key_required");
  assert.match(unkeyed.state.fault!.message, /inside parallel\(\) needs an explicit key/);
  assert.equal(unkeyed.effects.length, 0, "a faulted step journals nothing");
  const conflict = await drive(`await agent("one", { key: "k" }); return await agent("two", { key: "k" });`);
  assert.equal(conflict.state.fault?.code, "key_conflict");
  const stalled = await drive(`await new Promise(() => {});`);
  assert.equal(stalled.state.fault?.code, "stalled");
  const thrown = await drive(`await agent("x"); throw new Error("boom");`);
  assert.equal(thrown.state.status, "failed");
  assert.match(thrown.state.error!, /boom/);
  const budget = await drive(`await agent("x"); let i = 0; while (true) i++;`);
  assert.equal(budget.state.fault?.code, "step_budget");

  // A row from a newer runner: this one stops rather than misread it.
  const store = storage(), world = new World();
  const runner = new WorkflowRunner(store, sandbox(), world, { now: () => 5_000 });
  runner.init({ code: `await agent("a"); return await agent("b");`, seed: 1, startedAt: 1_000 });
  await runner.wake();
  const first = world.queue.shift()!;
  store.db.exec("UPDATE workflow_effects SET version = 2");
  await runner.land(first.key, first.attempt, world.answer(first));
  assert.equal(runner.state().fault?.code, "journal_version");
});

test("protocol 3 mismatches fail clearly", async () => {
  await assert.rejects(serveWorkflowStep({ protocol: 4 } as never, WASM), /protocol 4 is not 3, the one this sandbox speaks/);
  const old = { step: async () => { throw new TypeError("stub.step is not a function"); } } as unknown as WorkflowSandbox;
  const runner = new WorkflowRunner(storage(), old, new World());
  runner.init({ code: "return 1", seed: 1, startedAt: 1 });
  await assert.rejects(runner.wake(), /does not speak workflow step protocol 3/);
});

test("500 effects end to end, one step per effect", { timeout: 300_000 }, async t => {
  const code = `let count = 0; for (let i = 0; i < 500; i++) { const r = await agent("review src/delegation-" + i + ".ts"); if (r.answer) count++; } return count;`;
  const started = performance.now();
  const run = await drive(code);
  const ms = performance.now() - started;
  assert.equal(run.state.status, "done");
  assert.equal(run.state.result, 500);
  assert.equal(run.effects.length, 500);
  const steps = run.store.db.prepare("SELECT ms, snapshot_bytes, polls, replayed FROM workflow_steps ORDER BY step").all() as { ms: number; snapshot_bytes: number; polls: number; replayed: number }[];
  assert.equal(steps.length, 501);
  assert.ok(steps.every(step => step.replayed === 0 || step === steps[0]));
  const last = steps.at(-2)!;
  const perStep = steps.reduce((sum, step) => sum + step.ms, 0) / steps.length;
  t.diagnostic(`500 effects: ${Math.round(ms)} ms in all, ${perStep.toFixed(1)} ms a step in the runner, last snapshot ${last.snapshot_bytes} bytes, ${Math.max(...steps.map(step => step.polls))} polls at most`);
  assert.ok(last.snapshot_bytes < 512 * 1024, `${last.snapshot_bytes}`);
});
