import type { Api, Model } from "@earendil-works/pi-ai";

// src/compaction.ts: a scope replaces the provider root, preserving only the
// provider API path after it (OpenRouter's /api/v1 becomes /messages or /responses).
const PROVIDER_ROOTS: Record<string, string> = { openrouter: "https://openrouter.ai/api/v1", anthropic: "https://api.anthropic.com", openai: "https://api.openai.com/v1" };
export function gatewayUrl(model: Model<Api>, url: string, baseUrl: string): string {
  const roots = [PROVIDER_ROOTS[model.provider], model.baseUrl].filter((value): value is string => !!value).map(value => value.replace(/\/+$/, "")).sort((a, b) => b.length - a.length);
  const root = roots.find(prefix => url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`));
  if (!root) throw new Error(`The key scope's baseUrl does not stand for ${new URL(url).origin}`);
  return baseUrl + url.slice(root.length);
}
