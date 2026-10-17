import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { openRouterRouting, type OpenRouterRouting } from "./pi-catalog.ts";

/**
 * DeepSeek's own API, reasoning on, refuses a conversation in which an assistant message has no `reasoning_content`:
 * "The `reasoning_content` in the thinking mode must be passed back to the API" (a 400, `invalid_prompt`). OpenRouter
 * serves DeepSeek's models from several hosts and only DeepSeek's own asks this, so the history must carry it whichever
 * host answered before.
 *
 * OpenRouter's Responses API gives a host no `reasoning_content` for a turn without a reasoning item (a host that sent
 * none, a turn made with reasoning off), so DeepSeek's models are called on its Chat Completions API, Pi's own API for
 * them, where Pi gives every assistant message its `reasoning_content`: its reasoning text, or an empty one when it had
 * none (compat `requiresReasoningContentOnAssistantMessages`, on these models' catalog entries). `deepseekContext`
 * makes the history so: every earlier DeepSeek turn on OpenRouter (whichever API, model id or host made it) replays its
 * reasoning text.
 */
export const REASONING_REPLAY_REFUSAL = "`reasoning_content` in the thinking mode must be passed back";
/** OpenRouter's name for DeepSeek's own endpoint, in a request's `provider.ignore`. */
const DEEPSEEK_HOST = "deepseek";
const DEEPSEEK_ID = /^~?deepseek\//;
const COMPLETIONS = "openai-completions" as Api;

/** Whether a failed response is DeepSeek's own API refusing history without reasoning. */
export function refusedReasoningReplay(errorMessage: string | undefined): boolean {
  return !!errorMessage?.includes(REASONING_REPLAY_REFUSAL);
}

/** Whether a model is a DeepSeek model of the OpenRouter catalog whose own API asks every assistant turn's reasoning back. */
export function deepseekOnOpenRouter(model: Pick<Model<Api>, "provider" | "id" | "compat">): boolean {
  return model.provider === "openrouter" && DEEPSEEK_ID.test(model.id)
    && (model.compat as { requiresReasoningContentOnAssistantMessages?: boolean } | undefined)?.requiresReasoningContentOnAssistantMessages === true;
}

/** The model a call is made with: a DeepSeek model on OpenRouter on its Chat Completions API (an agent made earlier holds Responses). */
export function deepseekTarget<T extends Model<Api>>(model: T): T {
  return deepseekOnOpenRouter(model) && model.api !== COMPLETIONS ? { ...model, api: COMPLETIONS } : model;
}

/** A tool call id as Chat Completions takes it: a Responses `call_id|item_id` pair is its call id, kept unique in its turn. */
function callId(id: string, taken: Set<string>): string {
  if (!id.includes("|")) return id;
  const base = id.slice(0, id.indexOf("|")).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 36) || "call";
  let candidate = base;
  for (let n = 2; taken.has(candidate); n++) candidate = `${base}_${n}`;
  return candidate;
}

/**
 * A call's history as DeepSeek's own API takes it, for a DeepSeek model on OpenRouter's Chat Completions API (`model`,
 * from deepseekTarget): each earlier assistant turn of a DeepSeek model on OpenRouter counts as this model's on this
 * API, so Pi gives its reasoning back as `reasoning_content` (a Responses reasoning item's text; an empty one for a turn
 * with none), and Responses tool call ids become Chat Completions' (their results' too). Any other history is as it was.
 */
export function deepseekContext(model: Model<Api>, context: Context): Context {
  if (!deepseekOnOpenRouter(model) || model.api !== COMPLETIONS) return context;
  const ids = new Map<string, string>();
  const messages = context.messages.map(message => {
    if (message.role === "toolResult") return ids.has(message.toolCallId) ? { ...message, toolCallId: ids.get(message.toolCallId)! } : message;
    if (message.role !== "assistant" || message.provider !== "openrouter" || !DEEPSEEK_ID.test(message.model)) return message;
    const taken = new Set<string>();
    const content = message.content.map(block => {
      if (block.type === "thinking") return block.redacted ? block : { ...block, thinkingSignature: "reasoning_content" };
      if (block.type !== "toolCall") return block;
      const id = callId(block.id, taken);
      taken.add(id);
      if (id === block.id) return block;
      ids.set(block.id, id);
      return { ...block, id };
    });
    return { ...message, api: model.api, model: model.id, content };
  });
  return { ...context, messages };
}

/**
 * A request to OpenRouter with the platform's provider routing for its model (OPENROUTER_ROUTING), under any the request
 * already has, and, when `avoid` (DeepSeek's own endpoint refused the agent's history once anyway), kept off that
 * endpoint for a DeepSeek model that reasons: `provider.ignore` gets it and `order` loses it, so the retry and later
 * calls go to another host. Any other request is as it was.
 */
export function openRouterPayload(model: Model<Api>, payload: unknown, avoid: boolean): unknown {
  if (model.provider !== "openrouter" || !payload || typeof payload !== "object") return payload;
  const request = payload as { reasoning?: { effort?: string }; provider?: OpenRouterRouting };
  const routing = openRouterRouting(model.id);
  let provider: OpenRouterRouting | undefined = routing || request.provider ? { ...routing, ...request.provider } : undefined;
  const reasons = !!request.reasoning?.effort && request.reasoning.effort !== "none";
  if (avoid && reasons && deepseekOnOpenRouter(model)) {
    const order = provider?.order?.filter(name => name !== DEEPSEEK_HOST);
    provider = { ...provider, ignore: [...new Set([...(provider?.ignore ?? []), DEEPSEEK_HOST])], ...(order ? { order } : {}) };
    if (!provider.order?.length) delete provider.order;
  }
  return provider ? { ...request, provider } : payload;
}
