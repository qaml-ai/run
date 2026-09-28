/**
 * A chat with one agent, for any UI framework: the agent's messages as simple typed parts, its status,
 * the input it waits on, and the actions (send, answer, stop, loadOlder), over your server's agent
 * handler (`createAgentHandler`) and the browser watcher. No dependencies and no Node APIs.
 *
 *   const chat = createAgentChat({ endpoint: "/api/agent" });
 *   chat.subscribe(() => render(chat.getSnapshot()));
 *   await chat.send("Where is my order?");
 *
 * The snapshot is immutable, and a message or part that did not change is the same object from one
 * snapshot to the next, so a UI re-renders only what changed (and keys rows by `id`: a sent message
 * keeps its id when the agent's copy of it arrives).
 */
import { watchAgent, type AgentView, type Watcher, type WatchOptions } from "./watch.ts";
import type { AgentInput, Sender } from "./typescript.ts";
import type { AgentEvent, AssistantMessage, ImageContent, Message, TextContent, ToolResultMessage } from "./types.ts";
export type { AgentInput, Sender };

export type ChatStatus = "connecting" | "ready" | "submitted" | "streaming" | "input_required" | "error";

/** A failure: `code` is stable (the handler's or the runtime's), `message` is for people. */
export interface ChatError { code: string; message: string; status?: number }

export interface TextPart { type: "text"; id: string; text: string; streaming: boolean }
export interface ReasoningPart { type: "reasoning"; id: string; text: string; streaming: boolean; redacted?: boolean }
export interface ImagePart { type: "image"; id: string; url: string; mimeType: string }
/**
 * A file the agent handed over (`present_file`). `url` is a signed link while one is known; else get
 * one with `chat.fileUrl(path)`.
 */
export interface FilePart { type: "file"; id: string; path: string; name: string; contentType?: string; size?: number; caption?: string; url?: string; toolCallId: string }
export type ToolState = "input_streaming" | "running" | "input_required" | "done" | "error";
export interface ToolProgress { progress?: number; total?: number; message?: string; text?: string }
/** A tool call: its arguments (partial while `input_streaming`), and its result once there is one. */
export interface ToolPart {
  type: "tool"; id: string; name: string;
  args: Record<string, unknown>;
  state: ToolState;
  /** The result's text, its content blocks, `details`, and `data`: the text parsed, when it is JSON. */
  result?: { text: string; content: (TextContent | ImageContent)[]; details?: unknown; data?: unknown };
  progress?: ToolProgress;
  /** What the call waits on from a person, while `input_required`. */
  input?: ChatInput;
}
export type UserPart = TextPart | ImagePart;
export type AssistantPart = TextPart | ReasoningPart | ToolPart | FilePart;

export interface UserChatMessage {
  id: string; role: "user"; parts: UserPart[]; text: string;
  from?: Sender; metadata?: Record<string, string>;
  createdAt: number;
  /** sending: on its way; sent: the agent has it; failed: see `error` (and `chat.retry(id)`). */
  status: "sending" | "sent" | "failed";
  error?: ChatError;
  /** Its index in the agent's history, once there. */
  index?: number;
}
export interface AssistantChatMessage {
  id: string; role: "assistant"; parts: AssistantPart[];
  createdAt: number;
  /** The agent is writing it now. */
  streaming: boolean;
  /** How its last response ended: stopped (by `stop()`) or failed (`error`). */
  stopReason?: "stop" | "aborted" | "error";
  error?: string;
}
export type ChatMessage = UserChatMessage | AssistantChatMessage;

/** Human input the agent waits on, as the runtime lists it, and whether an answer is on its way. */
export type ChatInput = AgentInput & { answering: boolean; error?: ChatError };

export interface ChatSnapshot {
  status: ChatStatus;
  messages: ChatMessage[];
  /** Everything the agent waits on (each is also on its tool part, where the call is shown). */
  inputs: ChatInput[];
  /** The latest failure to connect, send or act; null once things work again. */
  error: ChatError | null;
  hasOlder: boolean;
  connected: boolean;
  agentId: string | null;
}

/** An answer's value: approval or url: true/false; question: the label chosen (or labels, or own words), or a map of question to answer; form: its fields. */
export type InputValue = boolean | string | string[] | Record<string, unknown>;
export interface InputAnswer { action: "accept" | "decline" | "cancel"; content?: unknown }

export interface AgentChatOptions {
  /** Your agent handler's URL (`createAgentHandler`), e.g. "/api/agent". */
  endpoint: string;
  /** Which of the user's conversations (the handler maps it to their agent). Default: their one agent. */
  thread?: string;
  /** Headers for every call to the handler (an Authorization header for an API that does not use cookies). */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** Default "same-origin": cookies go with the calls. */
  credentials?: RequestCredentials;
  /** What a message sent while the agent works does: "queue" (default) waits for the turn; "steer" joins it. */
  whileRunning?: "queue" | "steer";
  /** Connect at once (default true). false: call `connect()` (a React provider does, in an effect). */
  autoConnect?: boolean;
  /** Passed to the watcher: `transport`, `pageSize`, `hiddenGraceMs`, `stallMs`. */
  watch?: Pick<WatchOptions, "transport" | "pageSize" | "hiddenGraceMs" | "stallMs">;
  /** Every event of the agent's stream, as it arrives. */
  onEvent?: (event: AgentEvent) => void;
  onError?: (error: ChatError) => void;
  fetch?: typeof globalThis.fetch;
}

export interface SendOptions {
  /** JSON for your handler's `onSend` (the page the user is on, say); the agent sees it only if you pass it on. */
  data?: unknown;
  whileRunning?: "queue" | "steer";
}

export interface AgentChat {
  getSnapshot(): ChatSnapshot;
  /** Listen for new snapshots; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Send a message: it shows at once (status "sending"), keyed by its id, which it keeps. */
  send(text: string, options?: SendOptions): Promise<{ id: string }>;
  /** Send a failed message again (the same id, so it is never sent twice). */
  retry(messageId: string): Promise<void>;
  /** Answer an input, with a value (see InputValue) or an answer. */
  answer(input: ChatInput | string, value: InputValue | InputAnswer): Promise<void>;
  decline(input: ChatInput | string): Promise<void>;
  /** Stop the agent's running turn. */
  stop(): Promise<void>;
  /** Load the page of history before the oldest message shown; false when there is none. */
  loadOlder(): Promise<boolean>;
  /** A signed download link for a file of the agent's (a FilePart's `path`). */
  fileUrl(path: string): Promise<string>;
  connect(): void;
  /** Close the stream; the state stays, and `connect()` opens it again. */
  disconnect(): void;
  /** Disconnect for good. */
  destroy(): void;
}

// ---------------------------------------------------------------------------------------------
// Answers

/** An answer to `input` from a plain value (see InputValue). */
export function answerValue(input: Pick<AgentInput, "kind" | "detail">, value: InputValue): InputAnswer {
  switch (input.kind) {
    case "approval": case "url":
      if (typeof value !== "boolean") throw new Error(`Answer ${input.kind === "approval" ? "an approval" : "a url step"} with true or false`);
      return { action: value ? "accept" : "decline" };
    case "question": {
      const questions = (input.detail?.questions ?? []) as { question: string }[];
      if (typeof value === "string" || Array.isArray(value)) {
        if (questions.length !== 1) throw new Error(`This input asks ${questions.length} questions: answer with { "<question>": "<answer>" } for each`);
        return { action: "accept", content: { answers: { [questions[0].question]: value } } };
      }
      if (typeof value !== "object" || value === null) throw new Error("Answer a question with the label chosen, or a map of question to answer");
      return { action: "accept", content: { answers: value } };
    }
    case "form":
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Answer a form with its fields, as an object");
      return { action: "accept", content: value };
    default:
      throw new Error(`Unknown input kind: ${String((input as { kind: unknown }).kind)}`);
  }
}
const isAnswer = (value: unknown): value is InputAnswer =>
  typeof value === "object" && value !== null && !Array.isArray(value) && ["accept", "decline", "cancel"].includes((value as { action?: string }).action as string) && Object.keys(value).every(key => key === "action" || key === "content");

// ---------------------------------------------------------------------------------------------
// The projection: the agent's messages as chat messages

/** A message this client sent that is not in the agent's history (yet). */
export interface LocalSend { id: string; text: string; createdAt: number; status: "sending" | "sent" | "failed"; error?: ChatError; data?: unknown; whileRunning?: "queue" | "steer" }

export interface ProjectInput {
  messages: readonly (Message & { requestId?: string; metadata?: Record<string, string>; from?: Sender })[];
  indexes: readonly number[];
  partial: AssistantMessage | null;
  progress?: ReadonlyMap<string, unknown>;
  running: boolean;
  inputs?: readonly ChatInput[];
  local?: readonly LocalSend[];
  /** Signed links to presented files, by path. */
  files?: ReadonlyMap<string, string>;
}

/** What the last projection built, to reuse what did not change. */
export type ProjectMemo = Map<string, { sources: readonly unknown[]; value: unknown; children: string[] }>;

type Turn = { index: number; assistants: AssistantMessage[] };
type Block = AssistantMessage["content"][number] & Record<string, any>;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, at) => value === b[at]);
const textOfContent = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => part?.type === "text" && typeof part.text === "string" ? part.text : "").join("") : "";
/** A tool result that stands in while its call waits on a person: the call is not done. */
const isInputPlaceholder = (result: ToolResultMessage | undefined) => isRecord(result?.details) && !!(result!.details as { inputRequired?: unknown }).inputRequired;
/** Whether a turn's last message hands off to tools (the turn goes on) rather than ending it. */
const continuesTurn = (message: Message | undefined) =>
  message?.role === "toolResult" || (message?.role === "assistant" && message.stopReason === "toolUse");
const isPresentFile = (name: string) => name === "present_file" || name.endsWith("__present_file");
const baseName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed || !"{[\"".includes(trimmed[0]) && !/^(true|false|null|-?\d)/.test(trimmed)) return undefined;
  try { return JSON.parse(trimmed); } catch { return undefined; }
}
function progressOf(update: unknown): ToolProgress | undefined {
  if (update === undefined) return undefined;
  const details = isRecord(update) && isRecord(update.details) ? update.details : undefined;
  const text = isRecord(update) ? textOfContent(update.content) : typeof update === "string" ? update : "";
  const out: ToolProgress = {};
  if (details?.type === "progress") {
    if (typeof details.progress === "number") out.progress = details.progress;
    if (typeof details.total === "number") out.total = details.total;
    if (typeof details.message === "string") out.message = details.message;
  }
  if (text) out.text = text;
  return out;
}

/** Reuse `previous` when `next` has the same fields (compared with ===, arrays element by element). */
function reuse<T extends object>(previous: T | undefined, next: T): T {
  if (!previous) return next;
  const a = previous as Record<string, unknown>, b = next as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.length !== Object.keys(a).length) return next;
  for (const key of keys) {
    const x = a[key], y = b[key];
    if (x === y) continue;
    if (Array.isArray(x) && Array.isArray(y) && same(x, y)) continue;
    return next;
  }
  return previous;
}

/**
 * The chat's messages from the agent's (a watcher's view) and the ones sent from here:
 * - a user message is one message, with the id it was sent with (its `requestId`), so the bubble
 *   shown when it was sent is the same row once it arrives;
 * - everything the agent did between two user messages is one assistant message, each tool result
 *   folded into its call's part;
 * - a running turn continues the last one only when that one called tools; otherwise it is a new
 *   message at the index its first message will take, from its first token (never an empty row);
 * - a message or part whose sources did not change is the same object as last time (`memo`).
 */
export function projectMessages(input: ProjectInput, memo: ProjectMemo = new Map()): ChatMessage[] {
  const { messages, indexes } = input;
  const results = new Map<string, ToolResultMessage>();
  for (const message of messages) if (message.role === "toolResult") results.set(message.toolCallId, message);
  const inputs = new Map<string, ChatInput>();
  for (const pending of input.inputs ?? []) inputs.set(pending.toolCallId, pending);
  const echoed = new Set<string>();
  for (const message of messages) if (message.role === "user" && typeof message.requestId === "string") echoed.add(message.requestId);
  const local = (input.local ?? []).filter(send => !echoed.has(send.id));

  type Group = { kind: "user"; index: number; message: ProjectInput["messages"][number] & { role: "user" } } | ({ kind: "turn" } & Turn);
  const groups: Group[] = [];
  let open: Extract<Group, { kind: "turn" }> | null = null;
  messages.forEach((message, position) => {
    const index = indexes[position] ?? position;
    if (message.role === "user") { open = null; groups.push({ kind: "user", index, message }); return; }
    if (message.role !== "assistant") return;
    if (!open) { open = { kind: "turn", index, assistants: [] }; groups.push(open); }
    open.assistants.push(message);
  });

  // The turn streaming now (see above). Sends of ours still on their way come first.
  const pendingSends = local.filter(send => send.status !== "failed").length;
  let streaming: Extract<Group, { kind: "turn" }> | null = null;
  if (input.partial || input.running) {
    const last = groups.at(-1);
    if (last?.kind === "turn" && continuesTurn(messages.at(-1)) && (input.partial || !pendingSends)) streaming = last;
    // A run with nothing streaming yet gets no row: an empty one would flash (after a finished answer,
    // before the run ends) or land above a message still on its way.
    else if (input.partial) {
      const next = (indexes.length ? indexes[indexes.length - 1] + 1 : 0) + pendingSends;
      streaming = { kind: "turn", index: next, assistants: [] };
      groups.push(streaming);
    }
  }

  const out: ChatMessage[] = [];
  const nextMemo: ProjectMemo = new Map();
  // Each value is kept with what it was built from, and the values built inside it (a message's
  // parts), which a message reused as a whole carries forward.
  let collector: string[] | null = null;
  const carry = (id: string, entry: ProjectMemo extends Map<string, infer E> ? E : never) => {
    nextMemo.set(id, entry);
    for (const child of entry.children) { const kept = memo.get(child); if (kept) carry(child, kept); }
  };
  const remember = <V>(id: string, sources: unknown[], build: () => V): V => {
    collector?.push(id);
    const previous = memo.get(id);
    if (previous && same(previous.sources, sources)) { carry(id, previous); return previous.value as V; }
    const outer = collector, children: string[] = [];
    collector = children;
    let built: V;
    try { built = build(); } finally { collector = outer; }
    const value = reuse(previous?.value as V & object | undefined, built as V & object) as V;
    nextMemo.set(id, { sources, value, children });
    return value;
  };

  for (const group of groups) {
    if (group.kind === "user") {
      const message = group.message;
      const id = typeof message.requestId === "string" && message.requestId ? message.requestId : `m:${group.index}`;
      out.push(remember(id, [message, group.index], () => userMessage(id, message, group.index)));
      continue;
    }
    const id = `t:${group.index}`;
    const isStreaming = group === streaming;
    const partial = isStreaming ? input.partial : null;
    // What the turn is built from: its messages, their calls' results, inputs, progress and file links.
    const sources: unknown[] = [isStreaming, partial, ...group.assistants];
    for (const assistant of [...group.assistants, ...(partial ? [partial] : [])]) {
      for (const block of assistant.content as Block[]) {
        if (block?.type !== "toolCall") continue;
        sources.push(results.get(block.id), inputs.get(block.id), input.progress?.get(block.id));
        if (isPresentFile(block.name) && typeof block.arguments?.path === "string") sources.push(input.files?.get(block.arguments.path as string));
      }
    }
    out.push(remember(id, sources, () => {
      const parts: AssistantPart[] = [];
      let ordinal = 0;
      const all = [...group.assistants, ...(partial ? [partial] : [])];
      for (const assistant of all) {
        const live = assistant === partial;
        const count = assistant.content.length;
        (assistant.content as Block[]).forEach((block, at) => {
          if (!block) return;
          const position = ordinal++;
          // Only the last block of the message streaming now is still being written.
          const writing = live && at === count - 1;
          const partId = `${id}:${position}`;
          if (block.type === "text") {
            if (block.text) parts.push(remember(partId, [block, writing], () => ({ type: "text", id: partId, text: block.text as string, streaming: writing })));
          } else if (block.type === "thinking") {
            if (block.redacted) parts.push(remember(partId, [block, writing], () => ({ type: "reasoning", id: partId, text: "", streaming: writing, redacted: true })));
            else if (block.thinking) parts.push(remember(partId, [block, writing], () => ({ type: "reasoning", id: partId, text: block.thinking as string, streaming: writing })));
          } else if (block.type === "toolCall") {
            const callId = typeof block.id === "string" && block.id ? block.id : partId;
            const result = results.get(callId);
            const pending = inputs.get(callId);
            const progress = input.progress?.get(callId);
            const name = String(block.name ?? "");
            const args = isRecord(block.arguments) ? block.arguments : {};
            if (isPresentFile(name) && typeof args.path === "string" && result && !result.isError && !isInputPlaceholder(result)) {
              const url = input.files?.get(args.path);
              parts.push(remember(`${id}:${callId}:file`, [block, result, url], () => fileAt(callId, args, result, url)));
              return;
            }
            parts.push(remember(`${id}:${callId}`, [block, result, pending, progress, writing], () => toolAt(callId, name, args, result, pending, progress, writing)));
          }
        });
      }
      const last = group.assistants.at(-1);
      const message: AssistantChatMessage = { id, role: "assistant", parts, createdAt: group.assistants[0]?.timestamp ?? partial?.timestamp ?? 0, streaming: isStreaming };
      if (!isStreaming && last) {
        if (last.stopReason === "aborted") message.stopReason = "aborted";
        else if (last.stopReason === "error") { message.stopReason = "error"; if (last.errorMessage) message.error = last.errorMessage; }
        else message.stopReason = "stop";
      }
      return message;
    }));
  }

  for (const send of local) {
    out.push(remember(send.id, [send], () => ({
      id: send.id, role: "user", parts: [{ type: "text", id: `${send.id}:0`, text: send.text, streaming: false }], text: send.text,
      createdAt: send.createdAt, status: send.status, ...(send.error ? { error: send.error } : {}),
    } satisfies UserChatMessage)));
  }
  memo.clear();
  for (const [key, value] of nextMemo) memo.set(key, value);
  return out;
}

function userMessage(id: string, message: ProjectInput["messages"][number] & { role: "user" }, index: number): UserChatMessage {
  const parts: UserPart[] = [];
  const content = message.content;
  if (typeof content === "string") { if (content) parts.push({ type: "text", id: `${id}:0`, text: content, streaming: false }); }
  else content.forEach((block, at) => {
    if (block.type === "text" && block.text) parts.push({ type: "text", id: `${id}:${at}`, text: block.text, streaming: false });
    else if (block.type === "image") parts.push({ type: "image", id: `${id}:${at}`, url: `data:${block.mimeType};base64,${block.data}`, mimeType: block.mimeType });
  });
  return {
    id, role: "user", parts, text: textOfContent(content), createdAt: message.timestamp ?? 0, status: "sent", index,
    ...(message.from ? { from: message.from } : {}), ...(message.metadata ? { metadata: message.metadata } : {}),
  };
}

function toolAt(id: string, name: string, args: Record<string, unknown>, result: ToolResultMessage | undefined, pending: ChatInput | undefined, progress: unknown, writing: boolean): ToolPart {
  const part: ToolPart = { type: "tool", id, name, args, state: "running" };
  if (result && !isInputPlaceholder(result)) {
    const text = textOfContent(result.content);
    const data = parseJson(text);
    part.state = result.isError ? "error" : "done";
    part.result = { text, content: result.content, ...(result.details !== undefined ? { details: result.details } : {}), ...(data !== undefined ? { data } : {}) };
    return part;
  }
  if (pending) { part.state = "input_required"; part.input = pending; }
  else if (result) part.state = "input_required";
  else if (writing) part.state = "input_streaming";
  const shown = progressOf(progress);
  if (shown) part.progress = shown;
  return part;
}

function fileAt(callId: string, args: Record<string, unknown>, result: ToolResultMessage, url: string | undefined): FilePart {
  const data = parseJson(textOfContent(result.content)) as { path?: string; size?: number; contentType?: string } | undefined;
  const path = typeof data?.path === "string" ? data.path : args.path as string;
  return {
    type: "file", id: `${callId}:file`, toolCallId: callId, path, name: baseName(path),
    ...(typeof data?.contentType === "string" ? { contentType: data.contentType } : {}),
    ...(typeof data?.size === "number" ? { size: data.size } : {}),
    ...(typeof args.caption === "string" ? { caption: args.caption } : {}),
    ...(url ? { url } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// The store

/**
 * Where the watcher reads the agent: the runtime (with the browser token), or, when the handler proxies
 * reads, the handler itself (under the thread's path), with the chat's own headers and credentials.
 */
export function readsFrom(minted: { url?: string; proxy?: boolean }, endpoint: string, thread: string | null | undefined, doFetch: typeof globalThis.fetch,
  headers?: AgentChatOptions["headers"], credentials?: RequestCredentials): Pick<WatchOptions, "url" | "fetch"> {
  if (!minted.proxy) return { url: minted.url!, fetch: doFetch };
  const base = `${endpoint.replace(/\/+$/, "")}${thread ? `/threads/${encodeURIComponent(thread)}` : ""}`;
  return {
    url: base,
    fetch: async (input, init = {}) => {
      const own = typeof headers === "function" ? await headers() : headers ?? {};
      // The watcher's Authorization is a placeholder here: the handler adds the real token, and yours goes instead.
      const merged: Record<string, string> = { ...init.headers as Record<string, string>, ...own };
      if (!own.Authorization && !own.authorization) delete merged.Authorization;
      return doFetch(input, { ...init, headers: merged, credentials: credentials ?? "same-origin" });
    },
  };
}

const newId = () => `cm_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
const EMPTY: ChatSnapshot = { status: "connecting", messages: [], inputs: [], error: null, hasOlder: false, connected: false, agentId: null };

/** A chat with the user's agent, through your agent handler: see `AgentChatOptions` and `ChatSnapshot`. */
export function createAgentChat(options: AgentChatOptions): AgentChat {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const listeners = new Set<() => void>();
  let snapshot = EMPTY;
  let view: AgentView | null = null;
  let watcher: Watcher | null = null;
  let generation = 0;
  let agentId: string | null = null;
  let error: ChatError | null = null;
  let fatal = false;
  let destroyed = false;
  let local: LocalSend[] = [];
  const answering = new Map<string, ChatError | null>();
  const files = new Map<string, { url: string; expiresAt?: number }>();
  let fileUrls = new Map<string, string>();
  const memo: ProjectMemo = new Map();
  let scheduled = false;

  function toError(value: unknown, fallback = "request_failed"): ChatError {
    if (isRecord(value) && typeof value.code === "string" && typeof value.message === "string") return value as unknown as ChatError;
    return { code: fallback, message: value instanceof Error ? value.message : String(value) };
  }
  function report(value: ChatError) { error = value; options.onError?.(value); schedule(); }

  /** A call to the handler: its JSON, or a ChatError. */
  async function call(action: string, body: Record<string, unknown> = {}): Promise<any> {
    const extra = typeof options.headers === "function" ? await options.headers() : options.headers ?? {};
    let response: Response;
    try {
      response = await doFetch(options.endpoint, {
        method: "POST", credentials: options.credentials ?? "same-origin",
        headers: { "Content-Type": "application/json", ...extra },
        body: JSON.stringify({ action, ...(options.thread !== undefined ? { thread: options.thread } : {}), ...body }),
      });
    } catch (cause) { throw { code: "network_error", message: `Could not reach ${options.endpoint}: ${(cause as Error).message}` } satisfies ChatError; }
    const value = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } | string };
    if (!response.ok) {
      const failure = typeof value.error === "object" ? value.error : { message: typeof value.error === "string" ? value.error : undefined };
      throw { code: failure?.code ?? `http_${response.status}`, message: failure?.message ?? `${options.endpoint}: HTTP ${response.status}`, status: response.status } satisfies ChatError;
    }
    return value;
  }

  function compute(): ChatSnapshot {
    const inputs: ChatInput[] = (view?.pendingInputs ?? []).map(input => {
      const state = answering.get(input.id);
      return state === undefined ? { ...input, answering: false } : { ...input, answering: state === null, ...(state ? { error: state } : {}) };
    });
    // Keep input objects stable while nothing about them changed.
    const previousInputs = new Map(snapshot.inputs.map(input => [input.id, input]));
    const stableInputs = inputs.map(input => reuse(previousInputs.get(input.id), input));
    const now = Date.now();
    const links = new Map<string, string>();
    for (const [path, link] of files) if (!link.expiresAt || link.expiresAt > now + 30_000) links.set(path, link.url);
    if (links.size !== fileUrls.size || [...links].some(([path, url]) => fileUrls.get(path) !== url)) fileUrls = links;
    const messages = projectMessages({
      messages: view?.messages ?? [], indexes: view?.indexes ?? [], partial: view?.partial ?? null, progress: view?.progress,
      running: view?.running ?? false, inputs: stableInputs, local, files: fileUrls,
    }, memo);
    const waiting = local.some(send => send.status !== "failed");
    // A run whose answer just ended is still finishing: not a new wait.
    const last = messages.at(-1);
    const streaming = messages.some(message => message.role === "assistant" && message.streaming) || (!!view?.running && !waiting && last?.role === "assistant");
    const status: ChatStatus = fatal ? "error"
      : streaming ? "streaming"
      : waiting || view?.running ? "submitted"
      : stableInputs.some(input => !input.answering) ? "input_required"
      : !view?.transport ? "connecting"
      : "ready";
    const next: ChatSnapshot = { status, messages, inputs: stableInputs, error, hasOlder: view?.hasOlder ?? false, connected: view?.connected ?? false, agentId };
    return reuse(snapshot, next);
  }
  function emit() {
    scheduled = false;
    const next = compute();
    if (next === snapshot) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(emit);
  }

  /** The generation whose token is being fetched, so a second connect() meanwhile does not start another. */
  let connecting: number | null = null;
  function connect() {
    if (destroyed || watcher || connecting === generation) return;
    const mine = ++generation;
    connecting = mine;
    fatal = false;
    void (async () => {
      let minted: { token: string; expiresAt: number; agentId: string; url?: string; proxy?: boolean };
      // A refusal (not signed in, not allowed) stops here; anything else is tried again, backing off.
      for (let backoff = 1000; ; backoff = Math.min(backoff * 2, 30_000)) {
        try { minted = await call("token"); break; }
        catch (cause) {
          if (mine !== generation) return;
          const failure = toError(cause);
          if (failure.status && failure.status < 500 && failure.status !== 429) { fatal = true; connecting = null; report(failure); return; }
          report(failure);
          await new Promise(resolve => setTimeout(resolve, backoff));
          if (mine !== generation) return;
        }
      }
      // Disconnected (or destroyed) while the token was on its way, or superseded by a later connect: stop here.
      if (mine !== generation || destroyed) return;
      connecting = null;
      try {
        agentId = minted.agentId;
        (watcher as Watcher | null)?.close();
        watcher = watchAgent({
          ...options.watch, ...readsFrom(minted, options.endpoint, options.thread, doFetch, options.headers, options.credentials),
          agentId: minted.agentId, token: minted.token, expiresAt: minted.expiresAt,
          getToken: async () => { const renewed = await call("token"); return { token: renewed.token, expiresAt: renewed.expiresAt }; },
          onChange: state => {
            if (mine !== generation) return;
            view = state;
            if (state.expired) fatal = true;
            else if (state.connected && error?.code === "stream_error") error = null;
            // Messages of ours the agent now has are done with.
            if (local.length) {
              const echoed = new Set(state.messages.flatMap(message => message.role === "user" && typeof (message as { requestId?: unknown }).requestId === "string" ? [(message as { requestId: string }).requestId] : []));
              if (local.some(send => echoed.has(send.id))) local = local.filter(send => !echoed.has(send.id));
            }
            for (const id of answering.keys()) if (!state.pendingInputs.some(input => input.id === id)) answering.delete(id);
            schedule();
          },
          onEvent: event => {
            if (event.type === "file_presented" && event.url) files.set(event.file.path, { url: event.url, ...(event.expiresAt ? { expiresAt: event.expiresAt } : {}) });
            options.onEvent?.(event);
          },
          onError: cause => { if (mine === generation) report({ code: "stream_error", message: cause.message }); },
        });
        view = watcher.state;
        schedule();
      } catch (cause) {
        if (mine !== generation) return;
        fatal = true;
        report(toError(cause));
      }
    })();
  }
  function disconnect() {
    generation++;
    connecting = null;
    watcher?.close();
    watcher = null;
    if (view) { view = { ...view, connected: false }; schedule(); }
  }

  async function deliver(send: LocalSend) {
    try {
      await call("send", { text: send.text, clientId: send.id, ...(send.data !== undefined ? { data: send.data } : {}), ...(send.whileRunning ? { whileRunning: send.whileRunning } : {}) });
      local = local.map(item => item.id === send.id ? { ...item, status: "sent" as const } : item);
      if (error && error.code !== "stream_error") error = null;
    } catch (cause) {
      const failure = toError(cause);
      local = local.map(item => item.id === send.id ? { ...item, status: "failed" as const, error: failure } : item);
      report(failure);
    }
    schedule();
  }
  const inputOf = (input: ChatInput | string) => typeof input === "string" ? snapshot.inputs.find(item => item.id === input) : input;

  const chat: AgentChat = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async send(text, sendOptions = {}) {
      if (!text.trim()) throw new Error("Send some text");
      const send: LocalSend = {
        id: newId(), text, createdAt: Date.now(), status: "sending",
        ...(sendOptions.data !== undefined ? { data: sendOptions.data } : {}),
        ...(sendOptions.whileRunning ?? options.whileRunning ? { whileRunning: sendOptions.whileRunning ?? options.whileRunning } : {}),
      };
      local = [...local, send];
      emit();
      await deliver(send);
      return { id: send.id };
    },
    async retry(messageId) {
      const send = local.find(item => item.id === messageId && item.status === "failed");
      if (!send) return;
      const again: LocalSend = { ...send, status: "sending" };
      delete again.error;
      local = local.map(item => item.id === messageId ? again : item);
      emit();
      await deliver(again);
    },
    async answer(target, value) {
      const input = inputOf(target);
      if (!input) throw new Error("No such input is pending");
      const answer = isAnswer(value) ? value : answerValue(input, value);
      answering.set(input.id, null);
      emit();
      try { await call("answer", { inputId: input.id, answer }); }
      catch (cause) {
        const failure = toError(cause);
        answering.set(input.id, failure);
        report(failure);
        return;
      }
      schedule();
    },
    decline(target) { return chat.answer(target, { action: "decline" }); },
    async stop() {
      try { await call("stop"); } catch (cause) { report(toError(cause)); }
    },
    async loadOlder() {
      if (!watcher) return false;
      try { return await watcher.loadOlder(); }
      catch (cause) { report(toError(cause)); return false; }
    },
    async fileUrl(path) {
      const known = files.get(path);
      if (known && (!known.expiresAt || known.expiresAt > Date.now() + 30_000)) return known.url;
      const link = await call("link", { path }) as { url: string; expiresAt?: number };
      files.set(path, { url: link.url, ...(link.expiresAt ? { expiresAt: link.expiresAt } : {}) });
      schedule();
      return link.url;
    },
    connect,
    disconnect,
    destroy() { destroyed = true; disconnect(); listeners.clear(); },
  };
  if (options.autoConnect !== false) connect();
  return chat;
}
