import { getModels } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";

const CHECK_ORDER = ["openai-completions", "openai-responses", "mistral-conversations", "google-generative-ai", "anthropic-messages"];

export type KeyCheck = { status: "valid" | "unverified"; detail?: string } | { status: "invalid"; detail: string };

/**
 * Check a provider key with a free authenticated request (listing models) against
 * the provider's published endpoint. Only a 401/403 counts as invalid; anything
 * else (unknown API, network trouble, 5xx) leaves the key unverified but usable.
 */
export async function checkProviderKey(provider: string, key: string, fetcher: typeof fetch = fetch): Promise<KeyCheck> {
  const usable = (getModels(provider as never) as Model<Api>[]).filter(candidate => candidate.baseUrl && !candidate.baseUrl.includes("{"));
  // Gateways such as OpenRouter also serve some models over Anthropic's API; their key is checked the OpenAI way.
  const model = CHECK_ORDER.map(api => usable.find(candidate => candidate.api === api)).find(Boolean) ?? usable[0];
  if (!model) return { status: "unverified", detail: "No published endpoint to check against" };
  const base = model.baseUrl.replace(/\/+$/, "");
  let request: { url: string; headers: Record<string, string> };
  if (model.api === "anthropic-messages") {
    request = { url: `${base}/v1/models?limit=1`, headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } };
  } else if (model.api === "google-generative-ai") {
    request = { url: `${base}/models?pageSize=1`, headers: { "x-goog-api-key": key } };
  } else if (model.api === "openai-completions" || model.api === "openai-responses" || model.api === "mistral-conversations") {
    request = { url: `${model.api === "mistral-conversations" ? `${base}/v1` : base}/models`, headers: { Authorization: `Bearer ${key}` } };
  } else {
    return { status: "unverified", detail: model.api === "bedrock-converse-stream" ? "Bedrock has no free way to check a key: the first call will" : `No key check for the ${model.api} API` };
  }
  try {
    const response = await fetcher(request.url, { headers: request.headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    await response.body?.cancel();
    if (response.ok) return { status: "valid" };
    if (response.status === 401 || response.status === 403) return { status: "invalid", detail: `${provider} rejected the key (HTTP ${response.status})` };
    return { status: "unverified", detail: `${provider} answered HTTP ${response.status}` };
  } catch (error) {
    return { status: "unverified", detail: `Could not reach ${provider}: ${(error as Error).message}` };
  }
}
