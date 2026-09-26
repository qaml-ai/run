import {
  newQuickJSWASMModuleFromVariant, newVariant, RELEASE_SYNC,
  type QuickJSContext, type QuickJSHandle, type QuickJSDeferredPromise, type QuickJSRuntime,
} from "quickjs-emscripten";
import { SANDBOX_LIMITS } from "./limits.ts";
import { SANDBOX_BOOTSTRAP } from "./sandbox-bootstrap.ts";

/** What the running execution lends the image's host functions and interrupt handler. */
type Execution = {
  emit(value: QuickJSHandle, overflow: QuickJSHandle): void;
  call(name: QuickJSHandle, json: QuickJSHandle): QuickJSHandle;
  interrupted(): boolean;
};

/**
 * QuickJS set up once per thread (instance, runtime, limits, context, bootstrap)
 * before any guest code runs, then snapshotted. Every execution starts from the
 * snapshot, and ends by writing it back over the whole memory: the snapshot's pages
 * where it has any, zeros everywhere else, pages a guest grew included. So nothing an
 * execution did (globals, prototypes, atoms, heap, stack, Math.random state) survives
 * it, and the memory never holds a guest's data between executions.
 *
 * The one mutable wasm global (the stack pointer) is back where it was whenever
 * control returns from wasm normally. The host-side objects (quickjs-emscripten's
 * runtime and context, host function refs) are all created before the snapshot and
 * none are created after it, so they keep agreeing with the memory. Handles an
 * execution creates are abandoned, never freed: freeing one after the restore would
 * corrupt the snapshot's heap. Anything else leaving wasm (a trap, a host stack
 * overflow) may have stopped it halfway: that image is restored all the same, then
 * dropped, and the next execution builds a new one.
 */
type Image = {
  memory: WebAssembly.Memory;
  runtime: QuickJSRuntime;
  vm: QuickJSContext;
  install: QuickJSHandle;
  formatError: QuickJSHandle;
  /** The snapshot's nonzero pages, merged into runs: the rest of it is zero. */
  pages: { offset: number; bytes: Uint8Array }[];
  /** Where the context keeps Math.random's state, reseeded for every execution. */
  random: number;
  current?: Execution;
};

let image: Promise<Image> | undefined;

/**
 * Build this thread's image now rather than in its first execution. The first
 * build also runs the glue and wasm before V8 has optimized them: tens of ms.
 */
export function prepareSandbox(wasmModule: WebAssembly.Module, mark: (phase: string) => void = () => {}) {
  if (!image) {
    const building = image = build(wasmModule, mark);
    building.catch(() => { if (image === building) image = undefined; });
  }
  return image;
}

async function build(wasmModule: WebAssembly.Module, mark: (phase: string) => void): Promise<Image> {
  // Hard guest-memory boundary: setMemoryLimit alone undercounts bulk
  // allocations in the pinned 0.32.0 release (upstream issue #271).
  // It starts at the module's declared minimum (16 MB) and grows in place up to the bound.
  const memory = new WebAssembly.Memory({ initial: 256, maximum: SANDBOX_LIMITS.wasmBytes / 65536 });
  const module = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmMemory: memory, wasmModule }));
  if (module.getWasmMemory() !== memory) throw new Error("QuickJS did not use the bounded memory");
  mark("instantiate");
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(SANDBOX_LIMITS.heapBytes);
  runtime.setMaxStackSize(SANDBOX_LIMITS.stackBytes);
  runtime.setModuleLoader(() => { throw new Error("Module imports are disabled in codemode"); });
  mark("runtime");
  const vm = runtime.newContext();
  mark("context");
  const random = randomState(vm, memory);
  mark("random");
  const running = () => {
    if (!self.current) throw new Error("No execution is running");
    return self.current;
  };
  // Never disposed: a guest could not free these anyway (the bootstrap's helpers hold them).
  const emit = vm.newFunction("emit", (value, overflow) => { running().emit(value, overflow); return vm.undefined; });
  const call = vm.newFunction("call", (name, json) => running().call(name, json));
  const bootstrap = vm.unwrapResult(vm.evalCode(SANDBOX_BOOTSTRAP, "sandbox-bootstrap.js"));
  const helpers = vm.unwrapResult(vm.callFunction(bootstrap, vm.undefined, call, emit));
  const install = vm.getProp(helpers, 0);
  const formatError = vm.getProp(helpers, 1);
  helpers.dispose();
  bootstrap.dispose();
  mark("bindings");
  const self: Image = { memory, runtime, vm, install, formatError, pages: [], random };
  runtime.setInterruptHandler(() => self.current?.interrupted() ?? false);
  self.pages = snapshot(memory);
  mark("snapshot");
  return self;
}

const PAGE = 4096;

/** Offsets of the pages where `a` and `b` differ (compared natively: this runs before V8 optimizes anything). */
function differing(a: Uint8Array, b: Uint8Array) {
  const offsets: number[] = [];
  for (let offset = 0; offset < a.length; offset += PAGE) {
    if (!Buffer.from(a.buffer, a.byteOffset + offset, PAGE).equals(Buffer.from(b.buffer, b.byteOffset + offset, PAGE))) offsets.push(offset);
  }
  return offsets;
}

function snapshot(memory: WebAssembly.Memory) {
  const bytes = new Uint8Array(memory.buffer);
  const pages: Image["pages"] = [];
  let start = -1, end = -1;
  for (const offset of [...differing(bytes, new Uint8Array(bytes.length)), Infinity]) {
    if (offset === end) { end += PAGE; continue; }
    if (start >= 0) pages.push({ offset: start, bytes: bytes.slice(start, end) });
    [start, end] = [offset, offset + PAGE];
  }
  return pages;
}

/** Put the snapshot back over the whole memory, however far an execution grew it. */
function restore(self: Image) {
  const bytes = new Uint8Array(self.memory.buffer);
  let end = 0;
  for (const { offset, bytes: page } of self.pages) {
    bytes.fill(0, end, offset);
    bytes.set(page, offset);
    end = offset + page.length;
  }
  bytes.fill(0, end);
}

/**
 * Where Math.random keeps its state (xorshift64*, a 64-bit word in the context), found
 * by stepping it once and looking for the word that took one xorshift step, then checked
 * by seeding it and predicting the next number. A fresh context seeds it from the clock;
 * restored from a snapshot, every execution would draw the same numbers, so each gets
 * its own seed instead. If this QuickJS build keeps it some other way, no image is built.
 */
function randomState(vm: QuickJSContext, memory: WebAssembly.Memory): number {
  const mask = (1n << 64n) - 1n;
  const step = (x: bigint) => { x ^= x >> 12n; x = (x ^ (x << 25n)) & mask; return x ^ (x >> 27n); };
  const draw = () => {
    const result = vm.unwrapResult(vm.evalCode("Math.random()"));
    try { return vm.getNumber(result); } finally { result.dispose(); }
  };
  const before = new Uint8Array(memory.buffer.slice(0));
  draw();
  const after = new Uint8Array(memory.buffer);
  const found: number[] = [];
  for (const page of differing(before, after)) {
    const [was, now] = [before, after].map(bytes => new BigUint64Array(bytes.buffer, page, PAGE / 8));
    for (let i = 0; i < was.length; i++) if (was[i] !== 0n && now[i] === step(was[i])) found.push(page + i * 8);
  }
  const seed = 0x9e3779b97f4a7c15n;
  const expected = new DataView(new ArrayBuffer(8));
  expected.setBigUint64(0, (0x3ffn << 52n) | (((step(seed) * 0x2545f4914f6cdd1dn) & mask) >> 12n));
  if (found.length === 1) {
    new BigUint64Array(memory.buffer, found[0], 1)[0] = seed;
    if (draw() === expected.getFloat64(0) - 1) return found[0];
  }
  throw new Error("Could not find Math.random's state in the QuickJS context");
}

/** Errors this module raises on purpose. Anything else escaping an execution leaves its image suspect. */
const expected = new WeakSet<Error>();
function failure(message: string) {
  const error = new Error(message);
  expected.add(error);
  return error;
}

/**
 * Runs in a pool worker. The main thread has already validated the catalog and
 * prepared the code, and it enforces tool-call schemas and quotas; this side
 * only bounds what crosses from the guest before handing it over.
 */
export async function runSandbox(options: {
  /** Compiled once per worker; the thread's image is instantiated from it. */
  wasmModule: WebAssembly.Module;
  /** Set by the main thread while guest code may be spinning: the interrupt handler polls it. */
  cancel: Int32Array;
  /** Aborted when the main thread gives up, to wake a guest waiting on nothing. */
  signal: AbortSignal;
  /** JavaScript: stripped of TypeScript already, or (`javascriptOnly`) not yet. */
  code: string;
  /**
   * The code may still hold TypeScript. If it does not compile, answer
   * `{ typescript: true }` without running any of it, and the runtime strips it.
   */
  javascriptOnly?: boolean;
  /** The names of the tools code may call; their schemas and search stay on the host. */
  tools: string[];
  timeoutMs: number;
  maxOutputCharacters: number;
  /** Resolves with the result as JSON, already within the size and transfer limits. */
  call: (name: string, args: unknown) => Promise<string>;
  onOutput: (text: string) => void;
  /** Benchmark hook (scripts/bench-js-exec.ts): called as each phase of the execution ends. */
  mark?: (phase: string) => void;
}) {
  const mark = options.mark ?? (() => {});
  const self = await prepareSandbox(options.wasmModule, mark);
  if (self.current) throw new Error("The sandbox is already running an execution");
  const { runtime, vm, memory } = self;
  const pending = new Set<QuickJSDeferredPromise>();
  const output: string[] = [];
  let remaining = options.maxOutputCharacters;
  let outputEvents = 0;
  let truncated = false;
  let calls = 0;
  let closed = false;
  let faulted = false;
  let cpuMs = 0;
  let enteredAt = performance.now();
  const deadline = enteredAt + options.timeoutMs;
  let wake: (() => void) | undefined;
  let interrupted = false;
  const onAbort = () => { interrupted = true; wake?.(); };
  options.signal.addEventListener("abort", onAbort, { once: true });
  function run<T>(fn: () => T): T {
    enteredAt = performance.now();
    try { return fn(); }
    finally { cpuMs += performance.now() - enteredAt; }
  }
  // Never dump arbitrary guest objects into Node. Getters/proxies/toJSON must
  // execute inside QuickJS with the same limits as the rest of the script.
  function string(handle: QuickJSHandle, maxChars: number): string {
    if (vm.typeof(handle) !== "string") throw new Error("Sandbox bridge expects a string");
    const length = vm.getProp(handle, "length");
    try { if (vm.getNumber(length) > maxChars) throw new Error("Sandbox bridge string exceeds size limit"); }
    finally { length.dispose(); }
    return vm.getString(handle);
  }
  function errorName(handle: QuickJSHandle) {
    const name = vm.getProp(handle, "name");
    try { return vm.typeof(name) === "string" ? vm.getString(name) : undefined; }
    finally { name.dispose(); }
  }
  function guestError(handle: QuickJSHandle): Error {
    if (interrupted) return failure("Codemode CPU or wall-clock limit exceeded");
    const formatted = run(() => vm.callFunction(self.formatError, vm.undefined, handle));
    try {
      return failure(formatted.error ? "Sandbox execution failed (memory or execution limit)" : string(formatted.value, 2048));
    } finally { formatted.dispose(); }
  }
  self.current = {
    interrupted() {
      const now = performance.now();
      interrupted ||= now >= deadline || cpuMs + now - enteredAt >= SANDBOX_LIMITS.cpuMs || Atomics.load(options.cancel, 0) === 1;
      return interrupted;
    },
    emit(value, overflow) {
      const text = string(value, 128_000);
      const part = outputEvents < SANDBOX_LIMITS.outputEvents ? text.slice(0, remaining) : "";
      truncated ||= text.length > part.length || vm.getNumber(overflow) === 1;
      if (part) {
        outputEvents++;
        remaining -= part.length;
        output.push(part);
        options.onOutput(part);
      }
    },
    call(nameHandle, jsonHandle) {
      const name = string(nameHandle, 80);
      // fs.writeFile carries a file's bytes: up to a tool result's size, not a tool call's.
      const args = JSON.parse(string(jsonHandle, name === "fs.writeFile" ? SANDBOX_LIMITS.resultBytes : SANDBOX_LIMITS.argumentBytes));
      // Also enforced by the main thread; failing here keeps a flood of calls from ever becoming messages.
      if (++calls > SANDBOX_LIMITS.toolCalls) throw new Error("Codemode tool call limit exceeded");
      if (pending.size >= SANDBOX_LIMITS.concurrentTools) throw new Error("Too many concurrent tool calls");
      const promise = vm.newPromise();
      pending.add(promise);
      // Once the execution ends, its memory is the snapshot again: nothing touches its handles after that.
      void Promise.resolve().then(() => {
        if (closed) throw new Error("Sandbox execution ended");
        return options.call(name, args);
      }).then(json => {
        if (closed) return;
        const result = vm.newString(json);
        try { promise.resolve(result); } finally { result.dispose(); }
      }).catch(error => {
        if (closed) return;
        const message = error instanceof Error ? error.message : "Tool call failed";
        const result = vm.newError(message.slice(0, 2048));
        try { promise.reject(result); } finally { result.dispose(); }
      }).finally(() => {
        if (closed) return;
        pending.delete(promise);
        promise.dispose();
        wake?.();
      });
      return promise.handle;
    },
  };
  try {
    // A fresh context seeds Math.random itself; the snapshot's seed would repeat in every execution.
    const seed = new BigUint64Array(memory.buffer, self.random, 1);
    do crypto.getRandomValues(seed); while (seed[0] === 0n);
    const catalog = vm.newString(JSON.stringify(options.tools));
    vm.unwrapResult(vm.callFunction(self.install, vm.undefined, catalog)).dispose();
    catalog.dispose();
    mark("install");
    const initial = run(() => vm.evalCode(`(async function() { "use strict";\n${options.code}\n})().then(value => { if (value !== undefined) text(value); })`, "codemode.js"));
    // Only compiling can fail here: the code's own errors reject the promise.
    if (initial.error) {
      try {
        if (options.javascriptOnly && errorName(initial.error) === "SyntaxError") return { typescript: true as const };
        throw guestError(initial.error);
      } finally { initial.dispose(); }
    }
    const result = initial.value;
    mark("compile");
    while (true) {
      const jobs = run(() => runtime.executePendingJobs(64));
      if (jobs.error) { try { throw guestError(jobs.error); } finally { jobs.dispose(); } }
      jobs.dispose();
      const state = vm.getPromiseState(result);
      if (state.type === "fulfilled") {
        state.value.dispose();
        if (pending.size) throw failure("Unawaited tool calls: await all tool promises before returning");
        break;
      }
      if (state.type === "rejected") { try { throw guestError(state.error); } finally { state.error.dispose(); } }
      if (interrupted) throw failure("Codemode CPU or wall-clock limit exceeded");
      // Bounded batches yield to host IPC. No guest timers, network, filesystem,
      // process APIs or host object references are installed.
      if (runtime.hasPendingJob()) await new Promise<void>(resolve => setImmediate(resolve));
      else await new Promise<void>(resolve => { wake = resolve; });
    }
    mark("run");
    return { output, truncated };
  } catch (error) {
    faulted = !(error instanceof Error && expected.has(error));
    throw error;
  } finally {
    closed = true;
    wake = undefined;
    options.signal.removeEventListener("abort", onAbort);
    self.current = undefined;
    restore(self);
    if (faulted) image = undefined;
    mark("restore");
  }
}
