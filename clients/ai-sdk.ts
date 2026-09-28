/**
 * Use the AI SDK's `useChat` (and anything built on its `ChatTransport`, like AI Elements) with an
 * agent on the runtime, through your agent handler (`createAgentHandler`):
 *
 *   import { useChat } from "@ai-sdk/react";
 *   import { lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
 *   import { AgentRuntimeChatTransport } from "@camelai/agent-runtime/ai-sdk";
 *
 *   const { messages, sendMessage, addToolApprovalResponse, stop } = useChat({
 *     transport: new AgentRuntimeChatTransport({ endpoint: "/api/agent" }),
 *     sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
 *   });
 *
 * The agent keeps the conversation: only the new message is sent (the chat's history is the agent's),
 * `chatId` is the handler's `thread`, and `stop()` stops the agent's run. Tool calls arrive as
 * `dynamic-tool` parts; an approval the agent waits on is a tool approval request (answer it with
 * `addToolApprovalResponse`); its other questions arrive as `data-agent-input` parts: answer them with
 * `transport.answer(input, value, { chatId })`, then `resumeStream()`. `loadMessages()` reads the history for
 * `useChat({ messages })`. The types are the AI SDK's (v5 and later), declared here so this module
 * needs no dependency on it.
 */
import { watchAgent, type Watcher } from "./watch.ts";
import { answerValue, projectMessages, readsFrom, type ChatMessage, type InputAnswer, type InputValue } from "./chat.ts";
import type { AgentInput } from "./typescript.ts";
import type { AgentEvent, MessageDelta } from "./types.ts";

/** The parts of the AI SDK's UIMessage this transport reads and writes. */
export interface AgentUIMessage {
  id: string;
  role: "system" | "user" | "assistant";
  metadata?: unknown;
  parts: Array<{ type: string; [key: string]: unknown }>;
}
/** The AI SDK's UIMessageChunk, as far as this transport sends it. */
export type AgentUIMessageChunk =
  | { type: "start"; messageId?: string }
  | { type: "start-step" } | { type: "finish-step" }
  | { type: "text-start" | "text-end" | "reasoning-start" | "reasoning-end"; id: string }
  | { type: "text-delta" | "reasoning-delta"; id: string; delta: string }
  | { type: "tool-input-start"; toolCallId: string; toolName: string; dynamic: true }
  | { type: "tool-input-delta"; toolCallId: string; inputTextDelta: string }
  | { type: "tool-input-available"; toolCallId: string; toolName: string; input: unknown; dynamic: true }
  | { type: "tool-output-available"; toolCallId: string; output: unknown; dynamic: true }
  | { type: "tool-output-error"; toolCallId: string; errorText: string; dynamic: true }
  | { type: "tool-approval-request"; approvalId: string; toolCallId: string }
  | { type: "data-agent-input"; id: string; data: AgentInput }
  | { type: "file"; url: string; mediaType: string }
  | { type: "error"; errorText: string }
  | { type: "abort"; reason?: string }
  | { type: "finish"; finishReason?: "stop" | "error" | "other" };

export interface AgentRuntimeChatTransportOptions {
  /** Your agent handler's URL, e.g. "/api/agent". */
  endpoint: string;
  /** The handler's `thread`. Default: the chat's id (`useChat({ id })`). */
  thread?: string | null;
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  credentials?: RequestCredentials;
  /** What a message sent while the agent works does ("queue", the default, or "steer"). */
  whileRunning?: "queue" | "steer";
  fetch?: typeof globalThis.fetch;
}

type SendOptions = {
  trigger: "submit-message" | "regenerate-message";
  chatId: string;
  messageId: string | undefined;
  messages: AgentUIMessage[];
  abortSignal: AbortSignal | undefined;
  headers?: Record<string, string> | Headers;
  body?: object;
  metadata?: unknown;
};

const CLIENT_ID = /^[A-Za-z0-9_-]{8,80}$/;
const textOf = (message: AgentUIMessage) => message.parts.flatMap(part => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
const resultOf = (result: unknown): unknown => {
  const content = (result as { content?: { type: string; text?: string }[] } | undefined)?.content;
  if (!Array.isArray(content)) return result;
  const text = content.flatMap(part => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
  try { return JSON.parse(text); } catch { return text; }
};

/** A ChatTransport for the AI SDK's useChat, over your agent handler. */
export class AgentRuntimeChatTransport {
  private readonly options: AgentRuntimeChatTransportOptions;
  private readonly doFetch: typeof globalThis.fetch;
  constructor(options: AgentRuntimeChatTransportOptions) {
    this.options = options;
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async call(action: string, thread: string | null, body: Record<string, unknown> = {}, headers?: Record<string, string> | Headers): Promise<any> {
    const own = typeof this.options.headers === "function" ? await this.options.headers() : this.options.headers ?? {};
    const extra = headers instanceof Headers ? Object.fromEntries(headers) : headers ?? {};
    const response = await this.doFetch(this.options.endpoint, {
      method: "POST", credentials: this.options.credentials ?? "same-origin",
      headers: { "Content-Type": "application/json", ...own, ...extra },
      body: JSON.stringify({ action, ...(thread !== null ? { thread } : {}), ...body }),
    });
    const value = await response.json().catch(() => ({})) as { error?: { message?: string } | string };
    if (!response.ok) throw new Error(typeof value.error === "object" ? value.error.message ?? `HTTP ${response.status}` : value.error ?? `${this.options.endpoint}: HTTP ${response.status}`);
    return value;
  }
  /** The chat this transport last sent for or reconnected to. */
  private lastChatId: string | undefined;
  private threadOf(chatId: string | undefined) {
    if (chatId !== undefined) this.lastChatId = chatId;
    return this.options.thread !== undefined ? this.options.thread : chatId ?? null;
  }

  /** A watcher of the user's agent, once it is following the live stream. */
  private async watch(thread: string | null, onEvent: (event: AgentEvent) => void, onChange: (watcher: Watcher) => void): Promise<Watcher> {
    const minted = await this.call("token", thread);
    const ready = Promise.withResolvers<void>();
    let watcher!: Watcher;
    watcher = watchAgent({
      ...readsFrom(minted, this.options.endpoint, thread, this.doFetch, this.options.headers, this.options.credentials),
      agentId: minted.agentId, token: minted.token, expiresAt: minted.expiresAt,
      getToken: async () => { const renewed = await this.call("token", thread); return { token: renewed.token, expiresAt: renewed.expiresAt }; },
      onEvent,
      onChange: state => { if (state.connected) ready.resolve(); if (watcher) onChange(watcher); },
      onError: error => { if (!watcher?.state.connected) ready.reject(error); },
    });
    await ready.promise;
    return watcher;
  }

  async sendMessages(options: SendOptions): Promise<ReadableStream<AgentUIMessageChunk>> {
    const thread = this.threadOf(options.chatId);
    const last = options.messages.at(-1);
    // Approvals answered in the chat (addToolApprovalResponse): answer them, and follow the resumed run.
    const approvals = last?.role === "assistant" ? last.parts.flatMap(part => {
      const approval = part.approval as { id?: string; approved?: boolean; reason?: string } | undefined;
      return part.state === "approval-responded" && approval?.id && typeof approval.approved === "boolean" ? [{ id: approval.id, approved: approval.approved, reason: approval.reason }] : [];
    }) : [];
    if (approvals.length) {
      return this.follow(thread, options, async () => {
        let resumed: string | undefined;
        for (const approval of approvals) {
          const answered = await this.call("answer", thread, { inputId: approval.id, answer: approval.approved ? { action: "accept" } : { action: "decline", ...(approval.reason ? { content: { reason: approval.reason } } : {}) } }, options.headers);
          resumed = answered.request?.id ?? resumed;
        }
        return resumed ? { requestId: resumed, gate: false } : null;
      });
    }
    if (!last || last.role !== "user") throw new Error("The agent keeps its own history: send a user message (regenerating an answer is not supported)");
    const text = textOf(last);
    const clientId = CLIENT_ID.test(last.id) ? last.id : `cm_${globalThis.crypto.randomUUID().replace(/-/g, "")}`;
    const data = options.body && Object.keys(options.body).length ? options.body : undefined;
    return this.follow(thread, options, async () => {
      const sent = await this.call("send", thread, { text, clientId, ...(data ? { data } : {}), ...(this.options.whileRunning ? { whileRunning: this.options.whileRunning } : {}) }, options.headers);
      return { requestId: sent.steeredInto ?? sent.requestId, gate: !sent.steeredInto, clientId };
    });
  }

  /** The run going on now, if any (after a reload, or an answer): its reply from where it stands. */
  async reconnectToStream(options: { chatId: string; headers?: Record<string, string> | Headers }): Promise<ReadableStream<AgentUIMessageChunk> | null> {
    const thread = this.threadOf(options.chatId);
    const resumed = this.resuming.get(thread);
    this.resuming.delete(thread);
    // Whether there is anything to follow is known once the watcher is connected.
    const following = Promise.withResolvers<boolean>();
    const stream = await this.follow(thread, { abortSignal: undefined, headers: options.headers }, async watcher => {
      const running = !!resumed || watcher.state.running;
      return running ? { requestId: resumed, gate: false, resume: true } : null;
    }, following.resolve);
    return await following.promise ? stream : null;
  }

  /**
   * Answer what the agent waits on (a `data-agent-input` part's input), then call `resumeStream()`. It goes
   * to the chat's thread: `chatId` (useChat's `id`), else the chat this transport last sent for.
   */
  async answer(input: AgentInput, value: InputValue | InputAnswer, options: { chatId?: string } = {}): Promise<void> {
    const answer = typeof value === "object" && value !== null && !Array.isArray(value) && "action" in value ? value as InputAnswer : answerValue(input, value as InputValue);
    const chatId = options.chatId ?? this.lastChatId;
    if (chatId === undefined && this.options.thread === undefined) throw new Error("Say which chat this answers: transport.answer(input, value, { chatId })");
    const thread = this.threadOf(chatId);
    const answered = await this.call("answer", thread, { inputId: input.id, answer });
    // The run it resumes (once the last input is answered): resumeStream() follows it, even before it starts.
    if (answered.request?.id) this.resuming.set(thread, answered.request.id);
  }
  /** Runs an answer resumed, by thread, for the next reconnectToStream. */
  private readonly resuming = new Map<string | null, string>();

  /** The agent's history as the AI SDK's messages, for `useChat({ messages })`. */
  async loadMessages(options: { chatId?: string; limit?: number } = {}): Promise<AgentUIMessage[]> {
    const thread = this.threadOf(options.chatId);
    const minted = await this.call("token", thread);
    const reads = readsFrom(minted, this.options.endpoint, thread, this.doFetch, this.options.headers, this.options.credentials);
    const response = await reads.fetch!(`${reads.url.replace(/\/+$/, "")}/v1/agents/${encodeURIComponent(minted.agentId)}/history?limit=${options.limit ?? 50}`, { headers: { Authorization: `Bearer ${minted.token}` } });
    if (!response.ok) throw new Error(`history: HTTP ${response.status}`);
    const page = await response.json() as { entries: { index: number; message: any }[] };
    return toUIMessages(projectMessages({ messages: page.entries.map(entry => entry.message), indexes: page.entries.map(entry => entry.index), partial: null, running: false }));
  }

  /**
   * Watch the agent, start (`begin`), and stream what follows as chunks until the run ends. With `gate`,
   * nothing is streamed before the user message the run answers arrives (an earlier run may be finishing).
   */
  private async follow(thread: string | null, options: Pick<SendOptions, "abortSignal" | "headers">,
    begin: (watcher: Watcher) => Promise<{ requestId: string | undefined; gate: boolean; clientId?: string; resume?: boolean } | null>,
    started: (following: boolean) => void = () => {}): Promise<ReadableStream<AgentUIMessageChunk>> {
    let controller!: ReadableStreamDefaultController<AgentUIMessageChunk>;
    let run: { requestId: string | undefined; gate: boolean; clientId?: string } | null = null;
    let open = false, ended = false, assistants = 0;
    const blocks = new Map<number, { id: string; kind: "text" | "reasoning" | "tool"; toolCallId?: string; toolName?: string }>();
    const pending: AgentEvent[] = [];
    const outputs = new Set<string>();
    const output = (toolCallId: string, result: unknown, isError: boolean) => {
      // A call waiting on a person has no result yet (its input_required says what it waits on).
      if ((result as { details?: { inputRequired?: boolean } } | undefined)?.details?.inputRequired || outputs.has(toolCallId)) return;
      outputs.add(toolCallId);
      push(isError
        ? { type: "tool-output-error", toolCallId, errorText: String(resultOf(result)), dynamic: true }
        : { type: "tool-output-available", toolCallId, output: resultOf(result), dynamic: true });
    };
    let watcher: Watcher | undefined;
    const push = (chunk: AgentUIMessageChunk) => { if (!ended) controller.enqueue(chunk); };
    const end = (chunk?: AgentUIMessageChunk) => {
      if (ended) return;
      if (chunk) push(chunk);
      push({ type: "finish" });
      ended = true;
      controller.close();
      watcher?.close();
    };
    const handle = (event: AgentEvent) => {
      if (!run) { pending.push(event); return; }
      if (!open) {
        if (run.gate && !(event.type === "message_start" && event.message.role === "user" && (event.message as { requestId?: string }).requestId === run.clientId)) return;
        open = true;
        push({ type: "start" });
        if (event.type === "message_start" && event.message.role === "user") return;
      }
      switch (event.type) {
        case "message_start":
          if (event.message.role === "assistant") { assistants++; blocks.clear(); push({ type: "start-step" }); }
          break;
        case "message_update": this.delta(event.assistantMessageEvent, assistants, blocks, push); break;
        case "message_end":
          // A call's result (a resumed call has no tool_execution_end of its own).
          if (event.message.role === "toolResult" && !outputs.has(event.message.toolCallId)) output(event.message.toolCallId, event.message, event.message.isError);
          if (event.message.role === "assistant") {
            for (const block of blocks.values()) if (block.kind !== "tool") push({ type: `${block.kind}-end`, id: block.id });
            blocks.clear();
            push({ type: "finish-step" });
          }
          break;
        case "tool_execution_end":
          output(event.toolCallId, event.result, event.isError);
          break;
        case "input_required":
          if (event.input.kind === "approval") push({ type: "tool-approval-request", approvalId: event.input.id, toolCallId: event.input.toolCallId });
          else push({ type: "data-agent-input", id: event.input.id, data: event.input });
          break;
        case "file_presented":
          if (event.url) push({ type: "file", url: event.url, mediaType: event.file.contentType });
          break;
      }
    };
    const stream = new ReadableStream<AgentUIMessageChunk>({
      start: async streamController => {
        controller = streamController;
        try {
          // The run is over once its outcome arrives (or, joining whatever runs, once nothing does).
          const settled = (current: Watcher) => {
            const outcome = current.state.lastOutcome;
            if (!run || ended || !outcome) return;
            if (run.requestId ? outcome.id !== run.requestId : current.state.running) return;
            if (!open) { open = true; push({ type: "start" }); }
            end(outcome.error ? { type: "error", errorText: outcome.error } : undefined);
          };
          watcher = await this.watch(thread, handle, settled);
          const run0 = await begin(watcher);
          started(!!run0);
          if (!run0) { end(); return; }
          if (run0.resume && watcher.state.partial) {
            // Joining a run mid-answer: what it has written so far, then the rest live.
            open = true;
            push({ type: "start" });
            assistants++;
            push({ type: "start-step" });
            watcher.state.partial.content.forEach((block, at) => {
              if (block.type === "text") this.delta({ type: "text_delta", contentIndex: at, delta: block.text }, assistants, blocks, push);
              else if (block.type === "thinking") this.delta({ type: "thinking_delta", contentIndex: at, delta: block.thinking }, assistants, blocks, push);
            });
          }
          run = run0;
          for (const event of pending.splice(0)) handle(event);
          settled(watcher);
        } catch (error) {
          started(false);
          if (!ended) { push({ type: "error", errorText: (error as Error).message }); ended = true; controller.close(); }
          watcher?.close();
        }
      },
      cancel: () => { ended = true; watcher?.close(); },
    });
    options.abortSignal?.addEventListener("abort", () => {
      // useChat's stop(): stop the agent's run too.
      void this.call("stop", thread).catch(() => {});
      if (!ended) { push({ type: "abort" }); ended = true; controller.close(); }
      watcher?.close();
    }, { once: true });
    return stream;
  }

  /** One delta of the assistant message streaming now, as chunks. */
  private delta(delta: MessageDelta, message: number, blocks: Map<number, { id: string; kind: "text" | "reasoning" | "tool"; toolCallId?: string; toolName?: string }>, push: (chunk: AgentUIMessageChunk) => void) {
    if (!("contentIndex" in delta)) return;
    const at = delta.contentIndex;
    const id = `${message}:${at}`;
    const open = (kind: "text" | "reasoning") => {
      if (blocks.get(at)) return;
      blocks.set(at, { id, kind });
      push({ type: `${kind}-start`, id });
    };
    switch (delta.type) {
      case "text_start": open("text"); break;
      case "text_delta": open("text"); if (delta.delta) push({ type: "text-delta", id, delta: delta.delta }); break;
      case "thinking_start": open("reasoning"); break;
      case "thinking_delta": open("reasoning"); if (delta.delta) push({ type: "reasoning-delta", id, delta: delta.delta }); break;
      case "text_end": case "thinking_end": {
        const block = blocks.get(at);
        if (block && block.kind !== "tool") { push({ type: `${block.kind}-end`, id }); blocks.delete(at); }
        break;
      }
      case "toolcall_start":
        if (delta.id) { blocks.set(at, { id, kind: "tool", toolCallId: delta.id, toolName: delta.name ?? "tool" }); push({ type: "tool-input-start", toolCallId: delta.id, toolName: delta.name ?? "tool", dynamic: true }); }
        break;
      case "toolcall_delta": {
        const block = blocks.get(at);
        if (block?.toolCallId && delta.delta) push({ type: "tool-input-delta", toolCallId: block.toolCallId, inputTextDelta: delta.delta });
        break;
      }
      case "toolcall_end":
        blocks.delete(at);
        push({ type: "tool-input-available", toolCallId: delta.toolCall.id, toolName: delta.toolCall.name, input: delta.toolCall.arguments, dynamic: true });
        break;
    }
  }
}

/** Chat messages (from `@camelai/agent-runtime/chat`) as the AI SDK's UIMessages. */
export function toUIMessages(messages: ChatMessage[]): AgentUIMessage[] {
  return messages.map(message => {
    if (message.role === "user") return { id: message.id, role: "user", parts: message.parts.map(part => part.type === "text" ? { type: "text", text: part.text } : { type: "file", url: part.url, mediaType: part.mimeType }) };
    return {
      id: message.id, role: "assistant",
      parts: message.parts.flatMap((part): AgentUIMessage["parts"] => {
        switch (part.type) {
          case "text": return [{ type: "text", text: part.text, state: "done" }];
          case "reasoning": return part.redacted ? [] : [{ type: "reasoning", text: part.text, state: "done" }];
          case "file": return part.url ? [{ type: "file", url: part.url, mediaType: part.contentType ?? "application/octet-stream", filename: part.name }] : [];
          case "tool": {
            const base = { type: "dynamic-tool", toolName: part.name, toolCallId: part.id, input: part.args };
            if (part.state === "done") return [{ ...base, state: "output-available", output: part.result?.data ?? part.result?.text }];
            if (part.state === "error") return [{ ...base, state: "output-error", errorText: part.result?.text ?? "failed" }];
            if (part.input?.kind === "approval") return [{ ...base, state: "approval-requested", approval: { id: part.input.id } }];
            return [{ ...base, state: "input-available" }];
          }
        }
      }),
    };
  });
}
