import { MessageChannel, Worker, type MessagePort } from "node:worker_threads";
import { availableParallelism, totalmem } from "node:os";
import { connect } from "node:net";
import { Rpc } from "./rpc.ts";
import { errorText, type ToolBridge, type WireMessage } from "./protocol.ts";
import { frames } from "./sandbox-wire.ts";
import { defaultCodeEngine, FILE_LIMITS, jsonWithinLimit, SANDBOX_LIMITS, type CodeEngine } from "./limits.ts";
import { FS_CALLS, HOST_CALLS } from "./sandbox-bootstrap.ts";
import { namespaces, searchQuery, searchTools } from "./tool-search.ts";
import type { Returned } from "./quickjs-sandbox.ts";
import { v8Exec } from "./v8-exec.ts";

/** How long a cancelled guest gets to unwind before its worker is terminated and replaced. */
const CANCEL_GRACE_MS = 250;
/** How often a busy worker's CPU time is read, and how far past its budget it may get before it is terminated. */
const CPU_CHECK_MS = 50;
const CPU_GRACE_MS = 250;

type Slot = { worker: Worker; state: "starting" | "idle" | "busy"; dispatched: number; idle?: (clean: boolean) => void; reaper?: NodeJS.Timeout; watchdog?: NodeJS.Timeout };

/**
 * Executions a node runs at once for tenants with a concurrency limit (`CodeGate`): what a
 * fraction of the memory this process may use (its cgroup's limit in a container) affords at a
 * worker's typical peak, so their executions cannot take a task's memory. A worker holds QuickJS's
 * 32 MiB of WASM memory, a V8 heap capped at 128 MiB and Node's own: 85-100 MB resident even
 * while its guest only waits on a tool, since a waiting guest keeps its worker.
 */
export function defaultCodeWorkers(memory = Math.min(process.constrainedMemory?.() || Infinity, totalmem())) {
  return Math.max(2, Math.min(32, Math.floor(memory * CODE_MEMORY_SHARE / CODE_WORKER_BYTES)));
}
const CODE_MEMORY_SHARE = 0.4;
const CODE_WORKER_BYTES = 128 * 1024 * 1024;
/** Workers a pool runs at most by default: what admin tenants, which `CodeGate` does not hold to the memory-sized capacity, may use. */
const MAX_CODE_WORKERS = 32;

/**
 * Warm worker threads, each running QuickJS/WASM. A worker is resource control (a
 * thread whose CPU time is watched, and that can be terminated); the sandbox is
 * QuickJS itself. A worker builds one QuickJS instance and snapshots it; every
 * execution starts from that snapshot, and the whole memory is written back over
 * when it ends (quickjs-sandbox.ts), so nothing of one execution reaches the next.
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
    this.max = options.max ?? MAX_CODE_WORKERS;
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
    clearInterval(slot.watchdog);
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
    clearInterval(slot.watchdog);
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

  /**
   * Hand one execution's port to the worker. Resolves true once its guest is disposed, false if the worker died.
   * The worker is terminated once its thread has been busy for `cpuMs` (and a grace for the guest's own limit
   * to report it) whatever it is doing: QuickJS checks its interrupt only between bytecodes, and a built-in
   * (a long indexOf, a BigInt's digits) or source preparation never reaches one. `overrun` hears it first.
   * A thread's busy time is its CPU time unless the host is oversubscribed, when it counts the wait as well.
   */
  dispatch(slot: Slot, port: MessagePort, cancel: SharedArrayBuffer, cpuMs: number, overrun: () => void): Promise<boolean> {
    const idle = new Promise<boolean>(resolve => { slot.idle = resolve; });
    const start = slot.worker.performance.eventLoopUtilization();
    slot.worker.postMessage({ port, cancel, id: ++slot.dispatched }, [port]);
    slot.watchdog = setInterval(() => {
      if (slot.worker.performance.eventLoopUtilization(start).active < cpuMs + CPU_GRACE_MS) return;
      clearInterval(slot.watchdog);
      overrun();
      this.retire(slot);
    }, CPU_CHECK_MS);
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

/** A worker of `pool` bound to one execution, which may keep its thread busy for `cpuMs`. */
export async function localGuest(pool: CodePool, signal: AbortSignal, cpuMs: number = SANDBOX_LIMITS.cpuMs): Promise<Guest> {
  const slot = await pool.acquire(signal);
  const cancel = new SharedArrayBuffer(4);
  const { port1, port2 } = new MessageChannel();
  let exceeded = false;
  const idle = pool.dispatch(slot, port2, cancel, cpuMs, () => { exceeded = true; });
  let ended = false;
  return {
    dispatched: true,
    send: message => port1.postMessage(message),
    listen(onMessage, onClose) {
      port1.on("message", onMessage);
      // A terminated or crashed worker closes its end.
      port1.once("close", () => onClose(exceeded ? cpuExceeded(cpuMs) : "Codemode worker exited"));
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
   * answered by one response; for an image scaled down to `fit`, its bytes come first in frames the
   * same way, and the result carries them as `data`. The answer is as untrusted as the process; the caller checks it.
   */
  inspect(bytes: Uint8Array, text: boolean, fit = false): Promise<unknown> {
    const socket = connect(this.path);
    this.load++;
    const done = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => socket.destroy(new Error("the sandbox process took too long")), FILE_LIMITS.inspectMs + 2_000);
    socket.on("error", error => done.reject(error));
    socket.once("close", () => { this.load--; clearTimeout(timer); done.reject(new Error("the sandbox process closed the connection")); });
    const data: Buffer[] = [];
    let received = 0;
    const write = frames(socket, (message: any) => {
      if (fit && message?.type === "data" && typeof message.data === "string") {
        data.push(Buffer.from(message.data, "base64"));
        received += data.at(-1)!.length;
        if (received > FILE_LIMITS.requestImageBytes) socket.destroy();
        return;
      }
      if (message?.type !== "response") return void socket.destroy();
      if (message.error !== undefined) done.reject(new Error(String(message.error).slice(0, 300)));
      else done.resolve(data.length && message.result && typeof message.result === "object" ? { ...message.result, data: Buffer.concat(data) } : message.result);
      socket.end();
    });
    try {
      write({ type: "request", id: "inspect", method: "inspect", params: { size: bytes.length, text, ...(fit ? { fit } : {}) } });
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

/** Why an execution was stopped by its worker's CPU watchdog. */
export const cpuExceeded = (cpuMs: number) => `Codemode CPU limit exceeded: the execution kept its thread busy for over ${cpuMs} ms`;

/** How many js_exec workers this node may run in all: AGENT_CODE_WORKERS_MAX, else 32. */
export function codeWorkers() {
  return process.env.AGENT_CODE_WORKERS_MAX ? Number(process.env.AGENT_CODE_WORKERS_MAX) : MAX_CODE_WORKERS;
}

/** How many of them tenants with a concurrency limit may use together (`CodeGate`): what the node's memory affords, within `codeWorkers`. */
export function codeCapacity() {
  return Math.min(defaultCodeWorkers(), codeWorkers());
}

let shared: CodePool | undefined;
/** The process-wide pool, sized by AGENT_CODE_WORKERS_MIN and AGENT_CODE_WORKERS_MAX (`codeWorkers`). */
export function codePool() {
  return shared ??= new CodePool({ min: process.env.AGENT_CODE_WORKERS_MIN ? Number(process.env.AGENT_CODE_WORKERS_MIN) : undefined, max: codeWorkers() });
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

/** What an execution printed, in order (its return value included), what it returned, and the guest's CPU time (as the sandbox reports it: for metrics only). */
export type CodeResult = { output: string[]; truncated: boolean; returned?: Returned; cpuMs?: number };

function guestResult(value: any, maxOutputCharacters: number): CodeResult {
  const output = value?.output;
  const returned = value?.returned;
  if (!Array.isArray(output) || typeof value.truncated !== "boolean" || output.length > SANDBOX_LIMITS.outputEvents ||
    !output.every(part => typeof part === "string") || output.reduce((total, part) => total + part.length, 0) > maxOutputCharacters ||
    (returned !== undefined && (typeof returned?.json !== "boolean" || typeof returned.truncated !== "boolean" ||
      (returned.index !== undefined && !(Number.isInteger(returned.index) && returned.index >= 0 && returned.index < output.length))))) {
    throw new Error("Codemode sandbox returned an invalid result");
  }
  const cpuMs = Number.isSafeInteger(value.cpuMs) && value.cpuMs >= 0 ? value.cpuMs as number : undefined;
  return { output, truncated: value.truncated, ...(returned ? { returned: { ...(returned.index !== undefined ? { index: returned.index } : {}), json: returned.json, truncated: returned.truncated } } : {}), ...(cpuMs !== undefined ? { cpuMs } : {}) };
}

/**
 * js_exec's result as the model reads it: what the code returned, as it is (JSON, or a
 * string's own text), after anything it logged. Nothing wraps the value, so it reads as
 * the data tools gave the code rather than as an envelope to unpack.
 */
export function presentResult(result: CodeResult, maxOutputCharacters: number = SANDBOX_LIMITS.outputCharacters): string {
  const { output, returned } = result;
  // An empty string sends nothing; a value the limit left no room for is only noted.
  const value = returned ? (returned.index !== undefined ? output[returned.index] : returned.truncated ? undefined : "\"\"") : undefined;
  const logs = output.filter((_, index) => index !== returned?.index).join("\n");
  const text = !returned ? logs || "No output: nothing was returned or logged."
    : logs ? `Logged:\n${logs}\n\nReturned:\n${value ?? "(cut)"}` : value ?? "";
  if (!result.truncated) return text;
  const cut = !returned?.truncated ? "" : value === undefined ? ", leaving no room for the return value" : returned.json ? ", so the returned JSON is incomplete" : "";
  return `${text}\n\n[Output cut at ${maxOutputCharacters.toLocaleString("en-US")} characters${cut}. Return only what you need (counts, chosen fields, a summary), or write the data to a file and read it in parts.]`;
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

/** A tenant's js_exec limits (client-sessions' `codeLimits`): CPU per execution, the longest timeoutMs, executions at once on a node, and the engine that runs them. */
export type CodeLimits = { cpuMs: number; maxTimeoutMs: number; concurrent: number; engine: CodeEngine };

/**
 * Admits js_exec executions on a node: at most `capacity` at once (what its memory affords), and
 * at most `limit` of them for any one tenant. Executions waiting are admitted a tenant at a time,
 * in turn, so a tenant that keeps every slot it may have busy cannot hold back another's. A tenant
 * without a limit (an admin tenant's, Infinity) is admitted at once and not counted: only the
 * pool's workers bound it, as before the gate, so the runtime's own heavy users never queue
 * behind the memory-sized capacity.
 */
export class CodeGate {
  readonly capacity: number;
  running = 0;
  private readonly counts = new Map<string, number>();
  /** Executions waiting, by tenant; the tenant first in the map is served next. */
  private readonly queues = new Map<string, { limit: number; admit: () => void }[]>();
  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Invalid codemode capacity");
    this.capacity = capacity;
  }

  /** Executions `tenant` has running. */
  count(tenant: string) { return this.counts.get(tenant) ?? 0; }

  /** Wait for a turn to run one of `tenant`'s executions, until `signal` aborts. Resolves with the function that gives it back. */
  acquire(tenant: string, limit: number, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (limit === Infinity) return Promise.resolve(() => {});
    if (!this.queues.has(tenant) && this.free(tenant, limit)) return Promise.resolve(this.take(tenant));
    const waiter = Promise.withResolvers<() => void>();
    const entry = { limit, admit: () => { signal.removeEventListener("abort", abort); waiter.resolve(this.take(tenant)); } };
    const abort = () => {
      const queue = this.queues.get(tenant) ?? [];
      queue.splice(queue.indexOf(entry), 1);
      if (!queue.length) this.queues.delete(tenant);
      waiter.reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    const queue = this.queues.get(tenant);
    if (queue) queue.push(entry); else this.queues.set(tenant, [entry]);
    return waiter.promise;
  }

  private free(tenant: string, limit: number) { return this.running < this.capacity && this.count(tenant) < limit; }

  private take(tenant: string) {
    this.running++;
    this.counts.set(tenant, this.count(tenant) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running--;
      const left = this.count(tenant) - 1;
      if (left) this.counts.set(tenant, left); else this.counts.delete(tenant);
      this.next();
    };
  }

  /** Admit waiting executions while there is room: the first tenant in turn that may run one more, which then goes last. */
  private next() {
    for (let admitted = true; admitted && this.running < this.capacity;) {
      admitted = false;
      for (const [tenant, queue] of this.queues) {
        if (!this.free(tenant, queue[0].limit)) continue;
        const entry = queue.shift()!;
        this.queues.delete(tenant);
        if (queue.length) this.queues.set(tenant, queue);
        entry.admit();
        admitted = true;
        break;
      }
    }
  }
}

export async function executeCode(options: {
  code: string; bridge: ToolBridge; signal?: AbortSignal;
  timeoutMs?: number; maxOutputCharacters?: number;
  onEvent?: (event: unknown) => void;
  /**
   * Where to run: by default the sandbox processes (which run each execution on the engine it names),
   * or without them this process's own: its QuickJS pool, or v8-exec processes. A `CodePool` given
   * stands for "this process's own", so it serves only executions on QuickJS.
   */
  pool?: CodePool | { open(): Guest };
  /**
   * The tenant's limits: CPU (`SANDBOX_LIMITS.cpuMs` by default), the longest timeoutMs (`SANDBOX_LIMITS.maxTimeoutMs`;
   * a longer timeoutMs is cut to it), and the engine (`defaultCodeEngine()` by default).
   */
  limits?: Partial<Pick<CodeLimits, "cpuMs" | "maxTimeoutMs" | "engine">>;
  /** Wait for the tenant's turn on the node (`CodeGate`); resolves with the function that gives it back. */
  admit?: (signal: AbortSignal) => Promise<() => void>;
}): Promise<CodeResult> {
  const maxTimeoutMs = Math.min(options.limits?.maxTimeoutMs ?? SANDBOX_LIMITS.maxTimeoutMs, SANDBOX_LIMITS.maxTimeoutMs);
  const cpuMs = Math.min(options.limits?.cpuMs ?? SANDBOX_LIMITS.cpuMs, SANDBOX_LIMITS.maxCpuMs);
  const requested = options.timeoutMs ?? SANDBOX_LIMITS.timeoutMs;
  const maxOutputCharacters = options.maxOutputCharacters ?? SANDBOX_LIMITS.outputCharacters;
  if (!Number.isInteger(requested) || requested < 1) throw new Error(`timeoutMs must be 1..${maxTimeoutMs}`);
  const timeoutMs = Math.min(requested, maxTimeoutMs);
  if (!Number.isInteger(maxTimeoutMs) || maxTimeoutMs < 1 || !Number.isInteger(cpuMs) || cpuMs < 1) throw new Error("Invalid codemode limits");
  if (!Number.isInteger(maxOutputCharacters) || maxOutputCharacters < 1 || maxOutputCharacters > SANDBOX_LIMITS.maxOutputCharacters) throw new Error(`maxOutputCharacters must be 1..${SANDBOX_LIMITS.maxOutputCharacters}`);
  if (typeof options.code !== "string" || options.code.length > 256_000) throw new Error("Invalid or oversized code");
  // The deadline and cancellation hold from here, before anything looks at the code or waits for a turn.
  // Nothing of the code is parsed on this thread: the worker strips TypeScript and compiles it (quickjs-sandbox.ts).
  const started = performance.now();
  const engine = options.limits?.engine ?? defaultCodeEngine();
  // The sandbox processes come first: their v8-exec processes inherit their confinement (sandbox-server.ts).
  const own = !options.pool || options.pool instanceof CodePool;
  const pool = !own ? options.pool! : (!options.pool && sandboxProcesses()) || (engine === "v8" ? v8Exec() : options.pool ?? codePool());
  // Tool calls still running, by name: a timeout while one runs names it and says timeoutMs can be raised.
  const pending = new Map<string, number>();
  const timedOut = () => {
    const waiting = [...pending.keys()].map(name => `tools.${name}`);
    return `Codemode timed out after ${timeoutMs}ms${waiting.length ? ` while ${waiting.slice(0, 3).join(", ")} ${waiting.length === 1 ? "was" : "were"} still running` : ""}; external side effects may have completed${waiting.length && timeoutMs < maxTimeoutMs ? `. Pass a larger timeoutMs (at most ${maxTimeoutMs}) for slow tools` : ""}`;
  };
  const controller = new AbortController();
  let release: (() => void) | undefined;
  let guest: Guest | undefined;
  let rpc: Rpc | undefined;
  let responded = false;
  const stop = (reason: string) => {
    if (controller.signal.aborted) return;
    controller.abort(new Error(reason));
    rpc?.close(reason);
    guest?.end(false);
  };
  const abort = () => stop("Codemode aborted; any external tool side effects may already have completed");
  const waiting = () => `Codemode timed out after ${timeoutMs}ms waiting for a sandbox worker${pool instanceof CodePool ? ` (${pool.saturation()})` : ""}`;
  const timer = setTimeout(() => stop(guest?.dispatched ? timedOut() : waiting()), timeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    // Loaded here: sandbox processes import this module for CodePool alone, and typebox would cost each about 25 MB.
    const { validateDefinitions, validateToolCall } = await import("./tool-policy.ts");
    validateDefinitions(options.bridge.definitions);
    // Code gets the tools' names; their schemas and search are answered here (hostCall).
    const names = options.bridge.definitions.map(tool => tool.name);
    if (options.admit) release = await options.admit(controller.signal);
    controller.signal.throwIfAborted();
    guest = pool instanceof CodePool ? await localGuest(pool, controller.signal, cpuMs) : pool.open();
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
      // fs calls go to the runtime's file tools, whatever other tools are named; their arguments are checked there.
      const fs = FS_CALLS.includes(params.name);
      if (fs && !options.bridge.fs) throw new Error("fs is not available: this agent has no files");
      if (fs && (!params.args || typeof params.args !== "object" || Array.isArray(params.args))) throw new Error("Invalid fs arguments");
      const checked = fs ? { tool: { name: params.name }, args: params.args as Record<string, unknown>, bytes: Buffer.byteLength(jsonWithinLimit(params.args, SANDBOX_LIMITS.resultBytes, "fs arguments")) }
        : validateToolCall(options.bridge.definitions, params.name, params.args);
      if (++calls > SANDBOX_LIMITS.toolCalls) throw new Error("Codemode tool call limit exceeded");
      if (inflight >= SANDBOX_LIMITS.concurrentTools) throw new Error("Too many concurrent tool calls");
      transferred += checked.bytes;
      if (transferred > SANDBOX_LIMITS.totalToolBytes) throw new Error("Codemode transfer limit exceeded");
      controller.signal.throwIfAborted();
      inflight++;
      const name = fs ? params.name : checked.tool.name;
      pending.set(name, (pending.get(name) ?? 0) + 1);
      try {
        const result = fs ? await options.bridge.fs!(params.name.slice(3), checked.args, controller.signal) : await options.bridge.call(checked.tool.name, checked.args, controller.signal);
        controller.signal.throwIfAborted();
        const json = jsonWithinLimit(result, SANDBOX_LIMITS.resultBytes, "Tool result");
        transferred += Buffer.byteLength(json);
        if (transferred > SANDBOX_LIMITS.totalToolBytes) throw new Error("Codemode transfer limit exceeded");
        return json;
      } finally {
        inflight--;
        const left = (pending.get(name) ?? 1) - 1;
        if (left > 0) pending.set(name, left); else pending.delete(name);
      }
    };
    // Rounded up, so the guest's own deadline never falls before this side's timer: its
    // answer at that moment is a wall-clock failure, which should read as the timeout.
    const remainingMs = Math.max(1, Math.ceil(timeoutMs - (performance.now() - started)));
    // The worker answers only after disposing the guest, so an answer means it is free again.
    const result = await channel.request("execute", { code: options.code, tools: names, maxOutputCharacters, timeoutMs: remainingMs, cpuMs, engine })
      .finally(() => { responded = !controller.signal.aborted; });
    return guestResult(result, maxOutputCharacters);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    // The guest's own deadline can report just before this side's timer fires.
    if (performance.now() - started >= timeoutMs) throw new Error(timedOut());
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    guest?.end(responded);
    stop("Codemode completed");
    release?.();
  }
}

/**
 * Where js_exec runs, for the startup log. With sandbox processes, each must answer `return 1`
 * first on each engine; with AGENT_SANDBOX_REQUIRED=1 (the image sets it), running without them is
 * an error. The default engine (AGENT_JS_EXEC) must work; the other is reported, for tenants pinned to it.
 */
export async function checkSandbox(): Promise<Record<string, unknown>> {
  const engine = defaultCodeEngine();
  const processes = sandboxProcesses();
  const reason = "no sandbox processes: agent-launcher starts them when run as root on Linux with AGENT_SANDBOX_PROCESSES > 0";
  if (!processes && process.env.AGENT_SANDBOX_REQUIRED === "1") throw new Error(`AGENT_SANDBOX_REQUIRED=1, but ${reason}`);
  const started = performance.now();
  const bridge: ToolBridge = { definitions: [], call: async () => null };
  const engines: Record<string, string> = {};
  for (const each of ["quickjs", "v8"] as const) {
    // The local QuickJS pool starts its workers on first use: not worth doing just to log it.
    if (!processes && each === "quickjs") { engines[each] = "local"; continue; }
    const targets: (CodePool | { open(): Guest } | undefined)[] = processes ? processes.processes : [undefined];
    const checked = Promise.all(targets.map(pool => executeCode({ code: "return 1", bridge, pool, timeoutMs: 60_000, limits: { engine: each } })));
    try { await checked; engines[each] = "ok"; }
    catch (error) {
      if (each === engine) throw new Error(`js_exec's default engine (${engine}) does not run: ${errorText(error)}`);
      engines[each] = `unavailable: ${errorText(error).slice(0, 200)}`;
    }
  }
  return { mode: processes ? "isolated" : "in-process", ...(processes ? { processes: processes.processes.length } : { reason }), engine, engines, ms: Math.round(performance.now() - started) };
}
