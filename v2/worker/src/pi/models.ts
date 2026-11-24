import {
  calculateCost,
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  lazyStream,
  type Api,
  type ApiStreamOptions,
  type AssistantMessage,
  type Context as PiAiContext,
  type Message as PiAiMessage,
  type Model,
  type MutableModels,
  type ProviderStreams,
  type SimpleStreamOptions,
  type TextContent,
  type Tool as PiAiTool,
  type ToolCall,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai";
import * as anthropicMessagesModule from "@earendil-works/pi-ai/api/anthropic-messages";
import * as azureOpenAIResponsesModule from "@earendil-works/pi-ai/api/azure-openai-responses";
import * as googleGenerativeAIModule from "@earendil-works/pi-ai/api/google-generative-ai";
import * as openAICodexResponsesModule from "@earendil-works/pi-ai/api/openai-codex-responses";
import * as openAICompletionsModule from "@earendil-works/pi-ai/api/openai-completions";
import * as openAIResponsesModule from "@earendil-works/pi-ai/api/openai-responses";

const anthropicMessagesApi = (): ProviderStreams => anthropicMessagesModule as unknown as ProviderStreams;
const azureOpenAIResponsesApi = (): ProviderStreams => azureOpenAIResponsesModule as unknown as ProviderStreams;
const googleGenerativeAIApi = (): ProviderStreams => googleGenerativeAIModule as unknown as ProviderStreams;
const openAICodexResponsesApi = (): ProviderStreams => openAICodexResponsesModule as unknown as ProviderStreams;
const openAICompletionsApi = (): ProviderStreams => openAICompletionsModule as unknown as ProviderStreams;
const openAIResponsesApi = (): ProviderStreams => openAIResponsesModule as unknown as ProviderStreams;
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { AZURE_MODELS } from "@earendil-works/pi-ai/providers/azure.models";
import { GOOGLE_MODELS } from "@earendil-works/pi-ai/providers/google.models";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import {
  defineExtension,
  GenerationTask,
  hook,
  type Extension,
  type GenerationHooks,
  type JsonObject,
  type ModelRef,
} from "@earendil-works/pi-durable";
import { randomId } from "../crypto.ts";
import { lookupCatalogModel, V2_MODEL_CATALOG, type ModelCostSpec } from "../model-catalog-data.ts";
import type { TenantDO } from "../tenant-do.ts";
import {
  ApiError,
  estimateTokens,
  type Env,
  type LlmToolSchema,
  type ModelStreamChunk,
  type ProviderApiStyle,
  type ProviderCredentials,
  type RpcStub,
  type RunUsage,
} from "../types.ts";

function tenantStub(env: Env, tenantId: string): RpcStub<TenantDO> {
  return env.TENANT_DO.get(env.TENANT_DO.idFromName(tenantId)) as unknown as RpcStub<TenantDO>;
}

function lookupPiAiModel(resolved: string): Model<Api> | undefined {
  const ref = parsePiModelRef(resolved);
  switch (ref.provider) {
    case "azure":
      return (AZURE_MODELS as Record<string, Model<Api>>)[ref.modelId];
    case "openai":
      return (OPENAI_MODELS as Record<string, Model<Api>>)[ref.modelId];
    case "anthropic":
      return (ANTHROPIC_MODELS as Record<string, Model<Api>>)[ref.modelId];
    case "gemini":
      return (GOOGLE_MODELS as Record<string, Model<Api>>)[ref.modelId];
    case "openai-codex":
      return (OPENAI_CODEX_MODELS as Record<string, Model<Api>>)[ref.modelId];
    default:
      return undefined;
  }
}

export function isReasoningModel(rawModel: string): boolean {
  const resolved = VIRTUAL_MODEL_ALIASES[rawModel] ?? rawModel;
  const piModel = lookupPiAiModel(resolved);
  if (piModel) return Boolean(piModel.reasoning);
  return Boolean(lookupCatalogModel(resolved)?.reasoning);
}

/**
 * Pure cost calculation helper (zero `cloudflare:workers` runtime imports) matching
 * CamelRun v2's tiered pricing, cache-read, and cache-write pricing rules.
 * Prefers bundled `pi-ai` model metadata via `calculateCost()` before falling back
 * to `V2_MODEL_CATALOG`.
 */
export function calculatePiCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  vmMs = 0,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): number {
  const vmCost = (vmMs / 1000) * 0.00005;
  const resolved = VIRTUAL_MODEL_ALIASES[model] ?? model;
  if (resolved.startsWith("mock/") || resolved === "mock") {
    return Number(vmCost.toFixed(8));
  }

  const clampedCacheRead = Math.max(0, Math.min(inputTokens, cacheReadTokens));
  const clampedCacheWrite = Math.max(0, Math.min(inputTokens - clampedCacheRead, cacheWriteTokens));
  const uncachedInput = Math.max(0, inputTokens - clampedCacheRead - clampedCacheWrite);

  const piModel = lookupPiAiModel(resolved);
  if (piModel) {
    const usage: Usage = {
      input: uncachedInput,
      output: outputTokens,
      cacheRead: clampedCacheRead,
      cacheWrite: clampedCacheWrite,
      totalTokens: inputTokens + outputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    calculateCost(piModel, usage);
    return Number((usage.cost.total + vmCost).toFixed(8));
  }

  const catalogEntry = lookupCatalogModel(resolved);
  const pickTier = (cost: ModelCostSpec) => {
    if (cost.tiers && cost.tiers.length > 0) {
      let active: { input: number; output: number; cacheRead?: number; cacheWrite?: number } = cost;
      for (const tier of cost.tiers) {
        if (inputTokens > tier.inputTokensAbove) active = tier;
      }
      return active;
    }
    return cost;
  };
  const pricing =
    resolved === "azure/gpt-6.2-sol" && inputTokens > 272_000
      ? { input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }
      : catalogEntry
        ? pickTier(catalogEntry.cost)
        : { input: 0.5, output: 2.0 };
  const cacheReadRate = pricing.cacheRead ?? pricing.input * 0.1;
  const cacheWriteRate = pricing.cacheWrite ?? pricing.input;
  const tokenCost =
    (uncachedInput * pricing.input +
      clampedCacheRead * cacheReadRate +
      clampedCacheWrite * cacheWriteRate +
      outputTokens * pricing.output) /
    1_000_000;
  return Number((tokenCost + vmCost).toFixed(8));
}

export const PLATFORM_AZURE_MODELS = new Set(["gpt-6-luna", "gpt-6.1-terra", "gpt-6.2-sol"]);
export const DEFAULT_MODEL_ID = "azure/gpt-6.1-terra";
export const calculateCostUsd = calculatePiCostUsd;

export function addModelUsage(
  usage: RunUsage,
  model: string,
  input: number,
  output: number,
  cacheRead = 0,
  cacheWrite = 0,
): void {
  const clampedCacheRead = Math.max(0, Math.min(input, cacheRead));
  usage.inputTokens += input;
  usage.outputTokens += output;
  if (clampedCacheRead > 0) {
    usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + clampedCacheRead;
  }
  usage.costUsd = Number(
    (usage.costUsd + calculatePiCostUsd(model, input, output, 0, clampedCacheRead, cacheWrite)).toFixed(8),
  );
}

export function getModelContextWindow(rawModel: string): number {
  const resolved = VIRTUAL_MODEL_ALIASES[rawModel] ?? rawModel;
  const piModel = lookupPiAiModel(resolved);
  if (piModel && piModel.contextWindow > 0) return piModel.contextWindow;
  const catalogEntry = lookupCatalogModel(resolved);
  if (catalogEntry) return catalogEntry.contextWindow;
  const m = resolved.toLowerCase();
  if (m === "azure/gpt-6.2-sol") return 1_050_000;
  if (
    m.includes("muse-ember") ||
    m.includes("gemini-2.5") ||
    m.includes("gemini-3") ||
    m.includes("gemini-4") ||
    m.includes("gpt-4.1")
  ) {
    return 1_048_576;
  }
  if (
    m.includes("claude-") ||
    m.includes("o1") ||
    m.includes("o3") ||
    m.includes("o4") ||
    m.includes("gpt-5") ||
    m.includes("gpt-6")
  ) {
    return 200_000;
  }
  return 128_000;
}

export function getAutoCompactThreshold(model: string, override?: number | null): number {
  const ctxWindow = getModelContextWindow(model);
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    const minThreshold = 8_000;
    const maxThreshold = Math.max(minThreshold, Math.floor(ctxWindow * 0.8));
    return Math.min(maxThreshold, Math.max(minThreshold, Math.floor(override)));
  }
  return Math.max(8_000, ctxWindow - PI_COMPACT_RESERVE_TOKENS);
}

export function getProviderLookupCandidates(
  env: Env,
  rawModel: string,
  keyScope?: string | null,
): {
  isMock: boolean;
  modelId: string;
  explicitProvider: string | null;
  candidates: string[];
} {
  const candidateModel = (rawModel || env.DEFAULT_MODEL || DEFAULT_MODEL_ID).trim();
  const model = VIRTUAL_MODEL_ALIASES[candidateModel] ?? candidateModel;

  if (model === "mock" || model.startsWith("mock/")) {
    return { isMock: true, modelId: model, explicitProvider: null, candidates: [] };
  }

  let explicitProvider: string | null = null;
  let modelId = model;
  const slashIdx = model.indexOf("/");
  if (slashIdx > 0) {
    explicitProvider = model.slice(0, slashIdx).toLowerCase();
    modelId = model.slice(slashIdx + 1);
  }

  if (explicitProvider === "azure" && PLATFORM_AZURE_MODELS.has(modelId)) {
    return { isMock: false, modelId, explicitProvider, candidates: keyScope?.trim() ? ["azure"] : [] };
  }
  if (explicitProvider === "azure") return { isMock: false, modelId, explicitProvider, candidates: ["azure"] };
  if (explicitProvider === "openai-codex") return { isMock: false, modelId, explicitProvider, candidates: ["openai-codex"] };
  if (explicitProvider === "custom" || explicitProvider?.startsWith("bedrock-openai-")) {
    return { isMock: false, modelId, explicitProvider, candidates: [explicitProvider] };
  }

  const candidates: string[] = [];
  if (explicitProvider === "anthropic" || (!explicitProvider && modelId.startsWith("claude-"))) {
    candidates.push("anthropic");
  } else if (explicitProvider === "google") {
    candidates.push("google", "gemini");
  } else if (
    explicitProvider === "gemini" ||
    (!explicitProvider && (modelId.startsWith("gemini-") || modelId.startsWith("gemma-")))
  ) {
    candidates.push("gemini", "google");
  } else if (explicitProvider === "openrouter") {
    candidates.push("openrouter");
  } else if (explicitProvider === "openai-responses") {
    candidates.push("openai-responses", "openai");
  } else if (explicitProvider === "openai") {
    candidates.push("openai", "openai-responses");
  } else if (explicitProvider) {
    candidates.push(explicitProvider);
  } else if (modelId.startsWith("grok-")) {
    candidates.push("xai");
  } else {
    candidates.push("openai", "openai-responses");
  }

  return { isMock: false, modelId, explicitProvider, candidates: [...new Set(candidates)] };
}

function hasCustomAuthHeaders(headers?: Record<string, string>): boolean {
  return Boolean(headers && Object.keys(headers).length > 0);
}

export function hasByokCredentials(
  creds: ProviderCredentials | null | undefined,
): creds is ProviderCredentials {
  return Boolean(creds && (creds.apiKey || hasCustomAuthHeaders(creds.headers)));
}

export async function resolveTenantByokProvider(
  env: Env,
  tenantId: string,
  rawModel: string,
  prefetchedProvider?: { model: string; keyScope?: string | null; credentials: ProviderCredentials | null },
  keyScope?: string | null,
): Promise<{
  isByok: boolean;
  prefetchedProvider: { model: string; keyScope?: string | null; credentials: ProviderCredentials | null } | undefined;
}> {
  const normScope = keyScope?.trim() || null;
  const { isMock, candidates } = getProviderLookupCandidates(env, rawModel, normScope);
  if (isMock) {
    return { isByok: false, prefetchedProvider };
  }
  if (
    prefetchedProvider !== undefined &&
    prefetchedProvider.model === rawModel &&
    (prefetchedProvider.keyScope ?? null) === normScope
  ) {
    return {
      isByok: hasByokCredentials(prefetchedProvider.credentials),
      prefetchedProvider,
    };
  }
  if (candidates.length === 0) {
    return {
      isByok: false,
      prefetchedProvider: { model: rawModel, keyScope: normScope, credentials: null },
    };
  }
  const stub = tenantStub(env, tenantId);
  let stored: ProviderCredentials | null = null;
  for (const candidate of candidates) {
    stored = await stub.getProviderSecret(candidate, normScope);
    if (stored) break;
  }
  return {
    isByok: hasByokCredentials(stored),
    prefetchedProvider: { model: rawModel, keyScope: normScope, credentials: stored },
  };
}

const VIRTUAL_MODEL_ALIASES: Record<string, string> = {
  "camelrun/default": DEFAULT_MODEL_ID,
  "camelrun/fast": "openrouter/meta/muse-ember",
  "camelrun/strong": "openrouter/google/gemini-4-carbon",
  "muse-ember": "openrouter/meta/muse-ember",
  "meta/muse-ember": "openrouter/meta/muse-ember",
};

const OPENAI_COMPAT_DEFAULTS: Record<string, { api: Api; baseUrl: string }> = {
  openai: { api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
  "openai-responses": { api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
  "openai-codex": { api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" },
  anthropic: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com" },
  gemini: { api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
  google: { api: "google-generative-ai", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
  openrouter: { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" },
  xai: { api: "openai-responses", baseUrl: "https://api.x.ai/v1" },
  meta: { api: "openai-responses", baseUrl: "https://api.meta.ai/v1" },
  deepseek: { api: "openai-completions", baseUrl: "https://api.deepseek.com" },
  groq: { api: "openai-completions", baseUrl: "https://api.groq.com/openai/v1" },
  mistral: { api: "openai-completions", baseUrl: "https://api.mistral.ai/v1" },
  together: { api: "openai-completions", baseUrl: "https://api.together.ai/v1" },
  fireworks: { api: "openai-completions", baseUrl: "https://api.fireworks.ai/inference/v1" },
  cerebras: { api: "openai-completions", baseUrl: "https://api.cerebras.ai/v1" },
  moonshotai: { api: "openai-completions", baseUrl: "https://api.moonshot.ai/v1" },
  "moonshotai-cn": { api: "openai-completions", baseUrl: "https://api.moonshot.cn/v1" },
  minimax: { api: "anthropic-messages", baseUrl: "https://api.minimax.io/anthropic" },
  "minimax-cn": { api: "anthropic-messages", baseUrl: "https://api.minimaxi.com/anthropic" },
  zai: { api: "openai-completions", baseUrl: "https://api.z.ai/api/coding/paas/v4" },
  "zai-coding-cn": { api: "openai-completions", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" },
  baseten: { api: "openai-completions", baseUrl: "https://inference.baseten.co/v1" },
  nvidia: { api: "openai-completions", baseUrl: "https://integrate.api.nvidia.com/v1" },
  huggingface: { api: "openai-completions", baseUrl: "https://router.huggingface.co/v1" },
  "kimi-coding": { api: "openai-completions", baseUrl: "https://api.kimi.com/coding/v1" },
};

const LAZY_APIS: Record<string, () => ProviderStreams> = {
  "azure-openai-responses": azureOpenAIResponsesApi,
  "openai-responses": openAIResponsesApi,
  "openai-completions": openAICompletionsApi,
  "anthropic-messages": anthropicMessagesApi,
  "google-generative-ai": googleGenerativeAIApi,
  "openai-codex-responses": openAICodexResponsesApi,
};

function apiForStyle(style: ProviderApiStyle): Api {
  switch (style) {
    case "openai-chat":
      return "openai-completions";
    case "openai-responses":
      return "openai-responses";
    case "openai-codex":
      return "openai-codex-responses";
    case "anthropic":
      return "anthropic-messages";
    case "gemini":
      return "google-generative-ai";
  }
}

export function parsePiModelRef(
  rawModel: string | undefined,
  env?: Pick<Env, "DEFAULT_MODEL">,
): ModelRef {
  const candidate = (rawModel || env?.DEFAULT_MODEL || DEFAULT_MODEL_ID).trim();
  const expanded = VIRTUAL_MODEL_ALIASES[candidate] ?? candidate;

  if (expanded === "mock" || expanded.startsWith("mock/")) {
    return {
      provider: "mock",
      modelId: expanded === "mock" ? "default" : expanded.slice("mock/".length) || "default",
    };
  }

  const slashIdx = expanded.indexOf("/");
  if (slashIdx > 0) {
    const rawProvider = expanded.slice(0, slashIdx).toLowerCase();
    const modelId = expanded.slice(slashIdx + 1);
    const provider =
      rawProvider === "google"
        ? "gemini"
        : rawProvider === "openai-responses"
          ? "openai"
          : rawProvider;
    return { provider, modelId };
  }

  if (expanded.startsWith("claude-")) return { provider: "anthropic", modelId: expanded };
  if (expanded.startsWith("gemini-") || expanded.startsWith("gemma-")) {
    return { provider: "gemini", modelId: expanded };
  }
  if (expanded.startsWith("grok-")) return { provider: "xai", modelId: expanded };
  return { provider: "openai", modelId: expanded };
}

export interface ResolvedAzureEndpoint {
  endpointKind: "byok" | "luna" | "sol";
  baseUrl: string;
  apiKey: string;
  deploymentName: string;
  api: Api;
  headers?: Record<string, string>;
}

function normalizeAzureOpenAIBaseUrl(rawEndpoint: string): string {
  const trimmed = rawEndpoint.trim().replace(/\/+$/, "");
  const parsed = new URL(trimmed);
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path === "" || path === "/" || path === "/openai") {
    parsed.pathname = "/openai/v1";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "");
  }
  return trimmed;
}

/**
 * Resolves the Azure OpenAI endpoint and credentials for a model ID:
 * - Tenant BYOK (`azure`) credentials always override platform deployments when present.
 * - Platform `gpt-6-luna` routes to `AZURE_OPENAI_LUNA_ENDPOINT`/`API_KEY` (falling back to Sol if unset).
 * - Platform `gpt-6.1-terra` and `gpt-6.2-sol` route to `AZURE_OPENAI_SOL_ENDPOINT`/`API_KEY`.
 */
export function resolveAzurePlatformConfig(
  env: Pick<
    Env,
    | "AZURE_OPENAI_LUNA_ENDPOINT"
    | "AZURE_OPENAI_LUNA_API_KEY"
    | "AZURE_OPENAI_SOL_ENDPOINT"
    | "AZURE_OPENAI_SOL_API_KEY"
  >,
  modelId: string,
  options?: {
    byok?: ProviderCredentials | null;
    keyScope?: string | null;
  },
): ResolvedAzureEndpoint | null {
  const byok = options?.byok ?? null;
  if (byok) {
    const deploymentName =
      byok.modelAliases && Object.hasOwn(byok.modelAliases, modelId)
        ? byok.modelAliases[modelId]!
        : modelId;
    const baseUrl = byok.baseUrl ? normalizeAzureOpenAIBaseUrl(byok.baseUrl) : "";
    const api: Api = byok.apiStyle
      ? apiForStyle(byok.apiStyle)
      : PLATFORM_AZURE_MODELS.has(modelId)
        ? "azure-openai-responses"
        : "openai-completions";
    return {
      endpointKind: "byok",
      baseUrl,
      apiKey: byok.apiKey || "",
      deploymentName,
      api,
      ...(byok.headers && Object.keys(byok.headers).length > 0 ? { headers: byok.headers } : {}),
    };
  }

  if (options?.keyScope?.trim()) {
    return null;
  }

  if (!PLATFORM_AZURE_MODELS.has(modelId)) {
    return null;
  }

  const useLuna =
    modelId === "gpt-6-luna" &&
    Boolean(env.AZURE_OPENAI_LUNA_ENDPOINT && env.AZURE_OPENAI_LUNA_API_KEY);

  const endpoint = useLuna ? env.AZURE_OPENAI_LUNA_ENDPOINT : env.AZURE_OPENAI_SOL_ENDPOINT;
  const apiKey = useLuna ? env.AZURE_OPENAI_LUNA_API_KEY : env.AZURE_OPENAI_SOL_API_KEY;
  if (!endpoint || !apiKey) {
    return null;
  }

  return {
    endpointKind: useLuna ? "luna" : "sol",
    baseUrl: normalizeAzureOpenAIBaseUrl(endpoint),
    apiKey,
    deploymentName: modelId,
    api: "azure-openai-responses",
  };
}

function buildFallbackModel(
  provider: string,
  modelId: string,
  api: Api,
  baseUrl: string,
): Model<Api> {
  const cat = lookupCatalogModel(`${provider}/${modelId}`) ?? lookupCatalogModel(modelId);
  const inputModalities: ("text" | "image")[] = cat?.input
    ? cat.input.filter((m): m is "text" | "image" => m === "text" || m === "image")
    : ["text", "image"];
  return {
    id: modelId,
    name: modelId,
    api,
    provider,
    baseUrl,
    reasoning: cat?.reasoning ?? false,
    input: inputModalities.length > 0 ? inputModalities : ["text"],
    cost: {
      input: cat?.cost.input ?? 0.5,
      output: cat?.cost.output ?? 2,
      cacheRead: cat?.cost.cacheRead ?? 0,
      cacheWrite: cat?.cost.cacheWrite ?? 0,
      ...(cat?.cost.tiers
        ? {
            tiers: cat.cost.tiers.map((t) => ({
              inputTokensAbove: t.inputTokensAbove,
              input: t.input,
              output: t.output,
              cacheRead: t.cacheRead ?? 0,
              cacheWrite: t.cacheWrite ?? 0,
            })),
          }
        : {}),
    },
    contextWindow: cat?.contextWindow ?? 128_000,
    maxTokens: cat?.maxTokens ?? 32_768,
  };
}

function createStaticAuth(
  name: string,
  apiKey: string | undefined,
  headers?: Record<string, string>,
  baseUrl?: string,
) {
  const hasHeaders = Boolean(headers && Object.keys(headers).length > 0);
  const configured = Boolean(apiKey || hasHeaders);
  return {
    apiKey: {
      name,
      async resolve() {
        if (!configured) return undefined;
        return {
          auth: {
            ...(apiKey ? { apiKey } : {}),
            ...(hasHeaders ? { headers } : {}),
            ...(baseUrl ? { baseUrl } : {}),
          },
          source: name,
        };
      },
    },
  };
}

function createLazyAuth(
  name: string,
  resolveAuth: () => Promise<
    { apiKey?: string; headers?: Record<string, string>; baseUrl?: string } | undefined
  >,
) {
  return {
    apiKey: {
      name,
      async resolve() {
        const resolved = await resolveAuth();
        if (!resolved) return undefined;
        const hasHeaders = Boolean(resolved.headers && Object.keys(resolved.headers).length > 0);
        if (!resolved.apiKey && !hasHeaders) return undefined;
        return {
          auth: {
            ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
            ...(hasHeaders ? { headers: resolved.headers } : {}),
            ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
          },
          source: name,
        };
      },
    },
  };
}

interface ResolvedStreamOverride {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  deploymentName?: string;
}

function wrapStreamsWithOverrides(
  streams: ProviderStreams,
  resolvePerModel: (
    model: Model<Api>,
  ) => ResolvedStreamOverride | Promise<ResolvedStreamOverride>,
): ProviderStreams {
  const adapt = async (
    model: Model<Api>,
    options?: ApiStreamOptions<Api> | SimpleStreamOptions,
  ): Promise<{ model: Model<Api>; options: ApiStreamOptions<Api> | SimpleStreamOptions }> => {
    const resolved = await resolvePerModel(model);
    const nextModel: Model<Api> = resolved.baseUrl
      ? { ...model, baseUrl: resolved.baseUrl }
      : model;
    const mergedHeaders =
      resolved.headers || options?.headers
        ? { ...(resolved.headers ?? {}), ...(options?.headers ?? {}) }
        : undefined;
    const existingOnPayload = options?.onPayload;
    const deploymentName = resolved.deploymentName;
    const onPayload =
      deploymentName && deploymentName !== model.id
        ? async (payload: unknown, payloadModel: Model<Api>) => {
            const mutated =
              payload && typeof payload === "object"
                ? { ...(payload as Record<string, unknown>), model: deploymentName }
                : payload;
            return (await existingOnPayload?.(mutated, payloadModel)) ?? mutated;
          }
        : existingOnPayload;

    const hasExplicitAuthHeader = Boolean(
      mergedHeaders &&
        Object.keys(mergedHeaders).some((k) => k.toLowerCase() === "authorization"),
    );
    const stripDummyAuth = !resolved.apiKey && Boolean(mergedHeaders) && !hasExplicitAuthHeader;
    const customFetch: typeof fetch | undefined = stripDummyAuth
      ? (input, init) => {
          const headers = new Headers(init?.headers);
          headers.delete("authorization");
          return globalThis.fetch(input, { ...init, headers });
        }
      : undefined;

    return {
      model: nextModel,
      options: {
        ...(options ?? {}),
        ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
        ...(mergedHeaders ? { headers: mergedHeaders } : {}),
        ...(customFetch ? { fetch: customFetch } : {}),
        ...(resolved.baseUrl && nextModel.api === "azure-openai-responses"
          ? { azureBaseUrl: resolved.baseUrl }
          : {}),
        ...(onPayload ? { onPayload } : {}),
      } as ApiStreamOptions<Api>,
    };
  };

  return {
    stream: (model, context, options) =>
      lazyStream(model, async () => {
        const adapted = await adapt(model, options);
        return streams.stream(adapted.model, context, adapted.options as ApiStreamOptions<Api>);
      }),
    streamSimple: (model, context, options) =>
      lazyStream(model, async () => {
        const adapted = await adapt(model, options);
        return streams.streamSimple(adapted.model, context, adapted.options as SimpleStreamOptions);
      }),
  };
}

// ---- Deterministic `mock/*` Provider ----

interface ParsedMockDirective {
  parallel: boolean;
  name: string;
  argsJson: string;
  args: JsonObject;
}

function safeParseArgs(jsonStr: string): JsonObject {
  if (!jsonStr || !jsonStr.trim()) return {};
  try {
    const parsed = JSON.parse(jsonStr);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : { value: parsed };
  } catch {
    return { _raw: jsonStr };
  }
}

function extractMockDirectives(text: string): ParsedMockDirective[] {
  const out: ParsedMockDirective[] = [];
  const regex =
    /\[(PARALLEL_CALL|CALL):([A-Za-z0-9_.:-]+)(?:\(([\s\S]*?)\)|\s+(\{[\s\S]*?\}))?\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const parallel = match[1] === "PARALLEL_CALL";
    const name = match[2]!;
    const rawArgs = (match[3] ?? match[4])?.trim() || "{}";
    out.push({
      parallel,
      name,
      argsJson: rawArgs,
      args: safeParseArgs(rawArgs),
    });
  }
  return out;
}

function stripMockDirectives(text: string): string {
  return text
    .replace(/\[(PARALLEL_CALL|CALL):([A-Za-z0-9_.:-]+)(?:\([\s\S]*?\)|\s+\{[\s\S]*?\})?\]/g, "")
    .replace(/\[COST:[^\]]+\]/g, "")
    .trim();
}

function extractUserMessageText(content: string | readonly (TextContent | { type: string })[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContent => b.type === "text" && typeof (b as TextContent).text === "string")
    .map((b) => b.text)
    .join("\n");
}

function extractToolResultText(content: readonly (TextContent | { type: string })[]): string {
  return content
    .filter((b): b is TextContent => b.type === "text" && typeof (b as TextContent).text === "string")
    .map((b) => b.text)
    .join("\n");
}

function synthesizeFromJsonSchema(schema: Record<string, unknown>, seedText: string): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if ("const" in schema) return schema.const;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "object" || schema.properties) {
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const result: Record<string, unknown> = {};
    for (const [k, propSchema] of Object.entries(props)) {
      result[k] = synthesizeFromJsonSchema(propSchema, seedText);
    }
    return result;
  }
  if (type === "array") {
    const itemSchema = (schema.items ?? { type: "string" }) as Record<string, unknown>;
    return [synthesizeFromJsonSchema(itemSchema, seedText)];
  }
  if (type === "number" || type === "integer") {
    return typeof schema.minimum === "number" ? schema.minimum : 1;
  }
  if (type === "boolean") return true;
  if (type === "null") return null;
  return seedText.slice(0, 120) || "ok";
}

function buildMockAssistantMessage(
  model: Model<Api>,
  context: TranscriptContext | PiAiContext,
  options?: { outputSchema?: Record<string, unknown> | null; mockCostPerCallUsd?: number },
): AssistantMessage {
  const messages = context.messages;
  let turnStartIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") {
      turnStartIdx = i;
      break;
    }
  }

  let directiveSourceIdx = turnStartIdx;
  if (turnStartIdx >= 0) {
    const latestText = extractUserMessageText(
      (messages[turnStartIdx] as Extract<(typeof messages)[number], { role: "user" }>).content,
    );
    if (!/\[(PARALLEL_CALL|CALL):/.test(latestText)) {
      for (let i = turnStartIdx - 1; i >= 0; i--) {
        const msg = messages[i]!;
        if (msg.role === "assistant") {
          const hasToolCalls = msg.content.some((c) => c.type === "toolCall");
          if (!hasToolCalls) break;
        }
        if (msg.role === "user") {
          const next = messages[i + 1];
          const nextHasCalls =
            next?.role === "assistant" && next.content.some((c) => c.type === "toolCall");
          if (!nextHasCalls) break;
          const txt = extractUserMessageText(msg.content);
          if (/\[(PARALLEL_CALL|CALL):/.test(txt)) {
            directiveSourceIdx = i;
            break;
          }
        }
      }
    }
  }

  const latestUserText =
    turnStartIdx >= 0
      ? extractUserMessageText(
          (messages[turnStartIdx] as Extract<(typeof messages)[number], { role: "user" }>).content,
        )
      : "";
  const directiveText =
    directiveSourceIdx >= 0
      ? extractUserMessageText(
          (messages[directiveSourceIdx] as Extract<(typeof messages)[number], { role: "user" }>).content,
        )
      : latestUserText;

  let assistantToolStepsAfterDirective = 0;
  const recentToolResults: string[] = [];
  if (directiveSourceIdx >= 0) {
    for (let i = directiveSourceIdx + 1; i < messages.length; i++) {
      const m = messages[i]!;
      if (m.role === "assistant" && m.content.some((c) => c.type === "toolCall")) {
        assistantToolStepsAfterDirective++;
      } else if (m.role === "toolResult") {
        const text = extractToolResultText(m.content);
        if (text) {
          recentToolResults.push(`${m.toolName}=${text}`);
        }
      }
    }
  }

  const inputTokens = Math.max(
    1,
    messages.reduce((acc, m) => {
      if (m.role === "user") return acc + estimateTokens(extractUserMessageText(m.content));
      if (m.role === "toolResult") return acc + estimateTokens(extractToolResultText(m.content));
      if (m.role === "assistant") {
        return (
          acc +
          estimateTokens(
            m.content
              .map((c) => (c.type === "text" ? c.text : c.type === "toolCall" ? c.name : ""))
              .join(" "),
          )
        );
      }
      return acc + 10;
    }, 0),
  );

  // Allow optional `[COST:0.25]` directive in test prompts for deterministic billing/spend-limit tests
  const costMatch = latestUserText.match(/\[COST:([0-9]+(?:\.[0-9]+)?)\]/);
  const explicitCost = costMatch
    ? Number(costMatch[1])
    : (options?.mockCostPerCallUsd ?? 0);

  const mkUsage = (outputTokens: number): Usage => ({
    input: inputTokens,
    output: outputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: inputTokens + outputTokens,
    cost: {
      input: explicitCost,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: explicitCost,
    },
  });

  const isSummarizationRequest = messages.some(
    (m) =>
      m.role === "system" &&
      typeof m.content === "string" &&
      m.content.includes("context summarization assistant"),
  );
  if (isSummarizationRequest) {
    const summaryText = `Summary of prior conversation (${Math.max(1, latestUserText.length)} chars summarized).`;
    return {
      role: "assistant",
      content: [{ type: "text", text: summaryText }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: mkUsage(12),
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  const directives = extractMockDirectives(directiveText);
  const availableToolNames = new Set<string>();
  if ("tools" in context && Array.isArray(context.tools)) {
    for (const t of context.tools) {
      if (t?.name) availableToolNames.add(t.name);
    }
  }
  for (const m of messages) {
    if (m.role === "system") {
      for (const added of m.toolsAdded ?? []) {
        if (added?.name) availableToolNames.add(added.name);
      }
      for (const removed of m.toolsRemoved ?? []) {
        if (typeof removed === "string") availableToolNames.delete(removed);
        else if (removed && typeof removed === "object" && "name" in removed && typeof (removed as { name?: unknown }).name === "string") {
          availableToolNames.delete((removed as { name: string }).name);
        }
      }
    }
  }

  if (directives.length > 0) {
    const parallelDirectives = directives.filter((d) => d.parallel);
    if (parallelDirectives.length > 0 && assistantToolStepsAfterDirective === 0) {
      const toolCalls: ToolCall[] = parallelDirectives
        .filter((d) => availableToolNames.size === 0 || availableToolNames.has(d.name))
        .map((d) => ({
          type: "toolCall",
          id: randomId("mcall", 6),
          name: d.name,
          arguments: d.args,
        }));
      if (toolCalls.length > 0) {
        return {
          role: "assistant",
          content: toolCalls,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: mkUsage(12 * toolCalls.length),
          stopReason: "toolUse",
          timestamp: Date.now(),
        };
      }
    }

    const sequentialDirectives = directives.filter((d) => !d.parallel);
    if (assistantToolStepsAfterDirective < sequentialDirectives.length) {
      const nextDirective = sequentialDirectives[assistantToolStepsAfterDirective]!;
      if (availableToolNames.size === 0 || availableToolNames.has(nextDirective.name)) {
        const call: ToolCall = {
          type: "toolCall",
          id: randomId("mcall", 6),
          name: nextDirective.name,
          arguments: nextDirective.args,
        };
        return {
          role: "assistant",
          content: [call],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: mkUsage(12),
          stopReason: "toolUse",
          timestamp: Date.now(),
        };
      }
    }
  }

  const jsonMatch = latestUserText.match(/\[JSON:(\{[\s\S]*\}|\[[\s\S]*\])\]/);
  if (jsonMatch?.[1] || options?.outputSchema) {
    let jsonText: string;
    if (jsonMatch?.[1]) {
      jsonText = jsonMatch[1];
    } else {
      const seed =
        recentToolResults.length > 0
          ? `${latestUserText} (${recentToolResults.join("; ")})`.trim()
          : stripMockDirectives(latestUserText) || "ok";
      jsonText = JSON.stringify(synthesizeFromJsonSchema(options!.outputSchema!, seed));
    }
    return {
      role: "assistant",
      content: [{ type: "text", text: jsonText }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: mkUsage(estimateTokens(jsonText)),
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  const cleanPrompt = stripMockDirectives(latestUserText);
  const parts: string[] = [];
  if (model.id === "echo") {
    parts.push(cleanPrompt || latestUserText || "echo");
  } else {
    parts.push(`[mock/${model.id}] ${cleanPrompt || "acknowledged"}`);
  }
  if (recentToolResults.length > 0) {
    parts.push(`Tools: ${recentToolResults.join(" | ")}`);
  }
  const reply = parts.join(" — ");

  return {
    role: "assistant",
    content: [{ type: "text", text: reply }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: mkUsage(estimateTokens(reply)),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function streamMockAssistantMessage(
  message: AssistantMessage,
  signal?: AbortSignal,
) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const partial: AssistantMessage = {
      ...message,
      content: [],
      stopReason: "stop",
    };

    if (signal?.aborted) {
      const aborted: AssistantMessage = {
        ...partial,
        stopReason: "aborted",
        errorMessage: "Request was aborted",
      };
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end(aborted);
      return;
    }

    stream.push({ type: "start", partial: { ...partial } });

    for (let i = 0; i < message.content.length; i++) {
      const block = message.content[i]!;
      if (block.type === "text") {
        const textBlock: TextContent = { type: "text", text: "" };
        partial.content = [...partial.content, textBlock];
        stream.push({ type: "text_start", contentIndex: i, partial: { ...partial } });
        const chunkSize = Math.max(8, Math.ceil(block.text.length / 3));
        for (let off = 0; off < block.text.length; off += chunkSize) {
          const delta = block.text.slice(off, off + chunkSize);
          textBlock.text += delta;
          stream.push({ type: "text_delta", contentIndex: i, delta, partial: { ...partial } });
        }
        stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: { ...partial } });
      } else if (block.type === "toolCall") {
        const callBlock: ToolCall = {
          type: "toolCall",
          id: block.id,
          name: block.name,
          arguments: {},
        };
        partial.content = [...partial.content, callBlock];
        stream.push({ type: "toolcall_start", contentIndex: i, partial: { ...partial } });
        const json = JSON.stringify(block.arguments);
        callBlock.arguments = block.arguments;
        stream.push({ type: "toolcall_delta", contentIndex: i, delta: json, partial: { ...partial } });
        stream.push({ type: "toolcall_end", contentIndex: i, toolCall: block, partial: { ...partial } });
      }
    }

    const doneReason =
      message.stopReason === "toolUse" || message.stopReason === "length"
        ? message.stopReason
        : "stop";
    stream.push({ type: "done", reason: doneReason, message });
    stream.end(message);
  });
  return stream;
}

export function createMockProvider(options?: {
  extraModelIds?: string[];
  getOutputSchema?: () => Record<string, unknown> | null | undefined;
  mockCostPerCallUsd?: number;
}) {
  const modelIds = new Set(["default", "echo", "fast", "strong", ...(options?.extraModelIds ?? [])]);
  const models: Model<Api>[] = [...modelIds].map((id) => ({
    id,
    name: `Mock (${id})`,
    api: "openai-responses",
    provider: "mock",
    baseUrl: "mock://local",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  }));

  const mockStreams: ProviderStreams = {
    stream: (model, context, streamOpts) => {
      const msg = buildMockAssistantMessage(model, context, {
        outputSchema: options?.getOutputSchema?.(),
        mockCostPerCallUsd: options?.mockCostPerCallUsd,
      });
      return streamMockAssistantMessage(msg, streamOpts?.signal);
    },
    streamSimple: (model, context, streamOpts) => {
      const msg = buildMockAssistantMessage(model, context, {
        outputSchema: options?.getOutputSchema?.(),
        mockCostPerCallUsd: options?.mockCostPerCallUsd,
      });
      return streamMockAssistantMessage(msg, streamOpts?.signal);
    },
  };

  return createProvider({
    id: "mock",
    name: "Mock",
    baseUrl: "mock://local",
    auth: createStaticAuth("Mock", "mock"),
    models,
    api: mockStreams,
  });
}

// ---- `buildPiModels` Registry Factory ----

export type ProviderCredentialLookup = (
  provider: string,
  keyScope: string | null,
) => Promise<ProviderCredentials | null>;

export const PI_COMPACT_RESERVE_TOKENS = 16_384;

export interface BuildPiModelsOptions {
  env: Env;
  tenantId: string;
  keyScope?: string | null;
  /** Optional model string being requested so dynamic/custom BYOK models are guaranteed registered. */
  rawModel?: string;
  /** Pre-fetched BYOK provider secrets keyed by provider name (avoids redundant TenantDO RPC). */
  prefetchedCredentials?: Record<string, ProviderCredentials | null>;
  /** Override secret lookup (defaults to `getTenantStub(env, tenantId).getProviderSecret`). */
  credentialLookup?: ProviderCredentialLookup;
  /** Optional getter for active run's structured `outputSchema` (used by `mock/*` provider). */
  getOutputSchema?: () => Record<string, unknown> | null | undefined;
  /** Optional synthetic cost per mock model call (for spend-limit testing). */
  mockCostPerCallUsd?: number;
}

export async function buildPiModels(options: BuildPiModelsOptions): Promise<MutableModels> {
  const { env, tenantId } = options;
  const normScope = options.keyScope?.trim() || null;
  const prefetched = options.prefetchedCredentials ?? {};
  const requestedRef = options.rawModel ? parsePiModelRef(options.rawModel, env) : null;

  const lookupSecret: ProviderCredentialLookup = async (provider, scope) => {
    if (Object.prototype.hasOwnProperty.call(prefetched, provider)) {
      return prefetched[provider] ?? null;
    }
    if (options.credentialLookup) {
      return options.credentialLookup(provider, scope);
    }
    try {
      return await tenantStub(env, tenantId).getProviderSecret(provider, scope);
    } catch {
      return null;
    }
  };

  // Lazy memoized secret lookup: only resolves the active provider eagerly (0 RPCs for mock
  // or when prefetchedCredentials already has the active provider; other core providers resolve
  // on demand inside auth.resolve / lazyStream).
  const secretCache = new Map<string, Promise<ProviderCredentials | null>>();
  const getSecret = (provider: string): Promise<ProviderCredentials | null> => {
    const cached = secretCache.get(provider);
    if (cached) return cached;
    const promise = (async () => {
      if (provider === "gemini") {
        const direct = await lookupSecret("gemini", normScope);
        return direct ?? (await lookupSecret("google", normScope));
      }
      if (provider === "openai") {
        const direct = await lookupSecret("openai", normScope);
        return direct ?? (await lookupSecret("openai-responses", normScope));
      }
      return lookupSecret(provider, normScope);
    })();
    secretCache.set(provider, promise);
    return promise;
  };

  const eagerSecret = async (provider: string): Promise<ProviderCredentials | null> => {
    if (
      requestedRef?.provider === provider ||
      Object.prototype.hasOwnProperty.call(prefetched, provider) ||
      (provider === "gemini" && Object.prototype.hasOwnProperty.call(prefetched, "google")) ||
      (provider === "openai" && Object.prototype.hasOwnProperty.call(prefetched, "openai-responses"))
    ) {
      return getSecret(provider);
    }
    return null;
  };

  const models = createModels();

  // 1. Mock provider (always registered for tests)
  models.setProvider(
    createMockProvider({
      extraModelIds: requestedRef?.provider === "mock" ? [requestedRef.modelId] : [],
      getOutputSchema: options.getOutputSchema,
      mockCostPerCallUsd: options.mockCostPerCallUsd,
    }),
  );

  // 2. Dual-endpoint Azure platform provider + BYOK override
  {
    const azureByok = await eagerSecret("azure");
    const azureCatalogModels: Model<Api>[] = Object.values(AZURE_MODELS).map((m) => {
      const cfg = resolveAzurePlatformConfig(env, m.id, { byok: azureByok, keyScope: normScope });
      return {
        ...m,
        ...(cfg ? { api: cfg.api, baseUrl: cfg.baseUrl } : {}),
      };
    });

    if (
      requestedRef?.provider === "azure" &&
      !azureCatalogModels.some((m) => m.id === requestedRef.modelId)
    ) {
      const cfg = resolveAzurePlatformConfig(env, requestedRef.modelId, {
        byok: azureByok,
        keyScope: normScope,
      });
      azureCatalogModels.push(
        buildFallbackModel(
          "azure",
          requestedRef.modelId,
          cfg?.api ?? "azure-openai-responses",
          cfg?.baseUrl ?? "",
        ),
      );
    }

    const anyPlatformAzure =
      !normScope &&
      Boolean(
        (env.AZURE_OPENAI_SOL_ENDPOINT && env.AZURE_OPENAI_SOL_API_KEY) ||
          (env.AZURE_OPENAI_LUNA_ENDPOINT && env.AZURE_OPENAI_LUNA_API_KEY),
      );

    const resolvePerAzureModel = async (model: Model<Api>) => {
      const byok = await getSecret("azure");
      const cfg = resolveAzurePlatformConfig(env, model.id, {
        byok,
        keyScope: normScope,
      });
      if (!cfg) {
        throw new ApiError(
          503,
          "missing_provider_key",
          `Azure deployment for '${model.id}' is not configured`,
        );
      }
      return {
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        headers: cfg.headers,
        deploymentName: cfg.deploymentName,
      };
    };

    models.setProvider(
      createProvider({
        id: "azure",
        name: "Azure OpenAI",
        auth: createLazyAuth("Azure OpenAI", async () => {
          const byok = await getSecret("azure");
          const configured = Boolean(byok || anyPlatformAzure);
          if (!configured) return undefined;
          return {
            apiKey:
              byok?.apiKey ||
              env.AZURE_OPENAI_SOL_API_KEY ||
              env.AZURE_OPENAI_LUNA_API_KEY ||
              undefined,
            headers: byok?.headers,
          };
        }),
        models: azureCatalogModels,
        api: {
          "azure-openai-responses": wrapStreamsWithOverrides(
            azureOpenAIResponsesApi(),
            resolvePerAzureModel,
          ),
          "openai-responses": wrapStreamsWithOverrides(openAIResponsesApi(), resolvePerAzureModel),
          "openai-completions": wrapStreamsWithOverrides(
            openAICompletionsApi(),
            resolvePerAzureModel,
          ),
        },
      }),
    );
  }

  // 3. OpenAI
  {
    const initialByok = await eagerSecret("openai");
    const defaultBaseUrl = (initialByok?.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
    const defaultApi: Api = initialByok?.apiStyle ? apiForStyle(initialByok.apiStyle) : "openai-responses";
    const list: Model<Api>[] = Object.values(OPENAI_MODELS).map((m) => ({
      ...m,
      api: initialByok?.apiStyle ? defaultApi : m.api,
      baseUrl: defaultBaseUrl,
    }));
    if (requestedRef?.provider === "openai" && !list.some((m) => m.id === requestedRef.modelId)) {
      list.push(buildFallbackModel("openai", requestedRef.modelId, defaultApi, defaultBaseUrl));
    }
    const resolveOverride = async (model: Model<Api>) => {
      const byok = await getSecret("openai");
      const apiKey = byok?.apiKey || (normScope ? "" : env.OPENAI_API_KEY || "");
      const baseUrl = (byok?.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
      return {
        apiKey,
        baseUrl,
        headers: byok?.headers,
        deploymentName:
          byok?.modelAliases && Object.hasOwn(byok.modelAliases, model.id)
            ? byok.modelAliases[model.id]
            : undefined,
      };
    };
    models.setProvider(
      createProvider({
        id: "openai",
        name: "OpenAI",
        baseUrl: defaultBaseUrl,
        auth: createLazyAuth("OpenAI API key", async () => {
          const byok = await getSecret("openai");
          const apiKey = byok?.apiKey || (normScope ? "" : env.OPENAI_API_KEY || "");
          const baseUrl = (byok?.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
          return { apiKey: apiKey || undefined, headers: byok?.headers, baseUrl };
        }),
        models: list,
        api: {
          "openai-responses": wrapStreamsWithOverrides(openAIResponsesApi(), resolveOverride),
          "openai-completions": wrapStreamsWithOverrides(openAICompletionsApi(), resolveOverride),
        },
      }),
    );
  }

  // 4. Anthropic
  {
    const initialByok = await eagerSecret("anthropic");
    const defaultBaseUrl = (initialByok?.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
    const defaultApi: Api = initialByok?.apiStyle ? apiForStyle(initialByok.apiStyle) : "anthropic-messages";
    const list: Model<Api>[] = Object.values(ANTHROPIC_MODELS).map((m) => ({
      ...m,
      api: initialByok?.apiStyle ? defaultApi : m.api,
      baseUrl: defaultBaseUrl,
    }));
    if (requestedRef?.provider === "anthropic" && !list.some((m) => m.id === requestedRef.modelId)) {
      list.push(buildFallbackModel("anthropic", requestedRef.modelId, defaultApi, defaultBaseUrl));
    }
    const resolveOverride = async (model: Model<Api>) => {
      const byok = await getSecret("anthropic");
      const apiKey = byok?.apiKey || (normScope ? "" : env.ANTHROPIC_API_KEY || "");
      const baseUrl = (byok?.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
      return {
        apiKey,
        baseUrl,
        headers: byok?.headers,
        deploymentName:
          byok?.modelAliases && Object.hasOwn(byok.modelAliases, model.id)
            ? byok.modelAliases[model.id]
            : undefined,
      };
    };
    models.setProvider(
      createProvider({
        id: "anthropic",
        name: "Anthropic",
        baseUrl: defaultBaseUrl,
        auth: createLazyAuth("Anthropic API key", async () => {
          const byok = await getSecret("anthropic");
          const apiKey = byok?.apiKey || (normScope ? "" : env.ANTHROPIC_API_KEY || "");
          const baseUrl = (byok?.baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
          return { apiKey: apiKey || undefined, headers: byok?.headers, baseUrl };
        }),
        models: list,
        api: {
          "anthropic-messages": wrapStreamsWithOverrides(anthropicMessagesApi(), resolveOverride),
          "openai-completions": wrapStreamsWithOverrides(openAICompletionsApi(), resolveOverride),
        },
      }),
    );
  }

  // 5. Gemini (Google Generative AI)
  {
    const initialByok = await eagerSecret("gemini");
    const defaultBaseUrl = (
      initialByok?.baseUrl || "https://generativelanguage.googleapis.com/v1beta"
    ).replace(/\/+$/, "");
    const defaultApi: Api = initialByok?.apiStyle ? apiForStyle(initialByok.apiStyle) : "google-generative-ai";
    const list: Model<Api>[] = Object.values(GOOGLE_MODELS).map((m) => ({
      ...m,
      provider: "gemini",
      api: initialByok?.apiStyle ? defaultApi : m.api,
      baseUrl: defaultBaseUrl,
    }));
    if (requestedRef?.provider === "gemini" && !list.some((m) => m.id === requestedRef.modelId)) {
      list.push(buildFallbackModel("gemini", requestedRef.modelId, defaultApi, defaultBaseUrl));
    }
    const resolveOverride = async (model: Model<Api>) => {
      const byok = await getSecret("gemini");
      const apiKey = byok?.apiKey || (normScope ? "" : env.GEMINI_API_KEY || "");
      const baseUrl = (
        byok?.baseUrl || "https://generativelanguage.googleapis.com/v1beta"
      ).replace(/\/+$/, "");
      return {
        apiKey,
        baseUrl,
        headers: byok?.headers,
        deploymentName:
          byok?.modelAliases && Object.hasOwn(byok.modelAliases, model.id)
            ? byok.modelAliases[model.id]
            : undefined,
      };
    };
    models.setProvider(
      createProvider({
        id: "gemini",
        name: "Google Gemini",
        baseUrl: defaultBaseUrl,
        auth: createLazyAuth("Gemini API key", async () => {
          const byok = await getSecret("gemini");
          const apiKey = byok?.apiKey || (normScope ? "" : env.GEMINI_API_KEY || "");
          const baseUrl = (
            byok?.baseUrl || "https://generativelanguage.googleapis.com/v1beta"
          ).replace(/\/+$/, "");
          return { apiKey: apiKey || undefined, headers: byok?.headers, baseUrl };
        }),
        models: list,
        api: {
          "google-generative-ai": wrapStreamsWithOverrides(googleGenerativeAIApi(), resolveOverride),
          "openai-completions": wrapStreamsWithOverrides(openAICompletionsApi(), resolveOverride),
        },
      }),
    );
  }

  // 6. OpenRouter (uses lean V2_MODEL_CATALOG + dynamic requested model ID, avoiding 301 KiB openrouter.json bloat)
  {
    const initialByok = await eagerSecret("openrouter");
    const defaultBaseUrl = (initialByok?.baseUrl || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
    const defaultApi: Api = initialByok?.apiStyle ? apiForStyle(initialByok.apiStyle) : "openai-completions";
    const list: Model<Api>[] = V2_MODEL_CATALOG.filter((m) => m.provider === "openrouter").map(
      (m) => buildFallbackModel("openrouter", m.modelId, defaultApi, defaultBaseUrl),
    );
    if (requestedRef?.provider === "openrouter" && !list.some((m) => m.id === requestedRef.modelId)) {
      list.push(buildFallbackModel("openrouter", requestedRef.modelId, defaultApi, defaultBaseUrl));
    }
    const resolveOverride = async (model: Model<Api>) => {
      const byok = await getSecret("openrouter");
      const apiKey = byok?.apiKey || (normScope ? "" : env.OPENROUTER_API_KEY || "");
      const baseUrl = (byok?.baseUrl || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
      return {
        apiKey,
        baseUrl,
        headers: byok?.headers,
        deploymentName:
          byok?.modelAliases && Object.hasOwn(byok.modelAliases, model.id)
            ? byok.modelAliases[model.id]
            : undefined,
      };
    };
    models.setProvider(
      createProvider({
        id: "openrouter",
        name: "OpenRouter",
        baseUrl: defaultBaseUrl,
        auth: createLazyAuth("OpenRouter API key", async () => {
          const byok = await getSecret("openrouter");
          const apiKey = byok?.apiKey || (normScope ? "" : env.OPENROUTER_API_KEY || "");
          const baseUrl = (byok?.baseUrl || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
          return { apiKey: apiKey || undefined, headers: byok?.headers, baseUrl };
        }),
        models: list,
        api: {
          "openai-completions": wrapStreamsWithOverrides(openAICompletionsApi(), resolveOverride),
          "anthropic-messages": wrapStreamsWithOverrides(anthropicMessagesApi(), resolveOverride),
        },
      }),
    );
  }

  // 7. OpenAI Codex (BYOK)
  {
    const initialByok = await eagerSecret("openai-codex");
    const defaultBaseUrl = (initialByok?.baseUrl || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
    const list: Model<Api>[] = Object.values(OPENAI_CODEX_MODELS).map((m) => ({
      ...m,
      baseUrl: defaultBaseUrl,
    }));
    if (requestedRef?.provider === "openai-codex" && !list.some((m) => m.id === requestedRef.modelId)) {
      list.push(buildFallbackModel("openai-codex", requestedRef.modelId, "openai-codex-responses", defaultBaseUrl));
    }
    models.setProvider(
      createProvider({
        id: "openai-codex",
        name: "OpenAI Codex",
        baseUrl: defaultBaseUrl,
        auth: createLazyAuth("OpenAI Codex", async () => {
          const byok = await getSecret("openai-codex");
          const baseUrl = (byok?.baseUrl || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
          return { apiKey: byok?.apiKey || undefined, headers: byok?.headers, baseUrl };
        }),
        models: list,
        api: wrapStreamsWithOverrides(openAICodexResponsesApi(), async () => {
          const byok = await getSecret("openai-codex");
          return {
            apiKey: byok?.apiKey || "",
            baseUrl: (byok?.baseUrl || "https://chatgpt.com/backend-api").replace(/\/+$/, ""),
            headers: byok?.headers,
          };
        }),
      }),
    );
  }

  // 8. Custom / OpenAI-compatible BYOK providers (e.g. xai, deepseek, custom, bedrock-openai-*)
  const coreProviders = new Set(["mock", "azure", "openai", "anthropic", "gemini", "openrouter", "openai-codex"]);
  const extraProviders = new Set<string>(Object.keys(prefetched));
  if (requestedRef && !coreProviders.has(requestedRef.provider)) {
    extraProviders.add(requestedRef.provider);
  }
  for (const providerId of extraProviders) {
    if (coreProviders.has(providerId)) continue;
    const byok = await getSecret(providerId);
    const defaults = OPENAI_COMPAT_DEFAULTS[providerId];
    if (!byok && !defaults) continue;
    const api: Api = byok?.apiStyle
      ? apiForStyle(byok.apiStyle)
      : (defaults?.api ?? "openai-completions");
    const baseUrl = (byok?.baseUrl || defaults?.baseUrl || "").replace(/\/+$/, "");
    const apiFactory = LAZY_APIS[api] ?? openAICompletionsApi;

    const modelIds = new Set<string>();
    if (requestedRef?.provider === providerId) modelIds.add(requestedRef.modelId);
    for (const alias of Object.keys(byok?.modelAliases ?? {})) modelIds.add(alias);
    for (const cat of V2_MODEL_CATALOG) {
      if (cat.provider === providerId) modelIds.add(cat.modelId);
    }

    const list: Model<Api>[] = [...modelIds].map((id) =>
      buildFallbackModel(providerId, id, api, baseUrl),
    );
    models.setProvider(
      createProvider({
        id: providerId,
        name: providerId,
        baseUrl,
        auth: createStaticAuth(providerId, byok?.apiKey || undefined, byok?.headers, baseUrl),
        models: list,
        api: wrapStreamsWithOverrides(apiFactory(), (model) => ({
          apiKey: byok?.apiKey,
          baseUrl,
          headers: byok?.headers,
          deploymentName:
            byok?.modelAliases && Object.hasOwn(byok.modelAliases, model.id)
              ? byok.modelAliases[model.id]
              : undefined,
        })),
      }),
    );
  }

  return models;
}

// ---- `beforeProviderRequest` Hook (outputSchema, OpenRouter privacy) ----

export interface ProviderRequestHookOptions {
  /** Returns the active run's JSON Schema for structured output, if any. */
  getOutputSchema?: () => Record<string, unknown> | null | undefined;
}

export function createProviderRequestHook(
  options?: ProviderRequestHookOptions,
): NonNullable<GenerationHooks["beforeProviderRequest"]> {
  return ({ model, payload }) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return undefined;
    }

    let next = payload as Record<string, unknown>;
    let mutated = false;
    const ensureClone = () => {
      if (!mutated) {
        next = { ...next };
        mutated = true;
      }
    };

    // 1. Structured output schema injection
    const outputSchema = options?.getOutputSchema?.();
    if (outputSchema && typeof outputSchema === "object") {
      ensureClone();
      if (
        model.api === "azure-openai-responses" ||
        model.api === "openai-responses" ||
        model.api === "openai-codex-responses"
      ) {
        const existingText =
          next.text && typeof next.text === "object" && !Array.isArray(next.text)
            ? (next.text as Record<string, unknown>)
            : {};
        next.text = {
          ...existingText,
          format: {
            type: "json_schema",
            name: "structured_output",
            schema: outputSchema,
            strict: false,
          },
        };
      } else if (model.api === "openai-completions") {
        next.response_format = {
          type: "json_schema",
          json_schema: {
            name: "structured_output",
            schema: outputSchema,
            strict: false,
          },
        };
      } else if (model.api === "google-generative-ai") {
        const existingConfig =
          next.generationConfig &&
          typeof next.generationConfig === "object" &&
          !Array.isArray(next.generationConfig)
            ? (next.generationConfig as Record<string, unknown>)
            : {};
        next.generationConfig = {
          ...existingConfig,
          responseMimeType: "application/json",
          responseSchema: outputSchema,
        };
      }
    }

    // 2. OpenRouter zero-data-retention privacy flag
    if (model.provider === "openrouter") {
      ensureClone();
      const existingProvider =
        next.provider && typeof next.provider === "object" && !Array.isArray(next.provider)
          ? (next.provider as Record<string, unknown>)
          : {};
      next.provider = {
        ...existingProvider,
        data_collection: "deny",
      };
    }

    return mutated ? { payload: next } : undefined;
  };
}

export function createProviderRequestExtension(options?: ProviderRequestHookOptions): Extension {
  return defineExtension({
    name: "camelrun-provider-request",
    hooks: [
      hook(GenerationTask, {
        beforeProviderRequest: createProviderRequestHook(options),
      }),
    ],
  });
}

// ---- Stateless Pi Model Streaming (`POST /v2/runs`, `POST /v2/decisions`, dreaming) ----

export interface StreamPiModelRequest {
  env: Env;
  tenantId: string;
  model: string;
  keyScope?: string | null;
  instructions?: string;
  messages: PiAiMessage[];
  tools?: LlmToolSchema[];
  outputSchema?: Record<string, unknown> | null;
  temperature?: number;
  maxOutputTokens?: number;
  promptCacheKey?: string;
  signal?: AbortSignal;
  prefetchedCredentials?: Record<string, ProviderCredentials | null>;
}

export type PiModelStreamChunk =
  | Exclude<ModelStreamChunk, { type: "done" }>
  | {
      type: "done";
      inputTokens: number;
      outputTokens: number;
      stopReason: string;
      cacheReadTokens?: number;
      message: AssistantMessage;
    };

export async function* streamPiModel(
  req: StreamPiModelRequest,
): AsyncGenerator<PiModelStreamChunk, void, unknown> {
  const ref = parsePiModelRef(req.model, req.env);
  const models = await buildPiModels({
    env: req.env,
    tenantId: req.tenantId,
    keyScope: req.keyScope ?? null,
    rawModel: req.model,
    prefetchedCredentials: req.prefetchedCredentials,
    getOutputSchema: () => req.outputSchema ?? null,
  });

  const model = models.getModel(ref.provider, ref.modelId);
  if (!model) {
    throw new ApiError(400, "unknown_model", `Model '${req.model}' is not registered`);
  }

  if (ref.provider !== "mock") {
    const auth = await models.getAuth(model);
    if (!auth) {
      const isPlatformAzure = ref.provider === "azure" && PLATFORM_AZURE_MODELS.has(ref.modelId);
      throw new ApiError(
        isPlatformAzure ? 503 : 400,
        "missing_provider_key",
        `No API key configured for provider '${ref.provider}'`,
      );
    }
  }

  const requestHook = createProviderRequestHook({
    getOutputSchema: () => req.outputSchema ?? null,
  });

  const piTools: PiAiTool[] | undefined =
    req.tools && req.tools.length > 0
      ? req.tools.map((t) => ({
          name: t.name,
          description: t.description || `Tool ${t.name}`,
          parameters: t.parameters as PiAiTool["parameters"],
        }))
      : undefined;

  const piContext: PiAiContext = {
    ...(req.instructions ? { systemPrompt: req.instructions } : {}),
    messages: req.messages,
    ...(piTools ? { tools: piTools } : {}),
  };

  const omitTemperature =
    model.reasoning &&
    (model.api === "azure-openai-responses" ||
      model.api === "openai-responses" ||
      (model.api === "openai-completions" && model.provider === "openai"));
  const defaultAzureReasoning =
    model.provider === "azure" && model.reasoning && model.api === "azure-openai-responses"
      ? ("low" as const)
      : undefined;

  const eventStream = models.streamSimple(model, piContext, {
    ...(req.signal ? { signal: req.signal } : {}),
    ...(req.temperature !== undefined && !omitTemperature ? { temperature: req.temperature } : {}),
    ...(req.maxOutputTokens !== undefined ? { maxTokens: req.maxOutputTokens } : {}),
    ...(req.promptCacheKey ? { sessionId: req.promptCacheKey.slice(0, 64) } : {}),
    ...(defaultAzureReasoning ? { reasoning: defaultAzureReasoning } : {}),
    onPayload: async (payload, payloadModel) => {
      const res = await requestHook(
        { model: payloadModel, payload } as Parameters<typeof requestHook>[0],
        {} as Parameters<typeof requestHook>[1],
        {} as Parameters<typeof requestHook>[2],
      );
      return res && "payload" in res ? res.payload : payload;
    },
  });

  let finalMessage: AssistantMessage | null = null;
  for await (const ev of eventStream) {
    if (ev.type === "text_delta") {
      yield { type: "text_delta", delta: ev.delta };
    } else if (ev.type === "toolcall_end") {
      const args =
        ev.toolCall.arguments && typeof ev.toolCall.arguments === "object"
          ? (ev.toolCall.arguments as Record<string, unknown>)
          : {};
      yield {
        type: "tool_call",
        id: ev.toolCall.id,
        name: ev.toolCall.name,
        argumentsJson: JSON.stringify(args),
        args,
      };
    } else if (ev.type === "done") {
      finalMessage = ev.message;
    } else if (ev.type === "error") {
      if (req.signal?.aborted) {
        throw req.signal.reason instanceof Error
          ? req.signal.reason
          : new DOMException("Request was aborted", "AbortError");
      }
      throw new ApiError(
        502,
        "provider_error",
        ev.error.errorMessage || "Model provider returned an error",
      );
    }
  }

  if (!finalMessage) {
    finalMessage = await eventStream.result();
  }
  if (finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted") {
    if (req.signal?.aborted) {
      throw req.signal.reason instanceof Error
        ? req.signal.reason
        : new DOMException("Request was aborted", "AbortError");
    }
    throw new ApiError(
      502,
      "provider_error",
      finalMessage.errorMessage || "Model provider returned an error",
    );
  }

  const uncachedInput = finalMessage.usage?.input ?? 0;
  const cacheReadTokens = finalMessage.usage?.cacheRead ?? 0;
  const cacheWriteTokens = finalMessage.usage?.cacheWrite ?? 0;
  const inputTokens = uncachedInput + cacheReadTokens + cacheWriteTokens;
  const outputTokens = finalMessage.usage?.output ?? 0;

  yield {
    type: "done",
    inputTokens,
    outputTokens,
    cacheReadTokens,
    stopReason: finalMessage.stopReason,
    message: finalMessage,
  };
}

export async function completePiModel(
  req: StreamPiModelRequest,
): Promise<{
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  message: AssistantMessage;
}> {
  let text = "";
  let doneChunk: Extract<PiModelStreamChunk, { type: "done" }> | null = null;
  for await (const chunk of streamPiModel(req)) {
    if (chunk.type === "text_delta") {
      text += chunk.delta;
    } else if (chunk.type === "done") {
      doneChunk = chunk;
    }
  }
  if (!doneChunk) {
    throw new ApiError(502, "provider_error", "Model stream ended without a terminal message");
  }
  return {
    text,
    inputTokens: doneChunk.inputTokens,
    outputTokens: doneChunk.outputTokens,
    cacheReadTokens: doneChunk.cacheReadTokens ?? 0,
    message: doneChunk.message,
  };
}
