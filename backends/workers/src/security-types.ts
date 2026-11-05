// Generated from src/session-config.ts + compaction.ts; only host imports are replaced.
// Run node backends/workers/scripts/reuse-security.mjs --check to check source drift.
export type EndpointModel = { contextWindow: number; maxTokens: number; reasoning?: boolean; input?: ('text' | 'image')[] };
/**
 * A tenant's own model endpoint, named as a provider in the tenants file: a pass-through
 * gateway where `<baseUrl>/<provider>` stands for that provider's API (`UPSTREAMS`). Pi speaks the
 * provider's own protocol to it with the runtime's identity token as the key; the endpoint swaps in
 * the real credential and meters, so calls cost the runtime nothing. `models` declares models Pi's
 * catalog lacks, by the model reference after `<name>/`.
 */
export type ModelEndpoint = { baseUrl: string; models?: Record<string, EndpointModel> };
/** A tenant's model endpoints by provider name. */
export type ModelEndpoints = Record<string, ModelEndpoint> | undefined;

/**
 * The providers an endpoint forwards to: the API root `<endpoint>/<provider>` maps onto, and the API
 * Pi speaks to it. OpenRouter's models use its Responses API (stateless), except Anthropic's, which
 * keep its Messages API: Responses gets them no prompt caching. Bedrock's root is regional: its
 * models are named with their region (`amazon-bedrock/<region>/<model id>`), which ends up in the path.
 * `openai-codex` is ChatGPT's Codex backend, for a ChatGPT subscription.
 */
export const UPSTREAMS: Record<string, { root: string; api: string; path?: string }> = {
  anthropic: { root: 'https://api.anthropic.com', api: 'anthropic-messages' },
  openai: { root: 'https://api.openai.com/v1', api: 'openai-responses' },
  openrouter: { root: 'https://openrouter.ai/api', api: 'openai-responses', path: '/v1' },
  google: { root: 'https://generativelanguage.googleapis.com/v1beta', api: 'google-generative-ai' },
  'amazon-bedrock': { root: 'https://bedrock-runtime.<region>.amazonaws.com', api: 'bedrock-converse-stream' },
  'openai-codex': { root: 'https://chatgpt.com/backend-api', api: 'openai-codex-responses' },
};


export type CustomModel = {
  id: string; contextWindow: number; maxOutputTokens?: number; input?: ('text' | 'image')[]; reasoning?: boolean;
  pricing?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }; compat?: Record<string, unknown>;
};
/** The APIs a custom provider may speak, as Pi names them. */
export const CUSTOM_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;
/** A tenant's or key scope's own provider, as models are resolved from it: its API, where it is, and its models. */
export type CustomProvider = { type: typeof CUSTOM_APIS[number]; baseUrl: string; models: CustomModel[] };
/** A tenant's custom providers by name. */
export type CustomProviders = Record<string, CustomProvider> | undefined;

export const FETCH_APIS = ["openai-completions", "openai-responses", "anthropic-messages"];