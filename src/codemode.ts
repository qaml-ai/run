import { totalmem } from "node:os";
import { connect } from "node:net";
import { Rpc } from "./rpc.ts";
import { errorText, type ToolBridge, type WireMessage } from "./protocol.ts";
import { frames } from "./sandbox-wire.ts";
import { FILE_LIMITS, jsonWithinLimit, SANDBOX_LIMITS } from "./limits.ts";
import { FS_CALLS, HOST_CALLS } from "./sandbox-bootstrap.ts";
import { namespaces, searchQuery, searchTools } from "./tool-search.ts";
import { v8Exec } from "./v8-exec.ts";

/**
 * Executions a node runs at once for tenants with a concurrency limit (`CodeGate`): what a
 * fraction of the memory this process may use (its cgroup's limit in a container) affords at an
 * execution's typical peak, so their executions cannot take a task's memory. A v8-exec process may
 * hold a 128 MiB V8 heap and 128 MiB of ArrayBuffers, though most stay far below.
 */
export function defaultCodeWorkers(memory = Math.min(process.constrainedMemory?.() || Infinity, totalmem())) {
  return Math.max(2, Math.min(32, Math.floor(memory * CODE_MEMORY_SHARE / CODE_WORKER_BYTES)));
}
const CODE_MEMORY_SHARE = 0.4;
const CODE_WORKER_BYTES = 128 * 1024 * 1024;

/** One execution's link to its guest: a v8-exec process of this process's own, or a sandbox process. */
export interface Guest {
  /** Whether the execution has started, rather than waiting in a queue. */
  readonly dispatched: boolean;
  send(message: WireMessage): void;
  /** Messages from the guest, unvalidated; `onClose` when its process goes away first. */
  listen(onMessage: (message: unknown) => void, onClose: (reason: string) => void): void;
  /** Cancel the guest and let its process go. */
  end(): void;
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

/**
 * How many js_exec executions tenants with a concurrency limit may run together on this node (`CodeGate`):
 * what its memory affords (`defaultCodeWorkers`), within AGENT_CODE_WORKERS_MAX if set.
 */
export function codeCapacity() {
  return Math.min(defaultCodeWorkers(), process.env.AGENT_CODE_WORKERS_MAX ? Number(process.env.AGENT_CODE_WORKERS_MAX) : Infinity);
}

let sandboxes: SandboxProcesses | null | undefined;
/**
 * The sandbox processes agent-launcher started (AGENT_SANDBOX_SOCKETS, which it sets), or
 * undefined without them: then js_exec runs in v8-exec processes of this process's own.
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

/** Where in an execution's output its return value is (absent when cut entirely), whether it was rendered as JSON, and whether it was cut. */
export type Returned = { index?: number; json: boolean; truncated: boolean };

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

/** A tenant's js_exec limits (client-sessions' `codeLimits`): CPU per execution, the longest timeoutMs, and executions at once on a node. */
export type CodeLimits = { cpuMs: number; maxTimeoutMs: number; concurrent: number };

/**
 * Admits js_exec executions on a node: at most `capacity` at once (what its memory affords), and
 * at most `limit` of them for any one tenant. Executions waiting are admitted a tenant at a time,
 * in turn, so a tenant that keeps every slot it may have busy cannot hold back another's. A tenant
 * without a limit (an admin tenant's, Infinity) is admitted at once and not counted: only the
 * v8-exec process limit (AGENT_V8_MAX) bounds it, so the runtime's own heavy users never queue
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
  /** Where to run: by default the sandbox processes, or without them v8-exec processes of this process's own. */
  pool?: { open(): Guest };
  /**
   * The tenant's limits: CPU (`SANDBOX_LIMITS.cpuMs` by default) and the longest timeoutMs (`SANDBOX_LIMITS.maxTimeoutMs`;
   * a longer timeoutMs is cut to it).
   */
  limits?: Partial<Pick<CodeLimits, "cpuMs" | "maxTimeoutMs">>;
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
  // Nothing of the code is parsed on this thread: v8-exec strips TypeScript and compiles it (sandbox/v8-exec).
  const started = performance.now();
  // The sandbox processes come first: their v8-exec processes inherit their confinement (sandbox-server.ts).
  const pool = options.pool ?? sandboxProcesses() ?? v8Exec();
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
  const stop = (reason: string) => {
    if (controller.signal.aborted) return;
    controller.abort(new Error(reason));
    rpc?.close(reason);
    guest?.end();
  };
  const abort = () => stop("Codemode aborted; any external tool side effects may already have completed");
  const waiting = () => `Codemode timed out after ${timeoutMs}ms waiting for a sandbox worker`;
  const timer = setTimeout(() => stop(guest?.dispatched ? timedOut() : waiting()), timeoutMs);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  try {
    // Loaded here: sandbox processes import this module for Guest alone, and typebox would cost each about 25 MB.
    const { validateDefinitions, validateToolCall } = await import("./tool-policy.ts");
    validateDefinitions(options.bridge.definitions);
    // Code gets the tools' names; their schemas and search are answered here (hostCall).
    const names = options.bridge.definitions.map(tool => tool.name);
    if (options.admit) release = await options.admit(controller.signal);
    controller.signal.throwIfAborted();
    guest = pool.open();
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
    const result = await channel.request("execute", { code: options.code, tools: names, maxOutputCharacters, timeoutMs: remainingMs, cpuMs });
    return guestResult(result, maxOutputCharacters);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    // The guest's own deadline can report just before this side's timer fires.
    if (performance.now() - started >= timeoutMs) throw new Error(timedOut());
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    guest?.end();
    stop("Codemode completed");
    release?.();
  }
}

/**
 * Where js_exec runs, for the startup log. With sandbox processes, each must answer `return 1`
 * first; without them, this process's v8-exec must. With AGENT_SANDBOX_REQUIRED=1 (the image sets
 * it), running without sandbox processes is an error.
 */
export async function checkSandbox(): Promise<Record<string, unknown>> {
  const processes = sandboxProcesses();
  const reason = "no sandbox processes: agent-launcher starts them when run as root on Linux with AGENT_SANDBOX_PROCESSES > 0";
  if (!processes && process.env.AGENT_SANDBOX_REQUIRED === "1") throw new Error(`AGENT_SANDBOX_REQUIRED=1, but ${reason}`);
  const started = performance.now();
  const bridge: ToolBridge = { definitions: [], call: async () => null };
  const targets: ({ open(): Guest } | undefined)[] = processes ? processes.processes : [undefined];
  try { await Promise.all(targets.map(pool => executeCode({ code: "return 1", bridge, pool, timeoutMs: 60_000 }))); }
  catch (error) { throw new Error(`js_exec does not run: ${errorText(error)}`); }
  return { mode: processes ? "isolated" : "in-process", ...(processes ? { processes: processes.processes.length } : { reason }), ms: Math.round(performance.now() - started) };
}
