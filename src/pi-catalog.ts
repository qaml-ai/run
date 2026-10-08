import { getModel as piGetModel, getModels as piGetModels } from "@earendil-works/pi-ai/compat";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";

const piModel = piGetModel as (provider: string, id: string) => Model<Api> | undefined;

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
const corrected = (model: Model<Api> | undefined): Model<Api> | undefined => {
  const claude = model?.provider === BEDROCK ? ANTHROPIC_ID.exec(model.id)?.[1] : undefined;
  if (!model || !claude) return model;
  return piModel("anthropic", claude)?.thinkingLevelMap?.off === null ? { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, off: null } } : model;
};

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

/** Pi's models for a provider, as this runtime corrects them: no Bedrock base id that has inference profiles. */
export function getModels(provider: string): Model<Api>[] {
  const models = piGetModels(provider as never) as Model<Api>[];
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
