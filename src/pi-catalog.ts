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
