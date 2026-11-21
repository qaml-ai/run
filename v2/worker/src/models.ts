import { getTenantStub } from "./tenant-do.ts";
import type { Env } from "./types.ts";

export interface V2ModelCatalogEntry {
  id: string;
  provider: string;
  modelId: string;
  reasoning?: boolean;
  maxTokens?: number;
  input: string[];
  cost: { input: number; output: number };
}

export interface V2ModelView extends V2ModelCatalogEntry {
  available: boolean;
}

export const V2_MODEL_CATALOG: V2ModelCatalogEntry[] = [
  { id: "azure/gpt-6.2-sol", provider: "azure", modelId: "gpt-6.2-sol", reasoning: true, maxTokens: 128_000, input: ["text", "image"], cost: { input: 2, output: 10 } },
  { id: "openrouter/meta/muse-ember", provider: "openrouter", modelId: "meta/muse-ember", reasoning: false, maxTokens: 32_768, input: ["text", "image"], cost: { input: 0.1, output: 0.5 } },
  { id: "openrouter/deepseek/deepseek-v4.1-flash", provider: "openrouter", modelId: "deepseek/deepseek-v4.1-flash", reasoning: true, maxTokens: 65_536, input: ["text"], cost: { input: 0.3, output: 1.2 } },
  { id: "openrouter/openai/gpt-6-luna", provider: "openrouter", modelId: "openai/gpt-6-luna", reasoning: true, maxTokens: 65_536, input: ["text", "image"], cost: { input: 0.1, output: 0.5 } },
  { id: "openai/gpt-5", provider: "openai", modelId: "gpt-5", reasoning: true, maxTokens: 128_000, input: ["text", "image"], cost: { input: 2.5, output: 10 } },
  { id: "openai/gpt-4.1", provider: "openai", modelId: "gpt-4.1", reasoning: false, maxTokens: 32_768, input: ["text", "image"], cost: { input: 2, output: 8 } },
  { id: "openai/gpt-4.1-mini", provider: "openai", modelId: "gpt-4.1-mini", reasoning: false, maxTokens: 32_768, input: ["text", "image"], cost: { input: 0.4, output: 1.6 } },
  { id: "openai/gpt-4.1-nano", provider: "openai", modelId: "gpt-4.1-nano", reasoning: false, maxTokens: 32_768, input: ["text", "image"], cost: { input: 0.1, output: 0.4 } },
  { id: "openai/gpt-4o", provider: "openai", modelId: "gpt-4o", reasoning: false, maxTokens: 16_384, input: ["text", "image"], cost: { input: 2.5, output: 10 } },
  { id: "openai/gpt-4o-mini", provider: "openai", modelId: "gpt-4o-mini", reasoning: false, maxTokens: 16_384, input: ["text", "image"], cost: { input: 0.15, output: 0.6 } },
  { id: "anthropic/claude-sonnet-4-0", provider: "anthropic", modelId: "claude-sonnet-4-0", reasoning: true, maxTokens: 64_000, input: ["text", "image"], cost: { input: 3, output: 15 } },
  { id: "anthropic/claude-3-5-haiku-latest", provider: "anthropic", modelId: "claude-3-5-haiku-latest", reasoning: false, maxTokens: 8_192, input: ["text", "image"], cost: { input: 0.8, output: 4 } },
  { id: "gemini/gemini-2.5-pro", provider: "gemini", modelId: "gemini-2.5-pro", reasoning: true, maxTokens: 65_536, input: ["text", "image"], cost: { input: 1.25, output: 10 } },
  { id: "gemini/gemini-2.5-flash", provider: "gemini", modelId: "gemini-2.5-flash", reasoning: true, maxTokens: 65_536, input: ["text", "image"], cost: { input: 0.15, output: 0.6 } },
];

export async function listV2Models(
  env: Env,
  tenantId: string,
  options?: {
    provider?: string | null;
    availableOnly?: boolean;
    keyScope?: string | null;
  },
): Promise<V2ModelView[]> {
  const providerFilter = options?.provider?.trim().toLowerCase() || null;
  const availableOnly = Boolean(options?.availableOnly);
  const keyScope = options?.keyScope?.trim() || null;
  const tenantProviders = await getTenantStub(env, tenantId).listProviders(keyScope);
  const configured = new Set(tenantProviders.map((p) => p.provider.toLowerCase()));

  const platformHas = (provider: string, modelId: string): boolean => {
    if (keyScope) return false;
    if (provider === "azure" && modelId === "gpt-6.2-sol") {
      return Boolean(env.AZURE_OPENAI_SOL_API_KEY && env.AZURE_OPENAI_SOL_ENDPOINT);
    }
    if (provider === "openai") return Boolean(env.OPENAI_API_KEY);
    if (provider === "anthropic") return Boolean(env.ANTHROPIC_API_KEY);
    if (provider === "gemini" || provider === "google") return Boolean(env.GEMINI_API_KEY);
    if (provider === "openrouter") return Boolean(env.OPENROUTER_API_KEY);
    return false;
  };

  const isAvailable = (provider: string, modelId: string): boolean =>
    configured.has(provider) ||
    (provider === "openai" && configured.has("openai-responses")) ||
    (provider === "gemini" && configured.has("google")) ||
    platformHas(provider, modelId);

  const models: V2ModelView[] = V2_MODEL_CATALOG.map((m) => ({
    ...m,
    available: isAvailable(m.provider, m.modelId),
  }));
  const seen = new Set(models.map((m) => m.id));
  for (const tp of tenantProviders) {
    for (const alias of Object.keys(tp.modelAliases ?? {})) {
      const id = `${tp.provider}/${alias}`;
      if (seen.has(id)) continue;
      seen.add(id);
      models.push({
        id,
        provider: tp.provider,
        modelId: alias,
        reasoning: false,
        maxTokens: 32_768,
        input: ["text", "image"],
        cost: { input: 0.5, output: 2 },
        available: true,
      });
    }
  }
  return models.filter(
    (m) => (!providerFilter || m.provider === providerFilter) && (!availableOnly || m.available),
  );
}
