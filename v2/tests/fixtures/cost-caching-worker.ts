import runtime, { AgentDO, TenantDO } from "../../worker/src/index.ts";
import {
  addModelUsage,
  calculateCostUsd,
  parsePiModelRef,
  streamPiModel,
} from "../../worker/src/pi/models.ts";
import { emptyUsage, type Env, type ProviderCredentials } from "../../worker/src/types.ts";

export { AgentDO, TenantDO };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/_test/cost" && request.method === "POST") {
      const body = await request.json<{
        model: string;
        inputTokens: number;
        outputTokens: number;
        vmMs?: number;
        cacheReadTokens?: number;
      }>();
      const costUsd = calculateCostUsd(
        body.model,
        body.inputTokens,
        body.outputTokens,
        body.vmMs ?? 0,
        body.cacheReadTokens ?? 0,
      );
      const usage = emptyUsage();
      addModelUsage(usage, body.model, body.inputTokens, body.outputTokens, body.cacheReadTokens ?? 0);
      return Response.json({ costUsd, usage });
    }
    if (url.pathname === "/_test/stream" && request.method === "POST") {
      const body = await request.json<{
        model: string;
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
        instructions: "Test instructions",
        messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
        promptCacheKey: body.promptCacheKey,
        prefetchedCredentials,
      })) {
        chunks.push(chunk);
      }
      return Response.json({ chunks });
    }
    return runtime.fetch(request, env, ctx);
  },
};
