import { CamelFsClient } from "./camelfs.ts";
import { randomId } from "./crypto.ts";
import { loadConversationImages, type ModelImage } from "./run-files.ts";
import type { LegacyInlineBlock } from "./legacy-inline-images.ts";
import { FILE_LIMITS } from "./lib/limits.ts";
import { lookupCatalogModel, type ModelCostSpec } from "./model-catalog-data.ts";
import type { ToolImageRef } from "./tool-images.ts";
import { getTenantStub } from "./tenant-do.ts";
import {
  ApiError,
  estimateTokens,
  type ChatRole,
  type Env,
  type LlmToolSchema,
  type ModelStreamChunk,
  type ProviderCredentials,
  type RunUsage,
  type StoredRunFile,
  type ToolCallInvocation,
} from "./types.ts";

export interface ConversationMessage {
  role: ChatRole;
  text?: string;
  files?: StoredRunFile[];
  images?: ModelImage[];
  toolImages?: ToolImageRef[];
  legacyInlineContent?: LegacyInlineBlock[];
  toolCalls?: ToolCallInvocation[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface StreamModelRequest {
  env: Env;
  tenantId: string;
  model: string;
  keyScope?: string | null;
  instructions?: string;
  messages: ConversationMessage[];
  tools?: LlmToolSchema[];
  outputSchema?: Record<string, unknown> | null;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  purpose?: "turn" | "compaction" | "dreaming" | "decision";
  /** Optional stable key for prompt-cache routing (OpenAI/Azure Responses `prompt_cache_key`). */
  promptCacheKey?: string;
  /** Pre-resolved tenant provider secret lookup (`undefined` = not prefetched; `{ credentials: null }` = verified none stored). */
  prefetchedProvider?: { credentials: ProviderCredentials | null };
}

interface ResolvedEndpoint {
  protocol: "mock" | "openai-chat" | "openai-responses" | "openai-codex" | "anthropic" | "gemini";
  providerName: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
  headers?: Record<string, string>;
}

const AZURE_TERRA = "azure/gpt-6.1-terra";
const AZURE_SOL = "azure/gpt-6.2-sol";
export const PLATFORM_AZURE_MODELS = new Set(["gpt-6.1-terra", "gpt-6.2-sol"]);
const MUSE_EMBER = "openrouter/meta/muse-ember";
const GEMINI_CARBON = "openrouter/google/gemini-4-carbon";
export const DEFAULT_MODEL_ID = AZURE_TERRA;

const VIRTUAL_MODEL_ALIASES: Record<string, string> = {
  "camelrun/default": DEFAULT_MODEL_ID,
  "camelrun/fast": MUSE_EMBER,
  "camelrun/strong": GEMINI_CARBON,
  "muse-ember": MUSE_EMBER,
  "meta/muse-ember": MUSE_EMBER,
};

interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const PROVIDER_DEFAULTS: Record<string, { protocol: ResolvedEndpoint["protocol"]; baseUrl: string }> = {
  openai: { protocol: "openai-responses", baseUrl: "https://api.openai.com/v1" },
  "openai-responses": { protocol: "openai-responses", baseUrl: "https://api.openai.com/v1" },
  "openai-codex": { protocol: "openai-codex", baseUrl: "https://chatgpt.com/backend-api" },
  anthropic: { protocol: "anthropic", baseUrl: "https://api.anthropic.com" },
  gemini: { protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com" },
  google: { protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com" },
  openrouter: { protocol: "openai-chat", baseUrl: "https://openrouter.ai/api/v1" },
  xai: { protocol: "openai-responses", baseUrl: "https://api.x.ai/v1" },
  meta: { protocol: "openai-responses", baseUrl: "https://api.meta.ai/v1" },
  deepseek: { protocol: "openai-chat", baseUrl: "https://api.deepseek.com" },
  groq: { protocol: "openai-chat", baseUrl: "https://api.groq.com/openai/v1" },
  mistral: { protocol: "openai-chat", baseUrl: "https://api.mistral.ai/v1" },
  together: { protocol: "openai-chat", baseUrl: "https://api.together.ai/v1" },
  fireworks: { protocol: "openai-chat", baseUrl: "https://api.fireworks.ai/inference/v1" },
  cerebras: { protocol: "openai-chat", baseUrl: "https://api.cerebras.ai/v1" },
  moonshotai: { protocol: "openai-chat", baseUrl: "https://api.moonshot.ai/v1" },
  "moonshotai-cn": { protocol: "openai-chat", baseUrl: "https://api.moonshot.cn/v1" },
  minimax: { protocol: "anthropic", baseUrl: "https://api.minimax.io/anthropic" },
  "minimax-cn": { protocol: "anthropic", baseUrl: "https://api.minimaxi.com/anthropic" },
  zai: { protocol: "openai-chat", baseUrl: "https://api.z.ai/api/coding/paas/v4" },
  "zai-coding-cn": { protocol: "openai-chat", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" },
  baseten: { protocol: "openai-chat", baseUrl: "https://inference.baseten.co/v1" },
  nvidia: { protocol: "openai-chat", baseUrl: "https://integrate.api.nvidia.com/v1" },
  huggingface: { protocol: "openai-chat", baseUrl: "https://router.huggingface.co/v1" },
  "kimi-coding": { protocol: "openai-chat", baseUrl: "https://api.kimi.com/coding/v1" },
};

function resolveActivePricing(cost: ModelCostSpec, inputTokens: number): ModelPricing {
  if (cost.tiers && cost.tiers.length > 0) {
    let active: ModelPricing = cost;
    for (const tier of cost.tiers) {
      if (inputTokens > tier.inputTokensAbove) {
        active = tier;
      }
    }
    return active;
  }
  return cost;
}

export function getModelContextWindow(rawModel: string): number {
  const resolved = VIRTUAL_MODEL_ALIASES[rawModel] ?? rawModel;
  const catalogEntry = lookupCatalogModel(resolved);
  if (catalogEntry) return catalogEntry.contextWindow;
  const m = resolved.toLowerCase();
  if (m === AZURE_SOL) return 1_050_000;
  if (
    m.includes("muse-ember") ||
    m.includes("gemini-2.5") ||
    m.includes("gemini-3") ||
    m.includes("gemini-4") ||
    m.includes("gpt-4.1")
  ) {
    return 1_048_576;
  }
  if (m.includes("claude-") || m.includes("o1") || m.includes("o3") || m.includes("o4") || m.includes("gpt-5") || m.includes("gpt-6")) {
    return 200_000;
  }
  return 128_000;
}

export function calculateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  vmMs = 0,
  cacheReadTokens = 0,
): number {
  const vmCost = (vmMs / 1000) * 0.00005; // $0.05 per 1,000 VM seconds
  const resolved = VIRTUAL_MODEL_ALIASES[model] ?? model;
  if (resolved.startsWith("mock/") || resolved === "mock") {
    return Number(vmCost.toFixed(8));
  }
  const catalogEntry = lookupCatalogModel(resolved);
  const pricing: ModelPricing = resolved === AZURE_SOL && inputTokens > 272_000
    ? { input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }
    : catalogEntry
      ? resolveActivePricing(catalogEntry.cost, inputTokens)
      : { input: 0.5, output: 2.0 };
  const clampedCacheRead = Math.max(0, Math.min(inputTokens, cacheReadTokens));
  const uncachedInput = Math.max(0, inputTokens - clampedCacheRead);
  const cacheReadRate = pricing.cacheRead ?? pricing.input * 0.1;
  const tokenCost = (
    uncachedInput * pricing.input +
    clampedCacheRead * cacheReadRate +
    outputTokens * pricing.output
  ) / 1_000_000;
  return Number((tokenCost + vmCost).toFixed(8));
}

export function addModelUsage(
  usage: RunUsage,
  model: string,
  input: number,
  output: number,
  cacheRead = 0,
) {
  const clampedCacheRead = Math.max(0, Math.min(input, cacheRead));
  usage.inputTokens += input;
  usage.outputTokens += output;
  if (clampedCacheRead > 0) {
    usage.cacheReadTokens = (usage.cacheReadTokens ?? 0) + clampedCacheRead;
  }
  usage.costUsd = Number(
    (usage.costUsd + calculateCostUsd(model, input, output, 0, clampedCacheRead)).toFixed(8),
  );
}

export function addVmUsage(usage: RunUsage, model: string, vmMs: number) {
  usage.vmMs += vmMs;
  usage.costUsd = Number((usage.costUsd + calculateCostUsd(model, 0, 0, vmMs)).toFixed(8));
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
  // An Azure deployment uses its own endpoint and key.
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

function decodeCodexAccountId(accessToken: string): string | null {
  try {
    const [, payload] = accessToken.split(".");
    if (!payload) return null;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as Record<string, unknown>;
    const auth = claims["https://api.openai.com/auth"];
    const accountId = auth && typeof auth === "object" ? (auth as Record<string, unknown>).chatgpt_account_id : undefined;
    return typeof accountId === "string" && accountId ? accountId : null;
  } catch {
    return null;
  }
}

export async function resolveModelEndpoint(
  env: Env,
  tenantId: string,
  rawModel: string,
  prefetchedProvider?: { credentials: ProviderCredentials | null },
  keyScope?: string | null,
): Promise<ResolvedEndpoint> {
  const normScope = keyScope?.trim() || null;
  const { isMock, modelId: canonicalModelId, explicitProvider, candidates: lookupOrder } =
    getProviderLookupCandidates(env, rawModel, normScope);

  if (isMock) {
    return {
      protocol: "mock",
      providerName: "mock",
      modelId: canonicalModelId,
      apiKey: "mock",
      baseUrl: "mock://local",
    };
  }

  let stored: ProviderCredentials | null = null;
  if (prefetchedProvider !== undefined) {
    stored = prefetchedProvider.credentials;
  } else if (lookupOrder.length > 0) {
    const tenantStub = getTenantStub(env, tenantId);
    for (const candidate of lookupOrder) {
      stored = await tenantStub.getProviderSecret(candidate, normScope);
      if (stored) break;
    }
  }

  if (explicitProvider === "azure" && PLATFORM_AZURE_MODELS.has(canonicalModelId) && !stored) {
    const { AZURE_OPENAI_SOL_ENDPOINT: endpoint, AZURE_OPENAI_SOL_API_KEY: apiKey } = env;
    if (!endpoint || !apiKey) {
      throw new ApiError(503, "missing_provider_key", `The platform Azure deployment for ${canonicalModelId} is not configured`);
    }
    return {
      protocol: "openai-responses",
      providerName: "azure",
      modelId: canonicalModelId,
      apiKey,
      baseUrl: new URL("/openai/v1", endpoint).toString(),
    };
  }

  const providerName = stored?.provider ?? lookupOrder[0] ?? "openai";
  const aliases = stored?.modelAliases;
  const modelId = aliases && Object.hasOwn(aliases, canonicalModelId) ? aliases[canonicalModelId] : canonicalModelId;
  const headers = stored?.headers;
  const hasHeaders = hasCustomAuthHeaders(headers);

  if (stored?.apiStyle) {
    const apiKey = stored.apiKey || "";
    if (!apiKey && !hasHeaders) {
      throw new ApiError(400, "missing_provider_key", `No API key or auth headers configured for provider '${providerName}'`);
    }
    const providerDefault = PROVIDER_DEFAULTS[providerName];
    const defaultBase =
      providerDefault?.baseUrl ??
      (stored.apiStyle === "anthropic" ? "https://api.anthropic.com"
        : stored.apiStyle === "gemini" ? "https://generativelanguage.googleapis.com"
        : stored.apiStyle === "openai-codex" ? "https://chatgpt.com/backend-api"
        : "https://api.openai.com/v1");
    return {
      protocol: stored.apiStyle,
      providerName,
      modelId,
      apiKey,
      baseUrl: (stored.baseUrl || defaultBase).replace(/\/+$/, ""),
      ...(hasHeaders ? { headers } : {}),
    };
  }

  if (providerName === "openai-codex") {
    const apiKey = stored?.apiKey || "";
    if (!apiKey && !hasHeaders) {
      throw new ApiError(400, "missing_provider_key", "No credentials configured for provider 'openai-codex'");
    }
    return {
      protocol: "openai-codex",
      providerName: "openai-codex",
      modelId,
      apiKey,
      baseUrl: (stored?.baseUrl || "https://chatgpt.com/backend-api").replace(/\/+$/, ""),
      ...(hasHeaders ? { headers } : {}),
    };
  }

  if (providerName === "anthropic" || (!explicitProvider && canonicalModelId.startsWith("claude-"))) {
    const apiKey = stored?.apiKey || (normScope ? "" : env.ANTHROPIC_API_KEY || "");
    if (!apiKey && !hasHeaders) {
      throw new ApiError(400, "missing_provider_key", `No API key configured for provider 'anthropic'`);
    }
    return {
      protocol: "anthropic",
      providerName: "anthropic",
      modelId,
      apiKey,
      baseUrl: (stored?.baseUrl || "https://api.anthropic.com").replace(/\/+$/, ""),
      ...(hasHeaders ? { headers } : {}),
    };
  }

  if (
    providerName === "gemini" ||
    providerName === "google" ||
    (!explicitProvider && (canonicalModelId.startsWith("gemini-") || canonicalModelId.startsWith("gemma-")))
  ) {
    const apiKey = stored?.apiKey || (normScope ? "" : env.GEMINI_API_KEY || "");
    if (!apiKey && !hasHeaders) {
      throw new ApiError(400, "missing_provider_key", `No API key configured for provider 'gemini'`);
    }
    return {
      protocol: "gemini",
      providerName: "gemini",
      modelId,
      apiKey,
      baseUrl: (stored?.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/+$/, ""),
      ...(hasHeaders ? { headers } : {}),
    };
  }

  if (
    providerName === "openai" ||
    providerName === "openai-responses" ||
    providerName.startsWith("bedrock-openai-")
  ) {
    const isBedrockOpenAi = providerName.startsWith("bedrock-openai-");
    const apiKey = stored?.apiKey || (normScope || isBedrockOpenAi ? "" : env.OPENAI_API_KEY || "");
    if (!apiKey && !hasHeaders) {
      throw new ApiError(
        400,
        "missing_provider_key",
        `No API key configured for provider '${providerName}'`,
      );
    }
    return {
      protocol: "openai-responses",
      providerName,
      modelId,
      apiKey,
      baseUrl: (stored?.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, ""),
      ...(hasHeaders ? { headers } : {}),
    };
  }

  if (providerName === "openrouter") {
    const apiKey = stored?.apiKey || (normScope ? "" : env.OPENROUTER_API_KEY || "");
    if (!apiKey && !hasHeaders) {
      throw new ApiError(400, "missing_provider_key", `No API key configured for provider 'openrouter'`);
    }
    return {
      protocol: "openai-chat",
      providerName: "openrouter",
      modelId,
      apiKey,
      baseUrl: (stored?.baseUrl || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
      ...(hasHeaders ? { headers } : {}),
    };
  }

  const providerDefault = PROVIDER_DEFAULTS[providerName];
  if (providerDefault) {
    const apiKey = stored?.apiKey || "";
    if (!apiKey && !hasHeaders) {
      throw new ApiError(
        400,
        "missing_provider_key",
        `No API key configured for provider '${providerName}'`,
      );
    }
    return {
      protocol: providerDefault.protocol,
      providerName,
      modelId,
      apiKey,
      baseUrl: (stored?.baseUrl || providerDefault.baseUrl).replace(/\/+$/, ""),
      ...(hasHeaders ? { headers } : {}),
    };
  }

  const apiKey = stored?.apiKey || "";
  if (!apiKey && !hasHeaders) {
    throw new ApiError(
      400,
      "missing_provider_key",
      `No API key configured for provider '${providerName}'`,
    );
  }
  if (!stored?.baseUrl) {
    throw new ApiError(400, "missing_provider_url", `Provider '${providerName}' requires a base URL`);
  }
  return {
    protocol: "openai-chat",
    providerName,
    modelId,
    apiKey,
    baseUrl: stored.baseUrl.replace(/\/+$/, ""),
    ...(hasHeaders ? { headers } : {}),
  };
}

export async function* streamModelResponse(
  req: StreamModelRequest,
): AsyncGenerator<ModelStreamChunk, void, unknown> {
  const endpoint = await resolveModelEndpoint(
    req.env,
    req.tenantId,
    req.model,
    req.prefetchedProvider,
    req.keyScope,
  );

  if (endpoint.protocol !== "mock" && req.messages.some((message) => message.files?.length || message.legacyInlineContent || message.toolImages?.length)) {
    const images = await loadConversationImages(new CamelFsClient(req.env, req.tenantId), req.messages,
      endpoint.protocol === "anthropic" && req.messages.some(message => message.legacyInlineContent)
        ? FILE_LIMITS.requestAnthropicImages : FILE_LIMITS.requestImages,
      { tenantId: req.tenantId, bucket: req.env.MEDIA_BUCKET });
    req = {
      ...req,
      messages: req.messages.map((message, index) => ({ ...message, images: images.get(index),
        ...(message.legacyInlineContent ? { legacyInlineContent: message.legacyInlineContent.map((block, blockIndex) =>
          block.type === "image" && !images.get(index)?.some(image => image.inlineBlockIndex === blockIndex)
            ? { type: "text" as const, text: "[image omitted from earlier in the conversation]" } : block) } : {}),
      })),
    };
  }

  switch (endpoint.protocol) {
    case "mock":
      yield* streamMockModel(endpoint.modelId, req);
      return;
    case "openai-chat":
      yield* streamOpenAiChat(endpoint, req);
      return;
    case "openai-responses":
    case "openai-codex":
      yield* streamOpenAiResponses(endpoint, req);
      return;
    case "anthropic":
      yield* streamAnthropicMessages(endpoint, req);
      return;
    case "gemini":
      yield* streamGeminiContent(endpoint, req);
      return;
  }
}

interface SseFrame {
  event: string;
  data: string;
}

async function* parseSseFrames(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame, void, unknown> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];

  try {
    while (true) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

        if (line === "") {
          if (dataLines.length > 0) {
            yield { event: eventName, data: dataLines.join("\n") };
            dataLines = [];
          }
          eventName = "message";
          continue;
        }
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const rest = line.slice(5);
          dataLines.push(rest.startsWith(" ") ? rest.slice(1) : rest);
        }
      }
    }

    if (buffer.trim().length > 0) {
      for (const rawLine of buffer.split(/\r?\n/)) {
        if (rawLine.startsWith("data:")) {
          const rest = rawLine.slice(5);
          dataLines.push(rest.startsWith(" ") ? rest.slice(1) : rest);
        }
      }
    }
    if (dataLines.length > 0) {
      yield { event: eventName, data: dataLines.join("\n") };
    }
  } finally {
    reader.releaseLock();
  }
}

function safeParseArgs(jsonStr: string): Record<string, unknown> {
  if (!jsonStr || !jsonStr.trim()) return {};
  try {
    const parsed = JSON.parse(jsonStr);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { _raw: jsonStr };
  }
}

function buildChatCompletionsUrl(baseUrl: string): string {
  if (baseUrl.endsWith("/chat/completions")) return baseUrl;
  if (/\/v\d+$/.test(baseUrl)) return `${baseUrl}/chat/completions`;
  return `${baseUrl}/v1/chat/completions`;
}

function buildResponsesUrl(baseUrl: string, codex = false): string {
  if (baseUrl.endsWith("/responses")) return baseUrl;
  if (codex) {
    if (baseUrl.endsWith("/codex")) return `${baseUrl}/responses`;
    return `${baseUrl}/codex/responses`;
  }
  if (/\/v\d+$/.test(baseUrl)) return `${baseUrl}/responses`;
  return `${baseUrl}/v1/responses`;
}

function imageDataUrl(image: ModelImage): string {
  return `data:${image.contentType};base64,${image.base64}`;
}

/** Preserve original text/image ordering for validated imported user messages. */
export function modelContentParts(
  message: ConversationMessage,
  text: (value: string) => Record<string, unknown>,
  image: (value: ModelImage) => Record<string, unknown>,
): Array<Record<string, unknown>> | undefined {
  if (message.legacyInlineContent) return message.legacyInlineContent.map(block => block.type === "text"
    ? text(block.text) : image({ contentType: block.mimeType, base64: block.data }));
  if (message.images?.length) return [text(message.text ?? ""), ...message.images.map(image)];
  return undefined;
}

type ChatUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number;
};

function cachedChatTokens(usage?: ChatUsage): number {
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0;
  return Number.isSafeInteger(cached) && cached > 0 && cached <= (usage?.prompt_tokens ?? 0) ? cached : 0;
}

const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;
function clampOpenAiPromptCacheKey(key?: string): string | undefined {
  const trimmed = key?.trim();
  if (!trimmed) return undefined;
  const chars = Array.from(trimmed);
  return chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH
    ? trimmed
    : chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

async function* streamOpenAiChat(
  endpoint: ResolvedEndpoint,
  req: StreamModelRequest,
): AsyncGenerator<ModelStreamChunk, void, unknown> {
  const apiMessages: Array<Record<string, unknown>> = [];
  if (req.instructions) {
    apiMessages.push({ role: "system", content: req.instructions });
  }
  const toolImages: Array<Record<string, unknown>> = [];
  const flushToolImages = () => {
    if (toolImages.length) apiMessages.push({ role: "user", content: toolImages.splice(0) });
  };
  for (const m of req.messages) {
    if (m.role !== "tool") flushToolImages();
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      apiMessages.push({
        role: "assistant",
        content: m.text || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: tc.argumentsJson || JSON.stringify(tc.args ?? {}),
          },
        })),
      });
    } else if (m.role === "tool") {
      apiMessages.push({
        role: "tool",
        tool_call_id: m.toolCallId ?? "call_0",
        content: m.text ?? "",
      });
      if (m.images?.length) {
        toolImages.push({ type: "text", text: `Images returned by tool call ${m.toolCallId}:` },
          ...m.images.map(image => ({ type: "image_url", image_url: { url: imageDataUrl(image) } })));
      }
    } else {
      apiMessages.push({
        role: m.role,
        content: modelContentParts(m, text => ({ type: "text", text }),
          image => ({ type: "image_url", image_url: { url: imageDataUrl(image) } })) ?? m.text ?? "",
      });
    }
  }

  flushToolImages();
  const payload: Record<string, unknown> = {
    model: endpoint.modelId,
    messages: apiMessages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (endpoint.providerName === "openrouter") payload.provider = { data_collection: "deny" };
  const isOpenAiReasoningChatModel =
    (endpoint.providerName === "openai" || /^https?:\/\/api\.openai\.com(\/|$)/i.test(endpoint.baseUrl)) &&
    /^(o1|o3|o4|gpt-5|gpt-6)/i.test(endpoint.modelId);
  if (req.temperature !== undefined && !isOpenAiReasoningChatModel) {
    payload.temperature = req.temperature;
  }
  if (req.maxOutputTokens !== undefined) {
    if (isOpenAiReasoningChatModel) {
      payload.max_completion_tokens = req.maxOutputTokens;
    } else {
      payload.max_tokens = req.maxOutputTokens;
    }
  }

  if (req.tools && req.tools.length > 0) {
    payload.tools = req.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  if (req.outputSchema) {
    payload.response_format = {
      type: "json_schema",
      json_schema: {
        name: "structured_output",
        schema: req.outputSchema,
        strict: false,
      },
    };
  }

  const res = await fetch(buildChatCompletionsUrl(endpoint.baseUrl), {
    method: "POST",
    headers: {
      ...(endpoint.headers ?? {}),
      ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
    },
    body: JSON.stringify(payload),
    signal: req.signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new ApiError(res.status, "provider_error", `Provider HTTP ${res.status}: ${errText}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json") || !res.body) {
    const json = (await res.json()) as {
      choices?: Array<{
        finish_reason?: string;
        message?: {
          content?: string | null;
          tool_calls?: Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
      usage?: ChatUsage;
    };
    const choice = json.choices?.[0];
    const content = choice?.message?.content ?? "";
    if (content) {
      yield { type: "text_delta", delta: content };
    }
    for (const tc of choice?.message?.tool_calls ?? []) {
      const id = tc.id || randomId("call", 6);
      const name = tc.function?.name || "unknown";
      const argsJson = tc.function?.arguments ?? "{}";
      yield {
        type: "tool_call",
        id,
        name,
        argumentsJson: argsJson,
        args: safeParseArgs(argsJson),
      };
    }
    yield {
      type: "done",
      inputTokens: json.usage?.prompt_tokens ?? estimateInputFromMessages(req),
      outputTokens: json.usage?.completion_tokens ?? estimateTokens(content),
      cacheReadTokens: cachedChatTokens(json.usage),
      stopReason: choice?.finish_reason ?? "stop",
    };
    return;
  }

  const toolBuffers = new Map<number, { id: string; name: string; args: string }>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let emittedTextLen = 0;
  let stopReason = "stop";

  for await (const frame of parseSseFrames(res.body, req.signal)) {
    if (frame.data === "[DONE]") break;
    let chunk: {
      choices?: Array<{
        finish_reason?: string | null;
        delta?: {
          content?: string | null;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
      usage?: ChatUsage;
    };
    try {
      chunk = JSON.parse(frame.data);
    } catch {
      continue;
    }

    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
      outputTokens = chunk.usage.completion_tokens ?? outputTokens;
      cacheReadTokens = cachedChatTokens(chunk.usage);
    }

    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) {
      stopReason = choice.finish_reason;
    }
    const delta = choice.delta;
    if (delta?.content) {
      emittedTextLen += delta.content.length;
      yield { type: "text_delta", delta: delta.content };
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let entry = toolBuffers.get(idx);
        if (!entry) {
          entry = { id: tc.id || randomId("call", 6), name: "", args: "" };
          toolBuffers.set(idx, entry);
        }
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
      }
    }
  }

  for (const [, tc] of [...toolBuffers.entries()].sort((a, b) => a[0] - b[0])) {
    if (tc.name) {
      yield {
        type: "tool_call",
        id: tc.id,
        name: tc.name,
        argumentsJson: tc.args || "{}",
        args: safeParseArgs(tc.args || "{}"),
      };
    }
  }

  yield {
    type: "done",
    inputTokens: inputTokens || estimateInputFromMessages(req),
    outputTokens: outputTokens || Math.max(1, Math.ceil(emittedTextLen / 4)),
    cacheReadTokens,
    stopReason,
  };
}

type ResponsesUsage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
};

function cachedResponsesTokens(usage?: ResponsesUsage): number {
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
  return Number.isSafeInteger(cached) && cached > 0 && cached <= (usage?.input_tokens ?? 0) ? cached : 0;
}

const RESPONSES_CALL_ID_MAX_LENGTH = 64;

/**
 * OpenAI and Azure Responses APIs enforce a 64-character max length on `call_id`.
 * Histories migrated from other providers (e.g. OpenRouter) can contain longer IDs;
 * shorten them deterministically so `function_call` and `function_call_output`
 * always map to the same valid `call_id`.
 */
export function normalizeResponsesCallId(id?: string): string {
  if (!id) return "call_0";
  if (id.length <= RESPONSES_CALL_ID_MAX_LENGTH) return id;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < id.length; i++) {
    const code = id.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ (code + i), 0x85ebca6b);
  }
  h2 ^= h2 >>> 13;
  h2 = Math.imul(h2, 0xc2b2ae35);
  h2 ^= h2 >>> 16;
  const hash = (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
  let prefixEnd = RESPONSES_CALL_ID_MAX_LENGTH - 1 - hash.length;
  if (prefixEnd > 0 && id.charCodeAt(prefixEnd - 1) >= 0xd800 && id.charCodeAt(prefixEnd - 1) <= 0xdbff) {
    prefixEnd -= 1;
  }
  return `${id.slice(0, prefixEnd)}_${hash}`;
}

async function* streamOpenAiResponses(
  endpoint: ResolvedEndpoint,
  req: StreamModelRequest,
): AsyncGenerator<ModelStreamChunk, void, unknown> {
  const inputItems: Array<Record<string, unknown>> = [];
  // Keep the agent prompt in the input prefix so GPT-6.2 can cache it.
  if (req.instructions) inputItems.push({ role: "developer", content: req.instructions });
  for (const m of req.messages) {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      if (m.text) {
        inputItems.push({ role: "assistant", content: m.text });
      }
      for (const tc of m.toolCalls) {
        inputItems.push({
          type: "function_call",
          call_id: normalizeResponsesCallId(tc.id),
          name: tc.name,
          arguments: tc.argumentsJson || JSON.stringify(tc.args ?? {}),
        });
      }
    } else if (m.role === "tool") {
      inputItems.push({
        type: "function_call_output",
        call_id: normalizeResponsesCallId(m.toolCallId),
        output: m.images?.length ? [
          { type: "input_text", text: m.text ?? "" },
          ...m.images.map(image => ({ type: "input_image", image_url: imageDataUrl(image), detail: "auto" })),
        ] : m.text ?? "",
      });
    } else {
      inputItems.push({
        role: m.role,
        content: modelContentParts(m, text => ({ type: "input_text", text }),
          image => ({ type: "input_image", image_url: imageDataUrl(image), detail: "auto" })) ?? m.text ?? "",
      });
    }
  }

  const payload: Record<string, unknown> = {
    model: endpoint.modelId,
    input: inputItems,
    stream: true,
  };
  const azure = endpoint.providerName === "azure";
  const codex = endpoint.protocol === "openai-codex";
  const isDirectResponsesProvider =
    azure ||
    codex ||
    endpoint.providerName === "openai" ||
    endpoint.providerName === "openai-responses" ||
    endpoint.providerName === "xai";
  const catalogEntry = lookupCatalogModel(`${endpoint.providerName}/${endpoint.modelId}`);
  const isReasoningModel = catalogEntry
    ? catalogEntry.reasoning
    : /^(o1|o3|o4|gpt-5(?!-chat)|gpt-6|chat-latest|grok-4)/i.test(endpoint.modelId);

  const promptCacheKey = clampOpenAiPromptCacheKey(req.promptCacheKey);
  if (promptCacheKey && !endpoint.providerName.startsWith("bedrock-openai-")) {
    payload.prompt_cache_key = promptCacheKey;
  }
  if (isDirectResponsesProvider) {
    payload.store = false;
  }
  if (azure) {
    payload.reasoning = { effort: "low" };
  }
  if (codex) {
    if (!payload.instructions) payload.instructions = "You are a helpful coding assistant.";
  }
  if (req.temperature !== undefined && !codex && !isReasoningModel) {
    payload.temperature = req.temperature;
  }
  if (req.maxOutputTokens && !codex) {
    payload.max_output_tokens = Math.max(16, req.maxOutputTokens);
  }
  if (req.tools && req.tools.length > 0) {
    payload.tools = req.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false,
    }));
  }
  if (req.outputSchema) {
    payload.text = {
      format: {
        type: "json_schema",
        name: "structured_output",
        schema: req.outputSchema,
        strict: false,
      },
    };
  }

  const codexAccount = codex && endpoint.apiKey ? decodeCodexAccountId(endpoint.apiKey) : null;
  const responseHeaders: Record<string, string> = {
    ...(codex ? {
      "openai-beta": "responses=experimental",
      originator: "codex_cli_rs",
      ...(codexAccount ? { "chatgpt-account-id": codexAccount } : {}),
    } : {}),
    ...(endpoint.headers ?? {}),
    ...(endpoint.apiKey ? (azure ? { "api-key": endpoint.apiKey } : { Authorization: `Bearer ${endpoint.apiKey}` }) : {}),
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
  };

  const res = await fetch(buildResponsesUrl(endpoint.baseUrl, codex), {
    method: "POST",
    headers: responseHeaders,
    body: JSON.stringify(payload),
    signal: req.signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new ApiError(res.status, "provider_error", `OpenAI Responses HTTP ${res.status}: ${errText}`);
  }

  if (!res.body || (res.headers.get("content-type") ?? "").includes("application/json")) {
    const json = (await res.json()) as {
      output?: Array<{
        type?: string;
        call_id?: string;
        name?: string;
        arguments?: string;
        content?: Array<{ type?: string; text?: string }>;
      }>;
      usage?: ResponsesUsage;
    };
    let outLen = 0;
    for (const item of json.output ?? []) {
      if (item.type === "message") {
        for (const c of item.content ?? []) {
          if (c.text) {
            outLen += c.text.length;
            yield { type: "text_delta", delta: c.text };
          }
        }
      } else if (item.type === "function_call" && item.name) {
        const argsJson = item.arguments ?? "{}";
        yield {
          type: "tool_call",
          id: item.call_id || randomId("call", 6),
          name: item.name,
          argumentsJson: argsJson,
          args: safeParseArgs(argsJson),
        };
      }
    }
    yield {
      type: "done",
      inputTokens: json.usage?.input_tokens ?? estimateInputFromMessages(req),
      outputTokens: json.usage?.output_tokens ?? Math.max(1, Math.ceil(outLen / 4)),
      cacheReadTokens: cachedResponsesTokens(json.usage),
      stopReason: "stop",
    };
    return;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let outChars = 0;
  let cacheReadTokens = 0;

  for await (const frame of parseSseFrames(res.body, req.signal)) {
    if (frame.data === "[DONE]") break;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(frame.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(ev.type ?? frame.event);
    if (type === "response.output_text.delta" && typeof ev.delta === "string") {
      outChars += ev.delta.length;
      yield { type: "text_delta", delta: ev.delta };
    } else if (type === "response.output_item.done" && ev.item && typeof ev.item === "object") {
      const item = ev.item as Record<string, unknown>;
      if (item.type === "function_call" && typeof item.name === "string") {
        const argsJson = typeof item.arguments === "string" ? item.arguments : "{}";
        yield {
          type: "tool_call",
          id: typeof item.call_id === "string" ? item.call_id : randomId("call", 6),
          name: item.name,
          argumentsJson: argsJson,
          args: safeParseArgs(argsJson),
        };
      }
    } else if (type === "error" || type === "response.failed") {
      const errObj = (
        (ev.error && typeof ev.error === "object" ? ev.error : undefined) ??
        (ev.response && typeof ev.response === "object" && "error" in ev.response && ev.response.error && typeof ev.response.error === "object"
          ? ev.response.error
          : undefined)
      ) as { code?: unknown; message?: unknown } | undefined;
      const codeStr = typeof errObj?.code === "string" ? errObj.code : "";
      const msgStr = typeof errObj?.message === "string" ? errObj.message.slice(0, 300) : "";
      const detail = [codeStr, msgStr].filter(Boolean).join(": ");
      throw new ApiError(
        502,
        codeStr === "context_length_exceeded" ? "context_length_exceeded" : "provider_error",
        detail ? `The Responses API failed after accepting the request (${detail})` : "The Responses API failed after accepting the request",
      );
    } else if (type === "response.completed" && ev.response && typeof ev.response === "object") {
      const usage = (ev.response as { usage?: ResponsesUsage }).usage;
      if (usage) {
        inputTokens = usage.input_tokens ?? inputTokens;
        outputTokens = usage.output_tokens ?? outputTokens;
        cacheReadTokens = cachedResponsesTokens(usage);
      }
    }
  }

  yield {
    type: "done",
    inputTokens: inputTokens || estimateInputFromMessages(req),
    outputTokens: outputTokens || Math.max(1, Math.ceil(outChars / 4)),
    cacheReadTokens,
    stopReason: "stop",
  };
}

async function* streamAnthropicMessages(
  endpoint: ResolvedEndpoint,
  req: StreamModelRequest,
): AsyncGenerator<ModelStreamChunk, void, unknown> {
  const systemParts: string[] = [];
  if (req.instructions) systemParts.push(req.instructions);
  if (req.outputSchema) {
    systemParts.push(
      `Respond ONLY with valid JSON conforming to this JSON Schema:\n${JSON.stringify(req.outputSchema)}`,
    );
  }

  const messages: Array<Record<string, unknown>> = [];
  for (const m of req.messages) {
    if (m.role === "system") {
      if (m.text) systemParts.push(m.text);
      continue;
    }
    if (m.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      if (m.text) blocks.push({ type: "text", text: m.text });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.args ?? safeParseArgs(tc.argumentsJson),
        });
      }
      if (blocks.length > 0) {
        messages.push({ role: "assistant", content: blocks });
      }
    } else if (m.role === "tool") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId ?? "call_0",
            content: modelContentParts(m, text => ({ type: "text", text }), image => ({
              type: "image", source: { type: "base64", media_type: image.contentType, data: image.base64 },
            })) ?? m.text ?? "",
            is_error: Boolean(m.isError),
          },
        ],
      });
    } else {
      messages.push({
        role: "user",
        content: modelContentParts(m, text => ({ type: "text", text }), image => ({
          type: "image", source: { type: "base64", media_type: image.contentType, data: image.base64 },
        })) ?? m.text ?? "",
      });
    }
  }

  const payload: Record<string, unknown> = {
    model: endpoint.modelId,
    max_tokens: req.maxOutputTokens ?? 4096,
    messages,
    stream: true,
  };
  if (systemParts.length > 0) {
    payload.system = systemParts.join("\n\n");
  }
  if (req.temperature !== undefined) {
    payload.temperature = req.temperature;
  }
  if (req.tools && req.tools.length > 0) {
    payload.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  const url = endpoint.baseUrl.endsWith("/v1/messages")
    ? endpoint.baseUrl
    : `${endpoint.baseUrl}/v1/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...(endpoint.headers ?? {}),
      ...(endpoint.apiKey ? { "x-api-key": endpoint.apiKey } : {}),
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
    },
    body: JSON.stringify(payload),
    signal: req.signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new ApiError(res.status, "provider_error", `Anthropic HTTP ${res.status}: ${errText}`);
  }

  type AnthropicUsage = {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };

  if (!res.body || (res.headers.get("content-type") ?? "").includes("application/json")) {
    const json = (await res.json()) as {
      stop_reason?: string;
      content?: Array<{
        type?: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>;
      usage?: AnthropicUsage;
    };
    for (const block of json.content ?? []) {
      if (block.type === "text" && block.text) {
        yield { type: "text_delta", delta: block.text };
      } else if (block.type === "tool_use" && block.name) {
        const args = block.input ?? {};
        yield {
          type: "tool_call",
          id: block.id || randomId("toolu", 6),
          name: block.name,
          argumentsJson: JSON.stringify(args),
          args,
        };
      }
    }
    const rawInput = json.usage?.input_tokens ?? 0;
    const cacheRead = Math.max(0, json.usage?.cache_read_input_tokens ?? 0);
    const cacheWrite = Math.max(0, json.usage?.cache_creation_input_tokens ?? 0);
    const totalInput = rawInput + cacheRead + cacheWrite;
    yield {
      type: "done",
      inputTokens: totalInput || estimateInputFromMessages(req),
      outputTokens: json.usage?.output_tokens ?? 16,
      cacheReadTokens: cacheRead,
      stopReason: json.stop_reason ?? "end_turn",
    };
    return;
  }

  const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
  let rawInputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let stopReason = "end_turn";

  for await (const frame of parseSseFrames(res.body, req.signal)) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(frame.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(ev.type ?? frame.event);
    if (type === "message_start" && ev.message && typeof ev.message === "object") {
      const usage = (ev.message as { usage?: AnthropicUsage }).usage;
      if (usage) {
        rawInputTokens = usage.input_tokens ?? rawInputTokens;
        cacheReadTokens = Math.max(0, usage.cache_read_input_tokens ?? cacheReadTokens);
        cacheWriteTokens = Math.max(0, usage.cache_creation_input_tokens ?? cacheWriteTokens);
        outputTokens = usage.output_tokens ?? outputTokens;
      }
    } else if (type === "content_block_start" && ev.content_block && typeof ev.content_block === "object") {
      const idx = typeof ev.index === "number" ? ev.index : 0;
      const cb = ev.content_block as Record<string, unknown>;
      if (cb.type === "tool_use" && typeof cb.name === "string") {
        toolBlocks.set(idx, {
          id: typeof cb.id === "string" ? cb.id : randomId("toolu", 6),
          name: cb.name,
          json: "",
        });
      }
    } else if (type === "content_block_delta" && ev.delta && typeof ev.delta === "object") {
      const idx = typeof ev.index === "number" ? ev.index : 0;
      const d = ev.delta as Record<string, unknown>;
      if (d.type === "text_delta" && typeof d.text === "string") {
        yield { type: "text_delta", delta: d.text };
      } else if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
        const tb = toolBlocks.get(idx);
        if (tb) tb.json += d.partial_json;
      }
    } else if (type === "message_delta") {
      const d = ev.delta as { stop_reason?: string } | undefined;
      if (d?.stop_reason) stopReason = d.stop_reason;
      const u = ev.usage as AnthropicUsage | undefined;
      if (u?.input_tokens !== undefined) rawInputTokens = u.input_tokens;
      if (u?.cache_read_input_tokens !== undefined) cacheReadTokens = Math.max(0, u.cache_read_input_tokens);
      if (u?.cache_creation_input_tokens !== undefined) cacheWriteTokens = Math.max(0, u.cache_creation_input_tokens);
      if (u?.output_tokens !== undefined) outputTokens = u.output_tokens;
    }
  }

  for (const [, tb] of [...toolBlocks.entries()].sort((a, b) => a[0] - b[0])) {
    const argsJson = tb.json || "{}";
    yield {
      type: "tool_call",
      id: tb.id,
      name: tb.name,
      argumentsJson: argsJson,
      args: safeParseArgs(argsJson),
    };
  }

  const totalInputTokens = rawInputTokens + cacheReadTokens + cacheWriteTokens;
  yield {
    type: "done",
    inputTokens: totalInputTokens || estimateInputFromMessages(req),
    outputTokens: outputTokens || 1,
    cacheReadTokens,
    stopReason,
  };
}

async function* streamGeminiContent(
  endpoint: ResolvedEndpoint,
  req: StreamModelRequest,
): AsyncGenerator<ModelStreamChunk, void, unknown> {
  const contents: Array<Record<string, unknown>> = [];
  for (const m of req.messages) {
    if (m.role === "system") continue;
    if (m.role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      if (m.text) parts.push({ text: m.text });
      for (const tc of m.toolCalls ?? []) {
        parts.push({
          functionCall: {
            name: tc.name,
            args: tc.args ?? safeParseArgs(tc.argumentsJson),
          },
        });
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
    } else if (m.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: m.toolName ?? "tool",
              response: { result: m.text ?? "" },
            },
          },
          ...(m.images ?? []).map(image => ({ inlineData: { mimeType: image.contentType, data: image.base64 } })),
        ],
      });
    } else {
      contents.push({
        role: "user",
        parts: modelContentParts(m, text => ({ text }),
          image => ({ inlineData: { mimeType: image.contentType, data: image.base64 } })) ?? [{ text: m.text ?? "" }],
      });
    }
  }

  const payload: Record<string, unknown> = { contents };
  if (req.instructions) {
    payload.systemInstruction = { parts: [{ text: req.instructions }] };
  }
  if (req.tools && req.tools.length > 0) {
    payload.tools = [
      {
        functionDeclarations: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }
  if (req.outputSchema) {
    payload.generationConfig = {
      responseMimeType: "application/json",
      responseSchema: req.outputSchema,
    };
  }

  const url = `${endpoint.baseUrl}/v1beta/models/${encodeURIComponent(
    endpoint.modelId,
  )}:streamGenerateContent?alt=sse${endpoint.apiKey ? `&key=${encodeURIComponent(endpoint.apiKey)}` : ""}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...(endpoint.headers ?? {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: req.signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new ApiError(res.status, "provider_error", `Gemini HTTP ${res.status}: ${errText}`);
  }

  type GeminiUsageMetadata = {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  const cachedGeminiTokens = (usageMeta?: GeminiUsageMetadata): number => {
    const cached = usageMeta?.cachedContentTokenCount ?? 0;
    return Number.isSafeInteger(cached) && cached > 0 && cached <= (usageMeta?.promptTokenCount ?? 0) ? cached : 0;
  };

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;

  if (!res.body || (res.headers.get("content-type") ?? "").includes("application/json")) {
    const json = (await res.json()) as Record<string, unknown>;
    const usageMeta = json.usageMetadata as GeminiUsageMetadata | undefined;
    yield* emitGeminiChunk(json);
    yield {
      type: "done",
      inputTokens: usageMeta?.promptTokenCount ?? estimateInputFromMessages(req),
      outputTokens: usageMeta?.candidatesTokenCount ?? 16,
      cacheReadTokens: cachedGeminiTokens(usageMeta),
      stopReason: "STOP",
    };
    return;
  }

  for await (const frame of parseSseFrames(res.body, req.signal)) {
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(frame.data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const usageMeta = chunk.usageMetadata as GeminiUsageMetadata | undefined;
    if (usageMeta) {
      inputTokens = usageMeta.promptTokenCount ?? inputTokens;
      outputTokens = usageMeta.candidatesTokenCount ?? outputTokens;
      cacheReadTokens = cachedGeminiTokens(usageMeta);
    }
    yield* emitGeminiChunk(chunk);
  }

  yield {
    type: "done",
    inputTokens: inputTokens || estimateInputFromMessages(req),
    outputTokens: outputTokens || 1,
    cacheReadTokens,
    stopReason: "STOP",
  };
}

function* emitGeminiChunk(chunk: Record<string, unknown>): Generator<ModelStreamChunk> {
  const candidates = chunk.candidates as
    | Array<{
        content?: {
          parts?: Array<{
            text?: string;
            functionCall?: { name?: string; args?: Record<string, unknown> };
          }>;
        };
      }>
    | undefined;
  const parts = candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    if (part.text) {
      yield { type: "text_delta", delta: part.text };
    }
    if (part.functionCall?.name) {
      const args = part.functionCall.args ?? {};
      yield {
        type: "tool_call",
        id: randomId("gcall", 6),
        name: part.functionCall.name,
        argumentsJson: JSON.stringify(args),
        args,
      };
    }
  }
}

function estimateInputFromMessages(req: StreamModelRequest): number {
  let total = estimateTokens(req.instructions ?? "");
  for (const m of req.messages) {
    total += estimateTokens(m.text ?? "");
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        total += estimateTokens(tc.name) + estimateTokens(tc.argumentsJson);
      }
    }
  }
  return Math.max(1, total);
}

// ---- Built-in Deterministic Test Model (`mock/*`) ----

interface ParsedCallDirective {
  parallel: boolean;
  name: string;
  args: Record<string, unknown>;
  argsJson: string;
}

function extractDirectives(text: string): ParsedCallDirective[] {
  const out: ParsedCallDirective[] = [];
  const regex = /\[(PARALLEL_CALL|CALL):([a-zA-Z0-9_.:-]+)(?:\s+(\{[\s\S]*?\}))?\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const parallel = match[1] === "PARALLEL_CALL";
    const name = match[2]!;
    const rawJson = match[3]?.trim() || "{}";
    const args = safeParseArgs(rawJson);
    out.push({
      parallel,
      name,
      args,
      argsJson: JSON.stringify(args),
    });
  }
  return out;
}

function synthesizeFromJsonSchema(
  schema: Record<string, unknown>,
  seedText: string,
): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  if ("const" in schema) {
    return schema.const;
  }
  const rawType = schema.type;
  const type = Array.isArray(rawType) ? rawType[0] : rawType;

  if (type === "object" || (!type && schema.properties)) {
    const props = (schema.properties as Record<string, Record<string, unknown>> | undefined) ?? {};
    const result: Record<string, unknown> = {};
    for (const [key, propSchema] of Object.entries(props)) {
      result[key] = synthesizeFromJsonSchema(propSchema, seedText);
    }
    return result;
  }
  if (type === "array") {
    const itemSchema = (schema.items as Record<string, unknown> | undefined) ?? { type: "string" };
    return [synthesizeFromJsonSchema(itemSchema, seedText)];
  }
  if (type === "number" || type === "integer") {
    return typeof schema.minimum === "number" ? schema.minimum : 1;
  }
  if (type === "boolean") {
    return true;
  }
  if (type === "null") {
    return null;
  }
  return seedText.slice(0, 120) || "ok";
}

async function* emitTextInDeltas(text: string): AsyncGenerator<ModelStreamChunk, void, unknown> {
  if (!text) return;
  const chunkSize = Math.max(8, Math.ceil(text.length / 3));
  for (let i = 0; i < text.length; i += chunkSize) {
    yield { type: "text_delta", delta: text.slice(i, i + chunkSize) };
  }
}

async function* streamMockModel(
  modelId: string,
  req: StreamModelRequest,
): AsyncGenerator<ModelStreamChunk, void, unknown> {
  const inputTokens = estimateInputFromMessages(req);

  if (req.purpose === "compaction") {
    const userTurns = req.messages
      .filter((m) => m.role === "user" && m.text)
      .map((m) => m.text!.trim().slice(0, 140));
    const summary = `Compacted context (${req.messages.length} messages): ${
      userTurns.join(" | ") || "prior conversation summarized."
    }`;
    yield* emitTextInDeltas(summary);
    yield {
      type: "done",
      inputTokens,
      outputTokens: estimateTokens(summary),
      stopReason: "stop",
    };
    return;
  }

  if (req.purpose === "dreaming") {
    const notes = req.messages
      .filter((m) => (m.role === "user" || m.role === "assistant") && m.text)
      .slice(-8)
      .map((m) => `- [${m.role}] ${m.text!.replace(/\s+/g, " ").trim().slice(0, 160)}`);
    const doc = [
      "# Consolidated Agent Memory",
      "",
      `Updated: ${new Date().toISOString()}`,
      "",
      "## Key Observations",
      ...(notes.length > 0 ? notes : ["- No new observations recorded."]),
      "",
    ].join("\n");
    yield* emitTextInDeltas(doc);
    yield {
      type: "done",
      inputTokens,
      outputTokens: estimateTokens(doc),
      stopReason: "stop",
    };
    return;
  }

  // Locate the latest user prompt (or steer message) and count tool rounds after the initial turn user prompt
  let turnStartIdx = -1;
  for (let i = req.messages.length - 1; i >= 0; i--) {
    if (req.messages[i]!.role === "user") {
      turnStartIdx = i;
      break;
    }
  }

  // Also inspect earlier user messages only within the current active turn (e.g. a mid-turn steer
  // injected after a tool result), never crossing a completed or aborted prior turn boundary.
  let directiveSourceIdx = turnStartIdx;
  if (
    turnStartIdx >= 0 &&
    !(req.messages[turnStartIdx]!.text && /\[(PARALLEL_CALL|CALL):/.test(req.messages[turnStartIdx]!.text!))
  ) {
    for (let i = turnStartIdx - 1; i >= 0; i--) {
      const msg = req.messages[i]!;
      if (msg.role === "assistant" && (!msg.toolCalls || msg.toolCalls.length === 0)) break;
      if (msg.role === "user") {
        if (req.messages[i + 1]?.role !== "assistant" || !req.messages[i + 1]?.toolCalls?.length) break;
        if (msg.text && /\[(PARALLEL_CALL|CALL):/.test(msg.text)) {
          directiveSourceIdx = i;
          break;
        }
      }
    }
  }

  const latestUserText = turnStartIdx >= 0 ? (req.messages[turnStartIdx]!.text ?? "") : "";
  const directiveText =
    directiveSourceIdx >= 0 ? (req.messages[directiveSourceIdx]!.text ?? "") : latestUserText;

  let assistantToolStepsAfterDirective = 0;
  const recentToolResults: string[] = [];
  if (directiveSourceIdx >= 0) {
    for (let i = directiveSourceIdx + 1; i < req.messages.length; i++) {
      const m = req.messages[i]!;
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        assistantToolStepsAfterDirective++;
      } else if (m.role === "tool" && m.text) {
        recentToolResults.push(`${m.toolName ?? "tool"}=${m.text}`);
      }
    }
  }

  const directives = extractDirectives(directiveText);
  const availableToolNames = new Set((req.tools ?? []).map((t) => t.name));

  if (directives.length > 0) {
    const parallelDirectives = directives.filter((d) => d.parallel);
    if (parallelDirectives.length > 0 && assistantToolStepsAfterDirective === 0) {
      for (const d of parallelDirectives) {
        if (availableToolNames.size === 0 || availableToolNames.has(d.name)) {
          yield {
            type: "tool_call",
            id: randomId("mcall", 6),
            name: d.name,
            argumentsJson: d.argsJson,
            args: d.args,
          };
        }
      }
      yield {
        type: "done",
        inputTokens,
        outputTokens: 12,
        stopReason: "tool_calls",
      };
      return;
    }

    const sequentialDirectives = directives.filter((d) => !d.parallel);
    if (assistantToolStepsAfterDirective < sequentialDirectives.length) {
      const nextDirective = sequentialDirectives[assistantToolStepsAfterDirective]!;
      if (availableToolNames.size === 0 || availableToolNames.has(nextDirective.name)) {
        yield {
          type: "tool_call",
          id: randomId("mcall", 6),
          name: nextDirective.name,
          argumentsJson: nextDirective.argsJson,
          args: nextDirective.args,
        };
        yield {
          type: "done",
          inputTokens,
          outputTokens: 12,
          stopReason: "tool_calls",
        };
        return;
      }
    }
  }

  // Structured JSON output handling
  if (req.outputSchema) {
    const jsonMatch = latestUserText.match(/\[JSON:(\{[\s\S]*\}|\[[\s\S]*\])\]/);
    let jsonText: string;
    if (jsonMatch?.[1]) {
      jsonText = jsonMatch[1];
    } else {
      const seed =
        recentToolResults.length > 0
          ? `${latestUserText} (${recentToolResults.join("; ")})`.trim()
          : latestUserText.replace(/\[(PARALLEL_CALL|CALL):[^\]]+\]/g, "").trim() || "ok";
      const synthesized = synthesizeFromJsonSchema(req.outputSchema, seed);
      jsonText = JSON.stringify(synthesized);
    }
    yield* emitTextInDeltas(jsonText);
    yield {
      type: "done",
      inputTokens,
      outputTokens: estimateTokens(jsonText),
      stopReason: "stop",
    };
    return;
  }

  const cleanPrompt = latestUserText.replace(/\[(PARALLEL_CALL|CALL):[^\]]+\]/g, "").trim();
  const parts: string[] = [];
  if (modelId === "mock/echo") {
    parts.push(cleanPrompt || latestUserText || "echo");
  } else {
    parts.push(`[${modelId}] ${cleanPrompt || "acknowledged"}`);
  }
  if (recentToolResults.length > 0) {
    parts.push(`Tools: ${recentToolResults.join(" | ")}`);
  }

  const reply = parts.join(" — ");
  yield* emitTextInDeltas(reply);
  yield {
    type: "done",
    inputTokens,
    outputTokens: estimateTokens(reply),
    stopReason: "stop",
  };
}
