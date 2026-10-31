import type { Api, Model } from "@earendil-works/pi-ai";
import { HttpError } from "./http.ts";
import { safeError } from "./metrics.ts";
import { network } from "./node-context.ts";

/**
 * An `openrouter/<id>` Pi's catalog lacks passes straight through, so a model released today needs no entry of ours. What
 * the runtime must know of it comes from one lookup of that model when an agent takes it, and stays with the agent
 * (`withOpenRouterDetails`). OpenRouter's reported cost is what bills either way; the price here sets estimates and holds.
 * Without a lookup these defaults stand: too small a window costs a compaction (a provider's overflow compacts and asks
 * again), too large a one is that same overflow, and the price is a mid-range model's (UNPRICED_COST, platform-pricing.ts).
 */
const DEFAULTS = { contextWindow: 128_000, maxTokens: 8_192, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
/**
 * A third of OpenRouter's models always reason and answer a 400 to reasoning turned off, and neither the lookup nor the
 * request says which: so a model that takes reasoning is asked for at least low (pi-catalog.ts `reasoningFloor`), which
 * OpenRouter takes from all of them (2026-10-30).
 */
const UNKNOWN_LEVELS = { off: null, minimal: null } as Model<Api>["thinkingLevelMap"];
const COMPLETIONS_URL = "https://openrouter.ai/api/v1", MESSAGES_URL = "https://openrouter.ai/api";

export type Passthrough = Model<Api> & { passthrough?: true };

/** A model the catalog lacks, as an agent would hold it with no lookup: OpenRouter's API for its kind, as the catalog's are. */
export function passthroughModel(id: string): Passthrough {
  const anthropic = id.startsWith("anthropic/");
  return {
    id, name: id, provider: "openrouter", api: anthropic ? "anthropic-messages" : "openai-responses", baseUrl: anthropic ? MESSAGES_URL : COMPLETIONS_URL,
    reasoning: true, thinkingLevelMap: UNKNOWN_LEVELS, input: ["text", "image"], ...DEFAULTS, passthrough: true,
    compat: anthropic ? { forceAdaptiveThinking: true } : { thinkingFormat: "openrouter", supportsStrictMode: true, sendSessionAffinityHeaders: true, ...(id.startsWith("openai/") ? {} : { supportsDeveloperRole: false }) },
  } as Passthrough;
}

type Endpoint = { context_length?: number; max_completion_tokens?: number | null; supported_parameters?: string[]; pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string } };
const perMillion = (value: string | undefined) => { const price = Number(value); return Number.isFinite(price) && price > 0 ? Math.round(price * 1e15) / 1e9 : 0; };

/**
 * A pass-through model with what OpenRouter says of it (GET /models/{id}/endpoints): the largest window, the longest reply
 * every host serves (it skips a host that serves less than a call asks for), and the dearest host's prices, for holds. No
 * such model, or none with tools: a 400 with its reason. OpenRouter out of reach: the defaults, and its error at the call.
 */
export async function withOpenRouterDetails<T extends Passthrough>(model: T): Promise<T> {
  if (!model.passthrough) return model;
  const { passthrough: _, thinkingLevelMap: _levels, ...known } = model;
  const root = process.env.AGENT_OPENROUTER_API_URL ?? COMPLETIONS_URL;
  if (!root) return { ...known, thinkingLevelMap: UNKNOWN_LEVELS } as T;
  let body: { data?: { name?: string; architecture?: { input_modalities?: string[] }; endpoints?: Endpoint[] }; error?: { message?: string } }, status: number;
  try {
    const response = await network().fetch(`${root}/models/${model.id.replace(/:[a-z]+$/, "").split("/").map(encodeURIComponent).join("/")}/endpoints`, { signal: AbortSignal.timeout(5_000) });
    status = response.status;
    if (status >= 500) throw new Error(`status ${status}`);
    body = await response.json() as typeof body;
  } catch (error) {
    console.error(JSON.stringify({ type: "openrouter_model_lookup_failed", model: model.id, error: safeError(error) }));
    return { ...known, thinkingLevelMap: UNKNOWN_LEVELS } as T;
  }
  const endpoints = body.data?.endpoints ?? [];
  if (status === 404 || !endpoints.length) throw new HttpError(400, `OpenRouter has no model "${model.id}": ${body.error?.message ?? "no endpoints"}; see https://openrouter.ai/models`);
  const usable = endpoints.filter(endpoint => endpoint.supported_parameters?.includes("tools"));
  if (!usable.length) throw new HttpError(400, `Model "openrouter/${model.id}" cannot run an agent: OpenRouter lists no tool support for it`);
  const most = (pick: (endpoint: Endpoint) => number) => Math.max(0, ...usable.map(pick));
  const longest = usable.map(endpoint => endpoint.max_completion_tokens ?? 0).filter(tokens => tokens > 0);
  const parameters = new Set(usable.flatMap(endpoint => endpoint.supported_parameters ?? []));
  return {
    ...known, name: body.data?.name ?? model.id, reasoning: parameters.has("reasoning"), ...(parameters.has("reasoning") ? { thinkingLevelMap: UNKNOWN_LEVELS } : {}),
    input: body.data?.architecture?.input_modalities?.includes("image") ? ["text", "image"] : ["text"],
    contextWindow: most(endpoint => endpoint.context_length ?? 0) || DEFAULTS.contextWindow,
    maxTokens: longest.length ? Math.min(...longest) : DEFAULTS.maxTokens,
    cost: {
      input: most(endpoint => perMillion(endpoint.pricing?.prompt)), output: most(endpoint => perMillion(endpoint.pricing?.completion)),
      cacheRead: most(endpoint => perMillion(endpoint.pricing?.input_cache_read ?? endpoint.pricing?.prompt)), cacheWrite: most(endpoint => perMillion(endpoint.pricing?.input_cache_write)),
    },
    compat: { ...known.compat, ...(parameters.has("temperature") ? {} : { supportsTemperature: false }) },
  } as T;
}
