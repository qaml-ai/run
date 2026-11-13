import type { Api, Model } from "@earendil-works/pi-ai";
import { openRouterApi } from "./catalog.ts";
import { passthroughModel, type Passthrough } from "./openrouter-model.ts";
import { getModel } from "./pi-catalog.ts";

/**
 * Virtual models: a name an agent keeps, routed to a physical model for each request, after Pi's own (pi-coding-agent's
 * virtual-models.ts, which we do not vendor): the same `route` with `reason`, `previous` and `failed`. Providers only see
 * physical models and each assistant message records the one that answered, so a move replays as a model change does.
 * An agent stores the name (`virtual`) on its head's model: everything that reads an agent's model before a request
 * (its key, its limits) reads the head, and what is behind the name can change without touching agents.
 */
export const VIRTUAL_PROVIDER = "camelrun";
/**
 * Members share a provider: an agent holds one model key. A member may name the OpenRouter service tier it is asked on
 * (`service_tier`, sent by `withOpenRouterHosts`): `strong` asks Gemini 4 Carbon on flex, half the default tier's price,
 * and moves to the default tier when flex has no capacity (both backends wait a bounded wall-clock window first).
 * - `fast` and `strong` are model classes (docs/design/swarm-workflows.md): bulk work and judgment. Decided 2026-11-10.
 */
/**
 * A member's options: the OpenRouter service tier it is asked on, and its first-token budget (model-stream.ts): a member
 * that sends nothing within it for its input has stalled, and the next member takes the request.
 */
type Member = [provider: string, id: string, options?: { serviceTier: ServiceTier; firstTokenBudget?: FirstTokenBudget }];
/**
 * The longest a call asked on flex waits for flex capacity (asking again with backoff) before the default tier takes it,
 * on both backends. Probed 2026-11-12: on OpenRouter's shared Google quota flex answered every 60k-token request with an
 * immediate 429; on our own key it answered 8 of 10, but slowly (up to 95 s), while the default tier took 7-12 s. A long
 * wait only delays the default tier. One constant, to change as flex's capacity does.
 */
export const STRONG_FLEX_WAIT_CAP_SECONDS = 10;
/** Retry-safe public error; member details belong only in virtual_model_chain_failed logs. */
export const STRONG_UNAVAILABLE_MESSAGE = "503 Service Unavailable: camelrun/strong has no member that can take this request now (flex and the default tier both failed); it is retried after a backoff";
/** model-stream.ts `FirstTokenBudget`, restated: the Workers copy of this file is made without its first lines. */
type FirstTokenBudget = { baseMs: number; perKTokensMs: number };
/** Gemini 4 Carbon's first token comes within this for its input, with room (measured 2026-11-12, model-stream.ts). */
const GEMINI_FIRST_TOKEN: FirstTokenBudget = { baseMs: 30_000, perKTokensMs: 400 };
const VIRTUAL_MODELS: Record<string, { name: string; chain: Member[] }> = {
  default: { name: "camelRun default", chain: [["openrouter", "meta/muse-ember"], ["openrouter", "deepseek/deepseek-v4.1-flash-1017"]] },
  fast: { name: "camelRun fast", chain: [["openrouter", "meta/muse-ember"]] },
  strong: { name: "camelRun strong", chain: [["openrouter", "google/gemini-4-carbon", { serviceTier: "flex", firstTokenBudget: GEMINI_FIRST_TOKEN }], ["openrouter", "google/gemini-4-carbon", { serviceTier: "default", firstTokenBudget: GEMINI_FIRST_TOKEN }]] },
};

/** An OpenRouter service tier a virtual model's member is asked on (`service_tier`). */
export type ServiceTier = "flex" | "default";
export type VirtualSelection = Model<Api> & { virtual?: string; serviceTier?: ServiceTier; firstTokenBudget?: FirstTokenBudget };
/** Why a request is routed, as Pi says: `user` after a message someone wrote, `continuation` after tool results, `retry` after `failed`, `direct` outside the loop (a summary). */
export type ModelRouteReason = "user" | "continuation" | "retry" | "direct";
type Physical = { provider: string; model?: string; id?: string; serviceTier?: string };

/** A member as it is called. One OpenRouter serves that the catalog lacks passes through: at its lookup's values when an agent is made on it as the head, else the defaults (openrouter-model.ts). */
export const virtualMember = ([provider, id, options]: Member): Model<Api> => {
  const model = getModel(provider, id);
  const tier = options ? { serviceTier: options.serviceTier, ...(options.firstTokenBudget ? { firstTokenBudget: options.firstTokenBudget } : {}) } : {};
  if (!model && provider === "openrouter") return { ...passthroughModel(id), ...tier };
  if (!model) throw new Error(`Virtual model member ${provider}/${id} is not in the catalog`);
  return provider === "openrouter" ? { ...model, api: openRouterApi(model.api, model), ...tier } as Model<Api> : model;
};
/** The models behind a reference, most preferred first; undefined for a reference that is no virtual model. */
export function virtualChain(reference: string | undefined): Model<Api>[] | undefined {
  const id = reference?.startsWith(`${VIRTUAL_PROVIDER}/`) ? reference.slice(VIRTUAL_PROVIDER.length + 1) : undefined;
  return id !== undefined && Object.hasOwn(VIRTUAL_MODELS, id) ? VIRTUAL_MODELS[id].chain.map(virtualMember) : undefined;
}

/** A virtual model as an agent holds it: the chain's head as it is now, with its name; undefined when there is no such name. */
export function virtualModel(reference: string): VirtualSelection | undefined {
  const head = virtualChain(reference)?.[0];
  return head && { ...head, name: VIRTUAL_MODELS[reference.slice(VIRTUAL_PROVIDER.length + 1)].name, virtual: reference };
}
export const virtualModelReferences = () => Object.keys(VIRTUAL_MODELS).map(id => `${VIRTUAL_PROVIDER}/${id}`);

/** The name an agent's model goes by: a virtual model's, else `provider/id`. */
export const modelReference = (model: { provider: string; id: string; virtual?: string }) => model.virtual ?? `${model.provider}/${model.id}`;
/** An agent's stored model with what its virtual name stands for now. */
export const currentModel = <T extends VirtualSelection>(model: T): T => {
  const now = model.virtual ? virtualModel(model.virtual) as T | undefined : undefined;
  // A head that passes through has only defaults here: the agent's copy has its lookup's values.
  return !now || (now as Passthrough).passthrough && now.id === model.id ? model : now;
};

/** A member is the physical model: by provider and id, and by service tier when the physical model says one (an assistant message does not). */
const same = (model: VirtualSelection, physical: Physical) => model.provider === physical.provider && model.id === (physical.model ?? physical.id)
  && (physical.serviceTier === undefined || model.serviceTier === physical.serviceTier);

/**
 * The physical model for one request, or undefined when a `retry` has nowhere left to go. Sticky as Pi advises: a
 * `continuation` stays on `previous`, whose caches and signatures are valid; a `retry` moves past `failed`; anything
 * else starts at the head, so a recovered head takes the next message.
 */
export function routeModel(selection: VirtualSelection, request: { reason: ModelRouteReason; previous?: Physical; failed?: Physical }): Model<Api> | undefined {
  const chain = virtualChain(selection.virtual);
  if (!chain) return request.reason === "retry" ? undefined : selection;
  if (request.reason === "retry") {
    const at = request.failed ? chain.findIndex(model => same(model, request.failed!)) : -1;
    return at < 0 ? undefined : chain[at + 1];
  }
  const previous = request.reason === "continuation" && request.previous ? chain.find(model => same(model, request.previous!)) : undefined;
  return previous ?? chain[0];
}

/** A response as `routeModel` takes it: its model, and the service tier its request asked for (model-attempt-stream.ts `servedTier`), which names its member. */
export const askedTier = (message: { usage?: unknown }): { serviceTier?: string } => {
  const tier = (message.usage as { requestedServiceTier?: unknown } | undefined)?.requestedServiceTier;
  return typeof tier === "string" ? { serviceTier: tier } : {};
};
