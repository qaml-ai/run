import type { AgentEvent, Message, PresentedFile, ThinkingLevel } from "./types.ts";
import type { Run } from "./agents.ts";
import { Type, type TSchema, type Static } from "typebox";
import { Check } from "typebox/value";
import { FRAME_BYTES, type ClientEvent, type Outcome, type RequestMethod, type SessionCredentials, type SessionState } from "../shared/client-protocol.ts";
export { Type as schema };
export type { SessionCredentials, SessionState };
export type * from "./types.ts";

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
  signal: AbortSignal;
  /**
   * The same for every attempt at this call (a retry after a lost connection, a call run again once the
   * user answered): key your side effects by it, so a call that runs twice acts once.
   */
  idempotencyKey: string;
  /** This attempt's id (a JSON-RPC id): a new one each attempt, so never a key for side effects. */
  callId: string;
  /** The model's tool call this is (or, from code, the code's call). */
  toolCallId?: string;
  /**
   * Report progress: people watching see it, and each report restarts the tool's timeout (`timeoutMs`),
   * so a long call that keeps reporting is not cut off. A message, or how far it is (`progress` of `total`).
   */
  progress(update: string | { progress: number; total?: number; message?: string }): void;
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
  /**
   * How long one call may go without an answer before the runtime gives up on it (1 s to 20 minutes;
   * default 15 s).
   * Each `context.progress()` restarts it. A call cut off is an error the model sees; it may still finish here.
   */
  timeoutMs?: number;
  resultFormat?: "json" | "content";
  exposure?: "direct" | "codemode" | "both";
  executionMode?: "sequential" | "parallel";
  input: Record<string, unknown>;
  /** Return any JSON value (`undefined` is sent as null); throw to tell the model the call failed. */
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
export function toolContext(params: Record<string, any>, fallbackId: string, signal: AbortSignal, identity?: RuntimeIdentity, notify?: (message: Record<string, unknown>) => void): ToolContext {
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
  const callId = typeof meta[`${META}callId`] === "string" ? meta[`${META}callId`] : fallbackId;
  const toolCallId = typeof meta[`${META}toolCallId`] === "string" ? meta[`${META}toolCallId`] : undefined;
  const innerCallId = typeof meta[`${META}innerCallId`] === "string" ? meta[`${META}innerCallId`] : undefined;
  // The runtime's stable key; from a runtime that sends none, the model's call (and the code's call within it).
  const idempotencyKey = typeof meta[`${META}idempotencyKey`] === "string" ? meta[`${META}idempotencyKey`]
    : toolCallId ? [who?.agent ?? "", toolCallId, innerCallId ?? ""].join(":") : callId;
  const progressToken = meta.progressToken;
  let reported = 0;
  return {
    callId, idempotencyKey, signal,
    ...(toolCallId ? { toolCallId } : {}),
    progress(update) {
      if (progressToken === undefined || !notify || signal.aborted) return;
      const value = typeof update === "string" ? { progress: ++reported, message: update } : { ...update, progress: Math.max(update.progress, reported) };
      reported = value.progress;
      notify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, ...value } });
    },
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
      ...(tool.exposure || tool.executionMode || tool.needsApproval || tool.timeoutMs ? { _meta: {
        ...(tool.exposure ? { [`${META}exposure`]: tool.exposure } : {}), ...(tool.executionMode ? { [`${META}executionMode`]: tool.executionMode } : {}),
        ...(tool.needsApproval ? { [`${META}needsApproval`]: true } : {}), ...(tool.timeoutMs ? { [`${META}timeoutMs`]: tool.timeoutMs } : {}),
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
      // A tool that returns nothing did its work: the model hears null, not a failure it would retry.
      if (result === undefined) result = null;
      if (byteLength(JSON.stringify(result)) > 1024 * 1024) throw new Error("Tool must return a bounded JSON value");
      if (definition.resultFormat === "content") return result as CallToolResult;
      return { content: [{ type: "text", text: JSON.stringify(result) }], ...(isRecord(result) ? { structuredContent: result } : {}) };
    },
  };
}
/** The hosted runtime; `url` points elsewhere (a self-hosted runtime, or http://127.0.0.1:8790 in development). */
export const DEFAULT_URL = "https://agents.camelai.dev";
export interface RuntimeOptions {
  /** The runtime's origin. Default https://agents.camelai.dev. */
  url?: string;
  apiKey?: string;
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
   * The agent's events, for display: a run's result is the truth. They are delivered in order, one at a
   * time, apart from the connection (a slow or failing handler never holds up tool calls); an error it
   * throws goes to `onError`. A `message_update` is its delta alone (`assistantMessageEvent`), without the
   * message it updates: fold that from its `message_start` and the deltas since. Where the stream
   * cannot replay (a first connect, or a reconnect after the host's buffer moved on), the first event
   * is a `{ type: "snapshot", turn }` of the running turn to fold from.
   */
  onEvent?: (event: AgentEvent, requestId?: string) => unknown | Promise<unknown>;
  /**
   * A question, approval or setup step the agent's turn now waits on. Return an answer to give it
   * at once, or nothing to answer later with `agent.answer` (from any process, via connectAgent).
   */
  onInput?: (input: AgentInput, requestId?: string) => InputAnswer | void | Promise<InputAnswer | void>;
  onConnection?: (connected: boolean) => void;
  onError?: (error: Error) => void;
  /**
   * Whether this client answers the agent's tool calls (its attached MCP server). Default: true. One
   * process is the agent's application at a time; `false` connects to follow the agent and run it only,
   * as any number of processes may (serverless functions, a second service), and answers no tool calls.
   */
  attach?: boolean;
  /**
   * Replace the process that serves the agent's tools now (it stops serving them, and its onError hears
   * APPLICATION_REPLACED). Without it, connecting while another process serves them fails with APPLICATION_CONNECTED.
   */
  takeover?: boolean;
  /**
   * Declare this client's tools when they differ from those the agent has, as it connects (default true), so
   * a process restarted with changed tools updates its agent. The declaration applies between the agent's turns.
   */
  syncTools?: boolean;
}
/**
 * Human input a suspended turn waits on (its run ends with `stopped: "input_required"` and these in
 * `inputs`): the model's questions (ask_user), approvals, and a tool's form or URL step.
 */
export interface AgentInput {
  id: string; agent: string; requestId: string; toolCallId: string;
  kind: "question" | "approval" | "form" | "url"; message: string;
  /** What it asks, by `kind`. */
  detail: InputDetail;
  responders: { audience?: string[] };
  state: "pending" | "answered" | "declined" | "cancelled" | "expired" | "superseded";
  answer?: { action: string; content?: unknown; by: Record<string, unknown>; at: number };
  createdAt: number; expiresAt: number;
}
/** What an input asks: by its `kind`, the fields of one of these. */
export interface InputDetail {
  /** question: the model's questions (ask_user). */
  questions?: { question: string; header?: string; options: { label: string; description?: string }[]; multiSelect: boolean; allowOther: boolean }[];
  /** approval: the tool call it waits on, where its tool comes from ("application", "runtime", or a tool source's name), and why it asks. */
  tool?: string; source?: string; reason?: string;
  /** approval: the call's arguments, as its tool_call event has them; past 4,000 characters of JSON, `argumentsPreview` (their start) instead. */
  arguments?: Record<string, unknown>; argumentsPreview?: string; argumentsHash?: string;
  /** form: the fields asked for, as a flat JSON Schema. */
  requestedSchema?: Record<string, unknown>;
  /** url: the page to open, and its origin. */
  url?: string; origin?: string;
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
  /** Agent lifetime in seconds (60 to 366 days), or null to keep it until deleted. Default: until deleted with an `idempotencyKey` of yours, else one day. */
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
  /** Text the model reads after the system prompt (a definition's, say): per-conversation context. */
  systemPromptAppend?: string;
  /** false: no file tools (read, write, edit, ls, glob, grep) for an application with file tools of its own. */
  fileTools?: boolean;
  name?: string;
  type?: string;
  /**
   * A model from the runtime's catalog as "provider/model-id" (see GET /v1/models),
   * e.g. "anthropic/claude-sonnet-5-5" or "openrouter/openai/gpt-5.2". A full Pi
   * model object is also accepted if its endpoint is trusted by the runtime.
   */
  model?: string | Record<string, unknown>;
  thinkingLevel?: ThinkingLevel;
  initialMessages?: Message[];
  /** Volumes for the agent's file tools (read, write, edit, ls, glob, grep). Default: its own workspace volume at /workspace. */
  mounts?: Mount[];
  /** Tools the runtime answers itself, for an agent without a definition (one made from a definition has its definition's). */
  builtins?: Builtin[];
}
/** A tool the runtime answers itself: web_fetch, web_search, schedule (wake-ups) or ask_user (questions, waiting for the answer). */
export type Builtin = "web_fetch" | "web_search" | "schedule" | "ask_user";
/** A volume the agent's file tools see at `path`; `notify` prompts the agent when others change files there. */
/** How a tool source is authenticated: a stored bearer token, or identity tokens the runtime signs for each request. */
export type SourceAuth = { type: "bearer"; token: string } | { type: "runtime" };
/** Options every tool source takes. `exposure` defaults to both for a source of up to 10 tools, else codemode. */
interface SourceOptions { name: string; headers?: Record<string, string>; auth?: SourceAuth; audience?: string; allowTools?: string[]; denyTools?: string[]; exposure?: "direct" | "codemode" | "both"; timeoutMs?: number }
export interface DefinitionInput {
  name: string; model?: string; systemPrompt?: string; thinkingLevel?: ThinkingLevel;
  limits?: { ttlSeconds?: number | null }; mounts?: unknown[]; builtins?: Builtin[];
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
/**
 * A model on a provider of your own: its id on the server, its context window (compaction keeps requests within it),
 * the most it writes in a reply (default 8,192, or half a smaller window), what it takes in, whether it reasons, its
 * pricing in USD per million tokens (for usage, spend limits and webhooks; none: free), and `compat` switches for a
 * server that differs from OpenAI's.
 */
export interface CustomModel {
  id: string; contextWindow: number; maxOutputTokens?: number; input?: ("text" | "image")[]; reasoning?: boolean;
  pricing?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  compat?: { supportsDeveloperRole?: boolean; supportsUsageInStreaming?: boolean; supportsFinishReason?: boolean; supportsReasoningEffort?: boolean; maxTokensField?: "max_tokens" | "max_completion_tokens"; thinkingFormat?: "openai" | "openrouter" | "deepseek" | "together" | "zai" | "qwen" | "qwen-chat-template" };
}
/** A provider of your own: a public https server that speaks OpenAI Chat Completions (`POST <baseUrl>/chat/completions`). */
/** The API a custom provider speaks. */
export type CustomProviderType = "openai-completions" | "openai-responses" | "anthropic-messages";
export interface CustomProviderInput { type: CustomProviderType; baseUrl: string; apiKey?: string | null; headers?: Record<string, string> | null; /** anthropic-messages: "bearer" sends the key as Authorization: Bearer, not x-api-key. */ auth?: "x-api-key" | "bearer"; models: CustomModel[] }
/** A provider as GET /v1/providers lists it; never a key or header value. */
export interface ProviderSummary {
  id: string; kind: "model" | "search" | "fetch"; models: number; apiKey: boolean; requires?: string;
  key: { provider: string; source: "tenant" | "admin" | "platform"; last4?: string; setAt?: number } | null;
  custom?: { type: CustomProviderType; baseUrl: string; auth: "x-api-key" | "bearer"; headers?: string[]; models: CustomModel[] };
}
/** An agent as GET /v1/agents lists it. */
export interface AgentSummary { id: string; key: string | null; name: string; type: string; model: string; connected: boolean; running: boolean; expiresAt: number | null; resume: { failures: number; after: number } | null }
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
export type RecordedMessage = Message & { from?: Sender; requestId?: string; metadata?: Record<string, string> };
export interface AgentHistory { messages: RecordedMessage[] }
/** A page of history: whole turns, oldest first, each message at its index in the agent's history. `next` is the older page's `before` (null at the start). */
export interface HistoryPage { entries: { index: number; message: RecordedMessage }[]; next: number | null; total: number; split?: true }
/** What a run's model responses used (`run.completed`, `run.failed`); null when it made none on the node that ended it. */
export interface RunUsage { responses: number; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number }
type RunFacts = { agentId: string; requestId: string; method: "prompt" | "continue" | "resume" | "execute"; actor?: string; metadata?: Record<string, string> };
/**
 * An event a tenant's webhook endpoint receives (`POST /v1/webhooks {url, events}`), signed per Standard Webhooks.
 * `created` is Unix seconds; dedupe by `id`. Payloads carry ids and key facts: read the rest with the tenant token.
 */
export type WebhookEvent = { id: string; created: number } & (
  | { type: "run.started"; data: RunFacts & { resumes?: number } }
  | { type: "run.completed"; data: RunFacts & { usage: RunUsage | null; stopped?: "input_required" | "spend_limit"; inputIds?: string[]; replyIndex?: number; messageCount?: number; steeredInto?: string } }
  | { type: "run.failed"; data: RunFacts & { usage: RunUsage | null; error: string; uncertain?: boolean; steeredInto?: string } }
  | { type: "input.requested"; data: { agentId: string; requestId: string; inputId: string; toolCallId: string; kind: AgentInput["kind"]; expiresAt: number } }
  | { type: "input.resolved"; data: { agentId: string; requestId: string; inputId: string; state: Exclude<AgentInput["state"], "pending"> } }
  | { type: "usage.recorded"; data: {
      agentId: string; requestId: string | null; subject: string; actor: string | null; context: Record<string, unknown>; keyScope: string | null;
      provider: string; model: string; kind: "response" | "compaction"; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning?: number;
      cost: { usd: number; source: "provider" | "catalog" }; at: number;
    } });
/**
 * A file to attach to a message: bytes or a Blob (a File keeps its name and type), `{ name, data,
 * contentType? }`, a local path (Node entry), or `{ path }` for a file already in the agent's mounts.
 * The SDK uploads each to the agent's workspace (uploads/<request>/<name>) before sending the message.
 */
export type Attachment = Uint8Array | Blob | string | { name?: string; data: Uint8Array | Blob; contentType?: string } | { path: string };
/** A file in the agent's mounts, at the path the agent sees it. */
export interface AgentFile { path: string; version: number; size: number; updatedAt: number; by?: string; contentType: string }
export interface Schedule { id: string; agent: string; text?: string; code?: string; dueAt: number; everySeconds?: number; createdAt: number }
/**
 * `idempotencyKey`: the request's id; sending the same key again returns the same request, never a second one.
 * `signal`: stop waiting (the request goes on; `abort()` stops the agent's turn). `timeoutMs`: the same, after a time.
 */
export interface RequestOptions { idempotencyKey?: string; timeoutMs?: number; signal?: AbortSignal }
/**
 * `allowDisconnected`: run even when no process serves the agent's tools (its calls to them then fail as
 * not_connected). Without it, a run of an agent with application tools and none connected is refused
 * with APPLICATION_NOT_CONNECTED.
 */
export interface RunRequestOptions extends RequestOptions { allowDisconnected?: boolean }
/** Who sent a message: `id` is yours and the model may rely on it; the names are the sender's own. */
export interface Sender { id: string; name?: string; username?: string }
export class AgentError extends Error {
  /** The HTTP status, or 0 for a failure that is not an HTTP response's (a run's, the connection's). */
  status: number;
  requestId?: string;
  /** A stable name for the failure where the runtime gives one, e.g. APPLICATION_NOT_CONNECTED. */
  code?: string;
  /** The runtime could not tell whether the work took effect (a restart cut it short). */
  uncertain?: boolean;
  /** Milliseconds the runtime asked to wait before retrying (its Retry-After), for 429 and 503. */
  retryAfterMs?: number;
  constructor(message: string, status = 0, requestId?: string) { super(message); this.name = "AgentError"; this.status = status; this.requestId = requestId; }
}
/** A run that failed (`agent.run` throws it unless `throwOnError: false`): `run` is how it ended, `code` why. */
export class RunError extends AgentError {
  readonly run: Run;
  constructor(run: Run) {
    super(run.error?.message ?? "The run failed", 0, run.id);
    this.name = "RunError";
    this.run = run;
    this.code = run.error?.code;
    if (run.error?.uncertain) this.uncertain = true;
  }
}
/** What a run produced: its reply, how it stopped, the inputs it waits on and the files it wrote. */
export interface RunResult {
  /** The final assistant message's text ("" when it said nothing). */
  reply?: string;
  /** The model's error, or null. */
  error: string | null;
  /** Why it stopped early: waiting on human input (`inputs`), or its spend limit. */
  stopped?: "input_required" | "spend_limit";
  inputs?: AgentInput[];
  replyIndex?: number;
  /** Messages in the agent's history after it. */
  messages?: number;
  files?: AgentFile[];
  presented?: PresentedFile[];
  usage?: RunUsage | null;
  /** A stable name for `error`, where the runtime gives one. */
  code?: string;
  /** Tool calls that did not complete (the model was told): timed out, lost, with no application connected, and so on. */
  toolErrors?: ToolError[];
  /** Tool sources (MCP servers, OpenAPI specs) that could not be listed, so the model went without their tools. */
  sourceErrors?: { kind: string; source: string; message: string }[];
}
/**
 * A tool call that did not complete. `code`: timeout or connection_lost (with `outcomeUnknown`: it may have
 * taken effect), not_connected (no application was connected to run it: it did not run), source_unavailable, failed.
 */
export interface ToolError { tool: string; toolCallId?: string; innerCallId?: string; code: "timeout" | "connection_lost" | "not_connected" | "source_unavailable" | "failed"; outcomeUnknown?: true; message: string }
/** An error body's stable name: its `code`, or the prefix of its message (`APPLICATION_CONNECTED: …`). */
function codeOf(value: { error?: unknown; code?: unknown }): { code?: string } {
  if (typeof value.code === "string") return { code: value.code };
  const prefix = typeof value.error === "string" ? /^([A-Z][A-Z0-9_]+):/.exec(value.error)?.[1] : undefined;
  return prefix ? { code: prefix } : {};
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
/** A downloaded file's version, from X-File-Version: proxies may rewrite the ETag (W/"n" once gzipped). */
const fileVersion = (response: Response) => Number(response.headers.get("x-file-version"));

async function rejectRedirect(response: Response) {
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new AgentError("Runtime redirects are not allowed", response.status);
  }
}

/**
 * Hosts plain http:// may reach: loopback, and names and addresses only a private network resolves
 * (a Docker Compose service, `*.internal`, `*.local`, 10/8, 172.16/12, 192.168/16), as for a runtime kept private.
 */
export function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (["localhost", "[::1]"].includes(host) || /\.(?:localhost|internal|local)$/.test(host)) return true;
  const ip = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
  if (ip) {
    const [a, b] = [Number(ip[1]), Number(ip[2])];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return !host.includes(".") && !host.startsWith("[");
}

class Transport {
  readonly base: string;
  readonly fetcher: typeof globalThis.fetch;
  constructor(options: RuntimeOptions) {
    const url = new URL(options.url ?? DEFAULT_URL);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Use a runtime origin without credentials, path, or query");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && privateHost(url.hostname))) throw new Error("Remote runtimes require https://; http:// only on a private network (localhost, a single-label or .internal name, a private IP)");
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
        if (!response.ok) throw Object.assign(new AgentError(value.error ?? `HTTP ${response.status}`, response.status), { retryAfterMs: retryAfter(response), ...codeOf(value) });
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

/** What an agent's key, and a request's id (its idempotency key), may be. */
const AGENT_KEY = /^[A-Za-z0-9_-]{1,80}$/;
const REQUEST_ID = AGENT_KEY;
/** A create request's fields, from the options given. */
function provisioning(options: CreateAgentOptions) {
  const fields = ["subject", "context", "keyScope", "spendLimit", "modelHeaders", "definition", "mounts", "model", "thinkingLevel", "initialMessages", "name", "type", "systemPrompt", "systemPromptAppend", "fileTools", "builtins"] as const;
  return Object.fromEntries(fields.filter(field => options[field] !== undefined).map(field => [field, options[field]]));
}

/** Trusted-backend SDK. Only createAgent needs the operator key. */
export class AgentRuntime {
  readonly options: RuntimeOptions;
  private readonly transport: Transport;
  constructor(options: RuntimeOptions = {}) { this.options = options; this.transport = new Transport(options); }
  /**
   * The agent for `key`: made if there is none, set to `options` if it differs. Returns its credentials;
   * connect with `connectAgent`. Keyed agents live until they are deleted.
   */
  async upsertAgent(key: string, options: CreateAgentOptions): Promise<{ session: SessionCredentials; reconfigured?: { id: string } }> {
    const apiKey = this.options.apiKey;
    if (!apiKey) throw new AgentError("Set apiKey to provision an agent");
    if (!AGENT_KEY.test(key)) throw new AgentError(`An agent's key is 1 to 80 letters, digits, _ and -: ${JSON.stringify(key.slice(0, 100))} is not`);
    const server = options.mcp ?? toolServer(options.tools ?? {});
    // The key is the agent's idempotency key: the same key is the same agent, reconfigured when its configuration differs.
    const answer = await this.transport.json("/v1/agents", apiKey, "POST", { mcp: { tools: await server.listTools() }, ...provisioning(options) }, true, { "Idempotency-Key": key });
    return { session: { id: answer.id, token: answer.token, expiresAt: answer.expiresAt ?? null }, ...(answer.reconfigured ? { reconfigured: answer.reconfigured } : {}) };
  }
  async createAgent(options: CreateAgentOptions): Promise<AgentClient> {
    const key = this.options.apiKey;
    if (!key) throw new AgentError("Set apiKey to provision an agent");
    const server = options.mcp ?? toolServer(options.tools ?? {});
    // A key of the caller's makes the agent durable (it lives until deleted); one the SDK makes up, only so a retried
    // create finds the same agent, keeps a scratch agent's day, said explicitly since any key would make it durable.
    const ttlSeconds = options.ttlSeconds !== undefined ? options.ttlSeconds : options.idempotencyKey === undefined ? 86_400 : undefined;
    const session = await this.transport.json("/v1/agents", key, "POST", { mcp: { tools: await server.listTools() }, ...provisioning(options), ...(ttlSeconds !== undefined ? { ttlSeconds } : {}) }, true,
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
  /**
   * Add or replace a provider of your own: a server that speaks OpenAI Chat Completions, with the models it has. Agents
   * name them `<name>/<model id>`. `apiKey` and `headers` left out keep what is stored; null removes them.
   */
  setProvider(name: string, config: CustomProviderInput): Promise<ProviderSummary> { return this.transport.json(`/v1/providers/${encodeURIComponent(name)}`, this.operator(), "PUT", config); }
  deleteProvider(name: string): Promise<{ deleted: true }> { return this.transport.json(`/v1/providers/${encodeURIComponent(name)}`, this.operator(), "DELETE", undefined, false); }
  /** Every provider: the built-in ones with your keys' status, and your own (`custom`). */
  providers(): Promise<ProviderSummary[]> { return this.transport.json("/v1/providers", this.operator()); }
  /** The tenant's agents, each with the key it was made with (null for one made without) and its name. */
  listAgents(): Promise<AgentSummary[]> { return this.transport.json("/v1/agents", this.operator()); }
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
  /** The definition for `key`, set to `input` whole: made if there is none, else a new revision if `input` changes it. The same key is the same definition. */
  upsertDefinition(key: string, input: DefinitionInput): Promise<Definition> {
    if (!AGENT_KEY.test(key)) throw new AgentError(`A definition's key is 1 to 80 letters, digits, _ and -: ${JSON.stringify(key.slice(0, 100))} is not`);
    return this.transport.json("/v1/definitions", this.operator(), "POST", input, true, { "Idempotency-Key": key });
  }
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
  /**
   * A token a browser reads one agent with (`@camelai/agent-runtime/watch`): mint one per user, after your
   * own access checks. It reads only that agent's events, state, history and inputs (or `scopes`), for
   * `ttlSeconds` (default 900, 5 to 3600).
   */
  browserToken(agentId: string, options: { ttlSeconds?: number; scopes?: ("events" | "state" | "history" | "inputs")[]; events?: string[]; redact?: "usage.cost"[]; subject?: string } = {}): Promise<{ token: string; expiresAt: number; agentId: string; url?: string }> {
    return this.transport.json(`/v1/agents/${encodeURIComponent(agentId)}/browser-tokens`, this.operator(), "POST", options, false);
  }
  /** Who the API key is: `tenant` is your tenant's id, which serveTools and verifyRuntimeToken take. */
  /** Who the API key is (`tenant`), and `defaultModel`, the model an agent gets when it names none. */
  me(): Promise<{ tenant: string; via: string; login?: string; defaultModel: string }> { return this.transport.json("/v1/me", this.operator()); }
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
    return { data: new Uint8Array(await response.arrayBuffer()), version: fileVersion(response), contentType: contentTypeOf(response) };
  }
  async readText(path: string) { return new TextDecoder().decode((await this.read(path)).data); }
  /** A signed URL to download (GET) or upload (PUT) one file without a token. */
  link(path: string, options: LinkOptions = {}): Promise<FileLink> { return this.transport.json(this.path("/links"), this.token, "POST", { path, ...options }, false); }
  async remove(path: string, options: { version?: number } = {}) {
    return (await this.transport.raw(this.file(path), this.token, { method: "DELETE", headers: options.version !== undefined ? { "If-Match": `"${options.version}"` } : {} })).json();
  }
}

/** A request's settlement, shared by every call waiting on it (`waiters` of them). */
type Pending = { promise: Promise<any>; resolve: (value: any) => void; reject: (error: Error) => void; waiters: number };
/** Requests one client may wait on at once. */
const MAX_PENDING = 1000;
/** Events waiting for a slow onEvent; past this, streamed deltas are dropped (the messages they build still arrive). */
const MAX_QUEUED_EVENTS = 10_000;
const INSPECT = Symbol.for("nodejs.util.inspect.custom");
/** Credentials whose token stays out of logs: not enumerable, so JSON.stringify and console.log leave it out. */
function redacted(session: SessionCredentials): SessionCredentials {
  const value = { id: session.id, expiresAt: session.expiresAt } as SessionCredentials;
  Object.defineProperty(value, "token", { value: session.token, enumerable: false });
  return value;
}
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
    return { data: new Uint8Array(await response.arrayBuffer()), contentType: contentTypeOf(response), version: fileVersion(response) };
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
  /** The agent's id (client_…): safe to log and to store. */
  readonly id: string;
  /** The agent's id and its token: keep the token secret (it is left out of logs and JSON). */
  readonly session: SessionCredentials;
  readonly tools: Tools;
  private server: ToolServer;
  private readonly transport: Transport;
  /** The last event taken from the stream: a reconnect resumes after it (a new client starts from a snapshot). */
  private cursor = 0;
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
  /** onEvent's queue: events wait here, in order, so the stream never waits on the application. */
  private dispatching: Promise<void> = Promise.resolve();
  private queued = 0;
  private dropped = 0;
  private readonly listeners = new Set<(event: AgentEvent, requestId?: string) => void>();
  private attaching: boolean;
  /** The stream was cut on purpose, to reconnect in another mode: not an error to report. */
  private switching = false;

  constructor(runtime: RuntimeOptions, session: SessionCredentials, options: AgentOptions) {
    if (!/^client_[a-f0-9]{40}$/.test(session.id)) throw new AgentError("Invalid session id");
    this.id = session.id;
    this.session = redacted(session);
    this.attaching = options.attach !== false;
    this.tools = { ...options.tools };
    this.server = options.mcp ?? toolServer(this.tools);
    this.options = options;
    this.transport = new Transport(runtime);
    this.openFile = runtime.openFile;
    this.pollMs = runtime.pollMs ?? 30_000;
    this.files = new AgentFiles(this.transport, this.session.token, this.path());
  }

  private path(suffix = "") { return `/clients/${this.session.id}${suffix}`; }
  private http(suffix: string, method = "GET", body?: unknown, retry = true) { return this.transport.json(this.path(suffix), this.session.token, method, body, retry); }
  private report(error: unknown) { this.options.onError?.(error instanceof Error ? error : new Error(String(error))); }

  async connect() {
    if (this.closed) throw new AgentError("Client closed");
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
        // One application serves an agent's tools at a time: a reconnect names the connection it held; `takeover` replaces another's, once.
        const mode = !this.attaching ? "&watch=1" : this.options.takeover && !this.connection ? "&takeover=true" : "";
        const response = await this.transport.fetcher(this.transport.base + this.path(`/events?snapshot=1${mode}`), {
          headers: {
            Authorization: `Bearer ${this.session.token}`, Accept: "text/event-stream", "Last-Event-ID": String(this.cursor),
            ...(this.attaching && this.connection ? { "X-Agent-Connection": this.connection } : {}),
          },
          signal: this.stream.signal, redirect: "manual",
        });
        await rejectRedirect(response);
        if (response.status === 409) {
          const refusal = await response.json().catch(() => ({})) as { error?: string; code?: string };
          if (refusal.code === "APPLICATION_CONNECTED" || refusal.error?.startsWith("APPLICATION_CONNECTED")) {
            throw Object.assign(new AgentError("Another process serves this agent's tools. One process at a time answers an agent's tool calls: close that one, pass takeover: true to replace it, or connect with attach: false to run the agent without serving its tools", 409), { code: "APPLICATION_CONNECTED" });
          }
          const snapshot = await this.sync();
          this.cursor = snapshot.cursor;
          this.emit({ type: "replay_gap", cursor: snapshot.cursor });
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
              // Another process took over this agent's tools: this one stops, rather than take them back.
              if (lines.includes("event: closed")) {
                throw Object.assign(new AgentError("Another process took over this agent's tools (takeover): this client no longer serves them, and follows the agent without them", 409), { code: "APPLICATION_REPLACED" });
              }
              if (lines.includes("event: ready")) {
                const ready = JSON.parse(data) as { connection?: string; toolsHash?: string };
                this.connection = ready.connection;
                // Tools that differ from those the agent was last given: declare these, between its turns.
                if (this.attaching && ready.toolsHash && this.options.syncTools !== false) void this.syncTools(ready.toolsHash).catch(error => this.report(error));
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
              // A snapshot restarts the stream at its cursor, even one below the last (a restarted host).
              if (event.type === "snapshot") {
                this.cursor = id;
                this.emit(event as AgentEvent);
                continue;
              }
              if (id <= this.cursor) continue;
              await this.receive(event);
              this.cursor = id;
            }
            if (byteLength(buffer) > FRAME_BYTES) throw new AgentError("SSE frame too large");
          }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      } catch (error) {
        if (this.closed) break;
        // Another process serves the tools now (it took over, or took them while this one was away): this one
        // goes on following the agent, and running it, without serving them, so its requests still settle.
        if (error instanceof AgentError && (error.code === "APPLICATION_REPLACED" || (error.code === "APPLICATION_CONNECTED" && this.connection))) {
          this.attaching = false;
          this.report(error);
        } else if (error instanceof AgentError && ([401, 403, 410].includes(error.status) || (error.status >= 300 && error.status < 400) || error.code === "APPLICATION_CONNECTED")) {
          this.fatal = error; this.ready.reject(error);
          for (const waiter of this.pending.values()) waiter.reject(error);
          this.pending.clear(); this.report(error); break;
        } else if (this.switching) this.switching = false; else this.report(error);
      } finally { clearTimeout(watchdog); this.options.onConnection?.(false); }
      if (!this.closed) { await pause(backoff); backoff = Math.min(5000, backoff * 2); }
    }
  }

  /** Rename/regroup this agent without changing its conversation or tools. */
  async setMetadata(metadata: { name: string; type: string }) {
    return this.transport.json(this.path('/metadata'), this.session.token, 'POST', metadata);
  }

  /** Hand an event to the listeners, and queue it for onEvent: the stream goes on without waiting for either. */
  private emit(event: AgentEvent, requestId?: string) {
    for (const listener of this.listeners) {
      try { listener(event, requestId); } catch (error) { this.report(error); }
    }
    const onEvent = this.options.onEvent;
    if (!onEvent) return;
    if (this.queued >= MAX_QUEUED_EVENTS && event.type === "message_update") {
      if (this.dropped++ === 0) this.report(new AgentError(`onEvent is falling behind: over ${MAX_QUEUED_EVENTS} events wait, so streamed deltas are dropped until it catches up`));
      return;
    }
    this.queued++;
    this.dispatching = this.dispatching.then(async () => {
      try { await onEvent(event, requestId); }
      catch (error) { this.report(error); }
      finally { if (--this.queued === 0) this.dropped = 0; }
    });
  }
  /** @internal Hear every event as it arrives (synchronously, before onEvent); returns the unsubscribe. */
  listen(listener: (event: AgentEvent, requestId?: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  /** Resolves once onEvent has handled every event received so far. */
  drained(): Promise<void> { return this.dispatching; }

  private async receive(event: ClientEvent) {
    if (event.type === "response") this.settle(event.id, event.outcome);
    else if (event.type === "event") {
      this.emit(event.event, event.requestId);
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
    if ("error" in value) {
      const outcome = value as { error?: string; code?: unknown; uncertain?: boolean };
      waiter.reject(Object.assign(new AgentError(outcome.error ?? "Unknown failure", 0, id), {
        ...(typeof outcome.code === "string" ? { code: outcome.code } : {}), ...(outcome.uncertain ? { uncertain: true } : {}),
      }));
    } else waiter.resolve(value.result);
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
    const notify = (notification: Record<string, unknown>) => void this.transport.json(this.path("/mcp"), this.session.token, "POST", notification, false, { "X-Agent-Connection": connection ?? "" }).catch(() => {});
    try {
      const answer = await answerMcp(message, this.server, params => toolContext(params, key, controller.signal, undefined, notify));
      await this.transport.json(this.path("/mcp"), this.session.token, "POST", { jsonrpc: "2.0", id: message.id, ...answer }, true, { "X-Agent-Connection": connection ?? "" });
    } finally { this.active.delete(key); }
  }

  /**
   * Send a request and wait for its outcome, however long the run takes: there is no timeout unless
   * `timeoutMs` or `signal` says so, and either only stops the wait (the request goes on).
   */
  async request(method: RequestMethod, params: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<any> {
    if (this.closed || this.fatal) throw this.fatal ?? new AgentError("Client closed");
    const id = options.idempotencyKey ?? globalThis.crypto.randomUUID();
    if (!REQUEST_ID.test(id)) throw new AgentError(`An idempotency key is 1 to 80 letters, digits, _ and -: ${JSON.stringify(id.slice(0, 100))} is not`, 400);
    options.signal?.throwIfAborted();
    const deferred = this.waiter(id, options, "Request timed out; it may still be running: requestStatus() or waitForRequest() observe it");
    try {
      const record = await this.http("/requests", "POST", { id, method, params });
      if (record.outcome) this.settle(id, record.outcome);
      return await this.outcome(id, deferred.promise);
    } catch (error) {
      if (error instanceof AgentError) { error.requestId ??= id; throw error; }
      if (options.signal?.aborted && error === options.signal.reason) throw error;
      throw new AgentError(String(error), 0, id);
    } finally { deferred.done(); }
  }

  /**
   * Wait for request `id` to settle, until `timeoutMs` or `signal` says to stop waiting. Calls waiting on the same
   * request share its settlement (the same key sent again joins the run), and each stops waiting on its own.
   */
  private waiter(id: string, options: { timeoutMs?: number; signal?: AbortSignal }, timedOut: string) {
    let shared = this.pending.get(id);
    if (!shared) {
      if (this.pending.size >= MAX_PENDING) throw new AgentError("Too many outstanding requests");
      shared = { ...Promise.withResolvers<any>(), waiters: 0 };
      // Attach immediately, even while the POST is pending, to avoid unhandled errors.
      shared.promise.catch(() => {});
      this.pending.set(id, shared);
    }
    shared.waiters++;
    const own = Promise.withResolvers<any>();
    own.promise.catch(() => {});
    shared.promise.then(own.resolve, own.reject);
    const timer = options.timeoutMs !== undefined ? setTimeout(() => own.reject(new AgentError(timedOut, 0, id)), options.timeoutMs) : undefined;
    const aborted = () => own.reject(options.signal!.reason);
    options.signal?.addEventListener("abort", aborted, { once: true });
    const settled = shared;
    return {
      promise: own.promise,
      done: () => {
        clearTimeout(timer); options.signal?.removeEventListener("abort", aborted);
        if (--settled.waiters === 0 && this.pending.get(id) === settled) this.pending.delete(id);
      },
    };
  }

  /** Wait for a request already sent (by this process or another) to settle. This never submits or re-executes work. */
  async waitForRequest(id: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<any> {
    if (this.closed || this.fatal) throw this.fatal ?? new AgentError("Client closed");
    options.signal?.throwIfAborted();
    const deferred = this.waiter(id, options, "Stopped waiting; the request may still be running");
    try {
      const record = await this.requestStatus(id);
      if (record.outcome) this.settle(id, record.outcome);
      return await this.outcome(id, deferred.promise);
    } finally { deferred.done(); }
  }

  /**
   * `from` says who sent the message: the model sees it in a block only the runtime can write, and
   * `from.id` is the turn's actor. `actor` names someone else acting (`act` in identity tokens) without telling the model.
   * `metadata` is the application's own key-value data about the message (at most 16 string values): the
   * stored message and its request carry it, with the request's id, in history, events and webhooks; the model never sees it.
   * `whileRunning: "steer"` hands the message to a running turn, and resolves with that turn's outcome. `spendLimit` is this run's own
   * budget: it ends before its next model request once it has spent that; the agent's spendLimit is unchanged.
   */
  prompt(text: string, options?: RunRequestOptions & { files?: Attachment[]; actor?: string; from?: Sender; metadata?: Record<string, string>; whileRunning?: "queue" | "steer"; spendLimit?: { usd: number } }) {
    return this.message("prompt", text, options, { ...(options?.actor ? { actor: options.actor } : {}), ...(options?.whileRunning === "steer" ? { whileRunning: "steer" } : {}), ...(options?.allowDisconnected ? { allowDisconnected: true } : {}), ...(options?.spendLimit ? { spendLimit: options.spendLimit } : {}) });
  }

  /**
   * Send a message with its files: each is uploaded to the agent's workspace under the request's
   * id first, then attached by path.
   */
  private async message(method: "prompt" | "steer", text: string, options: (RequestOptions & { files?: Attachment[]; from?: Sender; metadata?: Record<string, string> }) | undefined, extra: Record<string, unknown> = {}) {
    const id = options?.idempotencyKey ?? globalThis.crypto.randomUUID();
    const files = options?.files?.length ? await this.attach(id, options.files) : undefined;
    return this.request(method, { text, ...(files ? { files } : {}), ...extra, ...(options?.from ? { from: options.from } : {}), ...(options?.metadata ? { metadata: options.metadata } : {}) }, { ...options, idempotencyKey: id });
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
  continue(options?: RunRequestOptions & { actor?: string }) { return this.request("continue", { ...(options?.actor ? { actor: options.actor } : {}), ...(options?.allowDisconnected ? { allowDisconnected: true } : {}) }, options); }
  /** The legacy steer request: a message held for the running turn. New code: `prompt(text, { whileRunning: "steer" })`. */
  steer(text: string, options?: { from?: Sender; files?: Attachment[]; metadata?: Record<string, string> }) { return this.message("steer", text, options); }
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
    // Tools that run here now: answer the agent's calls, as its application.
    if (server && !this.attaching && (mcp || Object.keys(tools ?? {}).length)) await this.reconnect(true);
    return result;
  }
  /** Declare this client's tools when they differ from what the agent has (its `toolsHash`). */
  private async syncTools(declared: string) {
    const tools = await this.server.listTools();
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(tools))));
    if ([...digest].map(byte => byte.toString(16).padStart(2, "0")).join("") === declared) return;
    await this.request("configure", { mcp: { tools } });
  }
  /** Connect again, attached (answering tool calls) or not. */
  private async reconnect(attach: boolean) {
    this.attaching = attach;
    this.ready = Promise.withResolvers<void>();
    this.switching = true;
    this.stream?.abort();
    await this.connect();
  }
  execute(code: string, options?: RunRequestOptions & { timeoutMs?: number; executionTimeoutMs?: number; actor?: string }) {
    return this.request("execute", { code, ...(options?.executionTimeoutMs ? { timeoutMs: options.executionTimeoutMs } : {}), ...(options?.actor ? { actor: options.actor } : {}), ...(options?.allowDisconnected ? { allowDisconnected: true } : {}) }, options);
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

  toJSON() { return { id: this.id }; }
  [INSPECT]() { return `AgentClient { id: '${this.id}' }`; }

  async close() {
    this.closed = true; this.stream?.abort();
    for (const controller of this.active.values()) controller.abort();
    for (const [id, waiter] of this.pending) waiter.reject(new AgentError("Client closed; request may still be running", 0, id));
    this.pending.clear();
    await this.loop;
    // Events received before closing still reach onEvent, but a handler that never returns cannot hang shutdown.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.dispatching, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]);
    clearTimeout(timer);
  }
  async destroy() { try { await this.http("", "DELETE"); } finally { await this.close(); } }
  async [Symbol.asyncDispose]() { await this.close(); }
}

export { Agents, Agent } from "./agents.ts";
export type { AgentsOptions, AgentConfig, Run, RunFailure, RunInput, RunOptions, RunStream, StreamPart, InputValue, AnswerOptions } from "./agents.ts";
