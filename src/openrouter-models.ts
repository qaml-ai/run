import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { safeError } from "./metrics.ts";

/**
 * OpenRouter's own list of models (GET /api/v1/models), for the ones Pi's catalog lacks: a model released since the
 * vendored Pi was built works without a catalog entry. Pi's entry wins where there is one (it carries long-context
 * tiers and our corrections, pi-catalog.ts). A call is billed what OpenRouter reports; these prices set estimates and holds.
 *
 * Held in memory: loaded when a node starts and hourly, in the background, so nothing waits on it, and again when
 * a request names a model it lacks (`ensureOpenRouterModel`), at most once a minute. A list that never loads leaves Pi's
 * catalog as it was, and an agent keeps the model it was made with.
 */
const COMPLETIONS_URL = "https://openrouter.ai/api/v1", MESSAGES_URL = "https://openrouter.ai/api";
export const OPENROUTER_MODELS_URL = `${COMPLETIONS_URL}/models`;
const REFRESH_MS = 60 * 60_000, MISS_REFRESH_MS = 60_000;
/** The longest reply of a model that lists none: OpenRouter routes a call only to hosts that serve what it asks. */
const UNLISTED_MAX_OUTPUT = 32_000;
/** A router's price depends on where it sends each call (OpenRouter lists -1): held as a mid-range model's (UNPRICED_COST in platform-pricing.ts). */
const VARIABLE_PRICE = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

type Listing = {
  id?: unknown; name?: unknown; context_length?: unknown; supported_parameters?: unknown;
  architecture?: { input_modalities?: unknown; output_modalities?: unknown };
  top_provider?: { max_completion_tokens?: unknown }; reasoning?: { supported_efforts?: unknown; mandatory?: unknown } | null;
  pricing?: { prompt?: unknown; completion?: unknown; input_cache_read?: unknown; input_cache_write?: unknown };
};

let listed = new Map<string, Model<Api>>();
let refused = new Map<string, string>();
const strings = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
/** USD per token as OpenRouter lists it, in USD per million tokens. */
const perMillion = (value: unknown, otherwise: number) => {
  const price = Number(value);
  return value === undefined || value === null || !Number.isFinite(price) || price < 0 ? otherwise : Math.round(price * 1e15) / 1e9;
};

function listedCost(pricing: NonNullable<Listing["pricing"]>): Model<Api>["cost"] {
  if (Number(pricing.prompt) < 0 || Number(pricing.completion) < 0) return { ...VARIABLE_PRICE };
  const input = perMillion(pricing.prompt, VARIABLE_PRICE.input);
  // No cache price listed: a cached token is estimated at the input price, not free.
  return { input, output: perMillion(pricing.completion, VARIABLE_PRICE.output), cacheRead: perMillion(pricing.input_cache_read, input), cacheWrite: perMillion(pricing.input_cache_write, 0) };
}

/** The levels a model takes, from the efforts OpenRouter lists: off only where `none` is one. No efforts listed: Pi's default mapping. */
function thinkingLevels(efforts: string[]): Model<Api>["thinkingLevelMap"] {
  if (!efforts.length) return undefined;
  return { off: efforts.includes("none") ? "none" : null, ...Object.fromEntries(LEVELS.map(level => [level, efforts.includes(level) ? level : null])) };
}

/** A listing as Pi's model, as Pi's catalog writes OpenRouter's entries; why it cannot run an agent otherwise; undefined when it is not a model. */
function fromListing(entry: Listing): Model<Api> | string | undefined {
  const { id, context_length: context } = entry;
  if (typeof id !== "string" || !id.includes("/") || typeof context !== "number" || !(context > 0)) return undefined;
  const parameters = strings(entry.supported_parameters);
  if (!parameters.includes("tools")) return "OpenRouter lists no tool support for it, and an agent needs tools";
  if (!strings(entry.architecture?.output_modalities ?? ["text"]).includes("text")) return "OpenRouter lists no text output for it";
  const anthropic = id.startsWith("anthropic/");
  const reasoning = parameters.includes("reasoning");
  const efforts = reasoning ? strings(entry.reasoning?.supported_efforts) : [];
  const longest = entry.top_provider?.max_completion_tokens;
  const thinkingLevelMap = thinkingLevels(efforts);
  return {
    id, name: typeof entry.name === "string" ? entry.name : id, provider: "openrouter", reasoning,
    api: anthropic ? "anthropic-messages" : "openai-completions", baseUrl: anthropic ? MESSAGES_URL : COMPLETIONS_URL,
    input: strings(entry.architecture?.input_modalities).includes("image") ? ["text", "image"] : ["text"],
    cost: listedCost(entry.pricing ?? { prompt: -1 }), contextWindow: context,
    maxTokens: typeof longest === "number" && longest > 0 ? longest : Math.min(UNLISTED_MAX_OUTPUT, context),
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    compat: {
      ...(parameters.includes("temperature") ? {} : { supportsTemperature: false }),
      ...anthropic ? { forceAdaptiveThinking: true } : {
        thinkingFormat: "openrouter", supportsStrictMode: true, sendSessionAffinityHeaders: true,
        ...(id.startsWith("openai/") ? {} : { supportsDeveloperRole: false }),
        // DeepSeek's own API refuses history without its reasoning (deepseek-replay.ts).
        ...(/^~?deepseek\//.test(id) ? { requiresReasoningContentOnAssistantMessages: true } : {}),
      },
    },
  } as Model<Api>;
}

/** Replace the list with OpenRouter's answer (`{data: [...]}`); an answer with no models leaves it. */
export function setOpenRouterModels(answer: unknown): number {
  const data = (answer as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || !data.length) return 0;
  const models = new Map<string, Model<Api>>(), reasons = new Map<string, string>();
  for (const entry of data as Listing[]) {
    const made = fromListing(entry ?? {});
    if (typeof made === "string") reasons.set(entry.id as string, made);
    else if (made) models.set(made.id, made);
  }
  listed = models; refused = reasons;
  return models.size;
}

/** A model OpenRouter lists that can run an agent. */
export const listedOpenRouterModel = (id: string): Model<Api> | undefined => listed.get(id);
export const listedOpenRouterModels = (): Model<Api>[] => [...listed.values()];
/** Why a model OpenRouter lists cannot run an agent. */
export const openRouterRefusal = (id: string): string | undefined => refused.get(id) ?? refused.get(id.replace(/:[a-z]+$/, ""));

let source: { url: string; fetch: typeof fetch } | undefined, loading: Promise<void> | undefined, loadedAt = 0, timer: ReturnType<typeof setInterval> | undefined;

function load(): Promise<void> {
  return loading ??= (async () => {
    if (!source) return;
    loadedAt = Date.now();
    try {
      const response = await source.fetch(source.url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const count = setOpenRouterModels(await response.json());
      console.error(JSON.stringify({ type: "openrouter_models_loaded", count }));
    } catch (error) {
      console.error(JSON.stringify({ type: "openrouter_models_failed", error: safeError(error) }));
    }
  })().finally(() => { loading = undefined; });
}

/** Keep the list loaded from `url`, from now on: an empty url (AGENT_OPENROUTER_MODELS_URL="") never loads it. */
export function startOpenRouterModels(url: string, fetcher: typeof fetch) {
  if (!url || timer) return;
  source = { url, fetch: fetcher };
  void load();
  timer = setInterval(() => void load(), REFRESH_MS);
  timer.unref?.();
}

/**
 * For a `reference` a request names: an `openrouter/` model neither Pi's catalog nor the list has may have been released
 * since the list was loaded, so ask again before it is called unknown. `known` is the catalog's answer.
 */
export async function ensureOpenRouterModel(reference: unknown, known: (id: string) => unknown): Promise<void> {
  if (typeof reference !== "string" || !reference.startsWith("openrouter/") || !source) return;
  const id = reference.slice("openrouter/".length);
  if (known(id) || known(id.replace(/:[a-z]+$/, "")) || openRouterRefusal(id) || (!loading && Date.now() - loadedAt < MISS_REFRESH_MS)) return;
  await load();
}
