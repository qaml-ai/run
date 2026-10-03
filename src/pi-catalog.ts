import { getModel as piGetModel, getModels as piGetModels } from "@earendil-works/pi-ai/compat";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";

const piModel = piGetModel as (provider: string, id: string) => Model<Api> | undefined;

/**
 * Where Pi's catalog (1.0.0) says more than a provider serves. Claude Sonnet 5.5 on Bedrock is served through
 * the global inference profile only, and like everywhere else it always reasons: Bedrock refuses thinking
 * turned off, so its entry says off is not a level it has, as Pi's Anthropic and OpenRouter entries do.
 */
const HIDDEN = new Set(["amazon-bedrock/anthropic.claude-sonnet-5-5"]);
const ALWAYS_REASONS = new Set(["amazon-bedrock/global.anthropic.claude-sonnet-5-5"]);
const corrected = (model: Model<Api> | undefined): Model<Api> | undefined => {
  if (!model || HIDDEN.has(`${model.provider}/${model.id}`)) return undefined;
  return ALWAYS_REASONS.has(`${model.provider}/${model.id}`) ? { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, off: null } } : model;
};

/** Pi's model, as this runtime corrects it. */
export function getModel(provider: string, id: string): Model<Api> | undefined {
  return corrected(piModel(provider, id));
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

/** Pi's models for a provider, as this runtime corrects them. */
export function getModels(provider: string): Model<Api>[] {
  return (piGetModels(provider as never) as Model<Api>[]).flatMap(model => corrected(model) ?? []);
}
