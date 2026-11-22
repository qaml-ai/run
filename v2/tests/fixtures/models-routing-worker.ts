import runtime, { AgentDO, TenantDO } from "../../worker/src/index.ts";
import {
  calculateCostUsd,
  getModelContextWindow,
  resolveModelEndpoint,
  streamModelResponse,
} from "../../worker/src/providers.ts";
import { toApiErrorResponse, type Env, type ProviderCredentials } from "../../worker/src/types.ts";

export { AgentDO, TenantDO };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/_test/resolve" && request.method === "POST") {
        const body = await request.json<{
          model: string;
          tenantId?: string;
          keyScope?: string | null;
          credentials?: ProviderCredentials | null;
        }>();
        const endpoint = await resolveModelEndpoint(
          env,
          body.tenantId ?? "fixture-tenant",
          body.model,
          body.credentials !== undefined ? { credentials: body.credentials } : undefined,
          body.keyScope,
        );
        return Response.json(endpoint);
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
          temperature?: number;
          maxOutputTokens?: number;
          promptCacheKey?: string;
          credentials?: ProviderCredentials | null;
        }>();
        const chunks = [];
        for await (const chunk of streamModelResponse({
          env,
          tenantId: "fixture-tenant",
          model: body.model,
          instructions: "You are concise.",
          messages: [{ role: "user", text: "Hi" }],
          temperature: body.temperature,
          maxOutputTokens: body.maxOutputTokens,
          promptCacheKey: body.promptCacheKey,
          prefetchedProvider: body.credentials !== undefined ? { credentials: body.credentials } : undefined,
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
