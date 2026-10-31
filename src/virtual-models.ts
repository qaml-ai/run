import type { Api, Model } from "@earendil-works/pi-ai";
import { openRouterApi } from "./catalog.ts";
import { getModel } from "./pi-catalog.ts";

/**
 * Virtual models: a name an agent keeps, routed to a physical model for each request, after Pi's own (pi-coding-agent's
 * virtual-models.ts, which we do not vendor): the same `route` with `reason`, `previous` and `failed`. Providers only see
 * physical models and each assistant message records the one that answered, so a move replays as a model change does.
 * An agent stores the name (`virtual`) on its head's model: everything that reads an agent's model before a request
 * (its key, its limits) reads the head, and what is behind the name can change without touching agents.
 */
export const VIRTUAL_PROVIDER = "camelrun";
/** Members share a provider: an agent holds one model key. */
const VIRTUAL_MODELS: Record<string, { name: string; chain: [string, string][] }> = {
  default: { name: "camelRun default", chain: [["openrouter", "particle-ai/particle-1"], ["openrouter", "deepseek/deepseek-v4.1-flash-1017"]] },
};

export type VirtualSelection = Model<Api> & { virtual?: string };
/** Why a request is routed, as Pi says: `user` after a message someone wrote, `continuation` after tool results, `retry` after `failed`, `direct` outside the loop (a summary). */
export type ModelRouteReason = "user" | "continuation" | "retry" | "direct";
type Physical = { provider: string; model?: string; id?: string };

const member = ([provider, id]: [string, string]): Model<Api> => {
  const model = getModel(provider, id);
  if (!model) throw new Error(`Virtual model member ${provider}/${id} is not in the catalog`);
  return provider === "openrouter" ? { ...model, api: openRouterApi(model.api, model) } as Model<Api> : model;
};
/** The models behind a reference, most preferred first; undefined for a reference that is no virtual model. */
export function virtualChain(reference: string | undefined): Model<Api>[] | undefined {
  const id = reference?.startsWith(`${VIRTUAL_PROVIDER}/`) ? reference.slice(VIRTUAL_PROVIDER.length + 1) : undefined;
  return id !== undefined && Object.hasOwn(VIRTUAL_MODELS, id) ? VIRTUAL_MODELS[id].chain.map(member) : undefined;
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
export const currentModel = <T extends VirtualSelection>(model: T): T => (model.virtual && virtualModel(model.virtual) as T) || model;

const same = (model: Model<Api>, physical: Physical) => model.provider === physical.provider && model.id === (physical.model ?? physical.id);

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
