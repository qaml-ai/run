/**
 * Vendored from @earendil-works/pi-agent-core 0.87.1, src/harness/compaction/compaction.ts (its token estimates only)
 * (https://github.com/earendil-works/pi, tag v0.87.1), MIT License, Copyright (c) 2025 Mario Zechner. Pi 1.0 removed its
 * harness; the runtime's own compactor that used the rest is gone, as Pi durable compacts natively.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";

/** Calculate total context tokens from provider usage. */
export function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function getAssistantUsage(msg: AgentMessage): Usage | undefined {
  if (msg.role === "assistant" && "usage" in msg) {
    const assistantMsg = msg as AssistantMessage;
    if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage && calculateContextTokens(assistantMsg.usage) > 0) return assistantMsg.usage;
  }
  return undefined;
}

/** Estimated context-token usage for a message list. */
export interface ContextUsageEstimate {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  /** Index of the message that provided usage, or null when none exists. */
  lastUsageIndex: number | null;
}

/** Estimate context tokens for messages using provider usage when available. */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
  let usageInfo: { usage: Usage; index: number } | undefined;
  for (let i = messages.length - 1; i >= 0 && !usageInfo; i--) {
    const usage = getAssistantUsage(messages[i]);
    if (usage) usageInfo = { usage, index: i };
  }
  if (!usageInfo) {
    let estimated = 0;
    for (const message of messages) estimated += estimateTokens(message);
    return { tokens: estimated, usageTokens: 0, trailingTokens: estimated, lastUsageIndex: null };
  }
  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (let i = usageInfo.index + 1; i < messages.length; i++) trailingTokens += estimateTokens(messages[i]);
  return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
}

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
  if (typeof content === "string") return content.length;
  let chars = 0;
  for (const block of content) {
    if (block.type === "text" && block.text) chars += block.text.length;
    else if (block.type === "image") chars += ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}

/** Estimate token count for one message using a conservative character heuristic. */
export function estimateTokens(message: AgentMessage): number {
  let chars = 0;
  switch (message.role) {
    case "user":
      return Math.ceil(estimateTextAndImageContentChars((message as { content: string | Array<{ type: string; text?: string }> }).content) / 4);
    case "assistant": {
      for (const block of (message as AssistantMessage).content) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "thinking") chars += block.thinking.length;
        else if (block.type === "toolCall") chars += block.name.length + safeJsonStringify(block.arguments).length;
      }
      return Math.ceil(chars / 4);
    }
    case "toolResult":
      return Math.ceil(estimateTextAndImageContentChars(message.content) / 4);
    case "compactionSummary":
      return Math.ceil(message.summary.length / 4);
  }
  return 0;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}
