import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * DeepSeek's own API, reasoning on, refuses a conversation with an assistant turn that carries no reasoning: "The
 * `reasoning_content` in the thinking mode must be passed back to the API" (a 400, `invalid_prompt`). OpenRouter serves
 * DeepSeek's models from several hosts, and only DeepSeek's own asks this: a turn another host answered without
 * reasoning (or one made with reasoning off) is history it then refuses, on every later call routed there.
 */
export const REASONING_REPLAY_REFUSAL = "`reasoning_content` in the thinking mode must be passed back";
/** OpenRouter's name for DeepSeek's own endpoint, in a request's `provider.ignore`. */
const DEEPSEEK_HOST = "deepseek";

/** Whether a failed response is DeepSeek's own API refusing history without reasoning. */
export function refusedReasoningReplay(errorMessage: string | undefined): boolean {
  return !!errorMessage?.includes(REASONING_REPLAY_REFUSAL);
}

/** Whether an OpenRouter call is to a DeepSeek model whose own API asks every assistant turn's reasoning back. */
function deepseekOnOpenRouter(model: Model<Api>): boolean {
  return model.provider === "openrouter" && /^~?deepseek\//.test(model.id)
    && (model.compat as { requiresReasoningContentOnAssistantMessages?: boolean } | undefined)?.requiresReasoningContentOnAssistantMessages === true;
}

/** Items of a Responses API input the assistant made: its reasoning, tool calls and messages. */
const assistantItem = (item: any) => item?.type === "reasoning" || item?.type === "function_call" || item?.type === "custom_tool_call"
  || (item?.type === "message" && item.role === "assistant");

/** Whether some assistant turn in a Responses API input has no reasoning item. */
export function turnWithoutReasoning(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  let inTurn = false, reasoned = false;
  for (const item of input) {
    if (!assistantItem(item)) {
      if (inTurn && !reasoned) return true;
      inTurn = reasoned = false;
      continue;
    }
    inTurn = true;
    if (item.type === "reasoning") reasoned = true;
  }
  return inTurn && !reasoned;
}

/**
 * A Responses API request to OpenRouter as DeepSeek's own endpoint takes it: kept from that endpoint (`provider.ignore`)
 * when it reasons and some assistant turn has no reasoning to give back (which that endpoint refuses), or when `avoid`
 * (the agent's last call there was refused anyway). Any other request is as it was.
 */
export function deepseekPayload(model: Model<Api>, payload: unknown, avoid = false): unknown {
  if (!deepseekOnOpenRouter(model) || !payload || typeof payload !== "object") return payload;
  const request = payload as { reasoning?: { effort?: string }; input?: unknown; provider?: { ignore?: string[] } };
  const reasons = !!request.reasoning?.effort && request.reasoning.effort !== "none";
  if (!reasons || !(avoid || turnWithoutReasoning(request.input))) return payload;
  const ignore = [...new Set([...(request.provider?.ignore ?? []), DEEPSEEK_HOST])];
  return { ...request, provider: { ...request.provider, ignore } };
}
