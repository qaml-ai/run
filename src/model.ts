import { getModel } from "./pi-catalog.ts";
import type { Passthrough } from "./openrouter-model.ts";
import { resolveModel } from "./session-config.ts";
import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * The default with none of AGENT_PROVIDER, AGENT_MODEL and AGENT_BASE_URL set. Any of them set names what it always
 * named, so a runtime configured before DeepSeek became the default starts as it did: AGENT_MODEL (or an endpoint) alone
 * is Anthropic's, AGENT_PROVIDER=anthropic alone is Claude Sonnet 5.5.
 */
export function configuredModel(env: NodeJS.ProcessEnv = process.env): Model<Api> {
  const unset = env.AGENT_PROVIDER === undefined && env.AGENT_MODEL === undefined && env.AGENT_BASE_URL === undefined;
  const provider = env.AGENT_PROVIDER ?? (unset ? "openrouter" : "anthropic");
  const id = env.AGENT_MODEL ?? (provider === "openrouter" ? "deepseek/deepseek-v4.1-flash-1017" : "claude-sonnet-5-5");
  const model = getModel(provider, id);
  if (!model) throw new Error(`Unknown Pi model: ${provider}/${id}`);
  return { ...model, ...(env.AGENT_BASE_URL ? { baseUrl: env.AGENT_BASE_URL } : {}) };
}

/**
 * For a tenant with no key for the default's provider, most preferred first: DeepSeek V4.1 Flash on the platform's Azure,
 * else Claude Sonnet 5.5 on the providers a tenant may have its own key for. These choose a model when an agent is made,
 * by who holds a key; no running agent moves to them when a provider fails.
 */
const FALLBACKS = "azure/deepseek-v4.1-flash,anthropic/claude-sonnet-5-5,openrouter/anthropic/claude-sonnet-5.5,amazon-bedrock/global.anthropic.claude-sonnet-5-5";

/** A model the operator names: a typo should stop a node starting, not pass through to OpenRouter. */
function catalogModel(reference: string): Model<Api> {
  const model = resolveModel(reference);
  if ((model as Passthrough).passthrough) throw new Error(`Unknown model "${reference}"; see GET /v1/models`);
  return model;
}

/**
 * The models an agent that names none may get, in order: `head` (AGENT_PROVIDER and AGENT_MODEL),
 * then AGENT_MODEL_FALLBACKS (provider/model references, comma-separated; empty for none). Each
 * agent gets the first its key scope or its tenant holds a key for, else the first the platform's keys serve.
 */
export function defaultModels(head: Model<Api>, fallbacks = process.env.AGENT_MODEL_FALLBACKS): Model<Api>[] {
  const models = [head];
  for (const reference of (fallbacks ?? FALLBACKS).split(",").map(entry => entry.trim()).filter(Boolean)) {
    let model: Model<Api>;
    try { model = catalogModel(reference); }
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
    try { source = catalogModel(from); target = catalogModel(to); }
    catch (error) { throw new Error(`AGENT_CONTENT_FILTER_FALLBACKS: ${(error as Error).message}`); }
    if (source.provider === target.provider) throw new Error(`AGENT_CONTENT_FILTER_FALLBACKS: ${entry} stays on ${source.provider}, whose filter blocked it`);
    fallbacks.set(`${source.provider}/${source.id}`, target);
  }
  return fallbacks;
}
