import type { AssistantMessage, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ModelIdleCache } from "./model-idle-compaction-payload.ts";

export const IDLE_COMPACTION_CALL = Symbol("idleCompactionCall");
export const IDLE_COMPACTION_SKIPPED = "Idle compaction skipped";
export const IDLE_SUMMARY_PROMPT = "Write a concise context checkpoint that another assistant can use to resume this conversation. Summarize the earlier history, preserving the user's goals and constraints, decisions, completed work, and pending work. Include exact paths, identifiers, and errors when they matter. Recent messages are retained separately. Only output the checkpoint. Do not continue the task or call tools.";

/** Request settings that affect the provider's prompt, without credentials or transport callbacks. */
export type IdleRequestOptions = Pick<SimpleStreamOptions,
  "reasoning" | "thinkingBudgets" | "temperature" | "samplingParams" | "cacheRetention" | "sessionId">;

export type CachedRequest = {
  cache: ModelIdleCache;
  keyHash: string;
  sessionId: string;
  at: number;
  cachedTokens: number;
  retention?: SimpleStreamOptions["cacheRetention"];
  route: { provider: string; id: string; serviceTier?: string };
  options: IdleRequestOptions;
};

export type IdleCompactionDispatch = {
  [IDLE_COMPACTION_CALL]?:
    | { capture: (request: CachedRequest, message: AssistantMessage) => void | Promise<void> }
    | { replay: CachedRequest; stillIdle: () => boolean | Promise<boolean> };
};

export function idleRequestOptions(options: SimpleStreamOptions): IdleRequestOptions {
  const { reasoning, thinkingBudgets, temperature, samplingParams, cacheRetention, sessionId } = options;
  return structuredClone({ reasoning, thinkingBudgets, temperature, samplingParams, cacheRetention, sessionId });
}
