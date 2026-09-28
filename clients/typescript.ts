import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import { Type, type TSchema, type Static } from "typebox";
import { Check } from "typebox/value";
import { FRAME_BYTES, type ClientEvent, type Outcome, type RequestMethod, type SessionCredentials, type SessionState } from "../shared/client-protocol.ts";
export { Type as schema };
export type { SessionCredentials, SessionState };

/**
 * Who a tool call is for, as the runtime says: from its signed identity token when the tools are
 * served over HTTP (`serveTools`), or from the call itself when they are attached to the agent.
 * Authorize as `user`, within `tenant` and `context`.
 */
export interface RuntimeIdentity {
  /** Who is acting: the turn's actor (a prompt's `actor`, or its `from.id`), else the agent's subject. */
  user: string;
  /** Whom the agent acts for, as its creator set it (`createAgent({ subject })`); the agent's id if none. */
  subject: string;
  /** Who is acting in this turn, if the prompt named someone. */
  actor?: string;
  /** The runtime tenant that owns the agent. */
  tenant: string;
  agent: string;
  definition?: string;
  /** Claims the agent's creator attached (`createAgent({ context })`), e.g. `{ org, workspace }`. */
  context: Record<string, unknown>;
  /** Where the turn came from, e.g. `{ channel, conversationId, sender }` for a channel message. */
  origin?: Record<string, unknown>;
  /** The call was approved by a person: which input, who (their ids), and when. */
  approval?: { input: string; by: Record<string, unknown>; at: number };
}
/** A runtime identity from its claims (a verified token's payload, or an attached call's `_meta`). */
export function identityFromClaims(claims: Record<string, any>): RuntimeIdentity {
  const text = (value: unknown) => typeof value === "string" && value ? value : undefined;
  const agent = text(claims.agent) ?? "";
  const subject = text(claims.sub) ?? agent;
  const actor = text(claims.act);
  return {
    user: actor ?? subject, subject, ...(actor ? { actor } : {}), tenant: text(claims.tenant) ?? "", agent,
    ...(text(claims.definition) ? { definition: claims.definition } : {}),
    context: isRecord(claims.ctx) ? claims.ctx : {}, ...(isRecord(claims.origin) ? { origin: claims.origin } : {}),
    ...(isRecord(claims.approval) ? { approval: claims.approval as RuntimeIdentity["approval"] & object } : {}),
  };
}
export interface ToolContext {
  signal: AbortSignal; callId: string; toolCallId?: string;
  /** Set by the runtime, e.g. `{ channel, conversationId, sender }` for a turn a channel message started. */
  origin?: Record<string, unknown>;
  /** Who the call is for: always set by `serveTools`; set for attached tools by runtimes that send it. */
  identity?: RuntimeIdentity;
  /**
   * Ask the user, and get their answer. The call ends here and the agent's turn waits, for days if need
   * be; once they answer, the runtime calls the tool again with the same arguments, and this returns
   * the answer. So everything before an ask runs again on that call: ask first, act after.
   * `confirm`: whether they said yes. `ask`: what they filled in (a flat object schema), or undefined
   * if they declined. `requireUrl`: whether they say they have done what the https page asks.
   */
  confirm(message: string): Promise<boolean>;
  ask<T extends Record<string, unknown> = Record<string, unknown>>(message: string, schema: Record<string, unknown>): Promise<T | undefined>;
  requireUrl(url: string, message: string): Promise<boolean>;
}
/** Thrown by a ToolContext's asks: the call answers MCP's `input_required`, and runs again once the user answers. */
export class InputRequired extends Error {
  readonly inputRequests: Record<string, { method: string; params: Record<string, unknown> }>;
  /** The answers so far, which the runtime hands back on the next call (MCP's `requestState`). */
  readonly requestState?: string;
  constructor(inputRequests: InputRequired["inputRequests"], requestState?: string) {
    super("Waiting for the user's input");
    this.name = "InputRequired";
    this.inputRequests = inputRequests;
    if (requestState) this.requestState = requestState;
  }
}
export interface Tool<T = any> {
  description: string;
  resultFormat?: "json" | "content";
  exposure?: "direct" | "codemode" | "both";
  executionMode?: "sequential" | "parallel";
  input: Record<string, unknown>;
  execute: (args: T, context: ToolContext) => unknown | Promise<unknown>;
  /**
   * Ask the user to approve each call before it runs (or only the calls this says need it). The runtime
   * shows them the real call; the tool is declared to the model directly, as code cannot wait for a person.
   */
  needsApproval?: boolean | ((args: T, context: ToolContext) => boolean | Promise<boolean>);
}
/** Infer callback arguments from the schema; no manually duplicated argument type. */
export function tool<S extends TSchema>(definition: Omit<Tool<Static<S>>, "input"> & { input: S }): Tool<Static<S>> {
  return { ...definition, input: definition.input as unknown as Record<string, unknown> };
}
export type Tools = Record<string, Tool>;
/** A tool as an MCP server lists it (`tools/list`). Runtime options ride in `_meta` under "agent-runtime/". */
export interface McpTool { name: string; title?: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown>; _metadata?: Record<string, string> }
/** An MCP `tools/call` result: complete, or (MCP's multi round-trip requests) asking for input to retry with. */
export type CallToolResult = { content: Array<Record<string, unknown>>; structuredContent?: Record<string, unknown>; isError?: boolean; resultType?: "complete" }
  | { resultType: "input_required"; inputRequests?: Record<string, { method: string; params?: Record<string, unknown> }>; requestState?: string; content?: never };
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
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

/**
 * A call's context from its params: ids, origin, and the identity the runtime sent in `_meta` (or
 * `identity`, from a verified token); its asks answer from the retry's `inputResponses`, by position.
 */
export function toolContext(params: Record<string, any>, fallbackId: string, signal: AbortSignal, identity?: RuntimeIdentity): ToolContext {
  const meta: Record<string, any> = isRecord(params._meta) ? params._meta : {};
  const sent = isRecord(meta[`${META}identity`]) ? identityFromClaims(meta[`${META}identity`]) : undefined;
  const who = identity ?? sent;
  const origin = isRecord(meta[`${META}origin`]) ? meta[`${META}origin`] : who?.origin;
  // Each round answers only its own ask: earlier answers come back in the state this call handed out.
  let earlier: Record<string, unknown> = {};
  try { earlier = typeof params.requestState === "string" ? JSON.parse(atob(params.requestState)) : {}; } catch { /* not ours: start over */ }
  const responses: Record<string, unknown> = { ...isRecord(earlier) ? earlier : {}, ...isRecord(params.inputResponses) ? params.inputResponses : {} };
  let asked = 0;
  const request = async (input: Record<string, unknown>): Promise<{ action?: string; content?: any }> => {
    const key = `input_${++asked}`;
    if (isRecord(responses[key])) return responses[key];
    throw new InputRequired({ [key]: { method: "elicitation/create", params: input } }, Object.keys(responses).length ? btoa(JSON.stringify(responses)) : undefined);
  };
  return {
    callId: typeof meta[`${META}callId`] === "string" ? meta[`${META}callId`] : fallbackId, signal,
    ...(typeof meta[`${META}toolCallId`] === "string" ? { toolCallId: meta[`${META}toolCallId`] } : {}),
    ...(origin ? { origin } : {}), ...(who ? { identity: who } : {}),
    confirm: async message => (await request({ mode: "form", message, requestedSchema: { type: "object", properties: {} } })).action === "accept",
    ask: async (message, schema) => { const answer = await request({ mode: "form", message, requestedSchema: schema }); return answer.action === "accept" ? answer.content : undefined; },
    requireUrl: async (url, message) => (await request({ mode: "url", message, url, elicitationId: `${fallbackId}-${asked + 1}` })).action === "accept",
  };
}

/**
 * Answer one MCP JSON-RPC request as a tool server: initialize, ping, tools/list and tools/call.
 * Both an attached server (answering over the agent's connection) and `serveTools` (over HTTP) use it.
 */
export async function answerMcp(
  message: Record<string, any>, server: ToolServer, context: (params: Record<string, any>) => ToolContext,
  info: { name: string; version: string } = { name: "agent-runtime-sdk", version: "1.0.0" },
): Promise<{ result: unknown } | { error: { code: number; message: string } }> {
  const params = isRecord(message.params) ? message.params : {};
  if (message.method === "initialize") return { result: { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: info } };
  if (message.method === "ping") return { result: {} };
  if (message.method === "tools/list") return { result: { tools: await server.listTools() } };
  if (message.method !== "tools/call") return { error: { code: -32601, message: `Unknown method ${message.method}` } };
  try {
    const result = await server.callTool(String(params.name), isRecord(params.arguments) ? params.arguments : {}, context(params));
    if (!isRecord(result) || (!Array.isArray(result.content) && result.resultType !== "input_required") || byteLength(JSON.stringify(result)) > 1024 * 1024) throw new Error("The MCP server must answer with a bounded CallToolResult");
    return { result };
  } catch (error) {
    return { error: { code: -32603, message: String(error).slice(0, 2048) } };
  }
}
/** `tool({...})` definitions as an attached MCP server: JSON results become a text block (and structured content for objects). */
export function toolServer(tools: Tools): ToolServer {
  return {
    listTools: () => Object.entries(tools).map(([name, tool]) => ({
      name, description: tool.description, inputSchema: tool.input,
      ...(tool.exposure || tool.executionMode || tool.needsApproval ? { _meta: {
        ...(tool.exposure ? { [`${META}exposure`]: tool.exposure } : {}), ...(tool.executionMode ? { [`${META}executionMode`]: tool.executionMode } : {}),
        ...(tool.needsApproval ? { [`${META}needsApproval`]: true } : {}),
      } } : {}),
    })),
    async callTool(name, args, context) {
      const definition = tools[name];
      if (!Object.hasOwn(tools, name) || !Check(definition.input, args)) throw new Error("Tool is missing or arguments failed validation");
      context.signal.throwIfAborted();
      // Not yet approved: the runtime asks the user, showing this call, and calls again once they approve.
      const asks = typeof definition.needsApproval === "function" ? await definition.needsApproval(args, context) : definition.needsApproval;
      if (asks && !context.identity?.approval) return { resultType: "input_required", inputRequests: { approval: { method: `${META}approval` } } };
      let result: unknown;
      try { result = await definition.execute(args, context); }
      catch (error) {
        if (error instanceof InputRequired) return { resultType: "input_required", inputRequests: error.inputRequests, ...(error.requestState ? { requestState: error.requestState } : {}) };
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
  /** Opens a local file to attach by its path; set by the Node entry (`@camelai/agent-runtime/node`). */
  openFile?: (path: string) => Promise<Blob>;
  /** How often a request still waiting for its result asks for its status, in case the result's event was lost. Default 30 s. */
  pollMs?: number;
}
export interface AgentOptions {
  /** The application's tools, served to the agent as an attached MCP server. */
  tools?: Tools;
  /** Or an MCP server of the application's own (see `clients/mcp.ts` for MCP SDK servers). */
  mcp?: ToolServer;
  /**
   * The agent's events. A `message_update` is its delta alone (`assistantMessageEvent`), without the
   * message it updates: fold that from its `message_start` and the deltas since. Where the stream
   * cannot replay (a first connect, or a reconnect after the host's buffer moved on), the first event
   * is a `{ type: "snapshot", turn }` of the running turn to fold from.
   */
  onEvent?: (event: any, requestId?: string) => unknown | Promise<unknown>;
  /**
   * A question, approval or setup step the agent's turn now waits on. Return an answer to give it
   * at once, or nothing to answer later with `agent.answer` (from any process, via connectAgent).
   */
  onInput?: (input: AgentInput, requestId?: string) => InputAnswer | void | Promise<InputAnswer | void>;
  onConnection?: (connected: boolean) => void;
  onError?: (error: Error) => void;
}
/**
 * Human input a suspended turn waits on (its run ends with `stopped: "input_required"` and these in
 * `inputs`): the model's questions (ask_user), approvals, and a tool's form or URL step.
 */
export interface AgentInput {
  id: string; agent: string; requestId: string; toolCallId: string;
  kind: "question" | "approval" | "form" | "url"; message: string;
  /** question: { questions }; approval: { tool, source, arguments, argumentsHash }; form: { requestedSchema }; url: { url, origin }. */
  detail: Record<string, any>;
  responders: { audience?: string[] };
  state: "pending" | "answered" | "declined" | "cancelled" | "expired" | "superseded";
  answer?: { action: string; content?: unknown; by: Record<string, unknown>; at: number };
  createdAt: number; expiresAt: number;
}
/** An answer. `content`: for a question, { answers: { "<question>": "<label>" | ["<label>"] | "<own words>" } }; for a form, its fields. `from`/`actor`: who answers, checked against who may. */
export interface InputAnswer { action: "accept" | "decline" | "cancel"; content?: unknown; from?: Sender; actor?: string }
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
  /** A key scope (PUT /v1/key-scopes/:scope/providers/:provider) whose keys its model calls use first. */
  keyScope?: string;
  /** The most the agent may spend on model calls from now on (USD); PATCH /v1/agents/:id/configuration sets a new one. */
  spendLimit?: { usd: number };
  /** Non-secret headers for each of its model calls, e.g. cf-aig-metadata; never auth headers. */
  modelHeaders?: Record<string, string>;
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
  limits?: { ttlSeconds?: number | null }; mounts?: unknown[]; builtins?: ("web_fetch" | "web_search" | "schedule")[];
  /** The search providers web_search tries, in order, instead of the runtime's. */
  webSearch?: { providers: ("exa" | "brave" | "parallel")[] };
  mcpServers?: (SourceOptions & { url: string })[];
  openApi?: (SourceOptions & { spec?: string | Record<string, unknown>; baseUrl?: string })[];
}
/** What applying a definition's revision did to one agent; poll a queued one's request for its outcome. */
export interface ApplyResult { agent: string; requestId: string; status: "updated" | "queued" | "failed"; error?: string }
/** A definition as the runtime returns it: credentials are never included. */
export interface Definition extends Omit<DefinitionInput, "mcpServers" | "openApi"> {
  id: string; revision: number; createdAt: number; updatedAt: number;
  mcpServers?: Record<string, unknown>[]; openApi?: Record<string, unknown>[];
  applied?: ApplyResult[];
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
export interface VolumeFile { path: string; version: number; size: number; updatedAt: number; by?: string; contentType: string }
export interface VolumeSnapshot { id: string; volume: string; name: string; seq: number; createdAt: number; files: number; bytes: number }
export interface VolumeChanges { seq: number; changes: { seq: number; path: string; kind: "write" | "delete"; version?: number; size?: number; by?: string; at: number }[]; gap?: boolean }
/** A signed URL for one file: send `method` to `url` with no Authorization header, until `expiresAt`. */
export interface FileLink { url: string; method: "GET" | "PUT"; path: string; expiresAt: number; maxBytes?: number; contentType?: string }
/** A link's options: `expiresIn` seconds (default 900, at most 86400); for PUT, the largest upload and its content type. */
export interface LinkOptions { method?: "GET" | "PUT"; expiresIn?: number; maxBytes?: number; contentType?: string }
/** A message as the runtime records it: a user message also names its sender (if given), the request that sent it, and the application's `metadata`. */
export type RecordedMessage = AgentMessage & { from?: Sender; requestId?: string; metadata?: Record<string, string> };
export interface AgentHistory { messages: RecordedMessage[] }
/** A page of history: whole turns, oldest first, each message at its index in the agent's history. `next` is the older page's `before` (null at the start). */
export interface HistoryPage { entries: { index: number; message: RecordedMessage }[]; next: number | null; total: number; split?: true }
/** What a run's model responses used (`run.finished`). */
export interface RunUsage { responses: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }
/** An event the tenant's webhook receives (`PUT /v1/usage-webhook {url, events}`), signed per Standard Webhooks; dedupe by `id`, order by `at`. */
export type WebhookEvent = { id: string; tenant: string; at: number } & (
  | { type: "usage"; agent: string; requestId: string | null; subject: string; actor: string | null; context: Record<string, unknown>; keyScope: string | null;
      provider: string; model: string; kind: "response" | "compaction"; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number;
      cost: { usd: number; source: "provider" | "catalog" } }
  | { type: "run.started"; agent: string; requestId: string; method: RequestMethod; actor?: string; resumes?: number }
  | { type: "run.finished"; agent: string; requestId: string; method: RequestMethod; actor?: string; outcome: Outcome; steeredInto?: string; usage: RunUsage | null }
  | { type: "input.requested" | "input.resolved"; agent: string; requestId: string; input: AgentInput });
/**
 * A file to attach to a message: bytes or a Blob (a File keeps its name and type), `{ name, data,
 * contentType? }`, a local path (Node entry), or `{ path }` for a file already in the agent's mounts.
 * The SDK uploads each to the agent's workspace (uploads/<request>/<name>) before sending the message.
 */
export type Attachment = Uint8Array | Blob | string | { name?: string; data: Uint8Array | Blob; contentType?: string } | { path: string };
/** A file in the agent's mounts, at the path the agent sees it. */
export interface AgentFile { path: string; version: number; size: number; updatedAt: number; by?: string; contentType: string }
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
/** A download's content type, without parameters (text is always UTF-8). */
const contentTypeOf = (response: Response) => (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();

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
  /**
   * A request with a raw body or response (file contents). It fails once nothing arrives for 30 s
   * (an upload has the runtime's 15 minutes to be sent), so a stalled transfer never hangs its caller.
   */
  async raw(path: string, token: string, init: { method?: string; body?: Uint8Array | Blob; headers?: Record<string, string> } = {}): Promise<Response> {
    // A 503 (the agent is moving, a node draining) was refused before anything happened; a read may be retried after anything.
    for (let attempt = 0; ; attempt++) {
      try { return await this.transfer(path, token, init); }
      catch (error) {
        const status = error instanceof AgentError ? error.status : 500;
        if (attempt >= 3 || !(status === 503 || (status >= 500 && (init.method ?? "GET") === "GET"))) throw error;
        await pause((error as AgentError).retryAfterMs ?? 100 * 2 ** attempt);
      }
    }
  }
  private async transfer(path: string, token: string, init: { method?: string; body?: Uint8Array | Blob; headers?: Record<string, string> }): Promise<Response> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => controller.abort(new AgentError("File transfer stalled")), ms); };
    wait(init.body === undefined ? 30_000 : 15 * 60_000);
    try {
      const response = await this.fetcher(this.base + path, { method: init.method ?? "GET", body: init.body as BodyInit | undefined, headers: { Authorization: `Bearer ${token}`, ...init.headers }, redirect: "manual", signal: controller.signal });
      await rejectRedirect(response);
      if (!response.ok) {
        const value = await response.json().catch(() => ({})) as any;
        throw Object.assign(new AgentError(value.error ?? `HTTP ${response.status}`, response.status), { retryAfterMs: retryAfter(response) });
      }
      if (!response.body) { clearTimeout(timer); return response; }
      wait(30_000);
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, stream) { wait(30_000); stream.enqueue(chunk); },
        flush() { clearTimeout(timer); },
      }));
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { clearTimeout(timer); throw error; }
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
    const session = await this.transport.json("/client-sessions", key, "POST", { mcp: { tools: await server.listTools() }, ...(options.subject !== undefined ? { subject: options.subject } : {}), ...(options.context !== undefined ? { context: options.context } : {}), ...(options.keyScope !== undefined ? { keyScope: options.keyScope } : {}), ...(options.spendLimit !== undefined ? { spendLimit: options.spendLimit } : {}), ...(options.modelHeaders !== undefined ? { modelHeaders: options.modelHeaders } : {}), ...(options.definition !== undefined ? { definition: options.definition } : {}), ...(options.mounts !== undefined ? { mounts: options.mounts } : {}), ...(options.model !== undefined ? { model: options.model } : {}), ...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}), ...(options.initialMessages !== undefined ? { initialMessages: options.initialMessages } : {}), ...(options.name !== undefined ? { name: options.name } : {}), ...(options.type !== undefined ? { type: options.type } : {}), ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}), ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}) }, true,
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
  /** Inputs waiting on someone across all the tenant's agents (`pending` ones, say), newest first. */
  inbox(state?: AgentInput["state"]): Promise<AgentInput[]> { return this.transport.json(`/v1/inputs${state ? `?state=${state}` : ""}`, this.operator()); }
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
  /** Without `contentType`, the runtime sniffs it from the file's first bytes and name. */
  async write(path: string, data: string | Uint8Array, options: { version?: number; contentType?: string } = {}): Promise<VolumeFile> {
    const body = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const headers: Record<string, string> = { "Content-Type": options.contentType ?? "application/octet-stream", ...(options.version === 0 ? { "If-None-Match": "*" } : options.version !== undefined ? { "If-Match": `"${options.version}"` } : {}) };
    return (await this.transport.raw(this.file(path), this.token, { method: "PUT", body, headers })).json();
  }
  /** A file's bytes, or `range` of them ([start, end) in bytes). */
  async read(path: string, options: { range?: [number, number?] } = {}): Promise<{ data: Uint8Array; version: number; contentType: string }> {
    const [start, end] = options.range ?? [];
    const response = await this.transport.raw(this.file(path), this.token, start !== undefined ? { headers: { Range: `bytes=${start}-${end !== undefined ? end - 1 : ""}` } } : {});
    return { data: new Uint8Array(await response.arrayBuffer()), version: Number(response.headers.get("etag")?.replaceAll('"', "")), contentType: contentTypeOf(response) };
  }
  async readText(path: string) { return new TextDecoder().decode((await this.read(path)).data); }
  /** A signed URL to download (GET) or upload (PUT) one file without a token. */
  link(path: string, options: LinkOptions = {}): Promise<FileLink> { return this.transport.json(this.path("/links"), this.token, "POST", { path, ...options }, false); }
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
const encodePath = (path: string) => path.split("/").filter(Boolean).map(encodeURIComponent).join("/");

/**
 * The agent's files, at the paths it sees them (`/workspace/report.pdf`), with the agent's own
 * token: what it wrote during a run (a run's outcome lists `files`), and links to hand them on.
 */
export class AgentFiles {
  private readonly transport: Transport;
  private readonly token: string;
  private readonly base: string;
  constructor(transport: Transport, token: string, base: string) { this.transport = transport; this.token = token; this.base = base; }
  /** Files under `path` (default: the first mount), in path order, a page at a time. */
  list(options: { path?: string; glob?: string; after?: string; limit?: number } = {}): Promise<{ files: AgentFile[]; next?: string }> {
    const query = new URLSearchParams(Object.entries(options).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    return this.transport.json(`${this.base}/files${query.size ? `?${query}` : ""}`, this.token);
  }
  async download(path: string): Promise<{ data: Uint8Array; contentType: string; version: number }> {
    const response = await this.transport.raw(`${this.base}/files/${encodePath(path)}`, this.token);
    return { data: new Uint8Array(await response.arrayBuffer()), contentType: contentTypeOf(response), version: Number(response.headers.get("etag")?.replaceAll('"', "")) };
  }
  /** Write a file into a writable mount; without `contentType` the runtime sniffs it. */
  async upload(path: string, data: Uint8Array | Blob | string, options: { contentType?: string } = {}): Promise<AgentFile> {
    const body = typeof data === "string" ? new TextEncoder().encode(data) : data;
    return (await this.transport.raw(`${this.base}/files/${encodePath(path)}`, this.token, { method: "PUT", body, headers: options.contentType ? { "Content-Type": options.contentType } : {} })).json();
  }
  /** A signed URL to download (GET) or upload (PUT) one file without a token, e.g. for a browser or another service. */
  link(path: string, options: LinkOptions = {}): Promise<FileLink> { return this.transport.json(`${this.base}/links`, this.token, "POST", { path, ...options }, false); }
}

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
  private readonly openFile?: (path: string) => Promise<Blob>;
  private readonly pollMs: number;
  /** The agent's files: list, download, upload and link. */
  readonly files: AgentFiles;
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
    this.openFile = runtime.openFile;
    this.pollMs = runtime.pollMs ?? 30_000;
    this.files = new AgentFiles(this.transport, this.session.token, this.path());
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
        const response = await this.transport.fetcher(this.transport.base + this.path("/events?snapshot=1"), {
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
              const event = JSON.parse(data) as ClientEvent;
              // A snapshot restarts the stream at its cursor, even one below the saved cursor (a restarted host).
              if (event.type === "snapshot") {
                this.journal.cursor = id; await this.save();
                await this.options.onEvent?.(event);
                continue;
              }
              if (id <= this.journal.cursor) continue;
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
    else if (event.type === "event") {
      await this.options.onEvent?.(event.event, event.requestId);
      const onInput = this.options.onInput;
      if (onInput && event.event?.type === "input_required") void (async () => {
        const answer = await onInput(event.event.input, event.requestId);
        if (answer) await this.answer(event.event.input.id, answer);
      })().catch(error => this.report(error));
    }
  }
  private settle(id: string, value: Outcome) {
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    if ("error" in value) waiter.reject(new AgentError(value.error ?? "Unknown failure", 0, id)); else waiter.resolve(value.result);
  }

  /**
   * A request's result arrives as an event; a reconnect also settles from /state. As a last resort,
   * ask for its status now and then, so an event lost on the way can never strand the caller.
   */
  private async outcome(id: string, result: Promise<any>) {
    const poll = setInterval(() => void this.requestStatus(id).then(record => { if (record.outcome) this.settle(id, record.outcome); }, () => {}), this.pollMs);
    try { return await result; } finally { clearInterval(poll); }
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
    const key = String(message.id);
    const controller = new AbortController();
    if (message.method === "tools/call") this.active.set(key, controller);
    try {
      const answer = await answerMcp(message, this.server, params => toolContext(params, key, controller.signal));
      await this.transport.json(this.path("/mcp"), this.session.token, "POST", { jsonrpc: "2.0", id: message.id, ...answer }, true, { "X-Agent-Connection": connection ?? "" });
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
      return await this.outcome(id, deferred.promise);
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
      return await this.outcome(id, deferred.promise);
    } finally { clearTimeout(timer); this.pending.delete(id); }
  }

  /**
   * `from` says who sent the message: the model sees it in a block only the runtime can write, and
   * `from.id` is the turn's actor. `actor` names someone else acting (`act` in identity tokens) without telling the model.
   * `metadata` is the application's own key-value data about the message (at most 16 string values): the
   * stored message and its request carry it, with the request's id, in history, events and webhooks; the model never sees it.
   * `whileRunning: "steer"` hands the message to a running turn, and resolves with that turn's outcome.
   */
  prompt(text: string, options?: RequestOptions & { files?: Attachment[]; images?: ImageContent[]; actor?: string; from?: Sender; metadata?: Record<string, string>; whileRunning?: "queue" | "steer" }) {
    return this.message("prompt", text, options, { ...(options?.actor ? { actor: options.actor } : {}), ...(options?.whileRunning === "steer" ? { whileRunning: "steer" } : {}) });
  }

  /**
   * Send a message with its files: each is uploaded to the agent's workspace under the request's
   * id first, then attached by path. `images` (base64 blocks) are sent inline and saved as files.
   */
  private async message(method: "prompt" | "steer" | "followUp", text: string, options: (RequestOptions & { files?: Attachment[]; images?: ImageContent[]; from?: Sender; metadata?: Record<string, string> }) | undefined, extra: Record<string, unknown> = {}) {
    const id = options?.idempotencyKey ?? globalThis.crypto.randomUUID();
    const files = options?.files?.length ? await this.attach(id, options.files) : undefined;
    return this.request(method, { text, ...(files ? { files } : {}), ...(options?.images ? { images: options.images } : {}), ...extra, ...(options?.from ? { from: options.from } : {}), ...(options?.metadata ? { metadata: options.metadata } : {}) }, { ...options, idempotencyKey: id });
  }

  private async attach(requestId: string, files: Attachment[]): Promise<{ path: string }[]> {
    const names = new Set<string>();
    const attached: { path: string }[] = [];
    for (const [index, file] of files.entries()) {
      if (isRecord(file) && "path" in file && typeof file.path === "string" && !("data" in file)) { attached.push({ path: file.path }); continue; }
      let data: Uint8Array | Blob, name: string | undefined, contentType: string | undefined;
      if (typeof file === "string") {
        if (!this.openFile) throw new AgentError("Attaching a local path needs the Node entry (@camelai/agent-runtime/node); pass bytes or a Blob instead");
        data = await this.openFile(file);
        name = file.split(/[\\/]/).pop();
      } else if (file instanceof Uint8Array || file instanceof Blob) {
        data = file;
        name = (file as { name?: string }).name;
        contentType = file instanceof Blob && file.type ? file.type : undefined;
      } else {
        const entry = file as { name?: string; data: Uint8Array | Blob; contentType?: string };
        ({ data, name } = entry);
        contentType = entry.contentType ?? (data instanceof Blob && data.type ? data.type : undefined);
      }
      // Each file in a request needs its own name: they share uploads/<request>/.
      const base = name || `attachment-${index + 1}`;
      let unique = base;
      for (let n = 2; names.has(unique); n++) unique = base.replace(/(\.[^.]*)?$/, extension => `-${n}${extension}`);
      names.add(unique);
      const response = await this.transport.raw(this.path(`/uploads/${encodeURIComponent(requestId)}/${encodeURIComponent(unique)}`), this.session.token, { method: "PUT", body: data, headers: contentType ? { "Content-Type": contentType } : {} });
      attached.push({ path: (await response.json()).path });
    }
    return attached;
  }
  history(): Promise<AgentHistory> { return this.http("/history"); }
  /**
   * The page of whole turns ending before `before` (default: the newest message, the running turn's
   * included), with at least `limit` messages (default 50) where there are that many. It reads only
   * that page, however long the history.
   */
  historyPage(options: { before?: number; limit?: number } = {}): Promise<HistoryPage> {
    const query = new URLSearchParams({ limit: String(options.limit ?? 50), ...(options.before !== undefined ? { before: String(options.before) } : {}) });
    return this.http(`/history?${query}`);
  }
  continue(options?: RequestOptions & { actor?: string }) { return this.request("continue", options?.actor ? { actor: options.actor } : {}, options); }
  steer(text: string, options?: { from?: Sender; files?: Attachment[]; metadata?: Record<string, string> }) { return this.message("steer", text, options); }
  followUp(text: string, options?: { from?: Sender; files?: Attachment[]; metadata?: Record<string, string> }) { return this.message("followUp", text, options); }
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
  /** Answer an input the agent waits on. `request` is the run resuming its turn, once its last input is answered. */
  answer(inputId: string, answer: InputAnswer): Promise<{ input: AgentInput; request: any | null }> { return this.http(`/inputs/${encodeURIComponent(inputId)}`, "POST", answer); }
  /** The agent's inputs, newest first: `pending` ones, say. */
  inputs(state?: AgentInput["state"]): Promise<AgentInput[]> { return this.http(`/inputs${state ? `?state=${state}` : ""}`); }
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
