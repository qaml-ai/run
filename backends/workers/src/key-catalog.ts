// Generated from src/catalog.ts + web-search.ts; only host imports are replaced.
// Run node backends/workers/scripts/reuse-security.mjs --check to check source drift.
import { getProviders } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels } from "./model-catalog.ts";
import { deepseekOnOpenRouter } from "./security-deepseek.ts";
export const SEARCH_PROVIDERS = ["exa", "brave", "parallel"] as const;
/** Page renderers web_fetch can use, by the provider key they take. */
export const FETCH_PROVIDERS = ["firecrawl"] as const;
/** Text-to-speech providers for POST /v1/speech (voice-providers/), by the key they take. */
export const SPEECH_PROVIDERS = ["cartesia", "deepgram", "elevenlabs"] as const;

/** Providers that authenticate with something other than a single API key. */
const NOT_API_KEY: Record<string, string> = {
  "google-vertex": "a Google Cloud service account",
  // The platform's, where its operator deploys them (azure-openai.ts): GET /v1/models marks those available.
  azure: "an Azure endpoint and deployment, which only the platform sets",
  "github-copilot": "GitHub OAuth",
  "openai-codex": "ChatGPT OAuth",
  "cloudflare-ai-gateway": "a Cloudflare account and gateway ID",
  "cloudflare-workers-ai": "a Cloudflare account ID",
};

export interface ProviderInfo {
  id: string;
  /** model: an LLM provider; search: a web search API, for the web_search built-in; fetch: a page renderer for web_fetch; speech: speech to text or text to speech, for voice sessions. */
  kind: "model" | "search" | "fetch" | "speech";
  models: number;
  /** Whether a tenant can use this provider by setting one API key. */
  apiKey: boolean;
  /** Why the provider is unavailable, when it needs more than an API key. */
  requires?: string;
}


const models = (provider: string) => getModels(provider);
const usableEndpoint = (model: Model<Api>) => !!model.baseUrl && !model.baseUrl.includes("{");

export function listProviders(): ProviderInfo[] {
  const search = [
    ...SEARCH_PROVIDERS.map((id): ProviderInfo => ({ id, kind: "search", models: 0, apiKey: true })),
    ...FETCH_PROVIDERS.map((id): ProviderInfo => ({ id, kind: "fetch", models: 0, apiKey: true })),
    ...SPEECH_PROVIDERS.map((id): ProviderInfo => ({ id, kind: "speech", models: 0, apiKey: true })),
  ];
  return [...getProviders().map((id): ProviderInfo => {
    const all = models(id);
    const requires = NOT_API_KEY[id] ?? (all.every(usableEndpoint) ? undefined : "a provider-specific endpoint");
    return { id, kind: "model", models: all.length, apiKey: !requires, ...(requires ? { requires } : {}) };
  }), ...search.filter(entry => !getProviders().includes(entry.id as never))].sort((a, b) => a.id.localeCompare(b.id));
}

export function providerInfo(id: string): ProviderInfo | undefined {
  return listProviders().find(provider => provider.id === id);
}

/**
 * The API Pi speaks to OpenRouter for a model: its Responses API (stateless, reasoning carried back
 * as it came), except for Anthropic's models, which keep its Messages API, since Responses gets
 * them no prompt caching, and DeepSeek's (`model`, of the catalog), which keep Chat Completions, where
 * every turn's reasoning goes back as DeepSeek's own API asks (deepseek-replay.ts).
 */
export function openRouterApi(api: string, model?: Pick<Model<Api>, "id" | "compat">): Api {
  if (model && api === "openai-completions" && deepseekOnOpenRouter({ ...model, provider: "openrouter" })) return api as Api;
  return (api === "anthropic-messages" ? api : "openai-responses") as Api;
}
