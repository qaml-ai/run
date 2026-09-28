import { getModel } from "./pi-catalog.ts";
import { resolveModel } from "./session-config.ts";
import type { Api, Model } from "@earendil-works/pi-ai";

export function configuredModel(): Model<Api> {
  const provider = process.env.AGENT_PROVIDER ?? "anthropic";
  const id = process.env.AGENT_MODEL ?? "claude-sonnet-5-5";
  const model = getModel(provider, id);
  if (!model) throw new Error(`Unknown Pi model: ${provider}/${id}`);
  return { ...model, ...(process.env.AGENT_BASE_URL ? { baseUrl: process.env.AGENT_BASE_URL } : {}) };
}

/** The same model as the default, on the other providers a tenant may have keys for, most preferred first. */
const FALLBACKS = "anthropic/claude-sonnet-5-5,openrouter/anthropic/claude-sonnet-5.5,amazon-bedrock/global.anthropic.claude-sonnet-5-5,openrouter/openai/gpt-6-luna";

/**
 * The models an agent that names none may get, in order: `head` (AGENT_PROVIDER and AGENT_MODEL),
 * then AGENT_MODEL_FALLBACKS (provider/model references, comma-separated; empty for none). Each
 * agent gets the first its tenant or key scope has a key for.
 */
export function defaultModels(head: Model<Api>, fallbacks = process.env.AGENT_MODEL_FALLBACKS): Model<Api>[] {
  const models = [head];
  for (const reference of (fallbacks ?? FALLBACKS).split(",").map(entry => entry.trim()).filter(Boolean)) {
    let model: Model<Api>;
    try { model = resolveModel(reference); }
    catch (error) { throw new Error(`AGENT_MODEL_FALLBACKS: ${(error as Error).message}`); }
    if (!models.some(known => known.provider === model.provider && known.id === model.id)) models.push(model);
  }
  return models;
}
