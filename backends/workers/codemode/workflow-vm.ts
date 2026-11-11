// The sandbox's side of a workflow step (exchange protocol 3, workflow-protocol.ts).
//
// A workflow's guest is a QuickJS VM that lives as long as the workflow: between steps it is a snapshot (quickjs-wasi's
// linear-memory image, plus the few fields of host-side state below), and a step restores it into a fresh instance of
// the same Wasm module, applies the step's results, runs it until it waits again and snapshots it. Without a snapshot
// (the first step, a build change, one over the size cap) the VM starts again and replays every earlier step's
// results in their original batches, which a deterministic VM turns into the same state.
//
// This is our own driver, not pi-codemode's: its VM driver keeps its state in closures that cannot be snapshotted,
// and workflow scripts see their own globals (agent, parallel, sleep, log, phase, now, random), not code mode's tools.
import { Intrinsics, QuickJS, type JSValueHandle } from "quickjs-wasi";
import {
  WORKFLOW_STEP_PROTOCOL, type IssuedEffect, type WorkflowBatch, type WorkflowFaultCode, type WorkflowStepOutcome, type WorkflowStepRequest,
} from "./workflow-protocol.ts";

/** Bumped whenever this driver or its prelude changes what a snapshot holds or what a script observes. */
export const WORKFLOW_DRIVER_VERSION = 2;
/**
 * sha256 of `quickjs-wasi/quickjs.wasm` as this package pins it. Wrangler compiles the module at build time, so its
 * bytes cannot be read at runtime; a test checks this against the installed file, so a dependency bump fails until it
 * is updated, and every snapshot from the old build is then refused (and replayed).
 */
export const QUICKJS_WASM_SHA256 = "d4c9375f2b1ca4dc95f72c8aa2982a7a9951ac8011490d79c6582df732b4bbd9";
/** The quickjs-wasi version the hash belongs to; a VM that reports another refuses to run (the same test checks it). */
export const QUICKJS_WASI_VERSION = "3.6.2";
/** As code mode's sandbox (codemode/index.ts): one VM's heap, and a step's interrupt-poll budget. */
export const WORKFLOW_HEAP_BYTES = 24 * 1024 * 1024;
export const WORKFLOW_STACK_BYTES = 256 * 1024;
export const WORKFLOW_POLL_BUDGET = 10_000;
/**
 * The most linear memory a step snapshots. Taking a snapshot copies the image once (the VM is disposed before it is
 * compressed), so the peak is about twice this plus the compressed bytes; past it the next step replays instead. The
 * isolate's 128 MiB is shared with code mode's VMs, so this stays well under the 24 MiB heap's worst case.
 */
export const WORKFLOW_SNAPSHOT_RAW_BYTES = 16 * 1024 * 1024;

/** FNV-1a, 64 bits, over each UTF-16 unit's two bytes (low first), as 16 hex digits. The guest's copy is the prelude's. */
export function fnv1a64(text: string) {
  let a = 0x2325, b = 0x8422, c = 0x9ce4, d = 0xcbf2;
  const byte = (x: number) => {
    a ^= x;
    const t0 = a * 0x1b3, t1 = b * 0x1b3 + (t0 >>> 16), t2 = c * 0x1b3 + (a << 8) + (t1 >>> 16), t3 = d * 0x1b3 + (b << 8) + (t2 >>> 16);
    a = t0 & 0xffff; b = t1 & 0xffff; c = t2 & 0xffff; d = t3 & 0xffff;
  };
  for (let i = 0; i < text.length; i++) { const unit = text.charCodeAt(i); byte(unit & 0xff); byte(unit >>> 8); }
  return [d, c, b, a].map(x => x.toString(16).padStart(4, "0")).join("");
}

/** Canonical JSON: object keys sorted, `undefined` and functions dropped from objects (null in arrays), as JSON does. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") { const json = JSON.stringify(value); return json === undefined ? "null" : json; }
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") return canonicalJson(toJSON.call(value));
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const object = value as Record<string, unknown>;
  return "{" + Object.keys(object).filter(key => object[key] !== undefined && typeof object[key] !== "function").sort()
    .map(key => JSON.stringify(key) + ":" + canonicalJson(object[key])).join(",") + "}";
}

/**
 * The guest's prelude: the workflow globals over one host function, `bridge(kind, ...)` with kind "effect" (key, kind,
 * args JSON, phase, options JSON, reused), "log" (text, phase), "phase" (name), "fault" (code, message) or "done" (ok,
 * value or error JSON). Evaluates to `{ settle(key, ok, json), adopt(tableJson), run(fn), status() }`. Its references to built-ins are taken before the script
 * runs, so a script that patches one changes only its own values, never what is reported.
 */
export const WORKFLOW_PRELUDE = `(function (bridge) {
  "use strict";
  const stringify = JSON.stringify, parse = JSON.parse, keysOf = Object.keys, isArray = Array.isArray, defineProperty = Object.defineProperty;
  const PromiseCtor = Promise, all = Promise.allSettled.bind(Promise), resolved = Promise.resolve.bind(Promise);
  const ErrorCtor = Error, TypeErrorCtor = TypeError, now = Date.now, random = Math.random;
  const pending = new Map(), settled = new Map(), known = new Map(), occurrences = new Map();
  let parallelDepth = 0, finished = false, phase = "";

  function canonical(value) {
    if (value === null || typeof value !== "object") { const json = stringify(value); return json === undefined ? "null" : json; }
    if (typeof value.toJSON === "function") return canonical(value.toJSON());
    if (isArray(value)) { const parts = []; for (let i = 0; i < value.length; i++) parts.push(canonical(value[i])); return "[" + parts.join(",") + "]"; }
    const parts = [];
    for (const key of keysOf(value).sort()) { const item = value[key]; if (item !== undefined && typeof item !== "function") parts.push(stringify(key) + ":" + canonical(item)); }
    return "{" + parts.join(",") + "}";
  }
  function fnv1a64(text) {
    let a = 0x2325, b = 0x8422, c = 0x9ce4, d = 0xcbf2;
    const byte = x => {
      a ^= x;
      const t0 = a * 0x1b3, t1 = b * 0x1b3 + (t0 >>> 16), t2 = c * 0x1b3 + (a << 8) + (t1 >>> 16), t3 = d * 0x1b3 + (b << 8) + (t2 >>> 16);
      a = t0 & 0xffff; b = t1 & 0xffff; c = t2 & 0xffff; d = t3 & 0xffff;
    };
    for (let i = 0; i < text.length; i++) { const unit = text.charCodeAt(i); byte(unit & 0xff); byte(unit >>> 8); }
    return [d, c, b, a].map(x => x.toString(16).padStart(4, "0")).join("");
  }
  function describe(error) {
    try {
      if (error instanceof ErrorCtor) return stringify({ name: String(error.name), message: String(error.message), stack: String(error.stack || "") });
      return stringify({ message: typeof error === "string" ? error : stringify(error) });
    } catch { return stringify({ message: "The script threw a value that cannot be described" }); }
  }
  // A fault ends the workflow whatever the script does next: it is reported first, then unwinds the script.
  function fault(code, message) {
    if (!finished) { finished = true; bridge("fault", code, message); }
    throw new ErrorCtor(message);
  }
  // A failed effect gives the script null (its item records why), so .filter(Boolean) drops it.
  const outcome = done => done.ok ? done.value : null;
  function effect(kind, args, options, extra) {
    if (finished) return new PromiseCtor(() => {});
    const json = canonical(args);
    let key;
    if (options !== undefined && options !== null && options.key !== undefined) {
      key = options.key;
      if (typeof key !== "string" || key === "" || key.length > 512) throw new TypeErrorCtor(kind + "() key must be a string of 1 to 512 characters");
    } else {
      // Branches of parallel() finish in any order, so a counted key there could hand one branch another's result.
      if (parallelDepth > 0) fault("key_required", kind + "() inside parallel() needs an explicit key, such as " + kind + "(..., { key: \\"review:\\" + file })");
      const base = kind + ":" + fnv1a64(json);
      const count = (occurrences.get(base) || 0) + 1;
      occurrences.set(base, count);
      key = count === 1 ? base : base + "#" + count;
    }
    const before = known.get(key);
    if (before !== undefined) {
      if (before.kind !== kind || before.args !== json) fault("key_conflict", "Key " + stringify(key) + " is already the key of another " + before.kind + "() with other arguments");
      const done = settled.get(key);
      if (done !== undefined) return resolved(outcome(done));
      return pending.get(key).promise;
    }
    known.set(key, { kind, args: json });
    // The revision's table: an effect the journal already has is answered from it, or waits for its result.
    const adopted = table.get(key);
    if (adopted !== undefined) {
      table.delete(key);
      bridge("effect", key, kind, json, phase, extra === undefined ? undefined : stringify(extra), true);
      if (adopted.value !== undefined) { const done = { ok: adopted.ok, value: parse(adopted.value) }; settled.set(key, done); return resolved(outcome(done)); }
    } else bridge("effect", key, kind, json, phase, extra === undefined ? undefined : stringify(extra), false);
    let resolve;
    const promise = new PromiseCtor(yes => { resolve = yes; });
    pending.set(key, { promise, resolve });
    return promise;
  }
  function settle(key, ok, json) {
    const entry = pending.get(key);
    if (entry === undefined) throw new ErrorCtor("A result for effect " + key + ", which is not waiting for one");
    pending.delete(key);
    const value = parse(json);
    const done = { ok, value };
    settled.set(key, done);
    entry.resolve(outcome(done));
  }
  const table = new Map();
  function adopt(json) { for (const entry of parse(json)) table.set(entry.key, entry); }
  function options(value, name) {
    if (value !== undefined && (value === null || typeof value !== "object" || isArray(value))) throw new TypeErrorCtor(name + "() options must be an object");
    return value;
  }
  const globals = {
    agent(prompt, opts) {
      if (typeof prompt !== "string" || prompt === "") throw new TypeErrorCtor("agent(prompt) needs a prompt string");
      options(opts, "agent");
      const args = { prompt };
      if (opts) for (const name of keysOf(opts)) if (name !== "key") args[name] = opts[name];
      return effect("agent", args, opts);
    },
    sleep(seconds, opts) {
      if (typeof seconds !== "number" || !(seconds >= 0) || seconds === Infinity) throw new TypeErrorCtor("sleep(seconds) needs a number of seconds");
      return effect("sleep", { seconds }, options(opts, "sleep"));
    },
    // A decision for a person. Answers with what they chose; expires after expiresInSeconds (7 days), then takes
    // the recommendation when onExpire is "recommended", or pauses the workflow.
    gate(opts) {
      options(opts, "gate");
      if (!opts || typeof opts.title !== "string" || opts.title === "") throw new TypeErrorCtor("gate({ title }) needs a title");
      const args = {};
      for (const name of keysOf(opts)) if (name !== "key" && name !== "expiresInSeconds" && name !== "onExpire") args[name] = opts[name];
      const extra = { expiresInSeconds: opts.expiresInSeconds === undefined ? 604800 : opts.expiresInSeconds, onExpire: opts.onExpire === "recommended" ? "recommended" : "pause" };
      if (typeof extra.expiresInSeconds !== "number" || !(extra.expiresInSeconds > 0)) throw new TypeErrorCtor("gate() expiresInSeconds must be a positive number");
      return effect("gate", args, opts, extra);
    },
    // Waits for every branch, even after one fails, so no branch is still issuing effects outside parallel().
    async parallel(items, fn) {
      if (!isArray(items)) throw new TypeErrorCtor("parallel() takes an array of functions, or an array and a function");
      parallelDepth++;
      let outcomes;
      try {
        outcomes = await all(items.map(item => {
          const branch = fn === undefined ? item : () => fn(item);
          if (typeof branch !== "function") throw new TypeErrorCtor("parallel() takes an array of functions, or an array and a function");
          return branch();
        }));
      } finally { parallelDepth--; }
      const values = [];
      for (const outcome of outcomes) { if (outcome.status === "rejected") throw outcome.reason; values.push(outcome.value); }
      return values;
    },
    log(...parts) {
      const text = parts.map(part => typeof part === "string" ? part : (() => { try { return stringify(part); } catch { return String(part); } })()).join(" ");
      bridge("log", text, phase);
    },
    phase(name) {
      if (typeof name !== "string" || name === "") throw new TypeErrorCtor("phase(name) needs a name");
      phase = name;
      bridge("phase", name);
    },
    now() { return now(); },
    random() { return random(); },
  };
  for (const name of keysOf(globals)) defineProperty(globalThis, name, { value: globals[name], enumerable: true });
  return {
    settle,
    adopt,
    run(fn) {
      let promise;
      try { promise = fn(); } catch (error) { finished = true; bridge("done", false, describe(error)); return; }
      promise.then(
        value => { if (finished) return; finished = true; let json; try { json = stringify(value); } catch (error) { bridge("done", false, describe(error)); return; } bridge("done", true, json); },
        error => { if (finished) return; finished = true; bridge("done", false, describe(error)); },
      );
    },
    status() { return finished ? -1 : pending.size; },
  };
})`;

const PRELUDE_HASH = fnv1a64(WORKFLOW_PRELUDE);

/** The build a snapshot belongs to. A snapshot restores only into the identical build; any other replays. */
export function workflowFingerprint() {
  return `quickjs-wasi ${QUICKJS_WASI_VERSION}, wasm ${QUICKJS_WASM_SHA256.slice(0, 16)}, prelude ${PRELUDE_HASH}, driver ${WORKFLOW_DRIVER_VERSION}, stack ${WORKFLOW_STACK_BYTES}, heap ${WORKFLOW_HEAP_BYTES}`;
}

/** Host-side state outside linear memory: with the memory image, everything a restore needs. */
interface DriverState {
  /** Where quickjs-wasi's state sits in the image (its `Snapshot` fields), set when a snapshot is taken. */
  image?: { stackPointer: number; runtimePtr: number; contextPtr: number; bytes: number };
  fingerprint: string;
  script: string;
  clock: { startedAt: number; now: number; seed: number };
  prng: number;
  tokens?: { api: number; settle: number; status: number };
}

class Interrupted extends Error {}

/**
 * What an uncatchable VM error was: the step's poll budget used up, the heap full (QuickJS fails a promise job it
 * cannot allocate for), or anything else, which is a VM crash rather than something the script did.
 */
export function classifyVmFailure(message: string, polls: number, heapBytes: number): { code: WorkflowFaultCode; message: string } {
  if (polls > WORKFLOW_POLL_BUDGET) return { code: "step_budget", message: `The step used up its budget of ${WORKFLOW_POLL_BUDGET} interrupt polls` };
  if (/out of memory/i.test(message) || heapBytes >= WORKFLOW_HEAP_BYTES * 0.9)
    return { code: "out_of_memory", message: `The script ran out of its ${WORKFLOW_HEAP_BYTES / 1024 / 1024} MiB heap (${message})` };
  return { code: "vm_crash", message: `The VM failed: ${message}` };
}

const checkVersion = (vm: QuickJS) => {
  if (vm.versions["quickjs-wasi"] !== QUICKJS_WASI_VERSION)
    throw new Error(`The sandbox runs quickjs-wasi ${vm.versions["quickjs-wasi"]}, built for ${QUICKJS_WASI_VERSION}: update QUICKJS_WASI_VERSION and QUICKJS_WASM_SHA256`);
};

/** One VM for one step, started or restored, reporting into `sink`. */
class WorkflowVm {
  polls = 0;
  replaying = false;
  creating = false;
  vm!: QuickJS;
  api!: JSValueHandle;
  settleFn!: JSValueHandle;
  statusFn!: JSValueHandle;
  phase: string | undefined;
  readonly issued: IssuedEffect[] = [];
  readonly logs: { phase: string | undefined; text: string }[] = [];
  done?: { ok: true; value: string | undefined } | { ok: false; error: string };
  fault?: { code: WorkflowFaultCode; message: string };
  state: DriverState;

  constructor(state: DriverState) { this.state = state; }

  options() {
    const self = this;
    const next = () => {
      self.state.prng = (self.state.prng + 0x6d2b79f5) >>> 0;
      let value = Math.imul(self.state.prng ^ (self.state.prng >>> 15), 1 | self.state.prng);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return (value ^ (value >>> 14)) >>> 0;
    };
    return {
      memoryLimit: WORKFLOW_HEAP_BYTES, maxStackSize: WORKFLOW_STACK_BYTES, timezoneOffset: 0, intrinsics: Intrinsics.ALL & ~Intrinsics.WEAK_REF,
      interruptHandler: () => ++self.polls > WORKFLOW_POLL_BUDGET,
      wasi: (memory: WebAssembly.Memory) => ({
        fd_write(_fd: number, iovs: number, count: number, written: number) {
          const view = new DataView(memory.buffer);
          let total = 0;
          for (let i = 0; i < count; i++) total += view.getUint32(iovs + i * 8 + 4, true);
          view.setUint32(written, total, true);
          return 0;
        },
        clock_time_get(id: number, _precision: bigint, result: number) {
          const clock = self.state.clock;
          // While the context is created QuickJS seeds Math.random() from this reading: derive it from the seed.
          const ns = self.creating ? (id === 0 ? BigInt(clock.seed + 1) * 1000n : 0n)
            : id === 0 ? BigInt(Math.round(clock.now)) * 1_000_000n : BigInt(Math.round(clock.now - clock.startedAt)) * 1_000_000n;
          new DataView(memory.buffer).setBigUint64(result, ns, true);
          return 0;
        },
        random_get(pointer: number, length: number) {
          const bytes = new Uint8Array(memory.buffer, pointer, length);
          for (let i = 0; i < length; i += 4) { const value = next(); for (let b = 0; b < 4 && i + b < length; b++) bytes[i + b] = value >>> (b * 8); }
          return 0;
        },
      }),
    };
  }

  bridge = (kind: JSValueHandle, a: JSValueHandle, b: JSValueHandle, c: JSValueHandle, d: JSValueHandle, e?: JSValueHandle, f?: JSValueHandle) => {
    const text = (handle: JSValueHandle | undefined) => handle === undefined || handle.isUndefined ? undefined : handle.toString();
    switch (kind.toString()) {
      case "effect": {
        const phase = text(d), options = text(e);
        const effect: IssuedEffect = { key: a.toString(), kind: b.toString(), args: c.toString(), phase: phase || undefined, replayed: this.replaying, reused: f !== undefined && f.toBoolean() };
        if (options !== undefined) effect.options = options;
        this.issued.push(effect);
        break;
      }
      case "log": if (!this.replaying) this.logs.push({ phase: text(b) || undefined, text: a.toString() }); break;
      case "phase": this.phase = a.toString(); break;
      case "fault": this.fault ??= { code: a.toString() as WorkflowFaultCode, message: b.toString() }; break;
      case "done": this.done ??= a.toBoolean() ? { ok: true, value: text(b) } : { ok: false, error: b.toString() }; break;
    }
    return this.vm.undefined;
  };

  /** Run promise jobs until none is left, polling the budget as QuickJS does between opcodes. */
  drain() {
    const exports = this.vm._getExports();
    let jobs = 0;
    while (exports.qjs_is_job_pending()) {
      if (exports.qjs_execute_pending_job() < 0) throw new Interrupted("a promise job failed");
      if (++jobs % 50 === 0 && ++this.polls > WORKFLOW_POLL_BUDGET) throw new Interrupted("Execution interrupted");
    }
  }

  static async start(request: WorkflowStepRequest, wasm: WebAssembly.Module, fingerprint: string) {
    const self = new WorkflowVm({
      fingerprint, script: fnv1a64(request.code), clock: { startedAt: request.startedAt, now: request.startedAt, seed: request.seed >>> 0 },
      prng: (request.seed ^ 0x9e3779b9) >>> 0,
    });
    self.creating = true;
    const vm = self.vm = await QuickJS.create({ ...self.options(), wasm } as never);
    self.creating = false;
    checkVersion(vm);
    const bridge = vm.newFunction("bridge", self.bridge as never);
    self.api = vm.withScope(scope => scope.escape(vm.callFunction(vm.evalCode(WORKFLOW_PRELUDE, "workflow-prelude.js"), vm.undefined, bridge)));
    self.settleFn = self.api.getProp("settle");
    self.statusFn = self.api.getProp("status");
    return self;
  }

  /** Run the script from its start until it first waits, knowing `table` first. */
  begin(code: string, table: WorkflowStepRequest["table"]) {
    const vm = this.vm;
    try {
      if (table?.length) {
        const adopt = this.api.getProp("adopt");
        vm.withScope(() => vm.callFunction(adopt, this.api, vm.newString(JSON.stringify(table))));
        adopt.dispose();
      }
      const run = this.api.getProp("run");
      const fn = vm.evalCode(`(async () => {${code}\n})`, "workflow.js");
      vm.callFunction(run, this.api, fn).dispose();
      fn.dispose(); run.dispose();
      this.drain();
    } catch (error) { this.crash(error); }
  }

  deliver(batch: WorkflowBatch) {
    if (this.fault || this.done) return;
    const vm = this.vm, clock = this.state.clock;
    clock.now = Math.max(clock.now, batch.at);
    try {
      for (const result of batch.results) {
        vm.withScope(() => vm.callFunction(this.settleFn, this.api, vm.newString(result.key), result.ok ? vm.true : vm.false, vm.newString(result.value)));
      }
      this.drain();
    } catch (error) { this.crash(error); }
  }

  private crash(error: unknown) {
    let heap = 0;
    try { heap = this.heapBytes; } catch { /* a VM too broken to report its heap */ }
    this.fault ??= classifyVmFailure(error instanceof Error ? error.message : String(error), this.polls, heap);
  }

  /** -1 once the script ended, else how many effects it waits on. */
  status() {
    if (this.fault || this.done) return -1;
    const value = this.vm.callFunction(this.statusFn, this.api);
    try { return value.toNumber(); } finally { value.dispose(); }
  }

  get linearBytes() { return this.vm._getExports().memory.buffer.byteLength; }

  /**
   * The VM's state as the parts of a snapshot: the header (driver state and where quickjs-wasi's state sits) and one
   * copy of linear memory. The caller disposes the VM before compressing them, so the live memory is not held too.
   */
  take(): Uint8Array[] {
    // Exported once: a restored VM keeps exported boxes for good, so the tokens stay valid in every later snapshot.
    this.state.tokens ??= { api: this.vm.exportHandle(this.api), settle: this.vm.exportHandle(this.settleFn), status: this.vm.exportHandle(this.statusFn) };
    const snapshot = this.vm.snapshot();
    if (snapshot.extensions.length) throw new Error("A workflow VM has no extensions");
    this.state.image = { stackPointer: snapshot.stackPointer, runtimePtr: snapshot.runtimePtr, contextPtr: snapshot.contextPtr, bytes: snapshot.memory.byteLength };
    const header = new TextEncoder().encode(JSON.stringify(this.state));
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, header.byteLength, true);
    return [length, header, snapshot.memory];
  }

  /** Read a snapshot's header without restoring it. */
  static header(bytes: Uint8Array): { state: DriverState; image: Uint8Array } {
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
    return { state: JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) as DriverState, image: bytes.subarray(4 + length) };
  }

  static async restore(state: DriverState, image: Uint8Array, wasm: WebAssembly.Module) {
    const self = new WorkflowVm(state);
    const at = state.image;
    if (!at || at.bytes !== image.byteLength) throw new Error("The snapshot's image does not match its header");
    // The image is a view of the decompressed bytes; restore copies it into the new instance's memory once.
    const vm = self.vm = await QuickJS.restore({ memory: image, stackPointer: at.stackPointer, runtimePtr: at.runtimePtr, contextPtr: at.contextPtr, extensions: [] }, { ...self.options(), wasm } as never);
    checkVersion(vm);
    vm.registerHostCallback("bridge", self.bridge as never);
    const tokens = state.tokens!;
    self.api = vm.importHandle(tokens.api);
    self.settleFn = vm.importHandle(tokens.settle);
    self.statusFn = vm.importHandle(tokens.status);
    return self;
  }

  get heapBytes() { return this.vm.getMemoryUsage().memoryUsedSize; }
  dispose() { this.vm.dispose(); }
}

async function pipe(parts: Uint8Array[], stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }) {
  const writer = stream.writable.getWriter();
  const written = (async () => { for (const part of parts) await writer.write(part); await writer.close(); })();
  const out = new Uint8Array(await new Response(stream.readable).arrayBuffer());
  await written;
  return out;
}
/** gzip of `parts` in order, without joining them first. */
export const gzip = (...parts: Uint8Array[]) => pipe(parts, new CompressionStream("gzip"));
export const gunzip = (bytes: Uint8Array) => pipe([bytes], new DecompressionStream("gzip"));

/**
 * One workflow step, in the sandbox. `wasm` is quickjs-wasi's compiled module (the one Wrangler bundled). Throws only
 * for a request it cannot read; a script's own failure, or one it causes, is an outcome.
 */
export async function serveWorkflowStep(request: WorkflowStepRequest, wasm: WebAssembly.Module): Promise<WorkflowStepOutcome> {
  if (request?.protocol !== WORKFLOW_STEP_PROTOCOL)
    throw new Error(`Workflow step: protocol ${String(request?.protocol)} is not ${WORKFLOW_STEP_PROTOCOL}, the one this sandbox speaks; the workflow runner and the sandbox Worker run different versions`);
  const fingerprint = workflowFingerprint();
  let vm: WorkflowVm;
  let replayed = false, disposed = false;
  if (request.restore) {
    const { state, image } = WorkflowVm.header(await gunzip(request.restore));
    if (state.fingerprint !== fingerprint)
      return { kind: "refused", reason: "fingerprint", message: `The snapshot is from build "${state.fingerprint}" and cannot restore into "${fingerprint}"; replay from the journal instead` };
    if (state.script !== fnv1a64(request.code))
      return { kind: "refused", reason: "script", message: "The snapshot is of another revision of the script; replay from the journal instead" };
    vm = await WorkflowVm.restore(state, image, wasm);
  } else {
    vm = await WorkflowVm.start(request, wasm, fingerprint);
    if (request.beganAt !== undefined) vm.state.clock.now = Math.max(vm.state.clock.now, request.beganAt);
    replayed = request.replay !== undefined;
    vm.replaying = replayed;
    vm.begin(request.code, request.table);
    for (const batch of request.replay ?? []) vm.deliver(batch);
    vm.replaying = false;
  }
  try {
    if (request.deliver) vm.deliver(request.deliver);
    // QuickJS turns a used-up budget into an uncatchable error the script may report as its own failure.
    if (vm.polls > WORKFLOW_POLL_BUDGET) {
      vm.done = undefined;
      vm.fault = { code: "step_budget", message: `The step used up its budget of ${WORKFLOW_POLL_BUDGET} interrupt polls` };
    }
    if (!vm.fault && !vm.done && vm.status() === 0)
      vm.fault = { code: "stalled", message: "The script waits on nothing that can ever settle: no effect is pending" };
    const live = !vm.fault && !vm.done;
    const heapBytes = live ? vm.heapBytes : 0, rawBytes = live ? vm.linearBytes : 0;
    // Past the raw cap the image is not even copied: the next step replays.
    const parts = live && rawBytes <= WORKFLOW_SNAPSHOT_RAW_BYTES ? vm.take() : undefined;
    vm.dispose();
    disposed = true;
    let snapshot: Uint8Array | undefined, snapshotBytes = 0;
    if (parts) {
      const bytes = await gzip(...parts);
      parts.length = 0;
      snapshotBytes = bytes.byteLength;
      if (snapshotBytes <= request.snapshotCap) snapshot = bytes;
    }
    return {
      kind: "ran", fingerprint, replayed, issued: vm.issued, logs: vm.logs, phase: vm.phase, done: vm.done, fault: vm.fault,
      snapshot, snapshotBytes, snapshotRawBytes: rawBytes, polls: vm.polls, heapBytes,
    };
  } finally { if (!disposed) vm.dispose(); }
}
