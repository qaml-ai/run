import { CamelFsClient } from "./camelfs.ts";
import { randomId } from "./crypto.ts";
import { loadConversationImages, type ModelImage } from "./run-files.ts";
import { getTenantStub } from "./tenant-do.ts";
import {
  ApiError,
  estimateTokens,
  type ChatRole,
  type Env,
  type LlmToolSchema,
  type ModelStreamChunk,
  type ProviderCredentials,
  type StoredRunFile,
  type ToolCallInvocation,
} from "./types.ts";

export interface ConversationMessage {
  role: ChatRole;
  text?: string;
  files?: StoredRunFile[];
  images?: ModelImage[];
  toolCalls?: ToolCallInvocation[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface StreamModelRequest {
  env: Env;
  tenantId: string;
  model: string;
  instructions?: string;
  messages: ConversationMessage[];
  tools?: LlmToolSchema[];
  outputSchema?: Record<string, unknown> | null;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  purpose?: "turn" | "compaction" | "dreaming" | "decision";
  /** Pre-resolved tenant provider secret lookup (`undefined` = not prefetched; `{ credentials: null }` = verified none stored). */
  prefetchedProvider?: { credentials: ProviderCredentials | null };
}

interface ResolvedEndpoint {
  protocol: "mock" | "openai-chat" | "openai-responses" | "anthropic" | "gemini";
  providerName: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
}

export const DEFAULT_MODEL_ID = "openrouter/meta/muse-ember";

const VIRTUAL_MODEL_ALIASES: Record<string, string> = {
  "camelrun/default": DEFAULT_MODEL_ID,
  "camelrun/fast": DEFAULT_MODEL_ID,
  "muse-ember": DEFAULT_MODEL_ID,
  "meta/muse-ember": DEFAULT_MODEL_ID,
};

const MODEL_PRICING_PER_1M: Record<string, { input: number; output: number }> = {
  "muse-ember": { input: 0.1, output: 0.5 },
  "meta/muse-ember": { input: 0.1, output: 0.5 },
  "openrouter/meta/muse-ember": { input: 0.1, output: 0.5 },
  "deepseek-v4.1-flash-1017": { input: 0.08, output: 0.35 },
  "openrouter/deepseek/deepseek-v4.1-flash": { input: 0.3, output: 1.2 },
  "azure/deepseek-v4.1-flash": { input: 0.3, output: 1.2 },
  "openrouter/openai/gpt-6-luna": { input: 0.1, output: 0.5 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-5": { input: 2.5, output: 10.0 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "claude-sonnet-4-0": { input: 3.0, output: 15.0 },
  "claude-3-5-haiku-latest": { input: 0.8, output: 4.0 },
  "gemini-2.5-flash": { input: 0.15, output: 0.6 },
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
};

export function getModelContextWindow(rawModel: string): number {
  const m = (VIRTUAL_MODEL_ALIASES[rawModel] ?? rawModel).toLowerCase();
  if (
    m.includes("muse-ember") ||
    m.includes("gemini-2.5") ||
    m.includes("gpt-4.1")
  ) {
    return 1_048_576;
  }
  if (m.includes("claude-") || m.includes("o3") || m.includes("gpt-5")) {
    return 200_000;
  }
  return 128_000;
}

export function calculateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  vmMs = 0,
): number {
  const vmCost = (vmMs / 1000) * 0.00005; // $0.05 per 1,000 VM seconds
  const resolved = VIRTUAL_MODEL_ALIASES[model] ?? model;
  if (resolved.startsWith("mock/") || resolved === "mock") {
    return Number(vmCost.toFixed(8));
  }
  const normalized = resolved.includes("/") ? resolved.split("/").pop()! : resolved;
  const pricing =
    MODEL_PRICING_PER_1M[resolved] ??
    MODEL_PRICING_PER_1M[normalized] ?? { input: 0.5, output: 2.0 };
  const tokenCost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  return Number((tokenCost + vmCost).toFixed(8));
}

export function getProviderLookupCandidates(
  env: Env,
  rawModel: string,
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

  // An Azure deployment uses its own endpoint and key.
  if (explicitProvider === "azure") return { isMock: false, modelId, explicitProvider, candidates: ["azure"] };

  const candidates: string[] = [];
  if (explicitProvider) {
    candidates.push(explicitProvider);
  }
  if (modelId.startsWith("claude-") || explicitProvider === "anthropic") {
    candidates.push("anthropic");
  } else if (modelId.startsWith("gemini-") || explicitProvider === "google" || explicitProvider === "gemini") {
    candidates.push("gemini", "google");
  } else if (explicitProvider === "openrouter") {
    candidates.push("openrouter");
  } else if (explicitProvider === "openai-responses") {
    candidates.push("openai-responses", "openai");
  } else {
    if (/^(o3|gpt-5)/.test(modelId)) {
      candidates.push("openai-responses");
    }
    candidates.push("openai");
  }

  return { isMock: false, modelId, explicitProvider, candidates };
}

export async function resolveModelEndpoint(
  env: Env,
  tenantId: string,
  rawModel: string,
  prefetchedProvider?: { credentials: ProviderCredentials | null },
): Promise<ResolvedEndpoint> {
  const { isMock, modelId: canonicalModelId, explicitProvider, candidates: lookupOrder } =
    getProviderLookupCandidates(env, rawModel);

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
  } else {
    const tenantStub = getTenantStub(env, tenantId);
    for (const candidate of lookupOrder) {
      stored = await tenantStub.getProviderSecret(candidate);
      if (stored) break;
    }
  }

  const providerName = stored?.provider ?? lookupOrder[0] ?? "openai";
  const aliases = stored?.modelAliases;
  const modelId = aliases && Object.hasOwn(aliases, canonicalModelId) ? aliases[canonicalModelId] : canonicalModelId;

  if (providerName === "anthropic" || (!explicitProvider && canonicalModelId.startsWith("claude-"))) {
    const apiKey = stored?.apiKey || env.ANTHROPIC_API_KEY || "";
    if (!apiKey) {
      throw new ApiError(400, "missing_provider_key", `No API key configured for provider 'anthropic'`);
    }
    return {
      protocol: "anthropic",
      providerName: "anthropic",
      modelId,
      apiKey,
      baseUrl: (stored?.baseUrl || "https://api.anthropic.com").replace(/\/+$/, ""),
    };
  }

  if (
    providerName === "gemini" ||
    providerName === "google" ||
    (!explicitProvider && canonicalModelId.startsWith("gemini-"))
  ) {
    const apiKey = stored?.apiKey || env.GEMINI_API_KEY || "";
    if (!apiKey) {
      throw new ApiError(400, "missing_provider_key", `No API key configured for provider 'gemini'`);
    }
    return {
      protocol: "gemini",
      providerName: "gemini",
      modelId,
      apiKey,
      baseUrl: (stored?.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/+$/, ""),
    };
  }

  if (providerName === "openai-responses") {
    const apiKey = stored?.apiKey || env.OPENAI_API_KEY || "";
    if (!apiKey) {
      throw new ApiError(
        400,
        "missing_provider_key",
        `No API key configured for provider 'openai-responses'`,
      );
    }
    return {
      protocol: "openai-responses",
      providerName: "openai-responses",
      modelId,
      apiKey,
      baseUrl: (stored?.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, ""),
    };
  }

  if (providerName === "openrouter") {
    const apiKey = stored?.apiKey || env.OPENROUTER_API_KEY || "";
    if (!apiKey) {
      throw new ApiError(400, "missing_provider_key", `No API key configured for provider 'openrouter'`);
    }
    return {
      protocol: "openai-chat",
      providerName: "openrouter",
      modelId,
      apiKey,
      baseUrl: (stored?.baseUrl || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
    };
  }

  const apiKey = stored?.apiKey || (providerName === "azure" ? undefined : env.OPENAI_API_KEY);
  if (!apiKey) {
    throw new ApiError(
      400,
      "missing_provider_key",
      `No API key configured for provider '${providerName}'`,
    );
  }
  if (providerName === "azure" && !stored?.baseUrl) {
    throw new ApiError(400, "missing_provider_url", "An Azure provider requires its deployment base URL");
  }
  return {
    protocol: "openai-chat",
    providerName,
    modelId,
    apiKey,
    baseUrl: (stored?.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, ""),
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
  );

  if (endpoint.protocol !== "mock" && req.messages.some((message) => message.files?.length)) {
    const images = await loadConversationImages(new CamelFsClient(req.env, req.tenantId), req.messages);
    req = {
      ...req,
      messages: req.messages.map((message, index) => ({ ...message, images: images.get(index) })),
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

function buildResponsesUrl(baseUrl: string): string {
  if (baseUrl.endsWith("/responses")) return baseUrl;
  if (/\/v\d+$/.test(baseUrl)) return `${baseUrl}/responses`;
  return `${baseUrl}/v1/responses`;
}

function imageDataUrl(image: ModelImage): string {
  return `data:${image.contentType};base64,${image.base64}`;
}

async function* streamOpenAiChat(
  endpoint: ResolvedEndpoint,
  req: StreamModelRequest,
): AsyncGenerator<ModelStreamChunk, void, unknown> {
  const apiMessages: Array<Record<string, unknown>> = [];
  if (req.instructions) {
    apiMessages.push({ role: "system", content: req.instructions });
  }
  for (const m of req.messages) {
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
    } else {
      apiMessages.push({
        role: m.role,
        content: m.images?.length ? [
          { type: "text", text: m.text ?? "" },
          ...m.images.map((image) => ({ type: "image_url", image_url: { url: imageDataUrl(image) } })),
        ] : m.text ?? "",
      });
    }
  }

  const payload: Record<string, unknown> = {
    model: endpoint.modelId,
    messages: apiMessages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (endpoint.providerName === "openrouter") payload.provider = { data_collection: "deny" };
  if (req.temperature !== undefined) payload.temperature = req.temperature;
  if (req.maxOutputTokens !== undefined) payload.max_tokens = req.maxOutputTokens;

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
      Authorization: `Bearer ${endpoint.apiKey}`,
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
      usage?: { prompt_tokens?: number; completion_tokens?: number };
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
      stopReason: choice?.finish_reason ?? "stop",
    };
    return;
  }

  const toolBuffers = new Map<number, { id: string; name: string; args: string }>();
  let inputTokens = 0;
  let outputTokens = 0;
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
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      chunk = JSON.parse(frame.data);
    } catch {
      continue;
    }

    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
      outputTokens = chunk.usage.completion_tokens ?? outputTokens;
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
    stopReason,
  };
}

async function* streamOpenAiResponses(
  endpoint: ResolvedEndpoint,
  req: StreamModelRequest,
): AsyncGenerator<ModelStreamChunk, void, unknown> {
  const inputItems: Array<Record<string, unknown>> = [];
  for (const m of req.messages) {
    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      if (m.text) {
        inputItems.push({ role: "assistant", content: m.text });
      }
      for (const tc of m.toolCalls) {
        inputItems.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.name,
          arguments: tc.argumentsJson || JSON.stringify(tc.args ?? {}),
        });
      }
    } else if (m.role === "tool") {
      inputItems.push({
        type: "function_call_output",
        call_id: m.toolCallId ?? "call_0",
        output: m.text ?? "",
      });
    } else {
      inputItems.push({
        role: m.role,
        content: m.images?.length ? [
          { type: "input_text", text: m.text ?? "" },
          ...m.images.map((image) => ({ type: "input_image", image_url: imageDataUrl(image), detail: "auto" })),
        ] : m.text ?? "",
      });
    }
  }

  const payload: Record<string, unknown> = {
    model: endpoint.modelId,
    input: inputItems,
    stream: true,
  };
  if (req.instructions) payload.instructions = req.instructions;
  if (req.maxOutputTokens) payload.max_output_tokens = req.maxOutputTokens;
  if (req.tools && req.tools.length > 0) {
    payload.tools = req.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
  if (req.outputSchema) {
    payload.text = {
      format: {
        type: "json_schema",
        name: "structured_output",
        schema: req.outputSchema,
      },
    };
  }

  const res = await fetch(buildResponsesUrl(endpoint.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${endpoint.apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream, application/json",
    },
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
      usage?: { input_tokens?: number; output_tokens?: number };
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
      stopReason: "stop",
    };
    return;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let outChars = 0;

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
    } else if (type === "response.completed" && ev.response && typeof ev.response === "object") {
      const usage = (ev.response as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
      if (usage) {
        inputTokens = usage.input_tokens ?? inputTokens;
        outputTokens = usage.output_tokens ?? outputTokens;
      }
    }
  }

  yield {
    type: "done",
    inputTokens: inputTokens || estimateInputFromMessages(req),
    outputTokens: outputTokens || Math.max(1, Math.ceil(outChars / 4)),
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
            content: m.text ?? "",
            is_error: Boolean(m.isError),
          },
        ],
      });
    } else {
      messages.push({
        role: "user",
        content: m.images?.length ? [
          { type: "text", text: m.text ?? "" },
          ...m.images.map((image) => ({
            type: "image",
            source: { type: "base64", media_type: image.contentType, data: image.base64 },
          })),
        ] : m.text ?? "",
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
      "x-api-key": endpoint.apiKey,
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
      usage?: { input_tokens?: number; output_tokens?: number };
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
    yield {
      type: "done",
      inputTokens: json.usage?.input_tokens ?? estimateInputFromMessages(req),
      outputTokens: json.usage?.output_tokens ?? 16,
      stopReason: json.stop_reason ?? "end_turn",
    };
    return;
  }

  const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
  let inputTokens = 0;
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
      const usage = (ev.message as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
      if (usage) {
        inputTokens = usage.input_tokens ?? inputTokens;
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
      const u = ev.usage as { output_tokens?: number } | undefined;
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

  yield {
    type: "done",
    inputTokens: inputTokens || estimateInputFromMessages(req),
    outputTokens: outputTokens || 1,
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
        ],
      });
    } else {
      contents.push({
        role: "user",
        parts: [
          { text: m.text ?? "" },
          ...(m.images ?? []).map((image) => ({ inlineData: { mimeType: image.contentType, data: image.base64 } })),
        ],
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
  )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(endpoint.apiKey)}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: req.signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new ApiError(res.status, "provider_error", `Gemini HTTP ${res.status}: ${errText}`);
  }

  let inputTokens = 0;
  let outputTokens = 0;

  if (!res.body || (res.headers.get("content-type") ?? "").includes("application/json")) {
    const json = (await res.json()) as Record<string, unknown>;
    yield* emitGeminiChunk(json);
    yield {
      type: "done",
      inputTokens: estimateInputFromMessages(req),
      outputTokens: 16,
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
    const usageMeta = chunk.usageMetadata as
      | { promptTokenCount?: number; candidatesTokenCount?: number }
      | undefined;
    if (usageMeta) {
      inputTokens = usageMeta.promptTokenCount ?? inputTokens;
      outputTokens = usageMeta.candidatesTokenCount ?? outputTokens;
    }
    yield* emitGeminiChunk(chunk);
  }

  yield {
    type: "done",
    inputTokens: inputTokens || estimateInputFromMessages(req),
    outputTokens: outputTokens || 1,
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

  // Also inspect all user messages in the current active turn before tool calls
  let directiveSourceIdx = turnStartIdx;
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const msg = req.messages[i]!;
    if (msg.role === "user" && msg.text && /\[(PARALLEL_CALL|CALL):/.test(msg.text)) {
      directiveSourceIdx = i;
      break;
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
