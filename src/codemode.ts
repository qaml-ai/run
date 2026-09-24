import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { Rpc } from "./rpc.ts";
import type { ToolBridge, WireMessage } from "./protocol.ts";
import { jsonWithinLimit, SANDBOX_LIMITS } from "./limits.ts";
import { validateDefinitions, validateToolCall } from "./tool-policy.ts";
import { prepareCodeModeUserCode, stripTypeScriptFromUserCode } from "../shared/code-mode-source.ts";

/** How long a cancelled guest gets to unwind before its worker is terminated and replaced. */
const CANCEL_GRACE_MS = 250;

type Slot = { worker: Worker; state: "starting" | "idle" | "busy"; dispatched: number; idle?: (clean: boolean) => void; reaper?: NodeJS.Timeout };

/**
 * Warm worker threads, each running QuickJS/WASM. A worker is only resource
 * control (a thread that can be terminated); the sandbox is QuickJS itself, and
 * every execution gets a fresh WASM instance, runtime and context.
 */
export class CodePool {
  min: number;
  readonly max: number;
  readonly idleMs: number;
  readonly slots = new Set<Slot>();
  private readonly waiters: { resolve: (slot: Slot) => void; reject: (error: Error) => void }[] = [];

  constructor(options: { min?: number; max?: number; idleMs?: number } = {}) {
    this.max = options.max ?? 32;
    this.min = Math.min(options.min ?? Math.min(4, availableParallelism()), this.max);
    this.idleMs = options.idleMs ?? 30_000;
    if (!Number.isInteger(this.min) || this.min < 0 || !Number.isInteger(this.max) || this.max < 1) throw new Error("Invalid codemode worker pool size");
    for (let i = 0; i < this.min; i++) this.spawn();
  }

  private spawn() {
    const worker = new Worker(new URL("./code-worker.ts", import.meta.url), {
      // Guest code never sees the worker's Node globals; an empty env still keeps secrets out of its copy.
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
    });
    const slot: Slot = { worker, state: "starting", dispatched: 0 };
    this.slots.add(slot);
    worker.on("message", message => {
      if (message === "ready") this.release(slot);
      // Tagged, so a late signal from an earlier execution cannot vouch for the current one.
      else if (message?.idle === slot.dispatched) slot.idle?.(true);
    });
    worker.on("error", error => {
      if (slot.state === "starting") this.waiters.shift()?.reject(error);
    });
    worker.once("exit", () => {
      this.slots.delete(slot);
      clearTimeout(slot.reaper);
      slot.idle?.(false);
      // A worker that never started is not replaced for warmth: that would retry a broken boot forever.
      if (slot.state !== "starting") while (this.slots.size < this.min) this.spawn();
      this.grow();
    });
  }

  /** Start workers for waiters not already covered by ones starting. */
  private grow() {
    const starting = [...this.slots].filter(slot => slot.state === "starting").length;
    for (let i = starting; i < this.waiters.length && this.slots.size < this.max; i++) this.spawn();
  }

  /** Return a worker whose guest is disposed. */
  release(slot: Slot) {
    slot.idle = undefined;
    const waiter = this.waiters.shift();
    if (waiter) return waiter.resolve(this.take(slot));
    slot.state = "idle";
    slot.worker.unref();
    if (this.slots.size > this.min) {
      slot.reaper = setTimeout(() => { if (slot.state === "idle" && this.slots.size > this.min) void slot.worker.terminate(); }, this.idleMs);
      slot.reaper.unref();
    }
  }

  private take(slot: Slot) {
    clearTimeout(slot.reaper);
    slot.state = "busy";
    slot.worker.ref();
    return slot;
  }

  /** A worker for one execution, queued until one frees up or `signal` aborts. */
  acquire(signal: AbortSignal): Promise<Slot> {
    signal.throwIfAborted();
    const idle = [...this.slots].find(slot => slot.state === "idle");
    if (idle) return Promise.resolve(this.take(idle));
    const waiter = Promise.withResolvers<Slot>();
    const abort = () => {
      this.waiters.splice(this.waiters.indexOf(entry), 1);
      waiter.reject(signal.reason);
    };
    const entry = {
      resolve: (slot: Slot) => { signal.removeEventListener("abort", abort); waiter.resolve(slot); },
      reject: (error: Error) => { signal.removeEventListener("abort", abort); waiter.reject(error); },
    };
    signal.addEventListener("abort", abort, { once: true });
    this.waiters.push(entry);
    this.grow();
    return waiter.promise;
  }

  /** Hand one execution's port to the worker. Resolves true once its guest is disposed, false if the worker died. */
  dispatch(slot: Slot, port: MessagePort, cancel: SharedArrayBuffer): Promise<boolean> {
    const idle = new Promise<boolean>(resolve => { slot.idle = resolve; });
    slot.worker.postMessage({ port, cancel, id: ++slot.dispatched }, [port]);
    return idle;
  }

  /** After a cancelled execution: reuse the worker once its guest unwinds, or terminate and replace it. */
  async recover(slot: Slot, idle: Promise<boolean>) {
    let timer: NodeJS.Timeout | undefined;
    const clean = await Promise.race([idle, new Promise<false>(resolve => { timer = setTimeout(resolve, CANCEL_GRACE_MS, false); })]);
    clearTimeout(timer);
    if (clean && this.slots.has(slot)) this.release(slot);
    else await slot.worker.terminate();
  }

  async close() {
    this.min = 0;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("Codemode worker pool closed"));
    await Promise.all([...this.slots].map(slot => slot.worker.terminate()));
  }
}

let shared: CodePool | undefined;
/** The process-wide pool, sized by AGENT_CODE_WORKERS_MIN and AGENT_CODE_WORKERS_MAX. */
export function codePool() {
  const count = (name: string) => process.env[name] ? Number(process.env[name]) : undefined;
  return shared ??= new CodePool({ min: count("AGENT_CODE_WORKERS_MIN"), max: count("AGENT_CODE_WORKERS_MAX") });
}

export async function executeCode(options: {
  code: string; bridge: ToolBridge; signal?: AbortSignal;
  timeoutMs?: number; maxOutputCharacters?: number;
  onEvent?: (event: unknown) => void;
  pool?: CodePool;
}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputCharacters = options.maxOutputCharacters ?? 32_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("timeoutMs must be 1..120000");
  if (!Number.isInteger(maxOutputCharacters) || maxOutputCharacters < 1 || maxOutputCharacters > 128_000) throw new Error("maxOutputCharacters must be 1..128000");
  if (typeof options.code !== "string" || options.code.length > 256_000) throw new Error("Invalid or oversized code");
  validateDefinitions(options.bridge.definitions);
  // Here rather than in the worker: sucrase would cost every worker its own copy,
  // and it is linear in code already capped at 256 KB (tens of milliseconds at worst).
  const code = prepareCodeModeUserCode(await stripTypeScriptFromUserCode(options.code));
  options.signal?.throwIfAborted();
  const pool = options.pool ?? codePool();
  const started = performance.now();
  const timedOut = `Codemode timed out after ${timeoutMs}ms; external side effects may have completed`;
  const controller = new AbortController();
  const cancel = new SharedArrayBuffer(4);
  let slot: Slot | undefined;
  let idle: Promise<boolean> | undefined;
  let rpc: Rpc | undefined;
  let responded = false;
  const stop = (reason: string) => {
    if (controller.signal.aborted) return;
    controller.abort(new Error(reason));
    // Reaches a guest spinning in QuickJS, which sees no messages until it yields.
    Atomics.store(new Int32Array(cancel), 0, 1);
    rpc?.close(reason);
  };
  const abort = () => stop("Codemode aborted; any external tool side effects may already have completed");
  const timer = setTimeout(() => stop(slot ? timedOut : `Codemode timed out after ${timeoutMs}ms waiting for a sandbox worker (all ${pool.max} busy)`), timeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });
  const { port1, port2 } = new MessageChannel();
  try {
    slot = await pool.acquire(controller.signal);
    controller.signal.throwIfAborted();
    idle = pool.dispatch(slot, port2, cancel);
    const channel = rpc = new Rpc(message => port1.postMessage(message));
    port1.on("message", message => { void channel.receive(message as WireMessage); });
    // A terminated or crashed worker closes its end.
    port1.once("close", () => stop("Codemode worker exited"));
    channel.onEvent = options.onEvent;
    let calls = 0;
    let inflight = 0;
    let transferred = 0;
    channel.handler = async (method, params) => {
      if (method !== "tool") throw new Error("Unknown tool");
      const checked = validateToolCall(options.bridge.definitions, params.name, params.args);
      if (++calls > SANDBOX_LIMITS.toolCalls) throw new Error("Codemode tool call limit exceeded");
      if (inflight >= SANDBOX_LIMITS.concurrentTools) throw new Error("Too many concurrent tool calls");
      transferred += checked.bytes;
      if (transferred > SANDBOX_LIMITS.totalToolBytes) throw new Error("Codemode transfer limit exceeded");
      controller.signal.throwIfAborted();
      inflight++;
      try {
        const result = await options.bridge.call(checked.tool.name, checked.args, controller.signal);
        controller.signal.throwIfAborted();
        const json = jsonWithinLimit(result, SANDBOX_LIMITS.resultBytes, "Tool result");
        transferred += Buffer.byteLength(json);
        if (transferred > SANDBOX_LIMITS.totalToolBytes) throw new Error("Codemode transfer limit exceeded");
        return json;
      } finally { inflight--; }
    };
    const remainingMs = Math.max(1, Math.floor(timeoutMs - (performance.now() - started)));
    // The worker answers only after disposing the guest, so an answer means it is free again.
    return await channel.request("execute", { code, tools: options.bridge.definitions, maxOutputCharacters, timeoutMs: remainingMs })
      .finally(() => { responded = !controller.signal.aborted; });
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    // The guest's own deadline can report just before this side's timer fires.
    if (performance.now() - started >= timeoutMs) throw new Error(timedOut);
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    stop("Codemode completed");
    port1.close();
    if (slot && (responded || !idle)) pool.release(slot);
    else if (slot) void pool.recover(slot, idle!);
  }
}
