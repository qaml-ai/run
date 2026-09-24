import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { Type, type TSchema, type Static } from "typebox";
import { Check } from "typebox/value";
import { FRAME_BYTES, type ToolDefinition, type CallRecord, type ClientEvent, type Outcome, type RequestMethod, type SessionCredentials, type SessionState } from "../shared/client-protocol.ts";
export { Type as schema };
export type { SessionCredentials, SessionState };

export interface ToolContext {
  signal: AbortSignal; callId: string; toolCallId?: string;
  /** Set by the runtime, e.g. `{ channel, conversationId, sender }` for a turn a channel message started. */
  origin?: Record<string, unknown>;
}
export interface Tool<T = any> {
  description: string;
  resultFormat?: "json" | "content";
  exposure?: "direct" | "codemode" | "both";
  executionMode?: "sequential" | "parallel";
  input: Record<string, unknown>;
  execute: (args: T, context: ToolContext) => unknown | Promise<unknown>;
}
/** Infer callback arguments from the schema; no manually duplicated argument type. */
export function tool<S extends TSchema>(definition: Omit<Tool<Static<S>>, "input"> & { input: S }): Tool<Static<S>> {
  return { ...definition, input: definition.input as unknown as Record<string, unknown> };
}
export type Tools = Record<string, Tool>;
export interface RuntimeOptions {
  url?: string;
  apiKey?: string;
  /** Persist tool receipts and event cursors before acknowledging work. Default: memory only. */
  journalStore?: JournalStore;
  /** Injectable for tests, observability, or an application's HTTP stack. */
  fetch?: typeof globalThis.fetch;
}
export interface AgentOptions {
  tools: Tools;
  onEvent?: (event: any, requestId?: string) => unknown | Promise<unknown>;
  onConnection?: (connected: boolean) => void;
  onError?: (error: Error) => void;
}
export type { ThinkingLevel };
export interface CreateAgentOptions extends AgentOptions {
  idempotencyKey?: string;
  /** Agent lifetime in seconds (60 to 366 days), or null to keep the agent until it is deleted. Default one day. */
  ttlSeconds?: number | null;
  systemPrompt?: string;
  name?: string;
  type?: string;
  /**
   * A model from the runtime's catalog as "provider/model-id" (see GET /v1/models),
   * e.g. "anthropic/claude-sonnet-5" or "openrouter/openai/gpt-5.2". A full Pi
   * model object is also accepted if its endpoint is trusted by the runtime.
   */
  model?: string | Model<Api>;
  thinkingLevel?: ThinkingLevel;
  initialMessages?: AgentMessage[];
  /** Volumes for the agent's file tools (read, write, edit, ls, glob, grep). Default: its own workspace volume at /workspace. */
  mounts?: Mount[];
}
/** A volume the agent's file tools see at `path`; `notify` prompts the agent when others change files there. */
export interface Mount { volumeId: string; path: string; mode: "ro" | "rw"; subpath?: string; notify?: boolean }
export interface Volume { id: string; name: string; createdAt: number; seq?: number; files?: number; bytes?: number; origin?: { volume: string; snapshot?: string; seq: number } }
export interface VolumeFile { path: string; version: number; size: number; updatedAt: number; by?: string }
export interface VolumeSnapshot { id: string; volume: string; name: string; seq: number; createdAt: number; files: number; bytes: number }
export interface VolumeChanges { seq: number; changes: { seq: number; path: string; kind: "write" | "delete"; version?: number; size?: number; by?: string; at: number }[]; gap?: boolean }
export interface AgentHistory { messages: AgentMessage[] }
export interface Schedule { id: string; agent: string; text?: string; code?: string; dueAt: number; everySeconds?: number; createdAt: number }
export interface RequestOptions { idempotencyKey?: string; timeoutMs?: number }
export class AgentError extends Error {
  status: number;
  requestId?: string;
  constructor(message: string, status = 0, requestId?: string) { super(message); this.name = "AgentError"; this.status = status; this.requestId = requestId; }
}
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const definitions = (tools: Tools): ToolDefinition[] => Object.entries(tools).map(([name, tool]) => ({ name, description: tool.description, parameters: tool.input, ...(tool.resultFormat ? { resultFormat: tool.resultFormat } : {}), ...(tool.exposure ? { exposure: tool.exposure } : {}), ...(tool.executionMode ? { executionMode: tool.executionMode } : {}) }));

async function rejectRedirect(response: Response) {
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new AgentError("Runtime redirects are not allowed", response.status);
  }
}

class Transport {
  readonly base: string;
  readonly fetcher: typeof globalThis.fetch;
  constructor(options: RuntimeOptions) {
    const url = new URL(options.url ?? "http://127.0.0.1:8790");
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Use a runtime origin without credentials, path, or query");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("Remote runtimes require https://");
    this.base = url.origin;
    const fetcher = options.fetch;
    this.fetcher = fetcher ? (input, init) => fetcher(input, init) : globalThis.fetch.bind(globalThis);
  }
  async json(path: string, token: string, method = "GET", body?: unknown, retry = true, headers: Record<string, string> = {}): Promise<any> {
    const data = body === undefined ? undefined : JSON.stringify(body);
    if (data && byteLength(data) > FRAME_BYTES) throw new AgentError("Request exceeds transport limit");
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await this.fetcher(this.base + path, {
          method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers }, body: data,
          redirect: "manual", signal: AbortSignal.timeout(10_000),
        });
        await rejectRedirect(response);
        const value = await response.json() as any;
        if (!response.ok) throw new AgentError(value.error ?? `HTTP ${response.status}`, response.status);
        return value;
      } catch (error) {
        if (!retry || attempt >= 3 || (error instanceof AgentError && error.status < 500)) throw error;
        await pause(100 * 2 ** attempt);
      }
    }
  }
  /** A request with a raw body or response (volume file contents). */
  async raw(path: string, token: string, init: { method?: string; body?: Uint8Array; headers?: Record<string, string> } = {}): Promise<Response> {
    const response = await this.fetcher(this.base + path, { method: init.method ?? "GET", body: init.body as BodyInit | undefined, headers: { Authorization: `Bearer ${token}`, ...init.headers }, redirect: "manual" });
    await rejectRedirect(response);
    if (!response.ok) {
      const value = await response.json().catch(() => ({})) as any;
      throw new AgentError(value.error ?? `HTTP ${response.status}`, response.status);
    }
    return response;
  }
}

/** Trusted-backend SDK. Only createAgent needs the operator key. */
export class AgentRuntime {
  readonly options: RuntimeOptions;
  private readonly transport: Transport;
  constructor(options: RuntimeOptions = {}) { this.options = options; this.transport = new Transport(options); }
  async createAgent(options: CreateAgentOptions): Promise<AgentClient> {
    const key = this.options.apiKey;
    if (!key) throw new AgentError("Set apiKey to provision an agent");
    const session = await this.transport.json("/client-sessions", key, "POST", { tools: definitions(options.tools), ...(options.mounts !== undefined ? { mounts: options.mounts } : {}), ...(options.model !== undefined ? { model: options.model } : {}), ...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}), ...(options.initialMessages !== undefined ? { initialMessages: options.initialMessages } : {}), ...(options.name !== undefined ? { name: options.name } : {}), ...(options.type !== undefined ? { type: options.type } : {}), ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}), ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}) }, true,
      { "Idempotency-Key": options.idempotencyKey ?? globalThis.crypto.randomUUID() });
    return this.connectAgent(session, options);
  }
  async connectAgent(session: SessionCredentials, options: AgentOptions): Promise<AgentClient> {
    const client = new AgentClient(this.options, session, options);
    try { await client.connect(); return client; }
    catch (error) { await client.close(); throw error; }
  }
  private operator() {
    if (!this.options.apiKey) throw new AgentError("Set apiKey to manage volumes and mounts");
    return this.options.apiKey;
  }
  createVolume(options: { name?: string } = {}): Promise<Volume> { return this.transport.json("/v1/volumes", this.operator(), "POST", options, false); }
  listVolumes(): Promise<Volume[]> { return this.transport.json("/v1/volumes", this.operator()); }
  /** A handle on one volume's files, snapshots and forks. */
  volume(id: string): VolumeHandle {
    if (!/^vol_[a-f0-9]{24}$/.test(id)) throw new AgentError("Invalid volume id");
    return new VolumeHandle(this.transport, this.operator(), id);
  }
  mounts(agentId: string): Promise<Mount[]> { return this.transport.json(`/v1/agents/${encodeURIComponent(agentId)}/mounts`, this.operator()); }
  /** Replace an agent's mounts; an idle agent restarts so its tools describe them. */
  setMounts(agentId: string, mounts: Mount[]): Promise<Mount[]> { return this.transport.json(`/v1/agents/${encodeURIComponent(agentId)}/mounts`, this.operator(), "PUT", { mounts }, false); }
}

/** Files are versioned: pass `version` to write or remove only if nobody changed the file since (0: must not exist). */
export class VolumeHandle {
  readonly id: string;
  private readonly transport: Transport;
  private readonly token: string;
  constructor(transport: Transport, token: string, id: string) { this.transport = transport; this.token = token; this.id = id; }
  private path(suffix = "") { return `/v1/volumes/${this.id}${suffix}`; }
  private file(path: string) { return this.path(`/files/${path.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`); }
  info(): Promise<Volume> { return this.transport.json(this.path(), this.token); }
  delete() { return this.transport.json(this.path(), this.token, "DELETE", undefined, false); }
  snapshot(options: { name?: string } = {}): Promise<VolumeSnapshot> { return this.transport.json(this.path("/snapshots"), this.token, "POST", options, false); }
  snapshots(): Promise<VolumeSnapshot[]> { return this.transport.json(this.path("/snapshots"), this.token); }
  deleteSnapshot(id: string) { return this.transport.json(this.path(`/snapshots/${encodeURIComponent(id)}`), this.token, "DELETE", undefined, false); }
  /** A new volume with this one's files (or a snapshot's); only metadata is copied. */
  fork(options: { name?: string; snapshot?: string } = {}): Promise<Volume> { return this.transport.json(this.path("/fork"), this.token, "POST", options, false); }
  changes(since = 0): Promise<VolumeChanges> { return this.transport.json(this.path(`/changes?since=${since}`), this.token); }
  list(options: { prefix?: string; glob?: string; after?: string; limit?: number } = {}): Promise<{ files: VolumeFile[]; next?: string }> {
    const query = new URLSearchParams(Object.entries(options).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    return this.transport.json(this.path(`/files${query.size ? `?${query}` : ""}`), this.token);
  }
  async write(path: string, data: string | Uint8Array, options: { version?: number } = {}): Promise<VolumeFile> {
    const body = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const headers: Record<string, string> = { "Content-Type": "application/octet-stream", ...(options.version === 0 ? { "If-None-Match": "*" } : options.version !== undefined ? { "If-Match": `"${options.version}"` } : {}) };
    return (await this.transport.raw(this.file(path), this.token, { method: "PUT", body, headers })).json();
  }
  /** A file's bytes, or `range` of them ([start, end) in bytes). */
  async read(path: string, options: { range?: [number, number?] } = {}): Promise<{ data: Uint8Array; version: number }> {
    const [start, end] = options.range ?? [];
    const response = await this.transport.raw(this.file(path), this.token, start !== undefined ? { headers: { Range: `bytes=${start}-${end !== undefined ? end - 1 : ""}` } } : {});
    return { data: new Uint8Array(await response.arrayBuffer()), version: Number(response.headers.get("etag")?.replaceAll('"', "")) };
  }
  async readText(path: string) { return new TextDecoder().decode((await this.read(path)).data); }
  async remove(path: string, options: { version?: number } = {}) {
    return (await this.transport.raw(this.file(path), this.token, { method: "DELETE", headers: options.version !== undefined ? { "If-Match": `"${options.version}"` } : {} })).json();
  }
}

export type Journal = { version: 1; cursor: number; calls: Record<string, { state: "started" | "done"; outcome?: Outcome }> };
/** Stores must resolve only once the complete snapshot is committed. Use one active client per agent. */
export interface JournalStore {
  load(sessionId: string): Promise<Journal | undefined>;
  save(sessionId: string, journal: Journal): Promise<void>;
}
export function memoryJournalStore(): JournalStore {
  const entries = new Map<string, Journal>();
  return {
    async load(id) { const value = entries.get(id); return value && structuredClone(value); },
    async save(id, journal) { entries.set(id, structuredClone(journal)); },
  };
}
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

export class AgentClient {
  readonly session: SessionCredentials;
  readonly tools: Tools;
  private readonly transport: Transport;
  private readonly store: JournalStore;
  private journal: Journal = { version: 1, cursor: 0, calls: {} };
  private loaded?: Promise<void>;
  private saving: Promise<void> = Promise.resolve();
  private readonly options: AgentOptions;
  private readonly pending = new Map<string, Pending>();
  private readonly active = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private readonly delivered = new Set<string>();
  private stream?: AbortController;
  private loop?: Promise<void>;
  private closed = false;
  private fatal?: Error;
  private ready = Promise.withResolvers<void>();

  constructor(runtime: RuntimeOptions, session: SessionCredentials, options: AgentOptions) {
    if (!/^client_[a-f0-9]{40}$/.test(session.id)) throw new AgentError("Invalid session id");
    this.session = { id: session.id, token: session.token, expiresAt: session.expiresAt };
    this.tools = { ...options.tools };
    this.options = options;
    this.transport = new Transport(runtime);
    this.store = runtime.journalStore ?? memoryJournalStore();
  }

  private async load() {
    const journal = await this.store.load(this.session.id);
    if (!journal) return;
    if (journal.version !== 1 || !Number.isSafeInteger(journal.cursor) || journal.cursor < 0 || !journal.calls || typeof journal.calls !== "object") throw new AgentError("Unsupported client journal");
    this.journal = structuredClone(journal);
  }
  private save() {
    const snapshot = structuredClone(this.journal);
    // Serialize commits so concurrent tool completions cannot overwrite newer receipts.
    this.saving = this.saving.then(() => this.store.save(this.session.id, snapshot));
    return this.saving;
  }
  private path(suffix = "") { return `/clients/${this.session.id}${suffix}`; }
  private http(suffix: string, method = "GET", body?: unknown, retry = true) { return this.transport.json(this.path(suffix), this.session.token, method, body, retry); }
  private report(error: unknown) { this.options.onError?.(error instanceof Error ? error : new Error(String(error))); }

  async connect() {
    if (this.closed) throw new AgentError("Client closed");
    await (this.loaded ??= this.load());
    this.loop ??= this.events();
    await Promise.race([this.ready.promise, new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new AgentError("Timed out connecting to agent")), 10_000);
      this.ready.promise.finally(() => clearTimeout(timer)).catch(() => {});
    })]);
  }

  private async events() {
    let backoff = 250;
    while (!this.closed) {
      this.stream = new AbortController();
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const touch = () => { clearTimeout(watchdog); watchdog = setTimeout(() => this.stream?.abort(), 20_000); };
      touch();
      try {
        const response = await this.transport.fetcher(this.transport.base + this.path("/events"), {
          headers: { Authorization: `Bearer ${this.session.token}`, Accept: "text/event-stream", "Last-Event-ID": String(this.journal.cursor) },
          signal: this.stream.signal, redirect: "manual",
        });
        await rejectRedirect(response);
        if (response.status === 409) {
          await response.body?.cancel();
          const snapshot = await this.sync();
          this.journal.cursor = snapshot.cursor; await this.save();
          await this.options.onEvent?.({ type: "replay_gap", cursor: snapshot.cursor });
          continue;
        }
        if (!response.ok) { await response.body?.cancel(); throw new AgentError(`Event stream HTTP ${response.status}`, response.status); }
        if (!response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) throw new AgentError("Expected an SSE response");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          while (!this.closed) {
            const { value, done } = await reader.read();
            if (done) break;
            touch();
            buffer += decoder.decode(value, { stream: true });
            let end: number;
            while ((end = buffer.indexOf("\n\n")) !== -1) {
              const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              if (byteLength(frame) > FRAME_BYTES) throw new AgentError("SSE frame too large");
              const lines = frame.split("\n");
              const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
              if (!data) continue;
              if (lines.includes("event: ready")) {
                await this.sync();
                backoff = 250; this.ready.resolve(); this.options.onConnection?.(true);
                continue;
              }
              const id = Number(lines.find(line => line.startsWith("id:"))?.slice(3));
              if (!Number.isSafeInteger(id) || id <= 0) throw new AgentError("Invalid SSE cursor");
              if (id <= this.journal.cursor) continue;
              const event = JSON.parse(data) as ClientEvent;
              await this.receive(event);
              this.journal.cursor = id;
              // Display events are replayable only from the host's memory; persisting the
              // cursor for each one would cost a storage write per streamed token.
              if (event.type !== "event") await this.save();
            }
            if (byteLength(buffer) > FRAME_BYTES) throw new AgentError("SSE frame too large");
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } catch (error) {
        if (this.closed) break;
        if (error instanceof AgentError && ([401, 403, 410].includes(error.status) || (error.status >= 300 && error.status < 400))) {
          this.fatal = error; this.ready.reject(error);
          for (const waiter of this.pending.values()) waiter.reject(error);
          this.pending.clear(); this.report(error); break;
        }
        this.report(error);
      } finally { clearTimeout(watchdog); this.options.onConnection?.(false); }
      if (!this.closed) { await pause(backoff); backoff = Math.min(5000, backoff * 2); }
    }
  }

  /** Rename/regroup this agent without changing its conversation or tools. */
  async setMetadata(metadata: { name: string; type: string }) {
    return this.transport.json(this.path('/metadata'), this.session.token, 'POST', metadata);
  }

  private async receive(event: ClientEvent) {
    if (event.type === "tool_call") this.dispatch(event.call);
    else if (event.type === "tool_cancel") this.active.get(event.id)?.controller.abort();
    else if (event.type === "response") this.settle(event.id, event.outcome);
    else if (event.type === "event") await this.options.onEvent?.(event.event, event.requestId);
  }
  private settle(id: string, value: Outcome) {
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    if ("error" in value) waiter.reject(new AgentError(value.error ?? "Unknown failure", 0, id)); else waiter.resolve(value.result);
  }

  private async sync(): Promise<SessionState> {
    const state = await this.outcomes();
    for (const request of state.requests) if (request.outcome) this.settle(request.id, request.outcome);
    for (const call of state.calls) this.dispatch(call);
    return state;
  }

  private dispatch(call: CallRecord) {
    if (this.closed || this.active.has(call.id) || this.delivered.has(call.id) || ["completed", "cancelled"].includes(call.state)) return;
    const controller = new AbortController();
    // Defer execution until the active entry exists; replay can arrive immediately.
    const task = Promise.resolve().then(() => this.runTool(call, controller)).catch(error => this.report(error)).finally(() => this.active.delete(call.id));
    this.active.set(call.id, { controller, task });
  }

  private async runTool(call: CallRecord, controller: AbortController) {
    let receipt = this.journal.calls[call.id];
    if (receipt?.state === "done") {
      await this.http(`/calls/${call.id}/outcome`, "POST", receipt.outcome);
      this.delivered.add(call.id); return;
    }
    if (call.state === "uncertain") return; // Already settled as unknown; never execute again.
    let value: Outcome;
    if (call.state === "started") value = { error: "The application lost this tool call's outcome; it may or may not have taken effect", uncertain: true };
    else {
      this.journal.calls[call.id] = { state: "started" }; await this.save();
      try {
        // Claim is deliberately NOT retried. A lost acknowledgement is ambiguous.
        const claim = await this.http(`/calls/${call.id}/claim`, "POST", {}, false);
        if (!claim.execute) {
          if (claim.call.state !== "started") return;
          value = { error: "Tool execution was already claimed; outcome unknown", uncertain: true };
        } else {
          const timer = setTimeout(() => controller.abort(), Math.max(1, call.deadline - Date.now()));
          // A callback that ignores cancellation must not keep a closed client's process alive until the deadline.
          (timer as { unref?: () => void }).unref?.();
          try {
            const definition = this.tools[call.name];
            if (!Object.hasOwn(this.tools, call.name) || !Check(definition.input, call.args)) throw new Error("Tool is missing or arguments failed validation");
            controller.signal.throwIfAborted();
            const result = await definition.execute(call.args, { callId: call.id, toolCallId: call.toolCallId, signal: controller.signal, ...(call.origin ? { origin: call.origin } : {}) });
            if (result === undefined || byteLength(JSON.stringify(result)) > 1024 * 1024) throw new Error("Tool must return a bounded JSON value");
            value = { result };
          } catch (error) { value = { error: String(error).slice(0, 2048), ...(controller.signal.aborted ? { uncertain: true } : {}) }; }
          finally { clearTimeout(timer); }
        }
      } catch (error) { value = { error: `Execution claim failed: ${String(error).slice(0, 1800)}`, uncertain: true }; }
    }
    // Persist before POST; reconnect resends this receipt, never the side effect.
    receipt = { state: "done", outcome: value };
    this.journal.calls[call.id] = receipt; await this.save();
    await this.http(`/calls/${call.id}/outcome`, "POST", value);
    this.delivered.add(call.id);
  }

  async request(method: RequestMethod, params: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<any> {
    if (this.closed || this.fatal) throw this.fatal ?? new AgentError("Client closed");
    if (this.pending.size >= 8) throw new AgentError("Too many outstanding requests");
    const id = options.idempotencyKey ?? globalThis.crypto.randomUUID();
    if (this.pending.has(id)) throw new AgentError("Request already pending", 409, id);
    const deferred = Promise.withResolvers<any>();
    // Attach immediately, even while the POST is pending, to avoid unhandled errors.
    deferred.promise.catch(() => {});
    this.pending.set(id, deferred);
    const timer = setTimeout(() => {
      this.pending.delete(id);
      deferred.reject(new AgentError("Request timed out; inspect requestStatus() or reuse the same idempotencyKey", 0, id));
    }, options.timeoutMs ?? 180_000);
    try {
      const record = await this.http("/requests", "POST", { id, method, params });
      if (record.outcome) this.settle(id, record.outcome);
      return await deferred.promise;
    } catch (error) {
      if (error instanceof AgentError) { error.requestId ??= id; throw error; }
      throw new AgentError(String(error), 0, id);
    } finally { clearTimeout(timer); this.pending.delete(id); }
  }

  /** Observe an already accepted request. This never submits or re-executes work. */
  async waitForRequest(id: string, options: { timeoutMs?: number } = {}): Promise<any> {
    if (this.closed || this.fatal) throw this.fatal ?? new AgentError("Client closed");
    if (this.pending.has(id)) throw new AgentError("Request already pending", 409, id);
    const deferred = Promise.withResolvers<any>();
    deferred.promise.catch(() => {});
    this.pending.set(id, deferred);
    const timer = setTimeout(() => {
      deferred.reject(new AgentError("Request observation timed out; the request may still be running", 0, id));
    }, options.timeoutMs ?? 180_000);
    try {
      const record = await this.requestStatus(id);
      if (record.outcome) this.settle(id, record.outcome);
      return await deferred.promise;
    } finally { clearTimeout(timer); this.pending.delete(id); }
  }

  prompt(text: string, options?: RequestOptions & { images?: ImageContent[] }) { return this.request("prompt", { text, ...(options?.images ? { images: options.images } : {}) }, options); }
  history(): Promise<AgentHistory> { return this.http("/history"); }
  continue(options?: RequestOptions) { return this.request("continue", {}, options); }
  steer(text: string) { return this.request("steer", { text }); }
  followUp(text: string) { return this.request("followUp", { text }); }
  /** Change the prompt, thinking level, tools, or model ("provider/model-id") between runs. */
  async configure(options: { systemPrompt?: string; thinkingLevel?: ThinkingLevel; tools?: Tools; model?: string }) {
    const result = await this.request("configure", { ...options, ...(options.tools ? { tools: definitions(options.tools) } : {}) });
    if (options.tools) {
      for (const key of Object.keys(this.tools)) delete this.tools[key];
      Object.assign(this.tools, options.tools);
    }
    return result;
  }
  execute(code: string, options?: RequestOptions & { timeoutMs?: number; executionTimeoutMs?: number }) {
    return this.request("execute", { code, ...(options?.executionTimeoutMs ? { timeoutMs: options.executionTimeoutMs } : {}) }, options);
  }
  /**
   * Wake this agent later: with `text` it gets a prompt, with `code` it runs sandboxed
   * code against your tools. `everySeconds` (at least 60) repeats it.
   */
  schedule(input: { text?: string; code?: string; at?: string | Date; inSeconds?: number; everySeconds?: number }): Promise<Schedule> {
    return this.http("/schedules", "POST", { ...input, ...(input.at instanceof Date ? { at: input.at.toISOString() } : {}) }, false);
  }
  schedules(): Promise<Schedule[]> { return this.http("/schedules"); }
  unschedule(id: string) { return this.http(`/schedules/${encodeURIComponent(id)}`, "DELETE", undefined, false); }
  status() { return this.request("status"); }
  abort() { return this.request("abort"); }
  requestStatus(id: string) { return this.http(`/requests/${encodeURIComponent(id)}`); }
  outcomes(): Promise<SessionState> { return this.http("/state"); }

  async close() {
    this.closed = true; this.stream?.abort();
    for (const { controller } of this.active.values()) controller.abort();
    for (const [id, waiter] of this.pending) waiter.reject(new AgentError("Client closed; request may still be running", 0, id));
    this.pending.clear();
    await this.loop;
    // User callbacks must cooperate with cancellation. Do not hang shutdown on one.
  }
  async destroy() { try { await this.http("", "DELETE"); } finally { await this.close(); } }
  async [Symbol.asyncDispose]() { await this.close(); }
}
