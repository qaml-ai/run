import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

import type { ToolDefinition } from "../shared/client-protocol.ts";
export type { ToolDefinition };
import type { SearchHit, SearchQuery } from "./tool-search.ts";
/** Which model tool call a tool call belongs to: its own, or for a call from js_exec, the js_exec call's and the call's id within it. */
export type CallContext = { toolCallId: string; innerCallId?: string };
import type { HistoryChunk } from "./history-pages.ts";
export interface ToolBridge {
  definitions: ToolDefinition[];
  call(name: string, args: Record<string, unknown>, signal: AbortSignal, context?: CallContext): Promise<unknown>;
  /** Why the agent's tenant may not spend more on models, if it has reached a limit. */
  spendLimit?(): Promise<string | undefined> | string | undefined;
  /** Answer a `tools.search` query over the agent's code-mode tools, with the operator's rerankers. */
  search?(query: SearchQuery): Promise<SearchHit[]>;
  /** A file reference's bytes (base64), for a model request that shows the file. */
  file?(ref: unknown): Promise<string>;
  /** Credentials for one model call, for an agent whose key is `IDENTITY_KEY` or `SCOPE_KEY`. */
  modelAuth?(): Promise<Credentials>;
  /** js_exec's `fs` (`op` is readFile, writeFile, stat, list or remove), answered by the runtime's file tools over the agent's mounts. */
  fs?(op: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  /** The agent's history index (history-pages.ts): how many messages it has, and writing a chunk where it ends (returning where it ends then). */
  history?: { indexed(): Promise<number | null>; write(chunk: HistoryChunk): Promise<number> };
}
/** The `apiKey` of an agent whose model is on its tenant's own endpoint: each call gets a fresh identity token instead (`ToolBridge.modelAuth`). */
export const IDENTITY_KEY = "agent-runtime:identity-token";
/** The `apiKey` of an agent with a key scope: each call reads the scope's current entry (`ToolBridge.modelAuth`), so a rotated key applies at once. */
export const SCOPE_KEY = "agent-runtime:key-scope";
/**
 * What one model call authenticates with: a key, or a tenant endpoint's identity token (`identity`).
 * A key scope's entry may also put an endpoint in front of the provider (`baseUrl`), add `headers`,
 * and name Bedrock's `region`.
 */
export type Credentials = { apiKey: string; identity?: boolean; baseUrl?: string; headers?: Record<string, string>; region?: string };
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
  /** Where the agent's volumes are mounted, for its prompt's summary of its environment. */
  mounts?: { path: string; mode: "ro" | "rw" }[];
  initialMessages?: AgentMessage[];
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Headers the tenant set for every model call of this agent (non-secret, never auth headers). */
  modelHeaders?: Record<string, string> | null;
  /** Host policy for retrying transient provider errors. */
  retry?: { maxAttempts: number; baseDelayMs: number };
  /** A run that began elsewhere will resume: leave an interrupted turn open to continue it. */
  resume?: boolean;
}
export type WireMessage =
  | { type: "request"; id: string; method: string; params: any }
  | { type: "response"; id: string; result?: any; error?: string }
  | { type: "event"; event: any };

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
