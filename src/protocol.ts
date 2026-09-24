import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

import type { ToolDefinition } from "../shared/client-protocol.ts";
export type { ToolDefinition };
export interface ToolBridge {
  definitions: ToolDefinition[];
  call(name: string, args: Record<string, unknown>, signal: AbortSignal, context?: { toolCallId: string }): Promise<unknown>;
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
  /** The transcript is `transcript.jsonl` in `directory`, which may hold a version-1 snapshot to import. */
  localTranscript?: boolean;
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
