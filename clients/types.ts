/**
 * The messages and events the runtime sends, as the SDK exposes them. They are declared here, not
 * imported from the model library the runtime uses, so an application's types need nothing else.
 * Fields the runtime may add later are allowed: every object type is open.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface TextContent { type: "text"; text: string }
export interface ThinkingContent { type: "thinking"; thinking: string; redacted?: boolean }
/** An image, base64-encoded. */
export interface ImageContent { type: "image"; data: string; mimeType: string }
/** A call the model made to a tool. */
export interface ToolCallContent { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }

/** What a model response used; cost in USD. */
export interface MessageUsage {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  reasoning?: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface UserMessage {
  role: "user"; content: string | (TextContent | ImageContent)[]; timestamp: number;
  /** A message the runtime made: a sub-agent's notification (`agentId`, its `name`; its `metadata` has status, output, error and usage). Not the person. */
  source?: { kind: "agent"; agentId: string; name: string };
}
export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCallContent)[];
  provider: string; model: string; api?: string;
  usage?: MessageUsage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted" | (string & {});
  errorMessage?: string;
  timestamp: number;
}
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string; toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}
/** Instructions the runtime adds itself, e.g. a compaction summary. */
export interface SystemMessage { role: "system"; content: string | TextContent[]; timestamp: number }
export type Message = UserMessage | AssistantMessage | ToolResultMessage | SystemMessage;

/** A file in the agent's mounts, as a run presents it; download it with `agent.files.download(path)`. */
export interface PresentedFile { type: "file"; path: string; volume: string; version: number; size: number; contentType: string; caption?: string; [key: string]: unknown }

/** A delta of the assistant message streaming now (a `message_update`'s `assistantMessageEvent`). */
export type MessageDelta =
  | { type: "start" }
  | { type: "text_start" | "thinking_start" | "toolcall_start"; contentIndex: number; id?: string; name?: string }
  | { type: "text_delta" | "thinking_delta" | "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "text_end" | "thinking_end"; contentIndex: number; content: string }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCallContent }
  | { type: "done" | "error"; reason?: string };

/**
 * An event on an agent's stream. The model loop's events (`agent_start` … `tool_execution_end`) and the
 * runtime's own. Events are for display: a run's result is the truth. New types may be added: ignore those you do not know.
 */
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: Message[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: Message; toolResults: ToolResultMessage[] }
  | { type: "turn_opened"; index: number }
  | { type: "message_start"; message: Message }
  /** A delta alone (`assistantMessageEvent`), without the message it updates: fold it from `message_start`. */
  | { type: "message_update"; assistantMessageEvent: MessageDelta }
  | { type: "message_end"; message: Message }
  /** A response taken back (before a retry, or a compaction on overflow): the message at `index` is gone. */
  | { type: "message_retracted"; index: number }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  /** A tool's progress: `partialResult.details` is `{ type: "progress", progress, total?, message? }` for one that reports it. */
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args?: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "input_required"; input: import("./typescript.ts").AgentInput }
  | { type: "input_resolved"; id: string; state: string; by?: Record<string, unknown> }
  /** A file the agent presented (present_file), with a signed link to it where the runtime made one. */
  | { type: "file_presented"; file: PresentedFile; url?: string; expiresAt?: number }
  /** What js_exec code logged, as it ran within the model's tool call `toolCallId`. */
  | { type: "codemode"; toolCallId: string; event: { type: "output"; text: string } | { type: string; [key: string]: unknown } }
  /** What code run by `execute` logged, as it ran. */
  | { type: "output"; text: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "compaction_start"; reason: string; background?: boolean }
  /** The model call that summarized the history, and what it used (not sent to browser tokens). */
  | { type: "compaction_usage"; provider: string; model: string; usage: MessageUsage; timestamp: number; background?: boolean }
  | { type: "compaction_end"; reason: string; skipped?: string; error?: string; tokensBefore?: number; summarizedMessages?: number; keptMessages?: number; background?: boolean }
  | { type: "context_trimmed"; retainedMessages: number; omittedMessages: number }
  | { type: "spend_limit_reached"; message: string }
  | { type: "turn_limit_reached"; message: string }
  /** `handoff`: the node running the turn left the cluster (a deploy, a drain) at a step boundary, and it continues here with nothing lost. */
  | { type: "turn_resumed" | "turn_recovered"; reason: string; handoff?: "retire" | "drain" }
  /** An event too large for the stream (`was` its type, e.g. message_end); history has the message. */
  | { type: "event_omitted"; reason: string; was?: string }
  /** With `subagents: true`: a delegate (or spawn_agent, `background`) call started (or found) its child agent `agentId`, running request `requestId`. */
  | { type: "subagent_start"; toolCallId: string; agentId: string; requestId: string; name: string; depth: number; background?: true }
  /** With `subagents: true`: one of the child's events (its streamed text left out); a grandchild's arrive nested in its child's. */
  | { type: "subagent_event"; toolCallId: string; agentId: string; event: AgentEvent }
  /** With `subagents: true`: the child's run ended, and how; a background child's as its notification lands (or a wait_agent takes it). */
  | { type: "subagent_end"; toolCallId: string; agentId: string; requestId: string; status: "completed" | "input_required" | "failed" | "aborted"; error?: string; name?: string; background?: true }
  /** With `subagents: true`: a background sub-agent messaged its parent (send_message). */
  | { type: "subagent_message"; agentId: string; name: string; text: string }
  /** The stream could not replay what was missed: recover from state (the SDK does). */
  | { type: "replay_gap"; cursor: number }
  /** Where the stream could not replay: the running turn as of now, to fold from. */
  | { type: "snapshot"; cursor: number; requestId: string | null; turn: { start: number | null; count: number; messages: Message[]; partial: AssistantMessage | null; truncated?: true } | null };
