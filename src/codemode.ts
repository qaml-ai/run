import { Rpc } from "./rpc.ts";
import { errorText, type ToolBridge, type WireMessage } from "./protocol.ts";
import { jsonWithinLimit, SANDBOX_LIMITS } from "./limits.ts";
import { namespaces, searchQuery, searchTools } from "./tool-search.ts";
import { validateDefinitions, validateToolCall } from "./tool-policy.ts";
import { v8Exec } from "./v8-exec.ts";
import { sandboxDir } from "./sandbox.ts";
import { parse } from "./inspect.ts";

/** Calls answered by the host rather than a tool, as the bootstrap (sandbox/v8-exec/src/bootstrap.js) makes them: no tool name contains a dot. */
export const HOST_CALLS = Object.freeze({ search: "tools.search", describe: "tools.describe", namespaces: "tools.namespaces" });
/** The bootstrap's `fs` calls: the runtime's file tools over the agent's mounts, whoever else has tools of those names. */
export const FS_CALLS = Object.freeze(["fs.readFile", "fs.writeFile", "fs.stat", "fs.list", "fs.remove"]);

/** One execution's link to its guest: its v8-exec process (v8-exec.ts). */
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
 * How many js_exec executions tenants with a concurrency limit may run together on this node (`CodeGate`):
 * AGENT_CODE_WORKERS_MAX, or 16. An execution waiting on tools holds its v8-exec process, about 20 MB
 * resident; 16 at once is about 320 MB, or a sixth of a 2 GB task.
 */
export function codeCapacity() {
  return Number(process.env.AGENT_CODE_WORKERS_MAX) || DEFAULT_CODE_CAPACITY;
}
const DEFAULT_CODE_CAPACITY = 16;

/** Tool calls, output events and the answer: more than this from one execution means the sandbox is misbehaving. */
const GUEST_MESSAGE_LIMIT = SANDBOX_LIMITS.toolCalls + SANDBOX_LIMITS.outputEvents + 8;

/**
 * Everything a guest sends is untrusted: its v8-exec process could be compromised.
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
 * Admits js_exec executions on a node: at most `capacity` at once (`codeCapacity`), and
 * at most `limit` of them for any one tenant. Executions waiting are admitted a tenant at a time,
 * in turn, so a tenant that keeps every slot it may have busy cannot hold back another's. A tenant
 * without a limit (an admin tenant's, Infinity) is admitted at once and not counted: only the
 * v8-exec process limit (AGENT_V8_MAX) bounds it, so the runtime's own heavy users never queue
 * behind the capacity.
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
  /** Where to run: by default this process's v8-exec runner (`v8Exec`). */
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
  const pool = options.pool ?? v8Exec();
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
 * Where untrusted code and files run, for the startup log: js_exec must answer `return 1`, and a parse
 * job must read an image's header, or the runtime does not start. Under agent-launcher they are
 * confined ("isolated"); without it, this process's own children ("in-process"), which
 * AGENT_SANDBOX_REQUIRED=1 (the image sets it) refuses.
 */
export async function checkSandbox(): Promise<Record<string, unknown>> {
  const isolated = sandboxDir() !== undefined;
  const reason = "no agent-launcher: it confines js_exec and file parsing when the image runs as root on Linux";
  if (!isolated && process.env.AGENT_SANDBOX_REQUIRED === "1") throw new Error(`AGENT_SANDBOX_REQUIRED=1, but ${reason}`);
  const started = performance.now();
  const bridge: ToolBridge = { definitions: [], call: async () => null };
  try { await executeCode({ code: "return 1", bridge, timeoutMs: 60_000 }); }
  catch (error) { throw new Error(`js_exec does not run: ${errorText(error)}`); }
  // A 1×1 PNG.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const parsed = await parse(png, false).catch(error => errorText(error));
  if ((parsed as { media?: { width?: unknown } })?.media?.width !== 1) throw new Error(`Files cannot be parsed: ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`);
  return { mode: isolated ? "isolated" : "in-process", ...(isolated ? {} : { reason }), ms: Math.round(performance.now() - started) };
}
