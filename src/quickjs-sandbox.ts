import {
  newQuickJSWASMModuleFromVariant, newVariant, RELEASE_SYNC,
  type QuickJSHandle, type QuickJSDeferredPromise,
} from "quickjs-emscripten";
import { SANDBOX_LIMITS } from "./limits.ts";
import { SANDBOX_BOOTSTRAP } from "./sandbox-bootstrap.ts";
import type { ToolDefinition } from "./protocol.ts";

/**
 * The last execution's memory, kept for the next one on this thread. A new
 * WebAssembly.Memory per execution counts as tens of MB of external memory each
 * time, and V8 answers with a full GC of the worker per execution or so: most of
 * what an execution cost. Zeroed before reuse, it is as fresh as a new one.
 */
let spare: WebAssembly.Memory | undefined;

/**
 * Runs in a pool worker. The main thread has already validated the catalog and
 * prepared the code, and it enforces tool-call schemas and quotas; this side
 * only bounds what crosses from the guest before handing it over.
 */
export async function runSandbox(options: {
  /** Compiled once per worker; every execution instantiates it with zeroed, bounded memory. */
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
  tools: ToolDefinition[];
  timeoutMs: number;
  maxOutputCharacters: number;
  /** Resolves with the result as JSON, already within the size and transfer limits. */
  call: (name: string, args: unknown) => Promise<string>;
  onOutput: (text: string) => void;
  /** Benchmark hook (scripts/bench-js-exec.ts): called as each phase of the execution ends. */
  mark?: (phase: string) => void;
}) {
  const mark = options.mark ?? (() => {});
  // Hard guest-memory boundary: setMemoryLimit alone undercounts bulk
  // allocations in the pinned 0.32.0 release (upstream issue #271).
  // It starts at the module's declared minimum (16 MB) and grows in place up to the bound.
  const memory = spare ?? new WebAssembly.Memory({ initial: 256, maximum: SANDBOX_LIMITS.wasmBytes / 65536 });
  spare = undefined;
  new Uint8Array(memory.buffer).fill(0);
  mark("zero");
  const module = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmMemory: memory, wasmModule: options.wasmModule }));
  if (module.getWasmMemory() !== memory) throw new Error("QuickJS did not use the bounded memory");
  mark("instantiate");
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(SANDBOX_LIMITS.heapBytes);
  runtime.setMaxStackSize(SANDBOX_LIMITS.stackBytes);
  runtime.setModuleLoader(() => { throw new Error("Module imports are disabled in codemode"); });
  mark("runtime");
  const vm = runtime.newContext();
  mark("context");
  const handles: QuickJSHandle[] = [];
  const pending = new Set<QuickJSDeferredPromise>();
  const output: string[] = [];
  let remaining = options.maxOutputCharacters;
  let outputEvents = 0;
  let truncated = false;
  let calls = 0;
  let closed = false;
  let cpuMs = 0;
  let enteredAt = performance.now();
  const deadline = enteredAt + options.timeoutMs;
  let wake: (() => void) | undefined;
  let interrupted = false;
  runtime.setInterruptHandler(() => {
    const now = performance.now();
    interrupted ||= now >= deadline || cpuMs + now - enteredAt >= SANDBOX_LIMITS.cpuMs || Atomics.load(options.cancel, 0) === 1;
    return interrupted;
  });
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
  let formatError: QuickJSHandle;
  function guestError(handle: QuickJSHandle): Error {
    if (interrupted) return new Error("Codemode CPU or wall-clock limit exceeded");
    const formatted = run(() => vm.callFunction(formatError, vm.undefined, handle));
    try {
      return new Error(formatted.error ? "Sandbox execution failed (memory or execution limit)" : string(formatted.value, 2048));
    } finally { formatted.dispose(); }
  }
  try {
    const emit = vm.newFunction("emit", (value, overflow) => {
      const text = string(value, 128_000);
      const part = outputEvents < SANDBOX_LIMITS.outputEvents ? text.slice(0, remaining) : "";
      truncated ||= text.length > part.length || vm.getNumber(overflow) === 1;
      if (part) {
        outputEvents++;
        remaining -= part.length;
        output.push(part);
        options.onOutput(part);
      }
      return vm.undefined;
    });
    handles.push(emit);
    const call = vm.newFunction("call", (nameHandle, jsonHandle) => {
      const name = string(nameHandle, 80);
      const args = JSON.parse(string(jsonHandle, SANDBOX_LIMITS.argumentBytes));
      // Also enforced by the main thread; failing here keeps a flood of calls from ever becoming messages.
      if (++calls > SANDBOX_LIMITS.toolCalls) throw new Error("Codemode tool call limit exceeded");
      if (pending.size >= SANDBOX_LIMITS.concurrentTools) throw new Error("Too many concurrent tool calls");
      const promise = vm.newPromise();
      pending.add(promise);
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
    });
    handles.push(call);
    const bootstrap = vm.unwrapResult(vm.evalCode(SANDBOX_BOOTSTRAP, "sandbox-bootstrap.js"));
    handles.push(bootstrap);
    const catalog = vm.newString(JSON.stringify(options.tools));
    handles.push(catalog);
    formatError = vm.unwrapResult(vm.callFunction(bootstrap, vm.undefined, call, emit, catalog));
    handles.push(formatError);
    mark("bindings");
    const initial = run(() => vm.evalCode(`(async function() { "use strict";\n${options.code}\n})().then(value => { if (value !== undefined) text(value); })`, "codemode.js"));
    // Only compiling can fail here: the code's own errors reject the promise.
    if (initial.error) {
      try {
        if (options.javascriptOnly && errorName(initial.error) === "SyntaxError") return { typescript: true as const };
        throw guestError(initial.error);
      } finally { initial.dispose(); }
    }
    const result = initial.value;
    handles.push(result);
    mark("compile");
    while (true) {
      const jobs = run(() => runtime.executePendingJobs(64));
      if (jobs.error) { try { throw guestError(jobs.error); } finally { jobs.dispose(); } }
      jobs.dispose();
      const state = vm.getPromiseState(result);
      if (state.type === "fulfilled") {
        state.value.dispose();
        if (pending.size) throw new Error("Unawaited tool calls: await all tool promises before returning");
        break;
      }
      if (state.type === "rejected") { try { throw guestError(state.error); } finally { state.error.dispose(); } }
      if (interrupted) throw new Error("Codemode CPU or wall-clock limit exceeded");
      // Bounded batches yield to host IPC. No guest timers, network, filesystem,
      // process APIs or host object references are installed.
      if (runtime.hasPendingJob()) await new Promise<void>(resolve => setImmediate(resolve));
      else await new Promise<void>(resolve => { wake = resolve; });
    }
    mark("run");
    return { output, truncated };
  } finally {
    closed = true;
    wake = undefined;
    options.signal.removeEventListener("abort", onAbort);
    for (const promise of pending) promise.dispose();
    for (const handle of handles.reverse()) if (handle.alive) handle.dispose();
    vm.dispose();
    runtime.dispose();
    spare = memory;
    mark("teardown");
  }
}
