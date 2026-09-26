import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

import type { ToolDefinition } from "../shared/client-protocol.ts";
export type { ToolDefinition };
import type { SearchHit, SearchQuery } from "./tool-search.ts";
export interface ToolBridge {
  definitions: ToolDefinition[];
  call(name: string, args: Record<string, unknown>, signal: AbortSignal, context?: { toolCallId: string }): Promise<unknown>;
  /** Why the agent's tenant may not spend more on models, if it has reached a limit. */
  spendLimit?(): Promise<string | undefined> | string | undefined;
  /** Answer a `tools.search` query over the agent's code-mode tools, with the operator's rerankers. */
  search?(query: SearchQuery): Promise<SearchHit[]>;
  /** A file reference's bytes (base64), for a model request that shows the file. */
  file?(ref: unknown): Promise<string>;
  /** js_exec's `fs` (`op` is readFile, writeFile, stat, list or remove), answered by the runtime's file tools over the agent's mounts. */
  fs?(op: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
export interface AgentConfig {
  id: string;
  directory: string;
  model: Model<Api>;
  apiKey?: string;
  systemPrompt?: string;
  tools: ToolDefinition[];
  initialMessages?: AgentMessage[];
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
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
