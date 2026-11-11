// Snapshot harness: a workflow step that RESTORES the guest instead of replaying it (docs/design/swarm-workflows.md,
// open question 1; test-only, no production path uses this).
//
// pi-codemode's VM driver (`startVm`, runtime/vm.js) keeps its state in closures, so this file is a minimal driver
// with the same protocol: the stock prelude (`PRELUDE_SOURCE`), the `bridge` host function, `settle`/`run`/`stalled`,
// the job drain with its interrupt polls, the deterministic clock and PRNG, `seq`-ordered results. On top it can
// `snapshot()` its whole state (QuickJS's linear memory plus the few host-side fields) and `restore()` it into a fresh
// instance of the same Wasm module. A snapshot names the build it came from, and refuses any other.
//
//   node --import ./test/sdk-deps.mjs --experimental-strip-types test/exchange-snapshot.ts [--json path]
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { gunzipSync, gzipSync as gzipDefault } from "node:zlib";

/** Level 1: twice as fast as the default for 8% more bytes (a snapshot is mostly zero pages). */
const gzipSync = (bytes: Uint8Array) => gzipDefault(bytes, { level: 1 });
import { Intrinsics, QuickJS, type JSValueHandle } from "quickjs-wasi";
// Not exported by the package; the file is pinned with pi-codemode's exact version.
import { PRELUDE_SOURCE } from "../node_modules/@earendil-works/pi-codemode/dist/runtime/prelude-source.js";

/** The deployed sandbox's limits (codemode/index.ts): one VM's heap, and its interrupt-poll budget. */
const SANDBOX_HEAP_BYTES = 24 * 1024 * 1024;
const POLL_BUDGET = 10_000;

const require = createRequire(import.meta.url);
const WASM_BYTES = readFileSync(require.resolve("quickjs-wasi/quickjs.wasm"));
const WASM = new WebAssembly.Module(WASM_BYTES);
/** Bumped whenever this driver changes what a snapshot holds or means. */
const DRIVER_VERSION = 1;
const STACK = 256 * 1024;
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/**
 * The build a snapshot belongs to: the Wasm module's own bytes, the engine versions, the prelude, this driver and the
 * VM's limits. A snapshot restores only into the identical build; anything else replays from the journal instead.
 */
export function buildFingerprint(heapBytes: number) {
  const versions = require("quickjs-wasi/package.json").version as string;
  return `quickjs-wasi ${versions}, wasm ${sha(WASM_BYTES).slice(0, 16)}, prelude ${sha(PRELUDE_SOURCE).slice(0, 16)}, driver ${DRIVER_VERSION}, stack ${STACK}, heap ${heapBytes}`;
}

export type VmMessage =
  | { type: "call"; id: number; name: string; args: string | undefined }
  | { type: "done"; ok: boolean; value?: string; error?: string };

/** Host-side state that is not in linear memory: everything `restore` needs besides the memory image. */
interface HostState {
  fingerprint: string;
  clock: { startedAt: number; now: number; seed: number };
  prng: number;
  nextSeq: number;
  issued: number;
  /** `exportHandle` tokens of the prelude's api and its functions, set by the first snapshot. */
  tokens?: { api: number; settle: number; stalled: number };
}

function mulberry(state: { prng: number }) {
  return () => {
    state.prng = (state.prng + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state.prng ^ (state.prng >>> 15), 1 | state.prng);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return (value ^ (value >>> 14)) >>> 0;
  };
}

export class SnapshotVm {
  /** Interrupt polls this instance has used: a step's budget, not the VM's lifetime's. */
  polls = 0;
  private vm!: QuickJS;
  private api!: JSValueHandle;
  private settle!: JSValueHandle;
  private stalled!: JSValueHandle;
  private state: HostState & { creating: boolean };
  private readonly post: (message: VmMessage) => void;
  private readonly budget: number;
  private constructor(state: HostState & { creating: boolean }, post: (message: VmMessage) => void, budget: number) {
    this.state = state; this.post = post; this.budget = budget;
  }

  private options(heapBytes: number) {
    const state = this.state, random = mulberry(state);
    return {
      wasm: WASM, memoryLimit: heapBytes, maxStackSize: STACK, timezoneOffset: 0, intrinsics: Intrinsics.ALL & ~Intrinsics.WEAK_REF,
      interruptHandler: () => ++this.polls > this.budget,
      wasi: (memory: WebAssembly.Memory) => ({
        fd_write(_fd: number, iovs: number, count: number, written: number) {
          const view = new DataView(memory.buffer);
          let total = 0;
          for (let i = 0; i < count; i++) total += view.getUint32(iovs + i * 8 + 4, true);
          view.setUint32(written, total, true);
          return 0;
        },
        clock_time_get(id: number, _precision: bigint, result: number) {
          const ns = state.creating ? (id === 0 ? BigInt(state.clock.seed + 1) * 1000n : 0n)
            : id === 0 ? BigInt(Math.round(state.clock.now)) * 1_000_000n : BigInt(Math.round(state.clock.now - state.clock.startedAt)) * 1_000_000n;
          new DataView(memory.buffer).setBigUint64(result, ns, true);
          return 0;
        },
        random_get(pointer: number, length: number) {
          const bytes = new Uint8Array(memory.buffer, pointer, length);
          for (let i = 0; i < length; i += 4) { const value = random(); for (let b = 0; b < 4 && i + b < length; b++) bytes[i + b] = value >>> (b * 8); }
          return 0;
        },
      }),
    };
  }

  private bridge = (kind: JSValueHandle, a: JSValueHandle, b: JSValueHandle, c: JSValueHandle) => {
    const name = kind.toString();
    if (name === "call") {
      this.state.issued++;
      this.post({ type: "call", id: a.toNumber(), name: b.toString(), args: c === undefined || c.isUndefined ? undefined : c.toString() });
    } else if (name === "done") {
      this.post(a.toBoolean() ? { type: "done", ok: true, value: b === undefined || b.isUndefined ? undefined : b.toString() } : { type: "done", ok: false, error: b.toString() });
    }
    return this.vm.undefined;
  };

  private drain() {
    const exports = this.vm._getExports();
    let jobs = 0;
    while (exports.qjs_is_job_pending()) {
      if (exports.qjs_execute_pending_job() < 0) throw new Error("Promise job failed");
      if (++jobs % 50 === 0 && ++this.polls > this.budget) throw new Error("Execution interrupted");
    }
    this.vm.callFunction(this.stalled, this.api).dispose();
  }

  /** A fresh VM running `code` until it first waits. */
  static async start(options: { code: string; tools: string[]; startedAt: number; seed: number; heapBytes?: number; budget?: number }, post: (message: VmMessage) => void) {
    const heapBytes = options.heapBytes ?? SANDBOX_HEAP_BYTES;
    const self = new SnapshotVm({
      fingerprint: buildFingerprint(heapBytes), creating: true, clock: { startedAt: options.startedAt, now: options.startedAt, seed: options.seed >>> 0 },
      prng: (options.seed ^ 0x9e3779b9) >>> 0, nextSeq: 1, issued: 0,
    }, post, options.budget ?? POLL_BUDGET);
    const vm = self.vm = await QuickJS.create(self.options(heapBytes) as never);
    self.state.creating = false;
    const bridge = vm.newFunction("bridge", self.bridge as never);
    const tools = JSON.stringify(options.tools.map(name => ({ name, jsName: name, description: "" })));
    self.api = vm.withScope(scope => scope.escape(vm.callFunction(vm.evalCode(PRELUDE_SOURCE, "codemode-prelude.js"), vm.undefined, bridge, vm.newString(tools), vm.newString("[]"), vm.newString("{}"))));
    self.settle = self.api.getProp("settle");
    self.stalled = self.api.getProp("stalled");
    const run = self.api.getProp("run");
    const fn = vm.evalCode(`(async (tools, console) => {${options.code}\n})`, "codemode.js");
    vm.callFunction(run, self.api, fn).dispose();
    fn.dispose(); run.dispose();
    self.drain();
    return self;
  }

  /** Apply result `seq` (strictly the next one) to call `id`, and run until the script waits again. */
  deliver(result: { seq: number; now: number; id: number; ok: boolean; payload: string | undefined }) {
    if (result.seq !== this.state.nextSeq) throw new Error(`Result ${result.seq} out of order, expected ${this.state.nextSeq}`);
    this.state.nextSeq++;
    this.state.clock.now = Math.max(this.state.clock.now, result.now);
    const vm = this.vm;
    vm.withScope(() => vm.callFunction(this.settle, this.api, vm.newNumber(result.id), result.ok ? vm.true : vm.false,
      result.payload === undefined ? vm.undefined : vm.newString(result.payload), vm.undefined));
    this.drain();
  }

  /** The whole VM as bytes: a JSON header (fingerprint and host-side state) and quickjs-wasi's memory image. */
  snapshot(): Uint8Array {
    // Exported once, on the first snapshot: a restored VM keeps the exported boxes for good, so their tokens stay
    // valid in every later snapshot of it, and exporting again each step would leak three boxes a step.
    this.state.tokens ??= { api: this.vm.exportHandle(this.api), settle: this.vm.exportHandle(this.settle), stalled: this.vm.exportHandle(this.stalled) };
    const { creating: _, ...state } = this.state;
    const header = new TextEncoder().encode(JSON.stringify(state));
    const image = QuickJS.serializeSnapshot(this.vm.snapshot());
    const out = new Uint8Array(4 + header.byteLength + image.byteLength);
    new DataView(out.buffer).setUint32(0, header.byteLength, true);
    out.set(header, 4);
    out.set(image, 4 + header.byteLength);
    return out;
  }

  /** A VM from `snapshot()`'s bytes, in a fresh instance; refuses a snapshot from any other build. */
  static async restore(bytes: Uint8Array, post: (message: VmMessage) => void, options: { heapBytes?: number; budget?: number } = {}) {
    const heapBytes = options.heapBytes ?? SANDBOX_HEAP_BYTES;
    const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
    const state = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) as HostState;
    const expected = buildFingerprint(heapBytes);
    if (state.fingerprint !== expected) throw new Error(`Snapshot from another build (${state.fingerprint}), not ${expected}: replay from the journal instead`);
    const self = new SnapshotVm({ ...state, creating: false }, post, options.budget ?? POLL_BUDGET);
    const vm = self.vm = await QuickJS.restore(QuickJS.deserializeSnapshot(bytes.subarray(4 + length)), self.options(heapBytes) as never);
    vm.registerHostCallback("bridge", self.bridge as never);
    const tokens = state.tokens!;
    self.api = vm.importHandle(tokens.api);
    self.settle = vm.importHandle(tokens.settle);
    self.stalled = vm.importHandle(tokens.stalled);
    return self;
  }

  get heapBytes() { return this.vm.getMemoryUsage().memoryUsedSize; }
  get linearBytes() { return this.vm._getExports().memory.buffer.byteLength; }
  dispose() { this.vm.dispose(); }
}

/** The replay harness's synthetic workflow, without a journal table: the snapshot holds every result it kept. */
export function workflowScript(n: number, keep: boolean) {
  return `const seen = [];
for (let i = 0; i < ${n}; i++) {
  const args = { type: "reviewer", model: "fast", prompt: "Review src/delegation-" + i + ".ts for the owner model refactor.", files: ["src/delegation-" + i + ".ts"] };
  const result = await tools.effect({ key: "agent:" + i, args });
  seen.push(${keep ? "result" : "result.sha256.slice(0, 8)"});
}
return { count: seen.length, random: Math.random(), now: Date.now() };`;
}

/** A handle, as a handle exchange gives the guest for a 20 KB body. */
const handle = (i: number) => JSON.stringify({ $handle: `wf/results/${i}`, bytes: 20_000, sha256: sha(String(i)) });

export interface SnapshotStep {
  effects: number;
  restoreMs: number; runMs: number; snapshotMs: number; gzipMs: number; gunzipMs: number;
  rawBytes: number; gzipBytes: number; linearBytes: number; polls: number;
}

/**
 * Run a workflow of `effects` sequential effects one step per effect, each step restoring the previous step's
 * snapshot (gzipped, as it would be stored), delivering one result and snapshotting again. Measures the steps listed.
 */
export async function snapshotWorkflow(effects: number, measure: number[], keep = false) {
  const out: SnapshotStep[] = [];
  const pending: VmMessage[] = [];
  let vm = await SnapshotVm.start({ code: workflowScript(effects, keep), tools: ["effect"], startedAt: 1_000, seed: 7 }, message => pending.push(message));
  let stored = gzipSync(vm.snapshot());
  vm.dispose();
  let done: VmMessage | undefined;
  for (let step = 1; step <= effects; step++) {
    const call = pending.shift();
    if (call?.type !== "call") throw new Error(`step ${step}: expected a call, got ${JSON.stringify(call)}`);
    let t = performance.now();
    const raw = gunzipSync(stored);
    const gunzipMs = performance.now() - t;
    t = performance.now();
    vm = await SnapshotVm.restore(raw, message => pending.push(message));
    const restoreMs = performance.now() - t;
    t = performance.now();
    vm.deliver({ seq: step, now: 1_000 + step, id: call.id, ok: true, payload: handle(step) });
    const runMs = performance.now() - t;
    t = performance.now();
    const bytes = vm.snapshot();
    const snapshotMs = performance.now() - t;
    t = performance.now();
    stored = gzipSync(bytes);
    const gzipMs = performance.now() - t;
    if (measure.includes(step)) out.push({ effects: step, restoreMs, runMs, snapshotMs, gzipMs, gunzipMs, rawBytes: bytes.byteLength, gzipBytes: stored.byteLength, linearBytes: vm.linearBytes, polls: vm.polls });
    vm.dispose();
    if (pending[0]?.type === "done") { done = pending.shift(); break; }
  }
  return { steps: out, done };
}

/** The same workflow in one VM that never stops: what every snapshot-driven run must equal. */
export async function continuousWorkflow(effects: number, keep = false) {
  const pending: VmMessage[] = [];
  const vm = await SnapshotVm.start({ code: workflowScript(effects, keep), tools: ["effect"], startedAt: 1_000, seed: 7 }, message => pending.push(message));
  for (let step = 1; step <= effects; step++) {
    const call = pending.shift();
    if (call?.type !== "call") throw new Error(`step ${step}: ${JSON.stringify(call)}`);
    vm.deliver({ seq: step, now: 1_000 + step, id: call.id, ok: true, payload: handle(step) });
  }
  vm.dispose();
  return pending.shift();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10), node: process.version, fingerprint: buildFingerprint(SANDBOX_HEAP_BYTES), runs: [] as unknown[] };
  for (const keep of [false, true]) {
    for (const effects of [50, 500, 5000]) {
      const started = performance.now();
      const { steps, done } = await snapshotWorkflow(effects, [1, effects], keep);
      const totalMs = performance.now() - started;
      (report.runs as unknown[]).push({ effects, keepsResults: keep, totalMs: Math.round(totalMs), done, steps });
      console.log(`\n${effects} effects, ${keep ? "script keeps every handle" : "script keeps 8 chars per result"}: whole workflow ${Math.round(totalMs)} ms, ${done?.type === "done" && done.ok ? "ok" : JSON.stringify(done)}`);
      console.table(steps.map(s => ({ step: s.effects, restoreMs: +s.restoreMs.toFixed(1), runMs: +s.runMs.toFixed(2), snapshotMs: +s.snapshotMs.toFixed(1), gzipMs: +s.gzipMs.toFixed(1), gunzipMs: +s.gunzipMs.toFixed(1), rawKiB: Math.round(s.rawBytes / 1024), gzipKiB: Math.round(s.gzipBytes / 1024), linearKiB: Math.round(s.linearBytes / 1024), polls: s.polls })));
    }
  }
  const jsonAt = process.argv.indexOf("--json");
  if (jsonAt > 0) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(process.argv[jsonAt + 1]!, JSON.stringify(report, null, 1) + "\n");
  }
}
