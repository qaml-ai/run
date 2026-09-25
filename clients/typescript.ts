import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { Type, type TSchema, type Static } from "typebox";
import { Check } from "typebox/value";
import { FRAME_BYTES, type ClientEvent, type Outcome, type RequestMethod, type SessionCredentials, type SessionState } from "../shared/client-protocol.ts";
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
/** A tool as an MCP server lists it (`tools/list`). Runtime options ride in `_meta` under "agent-runtime/". */
export interface McpTool { name: string; title?: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown>; _meta?: Record<string, unknown> }
/** An MCP `tools/call` result. */
export interface CallToolResult { content: Array<Record<string, unknown>>; structuredContent?: Record<string, unknown>; isError?: boolean }
/**
 * The MCP server an application attaches to its agent: the SDK relays the runtime's
 * `tools/list` and `tools/call` to it over the agent's connection. Throw from `callTool`
 * only when the call could not be answered; a tool's own failure is an `isError` result.
 */
export interface ToolServer {
  listTools(): McpTool[] | Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>, context: ToolContext): Promise<CallToolResult>;
}
const META = "agent-runtime/";
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** `tool({...})` definitions as an attached MCP server: JSON results become a text block (and structured content for objects). */
export function toolServer(tools: Tools): ToolServer {
  return {
    listTools: () => Object.entries(tools).map(([name, tool]) => ({
      name, description: tool.description, inputSchema: tool.input,
      ...(tool.exposure || tool.executionMode ? { _meta: { ...(tool.exposure ? { [`${META}exposure`]: tool.exposure } : {}), ...(tool.executionMode ? { [`${META}executionMode`]: tool.executionMode } : {}) } } : {}),
    })),
    async callTool(name, args, context) {
      const definition = tools[name];
      if (!Object.hasOwn(tools, name) || !Check(definition.input, args)) throw new Error("Tool is missing or arguments failed validation");
      context.signal.throwIfAborted();
      let result: unknown;
      try { result = await definition.execute(args, context); }
      catch (error) {
        if (context.signal.aborted) throw error;
        return { content: [{ type: "text", text: String(error).slice(0, 2048) }], isError: true };
      }
      if (result === undefined || byteLength(JSON.stringify(result)) > 1024 * 1024) throw new Error("Tool must return a bounded JSON value");
      if (definition.resultFormat === "content") return result as CallToolResult;
      return { content: [{ type: "text", text: JSON.stringify(result) }], ...(isRecord(result) ? { structuredContent: result } : {}) };
    },
  };
}
export interface RuntimeOptions {
  url?: string;
  apiKey?: string;
  /** Persist tool receipts and event cursors before acknowledging work. Default: memory only. */
  journalStore?: JournalStore;
  /** Injectable for tests, observability, or an application's HTTP stack. */
  fetch?: typeof globalThis.fetch;
}
export interface AgentOptions {
  /** The application's tools, served to the agent as an attached MCP server. */
  tools?: Tools;
  /** Or an MCP server of the application's own (see `clients/mcp.ts` for MCP SDK servers). */
  mcp?: ToolServer;
  onEvent?: (event: any, requestId?: string) => unknown | Promise<unknown>;
  onConnection?: (connected: boolean) => void;
  onError?: (error: Error) => void;
}
export type { ThinkingLevel };
export interface CreateAgentOptions extends AgentOptions {
  idempotencyKey?: string;
  /**
   * Make the agent from a definition (GET /v1/definitions): it supplies the model, system
   * prompt, thinking level and tool sources, so leave those out. `tools` (or `mcp`) are added
   * as the agent's attached server.
   */
  definition?: string;
  /** Agent lifetime in seconds (60 to 366 days), or null to keep the agent until it is deleted. Default one day. */
  ttlSeconds?: number | null;
  /** Who the agent acts for (a user id in your app): `sub` in the identity tokens its tool servers get. Set only at creation. */
  subject?: string;
  /** Claims your tool servers need (org, workspace, thread…): `ctx` in its identity tokens. Set only at creation. */
  context?: Record<string, unknown>;
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
/** How a tool source is authenticated: a stored bearer token, or identity tokens the runtime signs for each request. */
export type SourceAuth = { type: "bearer"; token: string } | { type: "runtime" };
/** Options every tool source takes. `exposure` defaults to both for a source of up to 10 tools, else codemode. */
interface SourceOptions { name: string; headers?: Record<string, string>; auth?: SourceAuth; audience?: string; allowTools?: string[]; denyTools?: string[]; exposure?: "direct" | "codemode" | "both"; timeoutMs?: number }
export interface DefinitionInput {
  name: string; model?: string; systemPrompt?: string; thinkingLevel?: ThinkingLevel;
  limits?: { ttlSeconds?: number | null }; mounts?: unknown[]; builtins?: ("web_fetch" | "schedule")[];
  mcpServers?: (SourceOptions & { url: string })[];
  openApi?: (SourceOptions & { spec?: string | Record<string, unknown>; baseUrl?: string })[];
}
/** A definition as the runtime returns it: credentials are never included. */
export interface Definition extends Omit<DefinitionInput, "mcpServers" | "openApi"> {
  id: string; revision: number; createdAt: number; updatedAt: number;
  mcpServers?: Record<string, unknown>[]; openApi?: Record<string, unknown>[];
  applied?: { accepted: string[]; failed: { agent: string; error: string }[] };
}
/** One source of an agent's tools; `excluded` says why the model does not get a tool, when it does not. */
export interface ToolSource {
  kind: "channel" | "application" | "files" | "builtin" | "mcp" | "openapi"; name: string;
  /** unlisted: an MCP server the runtime has not listed yet; error: listing it failed. */
  status: "listed" | "unlisted" | "error"; error?: string; listedAt?: number; connected?: boolean; url?: string;
  exposure?: "direct" | "codemode" | "both";
  tools: { name: string; description: string; exposure?: "direct" | "codemode" | "both"; executionMode?: "sequential" | "parallel"; parameters?: Record<string, unknown>; excluded?: string }[];
}
export interface Mount { volumeId: string; path: string; mode: "ro" | "rw"; subpath?: string; notify?: boolean }
export interface Volume { id: string; name: string; createdAt: number; seq?: number; files?: number; bytes?: number; origin?: { volume: string; snapshot?: string; seq: number } }
export interface VolumeFile { path: string; version: number; size: number; updatedAt: number; by?: string }
export interface VolumeSnapshot { id: string; volume: string; name: string; seq: number; createdAt: number; files: number; bytes: number }
export interface VolumeChanges { seq: number; changes: { seq: number; path: string; kind: "write" | "delete"; version?: number; size?: number; by?: string; at: number }[]; gap?: boolean }
export interface AgentHistory { messages: AgentMessage[] }
export interface Schedule { id: string; agent: string; text?: string; code?: string; dueAt: number; everySeconds?: number; createdAt: number }
export interface RequestOptions { idempotencyKey?: string; timeoutMs?: number }
/** Who sent a message: `id` is yours and the model may rely on it; the names are the sender's own. */
export interface Sender { id: string; name?: string; username?: string }
export class AgentError extends Error {
  status: number;
  requestId?: string;
  /** Milliseconds the runtime asked to wait before retrying (its Retry-After), for 429 and 503. */
  retryAfterMs?: number;
  constructor(message: string, status = 0, requestId?: string) { super(message); this.name = "AgentError"; this.status = status; this.requestId = requestId; }
}
/** Retry-After as milliseconds (seconds or an HTTP date), capped so a bad value cannot stall a caller. */
function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null) return undefined;
  const ms = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.min(Math.max(0, ms), 60_000) : undefined;
}
/** A 429 (quota, or an agent's queue is full) was refused before anything happened, so any request may be retried after it. */
const RATE_LIMIT_ATTEMPTS = 8;
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
        const value = await (response.ok ? response.json() : response.json().catch(() => ({}))) as any;
        if (!response.ok) throw Object.assign(new AgentError(value.error ?? `HTTP ${response.status}`, response.status), { retryAfterMs: retryAfter(response) });
        return value;
      } catch (error) {
        const limited = error instanceof AgentError && error.status === 429;
        if (limited ? attempt >= RATE_LIMIT_ATTEMPTS - 1 : !retry || attempt >= 3 || (error instanceof AgentError && error.status < 500)) throw error;
        // Honour the runtime's Retry-After, with jitter so refused callers do not return together; else back off exponentially.
        const backoff = Math.min(10_000, (limited ? 500 : 100) * 2 ** attempt);
        const hinted = error instanceof AgentError ? error.retryAfterMs : undefined;
        await pause(hinted !== undefined ? hinted + Math.random() * Math.min(1000, backoff) : backoff);
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
    const server = options.mcp ?? toolServer(options.tools ?? {});
    const session = await this.transport.json("/client-sessions", key, "POST", { mcp: { tools: await server.listTools() }, ...(options.subject !== undefined ? { subject: options.subject } : {}), ...(options.context !== undefined ? { context: options.context } : {}), ...(options.definition !== undefined ? { definition: options.definition } : {}), ...(options.mounts !== undefined ? { mounts: options.mounts } : {}), ...(options.model !== undefined ? { model: options.model } : {}), ...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}), ...(options.initialMessages !== undefined ? { initialMessages: options.initialMessages } : {}), ...(options.name !== undefined ? { name: options.name } : {}), ...(options.type !== undefined ? { type: options.type } : {}), ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}), ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}) }, true,
      { "Idempotency-Key": options.idempotencyKey ?? globalThis.crypto.randomUUID() });
    return this.connectAgent(session, options);
  }
  async connectAgent(session: SessionCredentials, options: AgentOptions): Promise<AgentClient> {
    const client = new AgentClient(this.options, session, options);
    try { await client.connect(); return client; }
    catch (error) { await client.close(); throw error; }
  }
  private operator() {
    if (!this.options.apiKey) throw new AgentError("Set apiKey to manage definitions, volumes and mounts");
    return this.options.apiKey;
  }
  createVolume(options: { name?: string } = {}): Promise<Volume> { return this.transport.json("/v1/volumes", this.operator(), "POST", options, false); }
  listVolumes(): Promise<Volume[]> { return this.transport.json("/v1/volumes", this.operator()); }
  /** A handle on one volume's files, snapshots and forks. */
  volume(id: string): VolumeHandle {
    if (!/^vol_[a-f0-9]{24}$/.test(id)) throw new AgentError("Invalid volume id");
    return new VolumeHandle(this.transport, this.operator(), id);
  }
  /**
   * Definitions: reusable agent configurations with their tool sources (MCP servers, OpenAPI
   * specs, built-ins). Make agents from one with `createAgent({ definition: id })`.
   */
  createDefinition(input: DefinitionInput): Promise<Definition> { return this.transport.json("/v1/definitions", this.operator(), "POST", input, false); }
  /** Replace the fields given (null removes one); `apply: "all"` also reconfigures its live agents between their turns. */
  updateDefinition(id: string, input: Partial<DefinitionInput> & { revision?: number; apply?: "all" }): Promise<Definition> { return this.transport.json(`/v1/definitions/${encodeURIComponent(id)}`, this.operator(), "PATCH", input, false); }
  definition(id: string): Promise<Definition> { return this.transport.json(`/v1/definitions/${encodeURIComponent(id)}`, this.operator()); }
  definitions(): Promise<Definition[]> { return this.transport.json("/v1/definitions", this.operator()); }
  deleteDefinition(id: string): Promise<{ deleted: boolean }> { return this.transport.json(`/v1/definitions/${encodeURIComponent(id)}`, this.operator(), "DELETE", undefined, false); }
  mounts(agentId: string): Promise<Mount[]> { return this.transport.json(`/v1/agents/${encodeURIComponent(agentId)}/mounts`, this.operator()); }
  /** Replace an agent's mounts; an idle agent restarts so its tools describe them. */
  setMounts(agentId: string, mounts: Mount[]): Promise<Mount[]> { return this.transport.json(`/v1/agents/${encodeURIComponent(agentId)}/mounts`, this.operator(), "PUT", { mounts }, false); }
  /**
   * Every source of an agent's tools (its application, file tools, built-ins, MCP servers, OpenAPI
   * specs) and what each offers the model. `schemas` includes input schemas; `refresh` lists MCP servers now.
   */
  async toolSources(agentId: string, options: { schemas?: boolean; refresh?: boolean } = {}): Promise<ToolSource[]> {
    const query = [options.schemas && "schemas=true", options.refresh && "refresh=true"].filter(Boolean).join("&");
    return (await this.transport.json(`/v1/agents/${encodeURIComponent(agentId)}${query ? `?${query}` : ""}`, this.operator())).toolSources;
  }
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

/** The client's event cursor, saved so a restarted client resumes where it was. */
export type Journal = { version: 1; cursor: number };
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
  private server: ToolServer;
  private readonly transport: Transport;
  private readonly store: JournalStore;
  private journal: Journal = { version: 1, cursor: 0 };
  private loaded?: Promise<void>;
  private saving: Promise<void> = Promise.resolve();
  private readonly options: AgentOptions;
  private readonly pending = new Map<string, Pending>();
  /** Tool calls running, by JSON-RPC id, so the runtime can cancel them. */
  private readonly active = new Map<string, AbortController>();
  /** The event stream's connection, named in the MCP messages this client sends back. */
  private connection?: string;
  private stream?: AbortController;
  private loop?: Promise<void>;
  private closed = false;
  private fatal?: Error;
  private ready = Promise.withResolvers<void>();

  constructor(runtime: RuntimeOptions, session: SessionCredentials, options: AgentOptions) {
    if (!/^client_[a-f0-9]{40}$/.test(session.id)) throw new AgentError("Invalid session id");
    this.session = { id: session.id, token: session.token, expiresAt: session.expiresAt };
    this.tools = { ...options.tools };
    this.server = options.mcp ?? toolServer(this.tools);
    this.options = options;
    this.transport = new Transport(runtime);
    this.store = runtime.journalStore ?? memoryJournalStore();
  }

  private async load() {
    const journal = await this.store.load(this.session.id);
    if (!journal) return;
    if (journal.version !== 1 || !Number.isSafeInteger(journal.cursor) || journal.cursor < 0) throw new AgentError("Unsupported client journal");
    this.journal = { version: 1, cursor: journal.cursor };
  }
  private save() {
    const snapshot = structuredClone(this.journal);
    // Serialize commits so an older cursor never overwrites a newer one.
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
                this.connection = (JSON.parse(data) as { connection?: string }).connection;
                await this.sync();
                backoff = 250; this.ready.resolve(); this.options.onConnection?.(true);
                continue;
              }
              const idLine = lines.find(line => line.startsWith("id:"));
              // The runtime's MCP messages are live only: no id, never replayed, no cursor.
              if (!idLine) {
                const event = JSON.parse(data) as ClientEvent;
                if (event.type === "mcp") void this.mcp(event.message).catch(error => this.report(error));
                continue;
              }
              const id = Number(idLine.slice(3));
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
    if (event.type === "response") this.settle(event.id, event.outcome);
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
    return state;
  }

  /**
   * Answer the runtime's JSON-RPC messages as the agent's attached MCP server: initialize,
   * ping, tools/list and tools/call, and cancellation. The runtime runs a call once; a call
   * whose answer is lost with the connection ends for the agent as "outcome unknown".
   */
  private async mcp(message: Record<string, any>) {
    if (typeof message.method !== "string") return;
    if (message.id === undefined) {
      if (message.method === "notifications/cancelled") this.active.get(String(message.params?.requestId))?.abort();
      return;
    }
    const connection = this.connection;
    const reply = (answer: { result: unknown } | { error: { code: number; message: string } }) =>
      this.transport.json(this.path("/mcp"), this.session.token, "POST", { jsonrpc: "2.0", id: message.id, ...answer }, true, { "X-Agent-Connection": connection ?? "" });
    const params = message.params ?? {};
    if (message.method === "initialize") return reply({ result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "agent-runtime-sdk", version: "1.0.0" } } });
    if (message.method === "ping") return reply({ result: {} });
    if (message.method === "tools/list") return reply({ result: { tools: await this.server.listTools() } });
    if (message.method !== "tools/call") return reply({ error: { code: -32601, message: `Unknown method ${message.method}` } });
    const controller = new AbortController();
    const key = String(message.id);
    this.active.set(key, controller);
    const meta = params._meta ?? {};
    try {
      const result = await this.server.callTool(params.name, params.arguments ?? {}, {
        callId: meta["agent-runtime/callId"] ?? key, signal: controller.signal,
        ...(meta["agent-runtime/toolCallId"] ? { toolCallId: meta["agent-runtime/toolCallId"] } : {}), ...(meta["agent-runtime/origin"] ? { origin: meta["agent-runtime/origin"] } : {}),
      });
      if (!isRecord(result) || !Array.isArray(result.content) || byteLength(JSON.stringify(result)) > 1024 * 1024) throw new Error("The MCP server must answer with a bounded CallToolResult");
      await reply({ result });
    } catch (error) {
      await reply({ error: { code: -32603, message: String(error).slice(0, 2048) } });
    } finally { this.active.delete(key); }
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

  /**
   * `from` says who sent the message: the model sees it in a block only the runtime can write, and
   * `from.id` is the turn's actor. `actor` names someone else acting (`act` in identity tokens) without telling the model.
   */
  prompt(text: string, options?: RequestOptions & { images?: ImageContent[]; actor?: string; from?: Sender }) {
    return this.request("prompt", { text, ...(options?.images ? { images: options.images } : {}), ...(options?.actor ? { actor: options.actor } : {}), ...(options?.from ? { from: options.from } : {}) }, options);
  }
  history(): Promise<AgentHistory> { return this.http("/history"); }
  continue(options?: RequestOptions & { actor?: string }) { return this.request("continue", options?.actor ? { actor: options.actor } : {}, options); }
  steer(text: string, options?: { from?: Sender }) { return this.request("steer", { text, ...(options?.from ? { from: options.from } : {}) }); }
  followUp(text: string, options?: { from?: Sender }) { return this.request("followUp", { text, ...(options?.from ? { from: options.from } : {}) }); }
  /** Change the prompt, thinking level, tools, or model ("provider/model-id") between runs. */
  async configure(options: { systemPrompt?: string; thinkingLevel?: ThinkingLevel; tools?: Tools; mcp?: ToolServer; model?: string }) {
    const { tools, mcp, ...rest } = options;
    const server = mcp ?? (tools ? toolServer(tools) : undefined);
    const result = await this.request("configure", { ...rest, ...(server ? { mcp: { tools: await server.listTools() } } : {}) });
    if (tools) {
      for (const key of Object.keys(this.tools)) delete this.tools[key];
      Object.assign(this.tools, tools);
    }
    if (server) this.server = mcp ?? toolServer(this.tools);
    return result;
  }
  execute(code: string, options?: RequestOptions & { timeoutMs?: number; executionTimeoutMs?: number; actor?: string }) {
    return this.request("execute", { code, ...(options?.executionTimeoutMs ? { timeoutMs: options.executionTimeoutMs } : {}), ...(options?.actor ? { actor: options.actor } : {}) }, options);
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
    for (const controller of this.active.values()) controller.abort();
    for (const [id, waiter] of this.pending) waiter.reject(new AgentError("Client closed; request may still be running", 0, id));
    this.pending.clear();
    await this.loop;
    // User callbacks must cooperate with cancellation. Do not hang shutdown on one.
  }
  async destroy() { try { await this.http("", "DELETE"); } finally { await this.close(); } }
  async [Symbol.asyncDispose]() { await this.close(); }
}
