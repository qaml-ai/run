import type { ModelAttemptHook } from "./model-attempt.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

import type { ToolDefinition } from "../shared/client-protocol.ts";
export type { ToolDefinition };
import type { SearchHit, SearchQuery } from "./tool-search.ts";
/** Which model tool call a tool call belongs to: its own, or for a call from js_exec, the js_exec call's and the call's id within it. */
/** A tool call from the model: its id, its place in js_exec's code if made there, and the history index of the assistant message that made it. */
export type CallContext = { toolCallId: string; innerCallId?: string; messageIndex?: number };
import type { HistoryChunk } from "./history-pages.ts";
import type { CommitEffect } from "../shared/append-log.ts";
/** The least `runLimits.contextTokens` may be: below it, a summary and the recent messages it keeps would not fit. */
export const MIN_CONTEXT_TOKENS = 20_000;
/**
 * The most one run may take (model responses, seconds), and how long one of its model requests may go quiet: before its
 * first token (`firstTokenSeconds`) and between events once it streams (`idleSeconds`; model-stream.ts). `contextTokens`:
 * the most context one request carries, which compaction keeps it within as it does the model's window (agent-host.ts).
 */
export type RunLimits = { maxResponses?: number; maxSeconds?: number; firstTokenSeconds?: number; idleSeconds?: number; contextTokens?: number };
/**
 * Why a turn ended early on a limit: spend (the agent's, the run's or the tenant's), or the run's responses or time.
 * `handoff`: its node is leaving the cluster (a deploy retiring it, or a drain), so the turn stops at this step boundary
 * and the next owner continues it from the transcript.
 */
/**
 * Why a turn must end: `limit` says which spend limit stopped it (the run's own, its agent's, the tenant's monthly cap,
 * the account's prepaid credit, or its end user's credit: then `code` is end_user_credit and `reason` says why).
 */
/**
 * Why a running turn ends before its next model request. A limit's stop carries its `code` (end_user_credit,
 * spend_limit), the limit reached, and for an end user's credit why (`reason`), whose (`endUser`) and which `bucket`.
 */
export type RunStop = { stopped: "spend_limit" | "turn_limit" | "handoff"; message: string; limit?: "run" | "agent" | "tenant" | "credit" | "end_user"; code?: string; reason?: string; bucket?: string; endUser?: string };
export interface ToolBridge {
  definitions: ToolDefinition[];
  call(name: string, args: Record<string, unknown>, signal: AbortSignal, context?: CallContext): Promise<unknown>;
  /** Why the running turn must end before its next model request: a spend limit reached, the run's own limits, or its node leaving (`RunStop`). */
  runLimit?(): Promise<RunStop | undefined> | RunStop | undefined;
  /** Answer a `tools.search` query over the agent's code-mode tools, with the operator's rerankers. */
  search?(query: SearchQuery): Promise<SearchHit[]>;
  /** A file reference's bytes (base64), for a model request that shows the file. */
  file?(ref: unknown): Promise<string>;
  /** An inline image (`{data, mimeType}`) saved to the agent's writable mount, as a file reference (AGENT_PI_IMAGE_REFS_TENANTS). */
  saveImage?(image: unknown): Promise<unknown>;
  /** Credentials for one model call, for an agent whose key is `IDENTITY_KEY` or `SCOPE_KEY`. */
  modelAuth?(): Promise<Credentials>;
  /** Durable provider-call identity and usage, acknowledged before dispatch/completion. */
  modelAttempt?: ModelAttemptHook;
  /** js_exec's `fs` (`op` is readFile, writeFile, stat, list or remove), answered by the runtime's file tools over the agent's mounts. */
  fs?(op: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  /** The agent's history index (history-pages.ts): how many messages it has, and writing a chunk where it ends (returning where it ends then). */
  history?: { indexed(): Promise<number | null>; write(chunk: HistoryChunk): Promise<number> };
  /** Events of work the agent does apart from any run (`background: true`: a background compaction's), which reach no run's stream. */
  background?(event: any): void;
  /** Wait for the tenant's turn to run js_exec on this node (codemode.ts `CodeGate`), until `signal` aborts; resolves with the function that gives it back. */
  codeSlot?(signal: AbortSignal): Promise<() => void>;
  /** Wait until this node may act for the agent (`Ownership.whenFresh`), before a model request or js_exec; rejects once it lost the agent. */
  lease?(): Promise<void>;
  /** What commits with a journal entry, in the transaction that writes it (a model response's spend): called as it is committed. */
  committing?(entry: import("@earendil-works/pi-durable").EntryRecord): CommitEffect | undefined;
}
/** The `apiKey` of an agent whose model is on its tenant's own endpoint: each call gets a fresh identity token instead (`ToolBridge.modelAuth`). */
/** How an error says the agent's storage failed a write: nothing more is written until a reload reads what it holds. */
export const PERSISTENCE_FAILED = "Session persistence failed";
/** The most serialized journal data a host may load as Pi context. */
export const CONTEXT_RANGE_MAX_BYTES = 128 * 1024 * 1024;
export const CONTEXT_TOO_LARGE = "context_too_large";
export const contextRangeMessage = (bytes: number, max: number) =>
  `This agent's context since its last compaction is ${bytes} bytes, past the ${max} bytes a run can load; start a new agent with a summary of the history, or ask the operator to raise AGENT_CONTEXT_RANGE_MAX_BYTES.`;
/** A model request lost every user message, so the turn must fail before calling the provider. */
export const CONTEXT_LOST = "context_lost";
/** A host refused an agent whose history is still only in the legacy format, which no release imports any more. */
export const NOT_MIGRATED = "AGENT_NOT_MIGRATED";
export const IDENTITY_KEY = "agent-runtime:identity-token";
/** The `apiKey` of an agent with a key scope: each call reads the scope's current entry (`ToolBridge.modelAuth`), so a rotated key applies at once. */
export const SCOPE_KEY = "agent-runtime:key-scope";
/**
 * What one model call authenticates with: a key, or a tenant endpoint's identity token (`identity`).
 * A key scope's entry may also put an endpoint in front of the provider (`baseUrl`), add `headers`,
 * and name Bedrock's `region`.
 */
/** `bearer`: plain `Authorization: Bearer` instead of `x-api-key`, without Pi's subscription OAuth behavior (Anthropic federation or a gateway). */
/** `deployments`: for the platform's Azure OpenAI resource (whose v1 API root is `baseUrl`), each azure model's deployment. */
export type Credentials = { apiKey: string; platform?: boolean; identity?: boolean; baseUrl?: string; headers?: Record<string, string>; region?: string; bearer?: true; deployments?: Record<string, string> };
export interface AgentConfig {
  id: string;
  directory: string;
  model: Model<Api>;
  apiKey?: string;
  systemPrompt?: string;
  /** Text after the system prompt, the agent's own: a definition's apply replaces the prompt and keeps this. */
  systemPromptAppend?: string;
  tools: ToolDefinition[];
  /** false: the model gets no file tools but present_file; its mounts stay open to fs in js_exec. */
  fileTools?: boolean;
  /**
   * false: no js_exec. The model calls every tool directly, and its prompt carries only the runtime text its tools need
   * (none for an agent without tools): for a tool-less agent, or one with a few tools of its own.
   */
  codeMode?: boolean;
  /** Where the agent's volumes are mounted, for its prompt's summary of its environment; `workspace` marks its own. */
  mounts?: { path: string; mode: "ro" | "rw"; workspace?: boolean }[];
  initialMessages?: AgentMessage[];
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** The most the model writes in one response, within its own maximum; null or absent: the model's maximum. */
  maxOutputTokens?: number | null;
  /** The model's sampling temperature (0 to 2), sent only on calls without reasoning (session-config.ts `callSettings`); null or absent: the provider's default. */
  temperature?: number | null;
  /** "deny": its OpenRouter calls go only to hosts that do not collect their data (`provider.data_collection`); null or absent: OpenRouter's default. */
  dataCollection?: "deny" | null;
  /** The most one run may take, set by the tenant: model responses and seconds. The runtime's maximums apply over them (client-sessions.ts). */
  runLimits?: RunLimits | null;
  /** Headers the tenant set for every model call of this agent (non-secret, never auth headers). */
  modelHeaders?: Record<string, string> | null;
  /** Host policy for retrying transient provider errors. */
  retry?: { maxAttempts: number; baseDelayMs: number };
  /** The runtime's timeouts for a model stream that goes quiet (model-stream.ts), set by the runtime; an agent's `runLimits` may set its own. */
  streamTimeouts?: { firstTokenMs?: number; idleMs?: number };
  /** Runtime bound on the serialized Pi context range, including entries hidden from model messages. */
  contextRangeMaxBytes?: number;
  /** A run that began elsewhere will resume: leave an interrupted turn open to continue it. */
  resume?: boolean;
  /** The agent's tenant, set by the runtime, for its metric lines. */
  tenant?: string;
  /** The tenant's js_exec limits, set by the runtime (never the agent's configuration): CPU per execution, the longest timeoutMs, and the engine. */
  codeLimits?: { cpuMs: number; maxTimeoutMs: number };
}
export type WireMessage =
  | { type: "request"; id: string; method: string; params: any }
  | { type: "response"; id: string; result?: any; error?: string }
  | { type: "event"; event: any };

/**
 * Where an agent keeps files of its own (attachments, tool outputs, scratch): its own workspace volume wherever it is
 * mounted (`workspace`), else a writable /workspace, else its first writable mount.
 */
export function scratchMount<M extends { path: string; mode: "ro" | "rw"; workspace?: boolean }>(mounts: M[] | undefined): M | undefined {
  return mounts?.find(mount => mount.workspace && mount.mode === "rw") ?? mounts?.find(mount => mount.path === "/workspace" && mount.mode === "rw") ?? mounts?.find(mount => mount.mode === "rw");
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
