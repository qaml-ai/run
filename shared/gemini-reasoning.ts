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

/** A call this applies to: Gemini through OpenRouter. Any other model keeps its reasoning, whatever Gemini refused. */
export function geminiOnOpenRouter(model: { provider: string; id: string }): boolean {
  return model.provider === "openrouter" && model.id.startsWith("google/");
}

/**
 * What an agent remembers of a refusal (both backends): the time of the last one, for the model it was refused on. Its
 * later Gemini calls drop the encrypted reasoning of turns written before that time, up front, without paying the refused
 * request again: the history keeps those signatures until compaction. Turns written since keep theirs (one written by
 * another provider again is refused again, and the time moves on). Cleared when the agent's model changes.
 */
export class ReasoningDrop {
  private before = 0;
  private model?: string;
  /** The agent's model now: a change clears what was learned. */
  model_(reference: string | undefined) { if (reference !== this.model) { this.model = reference; this.before = 0; } }
  refused(at = Date.now()) { this.before = at; }
  /** The history as a call to `target` sends it. */
  context<T extends Pick<Context, "messages">>(target: { provider: string; id: string }, context: T): T {
    return this.before && geminiOnOpenRouter(target) ? withoutReplayedReasoning(context, this.before) : context;
  }
  get active() { return this.before > 0; }
}

/**
 * The context with every assistant turn's replayed reasoning dropped (thinking signatures, tool calls' thought
 * signatures): what both providers accept. The model loses its earlier turns' encrypted thoughts, not their text, calls
 * or results.
 */
export function withoutReplayedReasoning<T extends Pick<Context, "messages">>(context: T, before = Infinity): T {
  let changed = false;
  const messages = context.messages.map(message => {
    if (message.role !== "assistant" || !((message.timestamp ?? 0) < before)) return message;
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
