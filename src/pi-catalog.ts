import { getModel as piGetModel, getModels as piGetModels } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";

const piModel = piGetModel as (provider: string, id: string) => Model<Api> | undefined;

/**
 * Models Anthropic has released that Pi's catalog (0.87.1) does not list yet, each copied from the
 * entry of the model it succeeds, which it matches in API surface, context window, output limit and
 * price. Claude Sonnet 5.5 (2026-09-28): `claude-sonnet-5-5` on Anthropic,
 * `anthropic.claude-sonnet-5-5` (plus its inference profiles) on Bedrock,
 * `anthropic/claude-sonnet-5.5` on OpenRouter; $2 / $10 per MTok, cache reads $0.20, cache writes
 * $2.50, 1M context, 128K output, like Claude Sonnet 5. A model Pi lists wins over its entry here,
 * so this can go once Pi publishes it.
 */
const SUCCESSORS: Array<{ provider: string; from: string; to: string; name: [string, string] }> = [
  { provider: "anthropic", from: "claude-sonnet-5", to: "claude-sonnet-5-5", name: ["Claude Sonnet 5", "Claude Sonnet 5.5"] },
  { provider: "openrouter", from: "anthropic/claude-sonnet-5", to: "anthropic/claude-sonnet-5.5", name: ["Claude Sonnet 5", "Claude Sonnet 5.5"] },
  ...["", "us.", "eu.", "jp.", "au.", "global."].map(profile => ({
    provider: "amazon-bedrock", from: `${profile}anthropic.claude-sonnet-5`, to: `${profile}anthropic.claude-sonnet-5-5`,
    name: ["Claude Sonnet 5", "Claude Sonnet 5.5"] as [string, string],
  })),
];

const supplement = new Map<string, Model<Api>[]>();
for (const { provider, from, to, name } of SUCCESSORS) {
  const base = piModel(provider, from);
  if (!base || piModel(provider, to)) continue;
  supplement.set(provider, [...supplement.get(provider) ?? [], { ...base, id: to, name: base.name.replace(name[0], name[1]) }]);
}

/** Pi's model, or one this runtime adds while Pi's catalog lacks it. */
export function getModel(provider: string, id: string): Model<Api> | undefined {
  return piModel(provider, id) ?? supplement.get(provider)?.find(model => model.id === id);
}

/** Pi's models for a provider, and the ones this runtime adds. */
export function getModels(provider: string): Model<Api>[] {
  return [...piGetModels(provider as never) as Model<Api>[], ...supplement.get(provider) ?? []];
}
