import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { renderMessages } from "../sender.ts";

export const DIGEST_TOKENS = 20_000;
export type ContextAside = { before?: number; runs: number[]; task?: string; digests?: Record<string, string> };

/** Keep the prompt and final reply, without reasoning or intermediate tool calls. */
export function runDigest(prompt: AgentMessage | undefined, messages: readonly AgentMessage[], budget = DIGEST_TOKENS): string {
  const reply = renderMessages([...messages]).findLast(message => message.role === "assistant");
  const text = (message: AgentMessage | undefined) => !message || !("content" in message) ? "" : typeof message.content === "string" ? message.content :
    message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
  const input = text(prompt && renderMessages([prompt])[0]), output = text(reply) || JSON.stringify(reply?.content.flatMap(part => part.type === "toolCall" && part.name === "final_output" ? [part.arguments] : [])[0] ?? "");
  const chars = Math.max(0, (budget - 32) * 3);
  const inputChars = Math.min(input.length, Math.max(chars - output.length, Math.floor(chars / 2)));
  return `History-none run\nPrompt: ${input.slice(0, inputChars)}\nFinal reply: ${output.slice(0, chars - inputChars)}`;
}

/** Newest first; both the stored runs and the restored messages fit this budget. */
export function boundedDigests(contents: readonly string[]): AgentMessage[] {
  const messages: AgentMessage[] = [];
  let remaining = DIGEST_TOKENS;
  for (const content of contents) {
    const message: AgentMessage = { role: "user", content, timestamp: 0 };
    const tokens = estimateMessageTokens(message);
    if (tokens > remaining) break;
    messages.push(message); remaining -= tokens;
  }
  return messages;
}
