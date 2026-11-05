// Generated from src/compaction.ts; source function/body unchanged.
import type { Api, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { estimateTokens } from "./money-tokens.ts";
export function estimateModelAttempt(model: Model<Api>, context: TranscriptContext, options: { maxTokens?: number }) {
    const input = () => Math.min(model.contextWindow, context.messages.reduce((sum, message) => sum + (message.role === "system"
      ? Math.ceil(JSON.stringify(message).length / 4) : estimateTokens(message)), 0));
    // The prefix the previous response read from or wrote to the provider's cache is likely read from it now, at its rate.
    const previous = context.messages.findLast(message => message.role === "assistant")?.usage;
    const inputTokens = input(), cachedTokens = Math.min(inputTokens, (previous?.cacheRead ?? 0) + (previous?.cacheWrite ?? 0));
    const estimate = { inputTokens, ...(cachedTokens > 0 ? { cachedTokens } : {}), maxOutputTokens: options.maxTokens ?? model.maxTokens, rates: { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead } };
    return estimate;
}
