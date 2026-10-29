import { getModel as piGetModel, getModels as piGetModels } from "@earendil-works/pi-ai/compat";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";

const piCatalog = piGetModel as (provider: string, id: string) => Model<Api> | undefined;

/**
 * Models Pi's catalog does not have yet, by provider and id: each is the Pi entry it is a release of (`from`), with
 * what differs, checked against the provider's own model list. Drop each once Pi ships it (Pi ships GPT-6.1 Terra on
 * OpenAI, Azure and OpenRouter since the vendored commit, and OpenRouter's DeepSeek V4.1 Flash 1017 since 1.4.0):
 * - Azure DeepSeek V4.1 Flash: measured 2026-10-26 on version 2026-09-10 (preview), not OpenRouter's
 *   2026-10-17 snapshot. Chat Completions serves tools, reasoning, images and cached input. Its 1,048,576-token
 *   window includes output, sent as max_tokens. Azure Global retail per million: $0.30 input, $1.20 output,
 *   $0.006 cached, no cache writes.
 */
const ADDED: Record<string, Record<string, { from: string; name: string; cost: Model<Api>["cost"] } & Partial<Pick<Model<Api>, "contextWindow" | "input" | "thinkingLevelMap" | "compat">>>> = {
  azure: {
    "deepseek-v4.1-flash": {
      from: "deepseek-v4-pro", name: "DeepSeek V4.1 Flash", input: ["text", "image"], contextWindow: 1_048_576,
      cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 }, compat: { maxTokensField: "max_tokens" },
      thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
    },
  },
};
const added = (provider: string, id: string): Model<Api> | undefined => {
  const entry = ADDED[provider]?.[id];
  const base = entry && !piCatalog(provider, id) ? piCatalog(provider, entry.from) : undefined;
  if (!base || !entry) return undefined;
  const { from, ...overrides } = entry;
  return { ...base, ...overrides, id, ...(overrides.compat ? { compat: { ...base.compat, ...overrides.compat } } : {}) };
};
const piModel = (provider: string, id: string): Model<Api> | undefined => piCatalog(provider, id) ?? added(provider, id);

/**
 * Where Pi's catalog says more about Bedrock than Bedrock serves, read from the catalog itself:
 * - Bedrock serves Anthropic's models on demand only through inference profiles (`global.`, `us.`, `eu.`, ...) and
 *   refuses their base id (`anthropic.claude-sonnet-5-5`), so a base id with a profile is not listed, and names its
 *   global profile (else its US one, else the first).
 * - A Claude model that always reasons on Anthropic's API (its entry has no off level) does on Bedrock too, which
 *   refuses thinking turned off, so its Bedrock entries say off is not a level they have either.
 */
const BEDROCK = "amazon-bedrock";
const ANTHROPIC_ID = /^(?:[a-z]+\.)?anthropic\.(.+)$/;
/** Each Bedrock base id's preferred inference profile: global, else US, else the first. */
const PROFILES = new Map<string, string>();
for (const { id } of piGetModels(BEDROCK as never) as Model<Api>[]) {
  const base = /^[a-z]+\.(anthropic\..+)$/.exec(id)?.[1];
  const held = base && PROFILES.get(base);
  if (base && (!held || id.startsWith("global.") || (id.startsWith("us.") && !held.startsWith("global.")))) PROFILES.set(base, id);
}
/**
 * Prices Pi's catalog has wrong, by provider and id, checked against the provider's own pricing. Drop each once Pi
 * ships the fix (pi-ai 1.4.0 still has them):
 * - Claude Sonnet 5.5 cache reads are $0.10 per million tokens (0.05x input, platform.claude.com/docs pricing), not
 *   $0.20. Pi 1.4.0 fixed its `anthropic` entry; Cloudflare's AI Gateway passes Anthropic's prices through and Pi's
 *   entry there still says $0.20. Bedrock's price for it is not published: left.
 * - OpenRouter models the platform's apps run on, at OpenRouter's list price (GET /api/v1/models, 2026-10-17): Pi's
 *   are another moment's, or a rate OpenRouter charges only some hours (DeepSeek V4.1 Flash's $0.30/$1.20 is its
 *   weekday-peak rate, twice the list price). A call is billed what OpenRouter reports it charged; these price
 *   estimates and holds, and a call that reports nothing.
 */
const PRICES: Record<string, Record<string, Partial<Model<Api>["cost"]>>> = {
  "cloudflare-ai-gateway": { "claude-sonnet-5-5": { cacheRead: 0.1 } },
  openrouter: {
    "deepseek/deepseek-v4.1-flash": { input: 0.15, output: 0.6, cacheRead: 0.003 },
    "moonshotai/kimi-k3": { input: 0.304, output: 11.936, cacheRead: 0.21 },
    "z-ai/glm-5.3": { input: 0.079, output: 4.8, cacheRead: 0.078 },
  },
};
/**
 * Azure OpenAI's Global Standard prices are OpenAI's, long context included (Microsoft's GPT-6 launch post lists
 * GPT-6 Sol at $2/$0.20 cached/$2.50 cache writes/$10 out, $4/$0.40/$5/$15 for long context). Pi's `azure` entries have
 * OpenAI's base rates without the long-context tier, so an azure model is priced as OpenAI's of the same id. Data Zone
 * deployments cost 10% (US) to 20% (EU) more: the platform's are Global Standard (docs/operations/configuration.md).
 */
const AZURE = "azure";
/**
 * Longest replies Pi's catalog has too long, by provider and id. A call that names no maximum asks for the model's
 * maxTokens, and OpenRouter routes it only to the hosts that serve that much: 1017's 943,718 (V4.1 Flash's longest
 * endpoint, which ADDED copies) leaves out DeepSeek's own endpoint (393,216), Baseten's (262,144), DeepInfra's,
 * Prime Intellect's and InferenceNet's (131,072), so 1017 asks for 131,072, which every host of its full context
 * serves. V4.1 Flash asks for 131,072 too: Pi's catalog moved it to 943,718 (2026-10-29), which leaves out Nebius
 * (943,200), one of its five allowed hosts (OPENROUTER_HOSTS), and with a long input asks for more than the window
 * holds. Azure Flash has no separate output cap (measured 2026-10-26), but input plus max_tokens must fit its window;
 * default to 131,072 there too.
 */
const MAX_TOKENS: Record<string, Record<string, number>> = {
  azure: { "deepseek-v4.1-flash": 131_072 },
  openrouter: { "deepseek/deepseek-v4.1-flash": 131_072, "deepseek/deepseek-v4.1-flash-1017": 131_072 },
};
const limited = (model: Model<Api>): Model<Api> => {
  const most = MAX_TOKENS[model.provider]?.[model.id];
  return most ? { ...model, maxTokens: most } : model;
};
const priced = (model: Model<Api>): Model<Api> => {
  const openai = model.provider === AZURE ? piModel("openai", model.id) : undefined;
  if (openai) return { ...model, cost: priced(openai).cost };
  const fix = PRICES[model.provider]?.[model.id];
  return fix ? { ...model, cost: { ...model.cost, ...fix } } : model;
};
/**
 * Pi's azure models name no endpoint: each resource is its own. Theirs is the platform's, given with each call
 * (compaction.ts `azureOptions`), so the catalog's address is a placeholder no call reaches (`.invalid` never resolves).
 */
const AZURE_PLACEHOLDER_URL = "https://azure-openai.invalid/openai/v1";
const corrected = (found: Model<Api> | undefined): Model<Api> | undefined => {
  const model = found && limited(found.provider === AZURE && !found.baseUrl ? priced({ ...found, baseUrl: AZURE_PLACEHOLDER_URL }) : priced(found));
  const claude = model?.provider === BEDROCK ? ANTHROPIC_ID.exec(model.id)?.[1] : undefined;
  if (!model || !claude) return model;
  return piModel("anthropic", claude)?.thinkingLevelMap?.off === null ? { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, off: null } } : model;
};

/**
 * The OpenRouter hosts a model of the platform's catalog may be served by (its requests' `provider.only`), by id; a
 * routing variant (`:nitro`) has its own entry where it has one, else its base model's. Any other model is
 * OpenRouter's to route. Only `only` is set: it
 * narrows the hosts and leaves OpenRouter's load balancing on, where `order` or `sort` turns it off (2026-10-17: an
 * `order` sent every DeepSeek V4.1 Flash call to one slow fp4 host). Each name is an OpenRouter provider slug
 * (GET /api/v1/providers), all of the provider's endpoints for the model.
 * - DeepSeek V4.1 Flash (Miguel, 2026-10-18): fp8 or full-precision hosts of the full context; none of the fp4 ones.
 * - DeepSeek V4.1 Flash 1017 and its `:nitro` variant (Miguel, 2026-10-23): none. Its hosts had been listed since
 *   2026-10-18 (a slow host, then two rate-limited ones, then a host list that left out Morph, Cloudflare and Wafer);
 *   by 2026-10-23 every host was fast and stable, so OpenRouter routes it among all of them, as it does other models,
 *   except the hosts of OPENROUTER_IGNORED_HOSTS.
 */
const OPENROUTER_HOSTS: Record<string, string[]> = {
  "deepseek/deepseek-v4.1-flash": ["fireworks", "together", "parasail", "coreweave", "nebius"],
};

/**
 * The OpenRouter hosts a model of the platform's catalog is never served by (its requests' `provider.ignore`), by id; a
 * routing variant (`:nitro`) is its base model's, a host variant (`:morph`) has its own `only` instead. A filter like
 * `only`, so load balancing stays on, and unlike a short `only` list it leaves every other host to take the load (an
 * `only` of a few hosts was rate-limited, 2026-10-18).
 * - DeepSeek V4.1 Flash 1017 (Miguel, 2026-10-27): InferenceNet and Wafer, which intermittently drop a tool call's
 *   optional arguments (13.6% of camel-builder's bot__preview calls failed on InferenceNet 2026-10-27 evening, 15.6%
 *   on Wafer 2026-10-26, against 1.7% on Together).
 */
const OPENROUTER_IGNORED_HOSTS: Record<string, string[]> = {
  "deepseek/deepseek-v4.1-flash-1017": ["inference-net", "wafer"],
};

/**
 * Host variants: `<model id>:<variant>` is its model served only by the variant's hosts (`provider.only`), sent to
 * OpenRouter as the model's own id (OpenRouter knows no such suffix). An agent opts in by its model, so one slice of
 * agents can try a host while every other agent of the model routes as before. Only `only`, never `order` or `sort`.
 * - `:morph` (2026-10-27): Morph's fp8 endpoint alone, a canary of its price and cache hits against `:nitro`
 *   (plans/deepseek-provider-spend.md). One host: a 429 there has nowhere else to go, so canary slices only.
 */
const OPENROUTER_HOST_VARIANTS: Record<string, string[]> = {
  morph: ["morph"],
};
const hostVariant = (id: string): { base: string; only: string[] } | undefined => {
  const match = /^(.+):([a-z]+)$/.exec(id);
  const only = match && Object.hasOwn(OPENROUTER_HOST_VARIANTS, match[2]) ? OPENROUTER_HOST_VARIANTS[match[2]] : undefined;
  return match && only ? { base: match[1], only } : undefined;
};

/** The OpenRouter hosts a model may be served by (a host variant's, else OPENROUTER_HOSTS), or undefined: OpenRouter's choice. */
export function openRouterHosts(id: string): string[] | undefined {
  return hostVariant(id)?.only ?? OPENROUTER_HOSTS[id] ?? OPENROUTER_HOSTS[id.replace(/:[a-z]+$/, "")];
}

/** The OpenRouter hosts a model is never served by (OPENROUTER_IGNORED_HOSTS), or undefined; none for a host variant. */
export function openRouterIgnoredHosts(id: string): string[] | undefined {
  return hostVariant(id) ? undefined : OPENROUTER_IGNORED_HOSTS[id] ?? OPENROUTER_IGNORED_HOSTS[id.replace(/:[a-z]+$/, "")];
}

/**
 * An OpenRouter request of the platform's catalog with its model's hosts (`provider.only`; a host variant's model sent as
 * its base id), the hosts it is never served by (`provider.ignore`) and, when its agent asks
 * (`dataCollection: "deny"`), only hosts that do not collect its data (`provider.data_collection`): OpenRouter skips the
 * providers whose data policy says they may train on it. All are filters, so load balancing stays on; any other
 * `provider` routing the request has is kept. Nothing else is added by default. Any other request is as it was.
 */
export function withOpenRouterHosts(model: Model<Api>, payload: unknown, dataCollection?: "deny" | null): unknown {
  if (model.provider !== "openrouter" || !payload || typeof payload !== "object") return payload;
  const only = openRouterHosts(model.id);
  const ignore = openRouterIgnoredHosts(model.id);
  if (!only && !ignore && !dataCollection) return payload;
  const request = payload as { model?: unknown; provider?: Record<string, unknown> };
  const variant = hostVariant(model.id);
  return {
    ...request, ...(variant && request.model === model.id ? { model: variant.base } : {}),
    provider: { ...(only ? { only } : {}), ...(ignore ? { ignore } : {}), ...request.provider, ...(dataCollection ? { data_collection: dataCollection } : {}) },
  };
}

/** Pi's model, as this runtime corrects it: a Bedrock base id that has inference profiles is its profile's. */
export function getModel(provider: string, id: string): Model<Api> | undefined {
  return corrected(piModel(provider, (provider === BEDROCK && PROFILES.get(id)) || id));
}

/**
 * The least reasoning `model` takes when it cannot reason less than that (its catalog entry has no off level), for a
 * call asking for none; undefined when off is a level it has. Read from the catalog, not only the model as an agent
 * holds it, which may predate its entry saying so. A model on a tenant's endpoint is named `<provider>/<id>`.
 */
export function reasoningFloor(model: Model<Api>): ThinkingLevel | undefined {
  const [provider, ...rest] = model.id.split("/");
  const known = getModel(model.provider, model.id) ?? (rest.length ? getModel(provider, rest.join("/")) : undefined) ?? model;
  if (!known.reasoning || known.thinkingLevelMap?.off !== null) return undefined;
  return known.thinkingLevelMap?.minimal === null ? "low" : "minimal";
}

/**
 * An agent's model with the catalog's prices, context window and longest reply now: an agent keeps the model it was given,
 * so one made before a price changed (PRICES) would go on counting the old one, and one made before a longest reply was corrected
 * (MAX_TOKENS) would go on asking for it. A model the catalog doesn't have at the same endpoint (a tenant's endpoint or
 * provider, priced by the tenant) is as it was.
 */
export function withCatalogPrices<T extends Model<Api>>(model: T): T {
  const known = getModel(model.provider, model.id) ?? getModel(model.provider, model.id.replace(/:[a-z]+$/, ""));
  if (!known || known.baseUrl !== model.baseUrl) return model;
  const cost = JSON.stringify(known.cost) !== JSON.stringify(model.cost), most = known.maxTokens !== model.maxTokens, window = known.contextWindow !== model.contextWindow;
  return cost || most || window ? { ...model, ...(cost ? { cost: known.cost } : {}), ...(most ? { maxTokens: known.maxTokens } : {}), ...(window ? { contextWindow: known.contextWindow } : {}) } : model;
}

/** Pi's models for a provider and those ADDED, as this runtime corrects them: no Bedrock base id that has inference profiles. */
export function getModels(provider: string): Model<Api>[] {
  const models = [...piGetModels(provider as never) as Model<Api>[], ...Object.keys(ADDED[provider] ?? {}).flatMap(id => added(provider, id) ?? [])];
  return models.flatMap(model => provider === BEDROCK && PROFILES.has(model.id) ? [] : [corrected(model)!]);
}

type ModelCompat = { supportsTemperature?: boolean; supportsMidConvoEffort?: boolean };

/**
 * Why a call to `model` reasoning at `reasoning` can take no temperature, or undefined when it can. Pi's catalog says
 * which Claude models refuse sampling settings (Opus 4.7 and later, and those with mid-conversation effort: Opus 5,
 * Sonnet 5.5, Fable 5.1), wherever they are served. A model that always reasons (o-series, GPT-5, Claude Fable 5) takes none, and no model takes
 * one while it reasons: Anthropic's thinking requires the default, OpenAI's reasoning models refuse it.
 */
export function temperatureRefusal(model: Model<Api>, reasoning: string | undefined): string | undefined {
  // A Claude model elsewhere (Bedrock, OpenRouter, an endpoint) refuses what it refuses at Anthropic, whose entry says so.
  const claude = /claude-[a-z]+-\d(?:[\d.-]*\d)?/.exec(model.id)?.[0]?.replaceAll(".", "-");
  const compat = { ...(claude ? getModel("anthropic", claude)?.compat : undefined), ...model.compat } as ModelCompat;
  if (compat.supportsTemperature === false || compat.supportsMidConvoEffort === true) return "its provider refuses one for this model";
  if (reasoningFloor(model)) return "it always reasons, and a model takes no temperature while it reasons";
  if (model.reasoning && reasoning !== undefined && reasoning !== "off") return `while it reasons (thinkingLevel ${reasoning}); set thinkingLevel off to use one`;
  return undefined;
}

/**
 * The stream options one model call takes from its agent's settings: `maxTokens` within the model's maximum (Pi also
 * keeps it within the context, and adds a thinking budget to it), and `temperature` unless the call cannot take one.
 * A setting that a later change made inapplicable (a definition's new model or thinking level) is left out, not sent.
 */
export function callSettings(model: Model<Api>, settings: { maxOutputTokens?: number | null; temperature?: number | null }, reasoning: string | undefined): { maxTokens?: number; temperature?: number } {
  return {
    ...(settings.maxOutputTokens != null ? { maxTokens: Math.min(settings.maxOutputTokens, model.maxTokens) } : {}),
    ...(settings.temperature != null && !temperatureRefusal(model, reasoning) ? { temperature: settings.temperature } : {}),
  };
}
