import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";
import { availableParallelism } from "node:os";
import { connect } from "node:net";
import { Rpc } from "./rpc.ts";
import { errorText, type ToolBridge, type WireMessage } from "./protocol.ts";
import { frames } from "./sandbox-wire.ts";
import { FILE_LIMITS, jsonWithinLimit, SANDBOX_LIMITS } from "./limits.ts";
import { prepareCodeModeUserCode, stripTypeScriptFromUserCode } from "../shared/code-mode-source.ts";
import { HOST_CALLS } from "./sandbox-bootstrap.ts";
import { namespaces, searchQuery, searchTools } from "./tool-search.ts";

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
  /** How many terminated workers may still be exiting before the pool stops starting new ones. */
  readonly maxDying: number;
  readonly slots = new Set<Slot>();
  /** Terminated workers whose threads have not exited yet: out of the pool, but still holding memory. */
  readonly dying = new Set<Worker>();
  private readonly waiters: { resolve: (slot: Slot) => void; reject: (error: Error) => void }[] = [];

  constructor(options: { min?: number; max?: number; idleMs?: number; maxDying?: number } = {}) {
    this.max = options.max ?? 32;
    this.min = Math.min(options.min ?? Math.min(4, availableParallelism()), this.max);
    this.idleMs = options.idleMs ?? 30_000;
    this.maxDying = options.maxDying ?? 8;
    if (!Number.isInteger(this.min) || this.min < 0 || !Number.isInteger(this.max) || this.max < 1 || !Number.isInteger(this.maxDying) || this.maxDying < 1) throw new Error("Invalid codemode worker pool size");
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
      if (!this.dying.delete(worker)) this.remove(slot);
      this.refill(slot);
    });
  }

  private remove(slot: Slot) {
    if (!this.slots.delete(slot)) return false;
    clearTimeout(slot.reaper);
    slot.idle?.(false);
    return true;
  }

  /**
   * Take a worker out of the pool and terminate it. Its slot is refilled now rather
   * than on 'exit', so a thread slow to stop never holds a slot, only its memory.
   */
  private retire(slot: Slot) {
    if (!this.remove(slot)) return;
    this.dying.add(slot.worker);
    if (this.dying.size >= this.maxDying) console.error(JSON.stringify({ type: "codemode_workers_dying", dying: this.dying.size, max: this.maxDying }));
    void slot.worker.terminate();
    this.refill(slot);
  }

  /** Replace a worker that left the pool, unless too many terminated ones are still exiting. */
  private refill(slot: Slot) {
    // A worker that never started is not replaced for warmth: that would retry a broken boot forever.
    if (slot.state !== "starting") while (this.slots.size < this.min && this.dying.size < this.maxDying) this.spawn();
    this.grow();
  }

  /** Start workers for waiters not already covered by ones starting. */
  private grow() {
    const starting = [...this.slots].filter(slot => slot.state === "starting").length;
    for (let i = starting; i < this.waiters.length && this.slots.size < this.max && this.dying.size < this.maxDying; i++) this.spawn();
  }

  /** Why an execution may be left waiting for a worker. */
  saturation() {
    return this.dying.size >= this.maxDying ? `${this.dying.size} terminated workers still exiting` : `all ${this.max} busy`;
  }

  /** Return a worker whose guest is disposed. */
  release(slot: Slot) {
    slot.idle = undefined;
    const waiter = this.waiters.shift();
    if (waiter) return waiter.resolve(this.take(slot));
    slot.state = "idle";
    slot.worker.unref();
    if (this.slots.size > this.min) {
      slot.reaper = setTimeout(() => { if (slot.state === "idle" && this.slots.size > this.min) this.retire(slot); }, this.idleMs);
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
    else this.retire(slot);
  }

  async close() {
    this.min = 0;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error("Codemode worker pool closed"));
    await Promise.all([...[...this.slots].map(slot => slot.worker), ...this.dying].map(worker => worker.terminate()));
  }
}

/** One execution's link to a QuickJS worker: in this process, or in a sandbox process. */
export interface Guest {
  /** Whether a worker has taken the execution, rather than it waiting in a queue. */
  readonly dispatched: boolean;
  send(message: WireMessage): void;
  /** Messages from the guest, unvalidated; `onClose` when its worker or process goes away first. */
  listen(onMessage: (message: unknown) => void, onClose: (reason: string) => void): void;
  /** Cancel the guest and let its worker go: at once if it answered, else once it unwinds or is replaced. */
  end(answered: boolean): void;
}

/** A worker of `pool` bound to one execution. */
export async function localGuest(pool: CodePool, signal: AbortSignal): Promise<Guest> {
  const slot = await pool.acquire(signal);
  const cancel = new SharedArrayBuffer(4);
  const { port1, port2 } = new MessageChannel();
  const idle = pool.dispatch(slot, port2, cancel);
  let ended = false;
  return {
    dispatched: true,
    send: message => port1.postMessage(message),
    listen(onMessage, onClose) {
      port1.on("message", onMessage);
      // A terminated or crashed worker closes its end.
      port1.once("close", () => onClose("Codemode worker exited"));
    },
    end(answered) {
      if (ended) return;
      ended = true;
      // Reaches a guest spinning in QuickJS, which sees no messages until it yields.
      Atomics.store(new Int32Array(cancel), 0, 1);
      port1.close();
      if (answered) pool.release(slot);
      else void pool.recover(slot, idle);
    },
  };
}

/**
 * One sandbox process (src/sandbox-server.ts), reached over the unix socket the
 * launcher bound for it: a connection per execution, closed to cancel it.
 */
export class SandboxProcess {
  readonly path: string;
  /** Executions this process has open to it. */
  load = 0;
  constructor(path: string) { this.path = path; }

  open(): Guest {
    const socket = connect(this.path);
    this.load++;
    let failure: Error | undefined;
    let ended = false;
    let deliver: (message: unknown) => void = () => {};
    const guest = {
      dispatched: false,
      send(message: WireMessage) {
        try { write(message); } catch (error) { socket.destroy(error as Error); }
      },
      listen(onMessage: (message: unknown) => void, onClose: (reason: string) => void) {
        deliver = onMessage;
        socket.once("close", () => onClose(`Codemode sandbox process exited${failure ? ` (${failure.message})` : ""}`));
      },
      end: () => {
        if (ended) return;
        ended = true;
        this.load--;
        socket.destroy();
      },
    };
    socket.on("error", error => { failure ??= error; });
    const write = frames(socket, message => {
      if (!guest.dispatched && (message as { type?: unknown })?.type === "dispatched") guest.dispatched = true;
      else deliver(message);
    });
    return guest;
  }

  /**
   * Parse an untrusted file here (inspect.ts): the request, then its bytes in frames of 2 MiB,
   * answered by one response. The answer is as untrusted as the process; the caller checks it.
   */
  inspect(bytes: Uint8Array, text: boolean): Promise<unknown> {
    const socket = connect(this.path);
    this.load++;
    const done = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => socket.destroy(new Error("the sandbox process took too long")), FILE_LIMITS.inspectMs + 2_000);
    socket.on("error", error => done.reject(error));
    socket.once("close", () => { this.load--; clearTimeout(timer); done.reject(new Error("the sandbox process closed the connection")); });
    const write = frames(socket, (message: any) => {
      if (message?.type !== "response") return void socket.destroy();
      if (message.error !== undefined) done.reject(new Error(String(message.error).slice(0, 300))); else done.resolve(message.result);
      socket.end();
    });
    try {
      write({ type: "request", id: "inspect", method: "inspect", params: { size: bytes.length, text } });
      for (let offset = 0; offset < bytes.length; offset += INSPECT_FRAME_BYTES) write({ type: "data", data: Buffer.from(bytes.subarray(offset, offset + INSPECT_FRAME_BYTES)).toString("base64") });
    } catch (error) { socket.destroy(error as Error); }
    return done.promise;
  }
}
/** Bytes per frame to a sandbox process: base64 of this stays well under a frame's 4 MiB. */
export const INSPECT_FRAME_BYTES = 2 * 1024 * 1024;

/** The sandbox processes the launcher started; each execution goes to the least loaded, ties round-robin. */
export class SandboxProcesses {
  readonly processes: SandboxProcess[];
  private next = 0;
  constructor(paths: string[]) {
    if (!paths.length) throw new Error("No sandbox processes");
    this.processes = paths.map(path => new SandboxProcess(path));
  }

  open(): Guest { return this.pick().open(); }

  /** The least loaded process, ties round-robin. */
  pick(): SandboxProcess {
    const count = this.processes.length;
    let pick = this.processes[this.next % count];
    for (let i = 1; i < count; i++) {
      const candidate = this.processes[(this.next + i) % count];
      if (candidate.load < pick.load) pick = candidate;
    }
    this.next = this.processes.indexOf(pick) + 1;
    return pick;
  }
}

let shared: CodePool | undefined;
/** The process-wide pool, sized by AGENT_CODE_WORKERS_MIN and AGENT_CODE_WORKERS_MAX. */
export function codePool() {
  const count = (name: string) => process.env[name] ? Number(process.env[name]) : undefined;
  return shared ??= new CodePool({ min: count("AGENT_CODE_WORKERS_MIN"), max: count("AGENT_CODE_WORKERS_MAX") });
}

let sandboxes: SandboxProcesses | null | undefined;
/**
 * The sandbox processes agent-launcher started (AGENT_SANDBOX_SOCKETS, which it sets), or
 * undefined without them: then js_exec runs on this process's own pool.
 */
export function sandboxProcesses(): SandboxProcesses | undefined {
  if (sandboxes === undefined) {
    const paths = (process.env.AGENT_SANDBOX_SOCKETS ?? "").split(",").filter(Boolean);
    sandboxes = paths.length ? new SandboxProcesses(paths) : null;
  }
  return sandboxes ?? undefined;
}

/** Tool calls, output events and the answer: more than this from one execution means the sandbox is misbehaving. */
const GUEST_MESSAGE_LIMIT = SANDBOX_LIMITS.toolCalls + SANDBOX_LIMITS.outputEvents + 8;

/**
 * Everything a guest sends is untrusted: a sandbox process could be compromised.
 * Keep only the checked fields of the messages a guest may send.
 */
function guestMessage(value: any): WireMessage {
  const id = value?.id;
  const validId = typeof id === "string" && id.length <= 64;
  if (value?.type === "request" && validId && value.method === "tool" && typeof value.params?.name === "string") {
    return { type: "request", id, method: "tool", params: { name: value.params.name, args: value.params.args } };
  }
  if (value?.type === "response" && validId) {
    if (value.error === undefined) return { type: "response", id, result: value.result };
    if (typeof value.error === "string") return { type: "response", id, error: value.error.slice(0, 4096) };
  }
  if (value?.type === "event" && value.event?.type === "output" && typeof value.event.text === "string") {
    return { type: "event", event: { type: "output", text: value.event.text } };
  }
  throw new Error("Codemode sandbox sent an invalid message");
}

function guestResult(value: any, maxOutputCharacters: number): { output: string[]; truncated: boolean } {
  const output = value?.output;
  if (!Array.isArray(output) || typeof value.truncated !== "boolean" || output.length > SANDBOX_LIMITS.outputEvents ||
    !output.every(part => typeof part === "string") || output.reduce((total, part) => total + part.length, 0) > maxOutputCharacters) {
    throw new Error("Codemode sandbox returned an invalid result");
  }
  return { output, truncated: value.truncated };
}

/** `tools.search`, `tools.describe` and `tools.namespaces`: answered from the catalog, which stays out of the sandbox. */
async function hostCall(bridge: ToolBridge, name: string, args: unknown) {
  if (name === HOST_CALLS.describe) {
    const tool = typeof args === "string" ? bridge.definitions.find(entry => entry.name === args) : undefined;
    if (!tool) return null;
    const { resultFormat: _format, ...described } = tool;
    return described;
  }
  if (name === HOST_CALLS.namespaces) return namespaces(bridge.definitions);
  const query = searchQuery(args);
  return bridge.search ? bridge.search(query) : searchTools(bridge.definitions, query);
}

export async function executeCode(options: {
  code: string; bridge: ToolBridge; signal?: AbortSignal;
  timeoutMs?: number; maxOutputCharacters?: number;
  onEvent?: (event: unknown) => void;
  /** Where to run: by default the sandbox processes, or without them this process's pool. */
  pool?: CodePool | { open(): Guest };
  /** Strip TypeScript here before running: set when the sandbox found the code does not compile as JavaScript. */
  typescript?: boolean;
}): Promise<{ output: string[]; truncated: boolean }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputCharacters = options.maxOutputCharacters ?? 32_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("timeoutMs must be 1..120000");
  if (!Number.isInteger(maxOutputCharacters) || maxOutputCharacters < 1 || maxOutputCharacters > 128_000) throw new Error("maxOutputCharacters must be 1..128000");
  if (typeof options.code !== "string" || options.code.length > 256_000) throw new Error("Invalid or oversized code");
  // Loaded here: sandbox processes import this module for CodePool alone, and typebox would cost each about 25 MB.
  const { validateDefinitions, validateToolCall } = await import("./tool-policy.ts");
  validateDefinitions(options.bridge.definitions);
  // Code gets the tools' names; their schemas and search are answered here (hostCall).
  const names = options.bridge.definitions.map(tool => tool.name);
  // Most code is plain JavaScript, and sucrase is most of what preparing it costs. Code
  // without a "<" goes to the sandbox as it is: QuickJS compiles it and, if that fails,
  // answers without running any of it, and it comes back here to be stripped. Never
  // V8: this process holds secrets, and no parser but QuickJS's (in WASM) and
  // sucrase's (JavaScript) sees guest code. A "<" may be a generic call, which
  // JavaScript reads as comparisons, so such code is always stripped first.
  // Sucrase runs here rather than in the worker, which would cost every worker its
  // own copy; it is linear in code already capped at 256 KB (tens of milliseconds at worst).
  const javascriptOnly = !options.typescript && !options.code.includes("<");
  const code = prepareCodeModeUserCode(javascriptOnly ? options.code : await stripTypeScriptFromUserCode(options.code));
  options.signal?.throwIfAborted();
  const pool = options.pool ?? sandboxProcesses() ?? codePool();
  const started = performance.now();
  const timedOut = `Codemode timed out after ${timeoutMs}ms; external side effects may have completed`;
  const controller = new AbortController();
  let guest: Guest | undefined;
  let rpc: Rpc | undefined;
  let responded = false;
  let typescript = false;
  const stop = (reason: string) => {
    if (controller.signal.aborted) return;
    controller.abort(new Error(reason));
    rpc?.close(reason);
    guest?.end(false);
  };
  const abort = () => stop("Codemode aborted; any external tool side effects may already have completed");
  const waiting = () => `Codemode timed out after ${timeoutMs}ms waiting for a sandbox worker${pool instanceof CodePool ? ` (${pool.saturation()})` : ""}`;
  const timer = setTimeout(() => stop(guest?.dispatched ? timedOut : waiting()), timeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    guest = pool instanceof CodePool ? await localGuest(pool, controller.signal) : pool.open();
    controller.signal.throwIfAborted();
    const link = guest;
    const channel = rpc = new Rpc(message => link.send(message));
    let received = 0;
    link.listen(message => {
      if (++received > GUEST_MESSAGE_LIMIT) return stop("Codemode sandbox sent too many messages");
      let checked: WireMessage;
      try { checked = guestMessage(message); }
      catch (error) { return stop(errorText(error)); }
      void channel.receive(checked);
    }, stop);
    // The worker bounds output too; this side holds the same line in case it does not.
    let remaining = maxOutputCharacters;
    let events = 0;
    channel.onEvent = event => {
      const text = event.text.slice(0, remaining);
      if (!text || ++events > SANDBOX_LIMITS.outputEvents) return;
      remaining -= text.length;
      options.onEvent?.({ type: "output", text });
    };
    let calls = 0;
    let inflight = 0;
    let transferred = 0;
    channel.handler = async (method, params) => {
      if (method !== "tool") throw new Error("Unknown tool");
      if (Object.values(HOST_CALLS).includes(params.name)) {
        if (++calls > SANDBOX_LIMITS.toolCalls) throw new Error("Codemode tool call limit exceeded");
        return JSON.stringify(await hostCall(options.bridge, params.name, params.args));
      }
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
    // Rounded up, so the guest's own deadline never falls before this side's timer: its
    // answer at that moment is a wall-clock failure, which should read as the timeout.
    const remainingMs = Math.max(1, Math.ceil(timeoutMs - (performance.now() - started)));
    // The worker answers only after disposing the guest, so an answer means it is free again.
    const result = await channel.request("execute", { code, tools: names, maxOutputCharacters, timeoutMs: remainingMs, ...(javascriptOnly ? { javascriptOnly } : {}) })
      .finally(() => { responded = !controller.signal.aborted; });
    // Believed only when asked, and when nothing ran: no tool call, no output.
    if (javascriptOnly && result?.typescript === true && !calls && !events) typescript = true;
    else return guestResult(result, maxOutputCharacters);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    // The guest's own deadline can report just before this side's timer fires.
    if (performance.now() - started >= timeoutMs) throw new Error(timedOut);
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    guest?.end(responded);
    stop("Codemode completed");
  }
  return executeCode({ ...options, typescript, timeoutMs: Math.max(1, Math.floor(timeoutMs - (performance.now() - started))) });
}

/**
 * Where js_exec runs, for the startup log. With sandbox processes, each must answer
 * `return 1` first; with AGENT_SANDBOX_REQUIRED=1 (the image sets it), running without them is an error.
 */
export async function checkSandbox(): Promise<Record<string, unknown>> {
  const processes = sandboxProcesses();
  if (!processes) {
    const reason = "no sandbox processes: agent-launcher starts them when run as root on Linux with AGENT_SANDBOX_PROCESSES > 0";
    if (process.env.AGENT_SANDBOX_REQUIRED === "1") throw new Error(`AGENT_SANDBOX_REQUIRED=1, but ${reason}`);
    return { mode: "in-process", reason };
  }
  const started = performance.now();
  const bridge: ToolBridge = { definitions: [], call: async () => null };
  await Promise.all(processes.processes.map(target => executeCode({ code: "return 1", bridge, pool: target, timeoutMs: 60_000 })));
  return { mode: "isolated", processes: processes.processes.length, ms: Math.round(performance.now() - started) };
}
