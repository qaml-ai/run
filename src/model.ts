import { getModel } from "./pi-catalog.ts";
import { resolveModel } from "./session-config.ts";
import type { Api, Model } from "@earendil-works/pi-ai";

export function configuredModel(env: NodeJS.ProcessEnv = process.env): Model<Api> {
  const provider = env.AGENT_PROVIDER ?? "anthropic";
  const id = env.AGENT_MODEL ?? "claude-sonnet-5-5";
  const model = getModel(provider, id);
  if (!model) throw new Error(`Unknown Pi model: ${provider}/${id}`);
  return { ...model, ...(env.AGENT_BASE_URL ? { baseUrl: env.AGENT_BASE_URL } : {}) };
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

/**
 * Models whose provider's content filter blocks ordinary answers (Azure's Prompt Shields calls DeepSeek's coding
 * replies jailbreaks), each with the same model elsewhere: a request the filter blocks is made once more there.
 */
const CONTENT_FILTER_FALLBACKS = "azure/deepseek-v4.1-flash=openrouter/deepseek/deepseek-v4.1-flash-1017:nitro";

/**
 * The content-filter fallbacks, by `provider/model-id`: AGENT_CONTENT_FILTER_FALLBACKS (`from=to` references,
 * comma-separated; empty for none), else CONTENT_FILTER_FALLBACKS. An agent on a `from` model whose request the
 * provider's content filter blocks has it made once more on `to` (content-filter-fallback.ts), on the agent's key for
 * `to`'s provider.
 */
export function contentFilterFallbacks(given = process.env.AGENT_CONTENT_FILTER_FALLBACKS): Map<string, Model<Api>> {
  const fallbacks = new Map<string, Model<Api>>();
  for (const entry of (given ?? CONTENT_FILTER_FALLBACKS).split(",").map(entry => entry.trim()).filter(Boolean)) {
    const [from, to, ...rest] = entry.split("=").map(part => part.trim());
    if (!from || !to || rest.length) throw new Error(`AGENT_CONTENT_FILTER_FALLBACKS: ${entry} is not from=to`);
    let source: Model<Api>, target: Model<Api>;
    try { source = resolveModel(from); target = resolveModel(to); }
    catch (error) { throw new Error(`AGENT_CONTENT_FILTER_FALLBACKS: ${(error as Error).message}`); }
    if (source.provider === target.provider) throw new Error(`AGENT_CONTENT_FILTER_FALLBACKS: ${entry} stays on ${source.provider}, whose filter blocked it`);
    fallbacks.set(`${source.provider}/${source.id}`, target);
  }
  return fallbacks;
}
