import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
type Block = AssistantMessage["content"][number];

/**
 * Gemini's encrypted reasoning (OpenRouter `reasoning_details`, `reasoning.encrypted`) is valid only on the provider
 * that produced it: a turn served by Google AI Studio (every flex call) replayed to Vertex, or one Vertex served replayed
 * to AI Studio, is refused with this 400 (probed 2026-11-12). The default tier is served by either, request to request,
 * so `camelrun/strong`'s fall back from flex to it, and any history that crossed the two, met it on every call.
 */
const REFUSAL = "Gemini models require OpenRouter reasoning details to be preserved";
export function refusedForeignReasoning(errorMessage: string | undefined): boolean {
  return !!errorMessage?.includes(REFUSAL);
}

/**
 * The context with every assistant turn's replayed reasoning dropped (thinking signatures, tool calls' thought
 * signatures): what both providers accept. The model loses its earlier turns' encrypted thoughts, not their text, calls
 * or results.
 */
export function withoutReplayedReasoning<T extends Pick<Context, "messages">>(context: T): T {
  let changed = false;
  const messages = context.messages.map(message => {
    if (message.role !== "assistant") return message;
    const content = (message as AssistantMessage).content.flatMap((block): Block[] => {
      if (block.type === "thinking" && (block.thinkingSignature || block.redacted)) {
        changed = true;
        return block.redacted || !block.thinking.trim() ? [] : [{ type: "thinking", thinking: block.thinking }];
      }
      if (block.type === "toolCall" && block.thoughtSignature) {
        changed = true;
        const { thoughtSignature: _signature, ...call } = block;
        return [call as Block];
      }
      return [block];
    });
    return { ...message, content } as typeof message;
  });
  return changed ? { ...context, messages } : context;
}
