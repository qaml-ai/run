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
import { fileAppendLog, type AppendLog } from "../shared/append-log.ts";
import { readTranscript, readTranscriptLog, Transcript, transcriptPath, type TranscriptRecord } from "./transcript.ts";
import type { HistoryChunk } from "./history-pages.ts";
import type { Claim } from "./ownership.ts";
import { createAgentHost, HISTORY_FLUSH_MS } from "./agent-host.ts";

/**
 * How agents run. "process": each agent is its own Node process (strong memory
 * isolation, ~50 MB each). "inline": many agents share this process, each
 * bounded by its compacted working set. Model-written code runs in QuickJS on the
 * hosting process's worker pool either way.
 */
export type Hosting = "process" | "inline";
type Common = { bridge: ToolBridge; calls: Set<AbortController>; listeners: Set<(event: any) => void>; transcript: AppendLog<TranscriptRecord> };
type ProcessHandle = Common & { kind: "process"; child: ChildProcess; rpc: Rpc };
type InlineHandle = Common & { kind: "inline"; host: ReturnType<typeof createAgentHost>; stop: (error: Error) => void; stopped: Promise<never> };
type Handle = ProcessHandle | InlineHandle;
export type SupervisorOptions = { runtime?: string; maxAgents?: number; storage?: Storage; hosting?: Hosting; /** How long stopping agents wait, all together, to index their settled turns (default 5 s). */ historyFlushMs?: number };

export class AgentSupervisor {
  readonly agents = new Map<string, Handle>();
  readonly starting = new Set<string>();
  /** Slots held for agents about to start (see `reserve`), with the tenant each is for; they count against capacity. */
  readonly reserved = new Map<string, string | undefined>();
  /** Agents being stopped. They are already out of `agents`, so no new work reaches a dying agent. */
  private readonly stopping = new Map<string, Promise<void>>();
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
      const result = await handle.bridge.call(checked.tool.name, checked.args, controller.signal, params.toolCallId ? { toolCallId: params.toolCallId, ...(params.innerCallId ? { innerCallId: params.innerCallId } : {}) } : undefined);
      controller.signal.throwIfAborted();
      return JSON.parse(jsonWithinLimit(result, SANDBOX_LIMITS.resultBytes, "Tool result"));
    }
    finally { handle.calls.delete(controller); }
  }
  private cancelTools(handle: Handle) { for (const call of handle.calls) call.abort(); return null; }

  /** Start an agent. `claim` is its owner's, which fences the transcript's writes. */
  async start(id: string, config: Omit<AgentConfig, "id" | "directory" | "tools">, bridge: ToolBridge, claim?: Claim) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid agent id");
    await this.stopping.get(id);
    validateDefinitions(bridge.definitions);
    if (this.agents.has(id) || this.starting.has(id)) throw new Error("Agent already exists");
    if (!this.reserved.delete(id) && this.full) throw Object.assign(new Error("Agent capacity reached"), { status: 503 });
    this.starting.add(id);
    try {
      const directory = resolve(join(this.root, id));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const storage = this.options.storage;
      const transcript = storage ? storage.log<TranscriptRecord>(AgentSupervisor.transcriptKey(id), claim) : fileAppendLog<TranscriptRecord>(transcriptPath(directory));
      const init = { ...config, id, directory, tools: bridge.definitions };
      return this.hosting === "inline" ? await this.startInline(id, init, bridge, transcript) : await this.startProcess(id, directory, init, bridge, transcript);
    } finally { this.starting.delete(id); }
  }

  private async startProcess(id: string, directory: string, init: AgentConfig, bridge: ToolBridge, transcript: AppendLog<TranscriptRecord>) {
    const { child, rpc } = childProcess("./agent-child.ts", directory, this.options.runtime, true);
    const handle: ProcessHandle = { kind: "process", bridge, child, rpc, calls: new Set(), listeners: new Set(), transcript };
    this.agents.set(id, handle);
    this.starting.delete(id);
    const cleanup = () => {
      this.cancelTools(handle);
      if (this.agents.get(id) === handle) this.agents.delete(id);
      void handle.transcript.close();
    };
    child.once("exit", cleanup);
    child.once("error", cleanup);
    rpc.onEvent = event => { for (const listener of handle.listeners) listener(event); };
    rpc.handler = async (method, params) => {
      if (method === "cancel-tools") return this.cancelTools(handle);
      if (method === "transcript") return this.transcriptRequest(handle, params);
      if (method === "spend-limit") return (await handle.bridge.spendLimit?.()) ?? null;
      if (method === "search") return this.search(handle, params);
      if (method === "file") return this.file(handle, params);
      if (method === "model-auth") return this.modelAuth(handle);
      if (method === "fs") return this.dispatchFs(handle, params);
      if (method === "history") return this.historyRequest(handle, params);
      if (method !== "tool") throw new Error("Unknown tool");
      return this.dispatchTool(handle, params);
    };
    const timeout = setTimeout(() => { rpc.close("Agent initialization timed out"); child.kill("SIGKILL"); }, 30_000);
    try { return await rpc.request("init", init); }
    catch (error) { await this.stop(id); throw error; }
    finally { clearTimeout(timeout); }
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
  private historyRequest(handle: Handle, params: { op: string; chunk?: HistoryChunk; total?: number }): Promise<any> {
    const history = handle.bridge.history;
    if (params.op === "indexed") return history ? history.indexed() : Promise.resolve(null);
    if (params.op === "truncate" && history && typeof params.total === "number") return history.truncate(params.total);
    if (params.op === "write" && history && params.chunk) return history.write(params.chunk);
    return Promise.reject(new Error("Unknown history operation"));
  }

  /**
   * The messages an agent's history index lacks, read from its log (all of them from `from`), without its
   * process; `settled` of them are of settled turns. A turn left open (its node died) is not: its next start
   * may retract its cut-off response and answer again, so only that start may index it.
   */
  async backlog(id: string, from: number) {
    const log = this.options.storage ? this.options.storage.log<TranscriptRecord>(AgentSupervisor.transcriptKey(id)) : fileAppendLog<TranscriptRecord>(transcriptPath(resolve(join(this.root, id))));
    const transcript = new Transcript(log, from);
    await transcript.load();
    const backlog = transcript.backlog!;
    return { backlog, settled: transcript.active ? Math.max(0, Math.min(backlog.messages.length, transcript.turnStart - backlog.from)) : backlog.messages.length };
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
      // Copies keep the agent from sharing objects with the supervisor, as IPC would.
      emit: event => { for (const listener of handle.listeners) listener(structuredClone(event)); },
      tool: (name, args, call) => this.dispatchTool(handle, { name, args: structuredClone(args), ...call }),
      cancelTools: async () => this.cancelTools(handle),
      spendLimit: async () => handle.bridge.spendLimit?.(),
      search: async query => structuredClone(await this.search(handle, structuredClone(query))),
      file: ref => this.file(handle, structuredClone(ref)),
      modelAuth: () => this.modelAuth(handle),
      fs: (op, args) => this.dispatchFs(handle, structuredClone({ op, args })),
      history: {
        indexed: () => this.historyRequest(handle, { op: "indexed" }), write: chunk => this.historyRequest(handle, { op: "write", chunk: structuredClone(chunk) }),
        truncate: total => this.historyRequest(handle, { op: "truncate", total }),
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

  async request(id: string, method: RequestMethod, params: any = {}, onEvent?: (event: any) => void) {
    const handle = this.agents.get(id);
    if (!handle) throw new Error("Agent not found");
    if (method === "configure" && params.tools !== undefined) validateDefinitions(params.tools);
    if (method === "abort") this.cancelTools(handle);
    if (onEvent) handle.listeners.add(onEvent);
    try {
      const result = await this.invoke(handle, method, params);
      if (method === "configure" && params.tools !== undefined) handle.bridge.definitions = params.tools;
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
    if (!handle) return this.stopping.get(id) ?? Promise.resolve();
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
