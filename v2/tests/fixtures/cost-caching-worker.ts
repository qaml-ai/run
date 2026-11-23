import runtime, { AgentDO, TenantDO } from "../../worker/src/index.ts";
import {
  addModelUsage,
  calculateCostUsd,
  streamModelResponse,
} from "../../worker/src/providers.ts";
import { getAutoCompactThreshold, needsAutoCompaction } from "../../worker/src/turn-loop.ts";
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
    if (url.pathname === "/_test/compact-threshold" && request.method === "POST") {
      const { model, override } = await request.json<{ model: string; override?: number | null }>();
      return Response.json({ threshold: getAutoCompactThreshold(model, override) });
    }
    if (url.pathname === "/_test/needs-compact" && request.method === "POST") {
      const body = await request.json<{
        count: number;
        tokensEst: number;
        lastTokensEst: number;
        threshold: number;
        excludeLast?: boolean;
        observedInputTokens?: number;
      }>();
      const needed = needsAutoCompaction(
        {
          measureMessagesAfter: () => ({
            count: body.count,
            tokensEst: body.tokensEst,
            lastTokensEst: body.lastTokensEst,
          }),
          listMessagesAfter: () => [],
        },
        0,
        body.threshold,
        {
          excludeLast: body.excludeLast,
          observedInputTokens: body.observedInputTokens,
        },
      );
      return Response.json({ needed });
    }
    if (url.pathname === "/_test/stream" && request.method === "POST") {
      const body = await request.json<{
        model: string;
        promptCacheKey?: string;
        credentials?: ProviderCredentials | null;
      }>();
      const chunks = [];
      for await (const chunk of streamModelResponse({
        env,
        tenantId: "fixture-tenant",
        model: body.model,
        instructions: "Test instructions",
        messages: [{ role: "user", text: "Hello" }],
        promptCacheKey: body.promptCacheKey,
        prefetchedProvider: body.credentials !== undefined ? { credentials: body.credentials } : undefined,
      })) {
        chunks.push(chunk);
      }
      return Response.json({ chunks });
    }
    return runtime.fetch(request, env, ctx);
  },
};
