import type { AssistantMessage, Message as PiAiMessage, TextContent, ToolCall } from "@earendil-works/pi-ai";
import runtime, { AgentDO, TenantDO } from "../../worker/src/index.ts";
import {
  buildPiModels,
  calculateCostUsd,
  DEFAULT_MODEL_ID,
  getModelContextWindow,
  parsePiModelRef,
  PLATFORM_AZURE_MODELS,
  streamPiModel,
} from "../../worker/src/pi/models.ts";
import { ApiError, toApiErrorResponse, type Env, type ProviderCredentials } from "../../worker/src/types.ts";

export { AgentDO, TenantDO };

interface FixtureInputMessage {
  role: "user" | "assistant" | "tool";
  text?: string;
  toolCalls?: Array<{ id: string; name: string; argumentsJson?: string; args?: Record<string, unknown> }>;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

function toPiMessages(raw: FixtureInputMessage[], provider: string, modelId: string): PiAiMessage[] {
  const out: PiAiMessage[] = [];
  for (const m of raw) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.text ?? "", timestamp: Date.now() });
    } else if (m.role === "assistant") {
      const blocks: Array<TextContent | ToolCall> = [];
      if (m.text) blocks.push({ type: "text", text: m.text });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({
          type: "toolCall",
          id: tc.id,
          name: tc.name,
          arguments: (tc.args ?? (tc.argumentsJson ? JSON.parse(tc.argumentsJson) : {})) as ToolCall["arguments"],
        });
      }
      const assistantMsg: AssistantMessage = {
        role: "assistant",
        content: blocks,
        api: "openai-responses",
        provider,
        model: modelId,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: (m.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      out.push(assistantMsg);
    } else if (m.role === "tool") {
      out.push({
        role: "toolResult",
        toolCallId: m.toolCallId ?? "",
        toolName: m.toolName ?? "tool",
        content: [{ type: "text", text: m.text ?? "" }],
        isError: Boolean(m.isError),
        timestamp: Date.now(),
      });
    }
  }
  return out;
}

function apiToProtocol(api: string): string {
  if (api === "azure-openai-responses" || api === "openai-responses") return "openai-responses";
  if (api === "openai-completions") return "openai-chat";
  if (api === "anthropic-messages") return "anthropic";
  if (api === "google-generative-ai") return "gemini";
  if (api === "openai-codex-responses") return "openai-codex";
  return api;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/_test/default-model" && request.method === "GET") {
        return Response.json({ defaultModelId: DEFAULT_MODEL_ID });
      }
      if (url.pathname === "/_test/resolve" && request.method === "POST") {
        const body = await request.json<{
          model: string;
          tenantId?: string;
          keyScope?: string | null;
          credentials?: ProviderCredentials | null;
        }>();
        const ref = parsePiModelRef(body.model, env);
        const prefetchedCredentials =
          body.credentials !== undefined ? { [ref.provider]: body.credentials } : undefined;
        const models = await buildPiModels({
          env,
          tenantId: body.tenantId ?? "fixture-tenant",
          keyScope: body.keyScope ?? null,
          rawModel: body.model,
          prefetchedCredentials,
        });
        const model = models.getModel(ref.provider, ref.modelId);
        if (!model) {
          throw new ApiError(400, "unknown_model", `Model '${body.model}' not found`);
        }
        const auth = ref.provider === "mock" ? { auth: { apiKey: "mock" } } : await models.getAuth(model);
        if (!auth) {
          const isPlatformAzure = ref.provider === "azure" && PLATFORM_AZURE_MODELS.has(ref.modelId);
          throw new ApiError(
            isPlatformAzure ? 503 : 400,
            "missing_provider_key",
            `No API key configured for provider '${ref.provider}'`,
          );
        }
        return Response.json({
          protocol: ref.provider === "mock" ? "mock" : apiToProtocol(model.api),
          providerName: model.provider,
          modelId: model.id,
          baseUrl: model.baseUrl,
          apiKey: auth.auth && "apiKey" in auth.auth ? auth.auth.apiKey : "",
        });
      }

      if (url.pathname === "/_test/pricing" && request.method === "POST") {
        const body = await request.json<{
          model: string;
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens?: number;
        }>();
        return Response.json({
          contextWindow: getModelContextWindow(body.model),
          costUsd: calculateCostUsd(
            body.model,
            body.inputTokens,
            body.outputTokens,
            0,
            body.cacheReadTokens ?? 0,
          ),
        });
      }

      if (url.pathname === "/_test/stream" && request.method === "POST") {
        const body = await request.json<{
          model: string;
          messages?: FixtureInputMessage[];
          temperature?: number;
          maxOutputTokens?: number;
          promptCacheKey?: string;
          credentials?: ProviderCredentials | null;
        }>();
        const ref = parsePiModelRef(body.model, env);
        const prefetchedCredentials =
          body.credentials !== undefined ? { [ref.provider]: body.credentials } : undefined;
        const chunks = [];
        for await (const chunk of streamPiModel({
          env,
          tenantId: "fixture-tenant",
          model: body.model,
          instructions: "You are concise.",
          messages: body.messages
            ? toPiMessages(body.messages, ref.provider, ref.modelId)
            : [{ role: "user", content: "Hi", timestamp: Date.now() }],
          temperature: body.temperature,
          maxOutputTokens: body.maxOutputTokens,
          promptCacheKey: body.promptCacheKey,
          prefetchedCredentials,
        })) {
          chunks.push(chunk);
        }
        return Response.json({ chunks });
      }
    } catch (error) {
      return toApiErrorResponse(error);
    }

    return runtime.fetch(request, env, ctx);
  },
};
