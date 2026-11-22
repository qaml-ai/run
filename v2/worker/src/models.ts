import {
  V2_MODEL_CATALOG,
  type ModelCostSpec,
  type ModelCostTier,
  type V2ModelCatalogEntry,
} from "./model-catalog-data.ts";
import { getTenantStub } from "./tenant-do.ts";
import type { Env } from "./types.ts";

export { V2_MODEL_CATALOG, type ModelCostSpec, type ModelCostTier, type V2ModelCatalogEntry };

export interface V2ModelView extends V2ModelCatalogEntry {
  available: boolean;
}

export async function listV2Models(
  env: Env,
  tenantId: string,
  options?: {
    provider?: string | null;
    availableOnly?: boolean;
    keyScope?: string | null;
  },
): Promise<V2ModelView[]> {
  const rawFilter = options?.provider?.trim().toLowerCase() || null;
  const providerFilter = rawFilter === "google" ? "gemini" : rawFilter === "openai-responses" ? "openai" : rawFilter;
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
        contextWindow: 128_000,
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
