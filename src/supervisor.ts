import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { childProcess, type Rpc } from "./rpc.ts";
import type { AgentConfig, CallContext, ToolBridge } from "./protocol.ts";
import type { RequestMethod } from "../shared/client-protocol.ts";
import type { ChildProcess } from "node:child_process";
import { validateDefinitions, validateToolCall } from "./tool-policy.ts";
import { searchQuery, searchTools } from "./tool-search.ts";
import { jsonWithinLimit, SANDBOX_LIMITS } from "./limits.ts";
import type { Storage } from "../shared/storage.ts";
import { fileAppendLog, type AppendLog, type CommitEffect } from "../shared/append-log.ts";
import { readTranscript, readTranscriptLog, Transcript, transcriptPath, type TranscriptRecord } from "./transcript.ts";
import type { HistoryChunk } from "./history-pages.ts";
import type { Claim } from "./ownership.ts";
import { createAgentHost, HISTORY_FLUSH_MS } from "./agent-host.ts";
import type { CodeExecutor } from "./codemode.ts";
import type { Outbound } from "./outbound.ts";
import { buggify } from "./buggify.ts";
import { closeInterruptedTurn } from "./history.ts";

/**
 * How agents run. "process": each agent is its own Node process (strong memory
 * isolation, ~50 MB each). "inline": many agents share this process, each
 * bounded by its compacted working set. Model-written code runs in v8-exec
 * processes either way (confined by agent-launcher when it started the runtime).
 */
export type Hosting = "process" | "inline";
type Common = { bridge: ToolBridge; calls: Set<AbortController>; listeners: Set<(event: any) => void>; transcript: AppendLog<TranscriptRecord> };
/** An agent process's js_exec turns (`codeSlot`), by its id for them: waiting (`release` unset) or held. */
type CodeSlots = Map<string, { controller: AbortController; release?: () => void }>;
type ProcessHandle = Common & { kind: "process"; child: ChildProcess; rpc: Rpc; slots: CodeSlots; watchdog?: NodeJS.Timeout };
type InlineHandle = Common & { kind: "inline"; host: ReturnType<typeof createAgentHost>; stop: (error: Error) => void; stopped: Promise<never> };
type Handle = ProcessHandle | InlineHandle;
export type SupervisorOptions = {
  runtime?: string; maxAgents?: number; storage?: Storage; hosting?: Hosting; /** How long stopping agents wait, all together, to index their settled turns (default 5 s). */ historyFlushMs?: number;
  /** An agent process is pinged this often, and killed once a ping has gone this long unanswered (default 5 s and 30 s). */
  pingMs?: number; unresponsiveMs?: number;
  /** Where inline agents run js_exec (src/codemode.ts): this process's v8-exec runner unless given. Agent processes always use their own. */
  codeExecutor?: CodeExecutor;
  /** What agent processes are told of the node's settings (`agentProcessEnv`); this process's own unless given. */
  agentEnv?: Record<string, string>;
  /** The outbound policy inline agents' model calls go through (agent processes get it in `agentEnv`). */
  modelOutbound?: Outbound;
  /** The history backlog's bound for inline agents (agent processes get it in `agentEnv`). */
  historyBacklogBytes?: number;
};

export class AgentSupervisor {
  readonly agents = new Map<string, Handle>();
  readonly starting = new Set<string>();
  /** Slots held for agents about to start (see `reserve`), with the tenant each is for; they count against capacity. */
  readonly reserved = new Map<string, string | undefined>();
  /** Agents being stopped. They are already out of `agents`, so no new work reaches a dying agent. */
  private readonly stopping = new Map<string, Promise<void>>();
  /** Starts under way that have no host yet, by agent: a stop meanwhile cancels them (see `stop`). */
  private readonly unhosted = new Map<string, Set<{ cancelled: boolean; settled: Promise<void> }>>();
  /** Turns being closed without their agent (`closeTurn`): the latest close of each, which the next one and a start wait for. */
  private readonly closing = new Map<string, Promise<void>>();
  readonly root: string;
  readonly options: SupervisorOptions;
  /**
   * `root` holds each agent's local working directory (its sandbox cwd). With
   * `storage`, transcripts live there under `sessions/<id>/transcript` instead of
   * in the working directory, so any host can load the agent. The supervisor
   * writes the transcript for its agent, which holds no claim or connection of its
   * own: an agent process sends records over IPC.
   */
  constructor(root: string, options: SupervisorOptions = {}) {
    this.root = root;
    this.options = options;
  }

  get hosting(): Hosting { return this.options.hosting ?? "process"; }

  static transcriptKey(id: string) { return `sessions/${id}/transcript`; }

  /** An agent's full history without its process. */
  async history(id: string) {
    if (!this.options.storage) return readTranscript(resolve(join(this.root, id)));
    return readTranscriptLog(this.options.storage.log(AgentSupervisor.transcriptKey(id)));
  }

  /** An agent's transcript records as its log holds them, read beside a live owner without writing. */
  async records(id: string): Promise<TranscriptRecord[]> {
    return (this.options.storage ? this.options.storage.log<TranscriptRecord>(AgentSupervisor.transcriptKey(id)) : fileAppendLog<TranscriptRecord>(transcriptPath(resolve(join(this.root, id))))).read();
  }

  /** Start a new agent's transcript as `records` (a fork's), under its owner's `claim`, before it is started. */
  async seed(id: string, records: TranscriptRecord[], claim?: Claim) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid agent id");
    const log = this.options.storage ? this.options.storage.log<TranscriptRecord>(AgentSupervisor.transcriptKey(id), claim) : fileAppendLog<TranscriptRecord>(transcriptPath(resolve(join(this.root, id))));
    try { await log.rewrite(() => records); }
    finally { await log.close(); }
  }

  /**
   * Settle the turn a stopped agent's transcript holds open (`closeInterruptedTurn`), under its owner's `claim`, without
   * starting it: for a run ended with no host to end it (one past its resumes, or stopped before its node was lost). The
   * same records the agent's next start would write, written before the run is seen to end. Whether there was a turn to settle.
   */
  async closeTurn(id: string, claim?: Claim): Promise<boolean> {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid agent id");
    // One at a time per agent, each reading the transcript as the one before left it: two closes of one turn (a load's and
    // a run's, or two loads') never both answer its open calls. Across nodes, the owner's claim fences the write instead.
    const current = (this.closing.get(id) ?? Promise.resolve()).then(() => this.closeTurnNow(id, claim));
    const settled = current.then(() => {}, () => {});
    this.closing.set(id, settled);
    try { return await current; }
    finally { if (this.closing.get(id) === settled) this.closing.delete(id); }
  }

  private async closeTurnNow(id: string, claim?: Claim): Promise<boolean> {
    await this.stopping.get(id);
    // A running agent's host writes its own transcript.
    if (this.agents.has(id) || this.starting.has(id)) throw new Error("Agent is running");
    const log = this.options.storage ? this.options.storage.log<TranscriptRecord>(AgentSupervisor.transcriptKey(id), claim) : fileAppendLog<TranscriptRecord>(transcriptPath(resolve(join(this.root, id))));
    try {
      const transcript = new Transcript(log);
      await transcript.load();
      return await closeInterruptedTurn(transcript);
    } finally { await log.close(); }
  }

  /** Delete a stopped agent's transcript and local directory. */
  async purge(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid agent id");
    await this.stopping.get(id);
    if (this.agents.has(id) || this.starting.has(id)) throw new Error("Agent is running");
    await this.options.storage?.removeLog(AgentSupervisor.transcriptKey(id));
    await rm(resolve(join(this.root, id)), { recursive: true, force: true });
  }

  /** Validate and dispatch an agent's application tool call, with the same limits in either hosting mode. */
  private async dispatchTool(handle: Handle, params: { name: string; args: unknown } & Partial<CallContext>) {
    const checked = validateToolCall(handle.bridge.definitions, params.name, params.args);
    const controller = new AbortController();
    handle.calls.add(controller);
    try {
      // A tool call may fail before its tool hears of it.
      if (buggify("tool.call.fails")) throw new Error("BUGGIFY: the tool call failed before it was sent");
      const result = await handle.bridge.call(checked.tool.name, checked.args, controller.signal, params.toolCallId ? { toolCallId: params.toolCallId, ...(params.innerCallId ? { innerCallId: params.innerCallId } : {}), ...(Number.isSafeInteger(params.messageIndex) ? { messageIndex: params.messageIndex } : {}) } : undefined);
      controller.signal.throwIfAborted();
      return JSON.parse(jsonWithinLimit(result, SANDBOX_LIMITS.resultBytes, "Tool result"));
    }
    finally { handle.calls.delete(controller); }
  }
  /** A run's events reach its listeners; background work's (a compaction between runs) goes to the bridge instead, whether or not a run is open. */
  private dispatchEvent(handle: Handle, event: any, copy = false) {
    // Copies keep an inline agent from sharing objects with the supervisor, as IPC would.
    if (event?.background === true) { handle.bridge.background?.(copy ? structuredClone(event) : event); return; }
    for (const listener of handle.listeners) listener(copy ? structuredClone(event) : event);
  }
  private cancelTools(handle: Handle) { for (const call of handle.calls) call.abort(); return null; }

  /** Start an agent. `claim` is its owner's, which fences the transcript's writes. */
  async start(id: string, config: Omit<AgentConfig, "id" | "directory" | "tools">, bridge: ToolBridge, claim?: Claim) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid agent id");
    // Until it has a host, a stop cancels it (see `stop`).
    const settled = Promise.withResolvers<void>();
    const pending = { cancelled: false, settled: settled.promise };
    const starts = this.unhosted.get(id) ?? new Set();
    this.unhosted.set(id, starts.add(pending));
    const hosted = () => { starts.delete(pending); if (!starts.size && this.unhosted.get(id) === starts) this.unhosted.delete(id); settled.resolve(); };
    try {
      await this.stopping.get(id);
      // A close of its turn writes first: the agent then loads the transcript as it left it.
      await this.closing.get(id);
      validateDefinitions(bridge.definitions);
      if (this.agents.has(id) || this.starting.has(id)) throw new Error("Agent already exists");
      if (!this.reserved.delete(id) && this.full) throw Object.assign(new Error("Agent capacity reached"), { status: 503 });
      this.starting.add(id);
      try {
        const directory = resolve(join(this.root, id));
        await mkdir(directory, { recursive: true, mode: 0o700 });
        // Stopped before it had a host (its node lost the agent, say): it makes none. Made anyway, the host would serve an
        // owner that is gone, and whoever loads the agent next would take it for theirs while it is still starting.
        if (pending.cancelled) throw new Error("Agent stopped");
        // From here until the host is in `agents`, nothing waits: a stop finds the host there.
        hosted();
        const storage = this.options.storage;
        const log = storage ? storage.log<TranscriptRecord>(AgentSupervisor.transcriptKey(id), claim) : fileAppendLog<TranscriptRecord>(transcriptPath(directory));
        const transcript = bridge.committing ? committing(log, bridge.committing) : log;
        const init = { ...config, id, directory, tools: bridge.definitions };
        return this.hosting === "inline" ? await this.startInline(id, init, bridge, transcript) : await this.startProcess(id, directory, init, bridge, transcript);
      } finally { this.starting.delete(id); }
    } finally { hosted(); }
  }

  private async startProcess(id: string, directory: string, init: AgentConfig, bridge: ToolBridge, transcript: AppendLog<TranscriptRecord>) {
    const { child, rpc } = childProcess("./agent-child.ts", directory, this.options.runtime, true, id, this.options.agentEnv);
    const handle: ProcessHandle = { kind: "process", bridge, child, rpc, calls: new Set(), listeners: new Set(), transcript, slots: new Map() };
    this.agents.set(id, handle);
    this.starting.delete(id);
    const cleanup = () => {
      clearInterval(handle.watchdog);
      this.cancelTools(handle);
      // A process that ends holding js_exec turns gives them back.
      for (const slot of handle.slots.keys()) this.releaseSlot(handle, slot);
      if (this.agents.get(id) === handle) this.agents.delete(id);
      void handle.transcript.close();
    };
    child.once("exit", cleanup);
    child.once("error", cleanup);
    rpc.onEvent = event => this.dispatchEvent(handle, event);
    rpc.handler = async (method, params) => {
      if (method === "cancel-tools") return this.cancelTools(handle);
      if (method === "transcript") return this.transcriptRequest(handle, params);
      if (method === "run-limit") return (await handle.bridge.runLimit?.()) ?? null;
      if (method === "search") return this.search(handle, params);
      if (method === "file") return this.file(handle, params);
      if (method === "model-auth") return this.modelAuth(handle);
      if (method === "fs") return this.dispatchFs(handle, params);
      if (method === "history") return this.historyRequest(id, handle, params);
      if (method === "code-slot") return this.codeSlot(handle, params?.id);
      if (method === "code-release") return this.releaseSlot(handle, params?.id);
      if (method === "lease") return (await handle.bridge.lease?.()) ?? null;
      if (method !== "tool") throw new Error("Unknown tool");
      return this.dispatchTool(handle, params);
    };
    const timeout = setTimeout(() => { rpc.close("Agent initialization timed out"); child.kill("SIGKILL"); }, 30_000);
    try {
      const result = await rpc.request("init", init);
      this.watch(id, handle);
      return result;
    }
    catch (error) { await this.stop(id); throw error; }
    finally { clearTimeout(timeout); }
  }

  /**
   * Kill an agent process that stops answering (its thread stuck in something synchronous), so it
   * cannot hold its slot or its run forever. Its run fails; the next start closes the interrupted
   * turn from its transcript (agent-host.ts), as after a crash.
   */
  private watch(id: string, handle: ProcessHandle) {
    const unresponsiveMs = this.options.unresponsiveMs ?? 30_000;
    let since: number | undefined;
    handle.watchdog = setInterval(() => {
      if (since === undefined) {
        const sent = since = Date.now();
        handle.rpc.request("ping").then(() => { if (since === sent) since = undefined; }, () => {});
      } else if (Date.now() - since >= unresponsiveMs && this.agents.get(id) === handle) {
        console.error(JSON.stringify({ type: "agent_unresponsive", agent: id, ms: Date.now() - since }));
        void this.stop(id, { flush: false });
      }
    }, this.options.pingMs ?? 5_000);
    handle.watchdog.unref();
  }

  /** Wait for a js_exec turn for an agent process (`ToolBridge.codeSlot`); it is held under `id` until `releaseSlot`. */
  private async codeSlot(handle: ProcessHandle, id: unknown) {
    if (typeof id !== "string" || id.length > 64 || handle.slots.has(id)) throw new Error("Invalid code slot");
    if (!handle.bridge.codeSlot) return null;
    const entry: { controller: AbortController; release?: () => void } = { controller: new AbortController() };
    handle.slots.set(id, entry);
    let release: () => void;
    try { release = await handle.bridge.codeSlot(entry.controller.signal); }
    catch (error) { if (handle.slots.get(id) === entry) handle.slots.delete(id); throw error; }
    // Given back while it waited: the process no longer wants it.
    if (handle.slots.get(id) !== entry) release();
    else entry.release = release;
    return null;
  }

  private releaseSlot(handle: ProcessHandle, id: unknown) {
    const entry = typeof id === "string" ? handle.slots.get(id) : undefined;
    if (!entry) return null;
    handle.slots.delete(id as string);
    entry.controller.abort(new Error("Code slot released"));
    entry.release?.();
    return null;
  }

  /** `tools.search` from an agent's code: the bridge's search (with rerankers), else keywords over its code-mode tools. */
  private search(handle: Handle, params: unknown) {
    const query = searchQuery(params);
    if (handle.bridge.search) return handle.bridge.search(query);
    return searchTools(handle.bridge.definitions.filter(tool => tool.exposure !== "direct"), query);
  }

  /** An agent's js_exec `fs` call: cancelled with its tool calls, and bounded like a tool result. */
  private async dispatchFs(handle: Handle, params: { op: string; args: Record<string, unknown> }) {
    if (!handle.bridge.fs) throw new Error("fs is not available: this agent has no files");
    const controller = new AbortController();
    handle.calls.add(controller);
    try { return JSON.parse(jsonWithinLimit(await handle.bridge.fs(params.op, params.args, controller.signal), SANDBOX_LIMITS.resultBytes, "fs result")); }
    finally { handle.calls.delete(controller); }
  }

  private modelAuth(handle: Handle) {
    if (!handle.bridge.modelAuth) throw new Error("This agent's model takes no per-call credentials");
    return handle.bridge.modelAuth();
  }

  private file(handle: Handle, ref: unknown) {
    if (!handle.bridge.file) throw new Error("Files are not available to this agent");
    return handle.bridge.file(ref);
  }

  /** An agent's history index operations; without an index, `indexed` is null and nothing is written. */
  private historyRequest(id: string, handle: Handle, params: { op: string; chunk?: HistoryChunk; from?: number }): Promise<any> {
    const history = handle.bridge.history;
    // What the agent's backlog left to its log, read through a log of its own, never the writer's.
    if (params.op === "read" && typeof params.from === "number") return this.backlog(id, params.from);
    if (params.op === "indexed") return history ? history.indexed() : Promise.resolve(null);
    if (params.op === "write" && history && params.chunk) return history.write(params.chunk);
    return Promise.reject(new Error("Unknown history operation"));
  }

  /** The messages an agent's history index lacks, read from its log (all of them from `from`), without its process. */
  async backlog(id: string, from: number) {
    const log = this.options.storage ? this.options.storage.log<TranscriptRecord>(AgentSupervisor.transcriptKey(id)) : fileAppendLog<TranscriptRecord>(transcriptPath(resolve(join(this.root, id))));
    // Unbounded: this backlog is read for one page, not kept.
    const transcript = new Transcript(log, from, Infinity);
    await transcript.load();
    return transcript.backlog!;
  }

  /** An agent process's transcript operations. Appends are applied before the first await, so they keep IPC order. */
  private transcriptRequest(handle: Handle, params: { op: string; records?: TranscriptRecord[]; durable?: boolean }) {
    const log = handle.transcript;
    if (params.op === "read") return log.read();
    if (params.op === "append") { for (const record of params.records ?? []) log.append(record); return log.flush(params.durable).then(() => null); }
    if (params.op === "rewrite") return log.rewrite(() => params.records ?? []).then(() => null);
    throw new Error("Unknown transcript operation");
  }

  private async startInline(id: string, init: AgentConfig, bridge: ToolBridge, transcript: AppendLog<TranscriptRecord>) {
    const stopped = Promise.withResolvers<never>();
    stopped.promise.catch(() => {});
    const handle = { kind: "inline", bridge, calls: new Set(), listeners: new Set(), stop: stopped.reject, stopped: stopped.promise, transcript } as unknown as InlineHandle;
    handle.host = createAgentHost({
      transcript,
      emit: event => this.dispatchEvent(handle, event, true),
      tool: (name, args, call) => this.dispatchTool(handle, { name, args: structuredClone(args), ...call }),
      cancelTools: async () => this.cancelTools(handle),
      runLimit: async () => handle.bridge.runLimit?.(),
      search: async query => structuredClone(await this.search(handle, structuredClone(query))),
      file: ref => this.file(handle, structuredClone(ref)),
      modelAuth: () => this.modelAuth(handle),
      fs: (op, args) => this.dispatchFs(handle, structuredClone({ op, args })),
      codeSlot: signal => handle.bridge.codeSlot?.(signal) ?? Promise.resolve(() => {}),
      ...(this.options.codeExecutor ? { codeExecutor: this.options.codeExecutor } : {}),
      ...(this.options.historyBacklogBytes ? { historyBacklogBytes: this.options.historyBacklogBytes } : {}),
      ...(this.options.modelOutbound ? { modelOutbound: this.options.modelOutbound } : {}),
      lease: async () => { await handle.bridge.lease?.(); },
      history: {
        indexed: () => this.historyRequest(id, handle, { op: "indexed" }), write: chunk => this.historyRequest(id, handle, { op: "write", chunk: structuredClone(chunk) }),
        read: from => this.historyRequest(id, handle, { op: "read", from }),
      },
    });
    this.agents.set(id, handle);
    this.starting.delete(id);
    try { return await this.invoke(handle, "init", init); }
    catch (error) { await this.stop(id); throw error; }
  }

  private invoke(handle: Handle, method: string, params: any): Promise<any> {
    if (handle.kind === "process") return handle.rpc.request(method, params);
    return Promise.race([handle.host.handle(method, structuredClone(params)), handle.stopped]).then(result => result === undefined ? result : structuredClone(result));
  }

  /**
   * Cut every agent's model requests in flight: this node's lease is no longer fresh (`Ownership.onStale`). Each is
   * made again once it is, or by the agent's next owner.
   */
  interrupt() {
    for (const handle of this.agents.values()) void this.invoke(handle, "interrupt", {}).catch(() => {});
  }

  /** No capacity for another agent; callers may stop an idle agent first. */
  get full() { return this.agents.size + this.starting.size + this.reserved.size >= (this.options.maxAgents ?? 8); }

  /**
   * Hold a slot for `id` until `start` takes it or `unreserve` gives it back, so
   * concurrent starts cannot together pass the capacity check. False when full.
   */
  reserve(id: string, tenant?: string) {
    if (this.reserved.has(id) || this.agents.has(id) || this.starting.has(id)) return true;
    if (this.full) return false;
    this.reserved.set(id, tenant);
    return true;
  }
  unreserve(id: string) { this.reserved.delete(id); }

  /** A request to the agent's host: a client request's method, or one of the runtime's own reads of its history. */
  async request(id: string, method: RequestMethod | "history" | "historyTail", params: any = {}, onEvent?: (event: any) => void) {
    const handle = this.agents.get(id);
    if (!handle) throw new Error("Agent not found");
    const tools = method === "configure" && params.tools !== undefined;
    if (tools) validateDefinitions(params.tools);
    if (method === "abort") this.cancelTools(handle);
    if (onEvent) handle.listeners.add(onEvent);
    try {
      const result = await this.invoke(handle, method, params);
      if (tools) handle.bridge.definitions = params.tools;
      return result;
    }
    finally { if (onEvent) handle.listeners.delete(onEvent); }
  }

  /**
   * Stop an agent. It first indexes its settled turns (`flush`, for up to `historyFlushMs`); callers
   * stopping many at once flush them together first (`flush`), and a node that lost the agent skips it.
   */
  stop(id: string, options: { flush?: boolean } = {}): Promise<void> {
    const handle = this.agents.get(id);
    if (!handle) {
      // Still starting, with no host yet: the start gives up, and a later start of the agent waits until it has.
      const starts = this.unhosted.get(id);
      if (!starts?.size) return this.stopping.get(id) ?? Promise.resolve();
      for (const pending of starts) pending.cancelled = true;
      const stopped = Promise.all([...starts].map(pending => pending.settled)).then(() => {}).finally(() => { if (this.stopping.get(id) === stopped) this.stopping.delete(id); });
      this.stopping.set(id, stopped);
      return stopped;
    }
    this.agents.delete(id);
    const stopped = this.halt(handle, options.flush ?? true).finally(() => { if (this.stopping.get(id) === stopped) this.stopping.delete(id); });
    this.stopping.set(id, stopped);
    return stopped;
  }

  /** Have agents index their settled turns, all at once, waiting at most `historyFlushMs` for all of them. */
  async flush(ids: string[]) {
    const handles = ids.flatMap(id => this.agents.get(id) ?? []);
    if (!handles.length) return;
    const flushed = handles.map(handle => (handle.kind === "process" ? handle.rpc.request("historyFlush", {}) : handle.host.handle("historyFlush", {})).catch(() => {}));
    await Promise.race([Promise.all(flushed), new Promise(resolve => setTimeout(resolve, this.flushMs).unref())]);
  }
  private get flushMs() { return this.options.historyFlushMs ?? HISTORY_FLUSH_MS; }

  private async halt(handle: Handle, flush: boolean) {
    this.cancelTools(handle);
    if (handle.kind === "process") {
      // Its settled turns go to the history index first (the inline host does this as it is disposed).
      if (flush) await Promise.race([handle.rpc.request("historyFlush", {}), new Promise(resolve => setTimeout(resolve, this.flushMs).unref())]).catch(() => {});
      handle.rpc.close("Agent stopped");
      const closed = once(handle.child, "close");
      handle.child.kill("SIGKILL");
      await closed;
    } else {
      // Callers see the same failure as a killed process; the host writes nothing more.
      handle.stop(new Error("Agent stopped"));
      await handle.host.dispose(flush ? this.flushMs : 0);
    }
    // Unloading compacts the transcript's tail into Storage.
    await handle.transcript.close();
  }

  async close() {
    await this.flush([...this.agents.keys()]);
    await Promise.all([...[...this.agents.keys()].map(id => this.stop(id, { flush: false })), ...this.stopping.values()]);
  }
}

/** `log` with each record appended with what commits with it (`ToolBridge.committing`). */
function committing<T>(log: AppendLog<T>, effect: (record: T) => CommitEffect | undefined): AppendLog<T> {
  return {
    read: () => log.read(),
    append: record => log.append(record, effect(record)),
    flush: durable => log.flush(durable),
    rewrite: snapshot => log.rewrite(snapshot),
    get appendedSinceRewrite() { return log.appendedSinceRewrite; },
    close: () => log.close(),
  };
}
