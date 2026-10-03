/**
 * Vendored from @earendil-works/pi-agent-core 0.87.1, src/harness/messages.ts
 * (https://github.com/earendil-works/pi, tag v0.87.1), MIT License, Copyright (c) 2025 Mario Zechner.
 * Pi 1.0 removed its harness; the runtime keeps the part its transcripts use: the compaction summary
 * message, stored by 0.87.1 and earlier, and its rendering for the model. Bash, custom and branch
 * summary messages, which the runtime never writes, are left out.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    compactionSummary: CompactionSummaryMessage;
  }
}

export function createCompactionSummaryMessage(summary: string, tokensBefore: number, timestamp: string | number): CompactionSummaryMessage {
  return {
    role: "compactionSummary",
    summary,
    tokensBefore,
    timestamp: typeof timestamp === "number" ? timestamp : new Date(timestamp).getTime(),
  };
}

/** The model's messages: a compaction summary becomes a user message, and roles the model does not take are dropped. */
export function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages
    .map((m): Message | undefined => {
      switch (m.role) {
        case "compactionSummary":
          return {
            role: "user",
            content: [{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX }],
            timestamp: m.timestamp,
          };
        case "system":
        case "user":
        case "assistant":
        case "toolResult":
          return m;
        default:
          return undefined;
      }
    })
    .filter((m): m is Message => m !== undefined);
}
