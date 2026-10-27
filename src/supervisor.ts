import type { Message } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { JournalHistory } from "./pi-durable/history.ts";
import { HostJournal } from "./pi-durable/host-journal.ts";
import { legacyHistory, recordsHistory, retiredRecords, type RetiredRecord } from "./pi-durable/retired-host.ts";
import { journalForkCut, type JournalForkCut } from "./pi-durable/fork.ts";
import { resetContext, type ContextReset } from "./pi-durable/reset.ts";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { agentProcessEnv, childProcess, type Rpc } from "./rpc.ts";
import type { AgentConfig, CallContext, ToolBridge } from "./protocol.ts";
import type { RequestMethod } from "../shared/client-protocol.ts";
import type { ChildProcess } from "node:child_process";
import { validateDefinitions, validateToolCall } from "./tool-policy.ts";
import { searchQuery, searchTools } from "./tool-search.ts";
import { jsonWithinLimit, SANDBOX_LIMITS } from "./limits.ts";
import type { Storage } from "../shared/storage.ts";
import { fileAppendLog, type AppendLog, type CommitEffect } from "../shared/append-log.ts";
import { chunksOf, type HistoryChunk } from "./history-pages.ts";
import type { Claim } from "./ownership.ts";
import { createAgentHost, HISTORY_FLUSH_MS, type LegacyLog } from "./agent-host.ts";
import type { CodeExecutor } from "./codemode.ts";
import type { Outbound } from "./outbound.ts";
import { buggify } from "./buggify.ts";
import { closeInterruptedTurn } from "./history.ts";
import type { Db, Sql } from "./db.ts";
import type { Storage as PiStorage } from "@earendil-works/pi-durable";
import { deletePiStorage, hasPiStorage, openPiJournalReader, openPiStorage, purgePiStorage, storageRequest } from "./pi-durable/storage.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { seedJournal } from "./pi-durable/seed.ts";

/** Where an agent's legacy log is, in a single-host directory (`AgentSupervisor.legacyLog`). */
export const transcriptPath = (directory: string) => join(directory, "transcript.jsonl");

/**
 * How agents run. "process": each agent is its own Node process (strong memory
 * isolation, ~50 MB each). "inline": many agents share this process, each
 * bounded by its compacted working set. Model-written code runs in v8-exec
 * processes either way (confined by agent-launcher when it started the runtime).
 */
export type Hosting = "process" | "inline";
type Common = { bridge: ToolBridge; calls: Set<AbortController>; listeners: Set<(event: any) => void>; legacy: AppendLog<RetiredRecord>; durable?: PiStorage };
/** An agent process's js_exec turns (`codeSlot`), by its id for them: waiting (`release` unset) or held. */
type CodeSlots = Map<string, { controller: AbortController; release?: () => void }>;
type ProcessHandle = Common & { kind: "process"; child: ChildProcess; rpc: Rpc; slots: CodeSlots; watchdog?: NodeJS.Timeout };
type InlineHandle = Common & { kind: "inline"; host: ReturnType<typeof createAgentHost>; stop: (error: Error) => void; stopped: Promise<never> };
type Handle = ProcessHandle | InlineHandle;
type SupervisorOptions = {
  runtime?: string; maxAgents?: number;
  /**
   * The node takes no more agents while this process's resident memory is above this (AGENT_MEMORY_HIGH_BYTES): with
   * inline hosting every agent is in it, so this, not the count, is what a node runs out of first. Unset: no such check.
   */
  memoryHighBytes?: number;
  storage?: Storage; hosting?: Hosting; /** How long stopping agents wait, all together, to index their settled turns (default 5 s). */ historyFlushMs?: number;
  /** How long Pi's journal (in `db`) repeats a read or commit the database did not answer: a failover (default 0). */
  piRetryMs?: number;
  /** An agent process is pinged this often, and killed once a ping has gone this long unanswered (default 5 s and 30 s). */
  pingMs?: number; unresponsiveMs?: number;
  /** Where inline agents run js_exec (src/codemode.ts): this process's v8-exec runner unless given. Agent processes always use their own. */
  codeExecutor?: CodeExecutor;
  /** What agent processes are told of the node's settings (`agentProcessEnv`); this process's own unless given. */
  agentEnv?: Record<string, string>;
  /** The outbound policy inline agents' model calls go through (agent processes get it in `agentEnv`). */
  modelOutbound?: Outbound;
  /** Tenants whose inline agents' system sections are native Pi sections (agent processes get it in `agentEnv`). */
  nativeSectionsTenants?: string[];
  /** Shared Pi records use the same database and ownership claim as the session. */
  db?: Db;
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
   * `root` holds each agent's local working directory (its sandbox cwd). An agent's history is its Pi journal (in `db`,
   * or in its working directory without one). Its legacy log, which only sessions from before Pi read, is in `storage`
   * under `sessions/<id>/transcript`, or in its working directory without it.
   */
  constructor(root: string, options: SupervisorOptions = {}) {
    this.root = root;
    this.options = options;
  }

  get hosting(): Hosting { return this.options.hosting ?? "process"; }

  static transcriptKey(id: string) { return `sessions/${id}/transcript`; }

  private piLocation(id: string) { return { sessionId: id, directory: resolve(join(this.root, id)), ...(this.options.db ? { db: this.options.db, retryMs: this.options.piRetryMs ?? 0 } : {}) }; }

  /** Whether the agent keeps a native (Pi) journal. */
  async hasDurableHistory(id: string): Promise<boolean> {
    const journal = await openPiJournalReader(this.piLocation(id));
    await journal?.close(BACKGROUND_CONTEXT);
    return !!journal;
  }

  /** The agent's legacy log, read only (records an import too large to copy left there, before Pi held everything). */
  private legacyLog(id: string): AppendLog<RetiredRecord> {
    return this.options.storage ? this.options.storage.log<RetiredRecord>(AgentSupervisor.transcriptKey(id)) : fileAppendLog<RetiredRecord>(transcriptPath(resolve(join(this.root, id))));
  }

  /**
   * An agent's full history without its process, read beside a live owner without writing: the messages before what
   * its journal holds (`settled`: the history index's first ones; without it, the retired host transcript's records),
   * then the journal's.
   */
  async history(id: string, settled?: (count: number) => Promise<AgentMessage[]>): Promise<AgentMessage[]> {
    const backlog = await this.journalBacklog(id, 0, settled);
    return backlog?.messages ?? [];
  }

  /**
   * Start a new agent's journal (a fork's) in its Pi storage under its owner's `claim`, before it is started: its
   * history's first `before` messages are in its history index already (written by the caller), `requests` are those
   * messages' requests, and `model` is the context it starts with.
   */
  async seed(id: string, start: { before: number; calls?: [string, number][]; requests: string[]; model: Message[] }, claim?: Claim) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid agent id");
    await mkdir(resolve(join(this.root, id)), { recursive: true, mode: 0o700 });
    const storage = await openPiStorage({ ...this.piLocation(id), ...(claim ? { claim } : {}) });
    try {
      const seeded = await seedJournal({ storage, sessionId: id, model: start.model, before: { total: start.before, ...(start.calls ? { calls: start.calls } : {}) }, requests: start.requests });
      if (seeded.status !== "seeded") throw new Error("The agent's Pi storage was seeded already");
    } finally { await storage.close(BACKGROUND_CONTEXT); }
  }

  /**
   * Settle the turn a stopped agent's journal holds open (`closeInterruptedTurn`), under its owner's `claim`, without
   * starting it: for a run ended with no host to end it (one past its resumes, or stopped before its node was lost). The
   * same records the agent's next start would write, written before the run is seen to end, with what commits with each
   * (`committing`). A session the host transcript wrote has it retired first, its history before the journal's base
   * indexed (`index`). Whether there was a turn to settle.
   */
  async closeTurn(id: string, claim?: Claim, options: { committing?: ToolBridge["committing"]; index?: ToolBridge["history"] } = {}): Promise<boolean> {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid agent id");
    // One at a time per agent, each reading the journal as the one before left it: two closes of one turn (a load's and
    // a run's, or two loads') never both answer its open calls. Across nodes, the owner's claim fences the write instead.
    const current = (this.closing.get(id) ?? Promise.resolve()).then(() => this.closeTurnNow(id, claim, options));
    const settled = current.then(() => {}, () => {});
    this.closing.set(id, settled);
    try { return await current; }
    finally { if (this.closing.get(id) === settled) this.closing.delete(id); }
  }

  private async closeTurnNow(id: string, claim: Claim | undefined, options: { committing?: ToolBridge["committing"]; index?: ToolBridge["history"] }): Promise<boolean> {
    await this.stopping.get(id);
    // A running agent's host writes its own journal.
    if (this.agents.has(id) || this.starting.has(id)) throw new Error("Agent is running");
    if (!await hasPiStorage(this.piLocation(id))) return false;
    const storage = await openPiStorage({ ...this.piLocation(id), ...(claim ? { claim } : {}),
      ...(options.committing ? { committing: async (entry, sql) => { await options.committing!(entry)?.(sql); } } : {}) });
    const legacy = this.legacyLog(id);
    try {
      const index = options.index;
      const indexed = index ? await index.indexed() : null;
      await HostJournal.retire(storage, { ...(index && indexed !== null ? { indexed, index: (from, messages, turns) => writeChunks(index, from, messages, turns) } : {}), legacy: () => legacy.read() });
      const journal = await HostJournal.open(storage);
      return journal ? await closeInterruptedTurn(journal) : false;
    } finally { await storage.close(BACKGROUND_CONTEXT); await legacy.close(); }
  }

  /**
   * Reset a stopped agent's Pi context (pi-durable/reset.ts) under its owner's `claim`, without starting it: a new
   * checkpoint at its journal's tail, written without loading the range it replaces. Undefined for an agent with no
   * journal yet (nothing to reset).
   */
  async resetContext(id: string, claim: Claim | undefined, options: { summary?: string; keepMessages?: number; limit: number; settled?: (end: number, from: number) => Promise<AgentMessage[]> }): Promise<ContextReset | undefined> {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid agent id");
    await this.stopping.get(id);
    // A running agent's host holds its context; it is stopped first.
    if (this.agents.has(id) || this.starting.has(id)) throw new Error("Agent is running");
    if (!await hasPiStorage(this.piLocation(id))) return undefined;
    const storage = await openPiStorage({ ...this.piLocation(id), ...(claim ? { claim } : {}) });
    try { return await resetContext(storage, options); }
    finally { await storage.close(BACKGROUND_CONTEXT); }
  }

  /** Delete a stopped agent's native journal, legacy log and local directory. Reuse a caller's purge transaction. */
  async purge(id: string, sql?: Sql) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error("Invalid agent id");
    await this.stopping.get(id);
    if (this.agents.has(id) || this.starting.has(id)) throw new Error("Agent is running");
    await this.options.storage?.removeLog(AgentSupervisor.transcriptKey(id));
    if (sql) await deletePiStorage(sql, id);
    else if (this.options.db) await purgePiStorage(this.options.db, id);
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

  /** Start an agent. `claim` is its owner's, which fences its journal's writes. */
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
      // A close of its turn writes first: the agent then loads the journal as it left it.
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
        const legacy = this.legacyLog(id);
        const location = { sessionId: id, directory, ...(this.options.db ? { db: this.options.db, retryMs: this.options.piRetryMs ?? 0 } : {}) };
        if (this.options.storage && !this.options.db) throw new Error("Pi durable shared storage requires the supervisor database");
        const durable = await openPiStorage({ ...location, ...(claim ? { claim } : {}), committing: async (entry, sql) => { await bridge.committing?.(entry)?.(sql); } });
        try {
          if (pending.cancelled) throw new Error("Agent stopped");
          hosted();
          const init = { ...config, id, directory, tools: bridge.definitions };
          return this.hosting === "inline" ? await this.startInline(id, init, bridge, legacy, durable) : await this.startProcess(id, directory, init, bridge, legacy, durable);
        } catch (error) { await durable?.close(BACKGROUND_CONTEXT); await legacy.close(); throw error; }
      } finally { this.starting.delete(id); }
    } finally { hosted(); }
  }

  private async startProcess(id: string, directory: string, init: AgentConfig, bridge: ToolBridge, legacy: AppendLog<RetiredRecord>, durable?: PiStorage) {
    // A supervisor given its tenant lists directly (tests) tells its agent processes, as a node's agentEnv does.
    const lists = {
      ...(this.options.nativeSectionsTenants?.length && !this.options.agentEnv?.AGENT_NATIVE_SECTIONS_TENANTS ? { AGENT_NATIVE_SECTIONS_TENANTS: this.options.nativeSectionsTenants.join(",") } : {}),
    };
    const { child, rpc } = childProcess("./agent-child.ts", directory, this.options.runtime, true, id, Object.keys(lists).length
      ? { ...this.options.agentEnv ?? agentProcessEnv(process.env), ...lists } : this.options.agentEnv);
    const handle: ProcessHandle = { kind: "process", bridge, child, rpc, calls: new Set(), listeners: new Set(), legacy, durable, slots: new Map() };
    this.agents.set(id, handle);
    this.starting.delete(id);
    const cleanup = () => {
      clearInterval(handle.watchdog);
      this.cancelTools(handle);
      // A process that ends holding js_exec turns gives them back.
      for (const slot of handle.slots.keys()) this.releaseSlot(handle, slot);
      if (this.agents.get(id) === handle) this.agents.delete(id);
      void handle.legacy.close();
      void handle.durable?.close(BACKGROUND_CONTEXT);
    };
    child.once("exit", cleanup);
    child.once("error", cleanup);
    rpc.onEvent = event => this.dispatchEvent(handle, event);
    rpc.handler = async (method, params) => {
      if (method === "cancel-tools") return this.cancelTools(handle);
      if (method === "legacy-log") return this.legacyRequest(handle, params);
      if (method === "pi-storage") {
        if (params?.method === "available") return !!handle.durable;
        if (!handle.durable) throw new Error("Pi storage is not open");
        return storageRequest(handle.durable, params);
      }
      if (method === "run-limit") return (await handle.bridge.runLimit?.()) ?? null;
      if (method === "search") return this.search(handle, params);
      if (method === "file") return this.file(handle, params);
      if (method === "model-auth") return this.modelAuth(handle);
      if (method === "model-attempt") return handle.bridge.modelAttempt?.(params) ?? false;
      if (method === "fs") return this.dispatchFs(handle, params);
      if (method === "history") return this.historyRequest(handle, params);
      if (method === "code-slot") return this.codeSlot(handle, params?.id);
      if (method === "code-release") return this.releaseSlot(handle, params?.id);
      if (method === "lease") return (await handle.bridge.lease?.()) ?? null;
      if (method !== "tool") throw new Error("Unknown tool");
      return this.dispatchTool(handle, params);
    };
    const timeout = setTimeout(() => { rpc.close("Agent initialization timed out"); child.kill("SIGKILL"); }, 120_000);
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
   * turn from its journal (agent-host.ts), as after a crash.
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
  private historyRequest(handle: Handle, params: { op: string; chunk?: HistoryChunk }): Promise<any> {
    const history = handle.bridge.history;
    if (params.op === "indexed") return history ? history.indexed() : Promise.resolve(null);
    if (params.op === "write" && history && params.chunk) return history.write(params.chunk);
    return Promise.reject(new Error("Unknown history operation"));
  }

  /**
   * A fork of agent `id` cut from its journal (pi-durable/fork.ts), read without its process: its history is `settled`
   * (the history index's first `indexed` messages, which `settled` reads) then the journal's. Undefined where the
   * journal cannot place the cut.
   */
  async journalFork(id: string, indexed: number, settled: (indexed: number) => Promise<AgentMessage[]>, at?: number | string): Promise<JournalForkCut | undefined> {
    if (!await hasPiStorage(this.piLocation(id))) return undefined;
    // Read only: opening the storage writes nothing that is not there already, and nothing here commits.
    const storage = await openPiStorage(this.piLocation(id));
    try {
      const history = await JournalHistory.openAny(storage);
      const tail = history && await history.messagesFrom(indexed);
      if (!history || !tail) return undefined;
      return await journalForkCut(storage, history, [...await settled(indexed), ...tail], at);
    } finally { await storage.close(BACKGROUND_CONTEXT); }
  }

  /**
   * The agent's history from absolute index `from` on, and where its turns began, without its process: the journal's,
   * after what comes before what it holds (`settled`: the history index's messages in [from, end); without it, or before the
   * index reaches it, the retired host transcript's records). Undefined for an agent with no journal.
   */
  async journalBacklog(id: string, from: number, settled?: (end: number, from: number) => Promise<AgentMessage[]>): Promise<{ from: number; messages: AgentMessage[]; turns: number[] } | undefined> {
    if (!await hasPiStorage(this.piLocation(id))) {
      // Only a legacy log: a session from before Pi, which no release imports any more.
      const legacy = this.legacyLog(id);
      try {
        const old = recordsHistory(await legacy.read());
        return old.messages.length ? { from, messages: old.messages.slice(from), turns: old.turns.filter(turn => turn >= from) } : undefined;
      } finally { await legacy.close(); }
    }
    // Read only: opening the storage writes nothing that is not there already, and nothing here commits.
    const storage = await openPiStorage(this.piLocation(id));
    try {
      const history = await JournalHistory.openAny(storage);
      if (!history) {
        // Its history still only in the legacy format: refused at start, but read.
        const legacy = this.legacyLog(id);
        try {
          const records = await legacy.read();
          if (!records.length) return undefined;
          const old = await legacyHistory(storage, records);
          return { from, messages: old.messages.slice(from), turns: old.turns.filter(turn => turn >= from) };
        } finally { await legacy.close(); }
      }
      const held = history.heldFrom;
      let before: AgentMessage[] = [], turns: number[] = [];
      if (from < held) {
        const indexed = settled ? await settled(held, from) : [];
        if (indexed.length >= held - from) before = indexed.slice(0, held - from);
        else {
          const legacy = this.legacyLog(id);
          try {
            const retired = recordsHistory(await retiredRecords(storage, () => legacy.read(), true) ?? []);
            if (retired.messages.length < held) throw new Error(`Agent ${id}'s history before its journal's base (${held} messages) is in neither its index nor its host transcript`);
            before = retired.messages.slice(from, held);
            turns = retired.turns.filter(turn => turn >= from && turn < held);
          } finally { await legacy.close(); }
        }
      }
      const messages = await history.messagesFrom(Math.max(from, held));
      if (!messages) return undefined;
      return { from, messages: [...before, ...messages], turns: [...turns, ...history.turnsFrom(Math.max(from, held))] };
    } finally { await storage.close(BACKGROUND_CONTEXT); }
  }

  /** An agent process's reads of its legacy log. */
  private async legacyRequest(handle: Handle, params: { op: string }) {
    if (params.op === "read") return handle.legacy.read();
    if (params.op === "empty") return (await handle.legacy.empty?.()) === true;
    throw new Error("Unknown legacy log operation");
  }

  private async startInline(id: string, init: AgentConfig, bridge: ToolBridge, legacy: AppendLog<RetiredRecord>, durable?: PiStorage) {
    const stopped = Promise.withResolvers<never>();
    stopped.promise.catch(() => {});
    const handle = { kind: "inline", bridge, calls: new Set(), listeners: new Set(), stop: stopped.reject, stopped: stopped.promise, legacy, durable } as unknown as InlineHandle;
    handle.host = createAgentHost({
      legacyLog: { read: () => this.legacyRequest(handle, { op: "read" }), empty: () => this.legacyRequest(handle, { op: "empty" }) } as LegacyLog,
      piStorage: async () => durable,
      emit: event => this.dispatchEvent(handle, event, true),
      tool: (name, args, call) => this.dispatchTool(handle, { name, args: structuredClone(args), ...call }),
      cancelTools: async () => this.cancelTools(handle),
      runLimit: async () => handle.bridge.runLimit?.(),
      search: async query => structuredClone(await this.search(handle, structuredClone(query))),
      file: ref => this.file(handle, structuredClone(ref)),
      modelAuth: () => this.modelAuth(handle),
      modelAttempt: event => handle.bridge.modelAttempt?.(structuredClone(event)) ?? Promise.resolve(false),
      fs: (op, args) => this.dispatchFs(handle, structuredClone({ op, args })),
      codeSlot: signal => handle.bridge.codeSlot?.(signal) ?? Promise.resolve(() => {}),
      ...(this.options.codeExecutor ? { codeExecutor: this.options.codeExecutor } : {}),
      ...(this.options.nativeSectionsTenants?.length ? { nativeSectionsTenants: this.options.nativeSectionsTenants } : {}),
      ...(this.options.modelOutbound ? { modelOutbound: this.options.modelOutbound } : {}),
      lease: async () => { await handle.bridge.lease?.(); },
      history: { indexed: () => this.historyRequest(handle, { op: "indexed" }), write: chunk => this.historyRequest(handle, { op: "write", chunk: structuredClone(chunk) }) },
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
  /** Over `memoryHighBytes`: the node starts no agent (ClientSessions.makeRoom), and takes no orphaned work, until it falls. */
  get memoryHigh() { return !!this.options.memoryHighBytes && process.memoryUsage.rss() > this.options.memoryHighBytes; }

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
  async request(id: string, method: RequestMethod | "historyTail", params: any = {}, onEvent?: (event: any) => void) {
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
    await handle.legacy.close();
    await handle.durable?.close(BACKGROUND_CONTEXT);
  }

  async close() {
    await this.flush([...this.agents.keys()]);
    await Promise.all([...[...this.agents.keys()].map(id => this.stop(id, { flush: false })), ...this.stopping.values()]);
  }
}

/** Write `messages` (the history's from `from`, where `turns` begin) to an agent's history index as chunks: where it ends then. */
async function writeChunks(index: NonNullable<ToolBridge["history"]>, from: number, messages: AgentMessage[], turns: number[]): Promise<number> {
  let indexed = from;
  for (const chunk of chunksOf({ from, messages, sizes: messages.map(message => JSON.stringify(message).length), turns })) {
    indexed = await index.write(chunk);
    if (indexed !== chunk.start + chunk.messages.length) break;
  }
  return indexed;
}
