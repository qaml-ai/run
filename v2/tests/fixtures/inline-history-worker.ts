import app, { AgentDO as RuntimeAgentDO, TenantDO } from "../../worker/src/index.ts";
import { buildConversationMessages } from "../../worker/src/turn-loop.ts";
import { streamModelResponse } from "../../worker/src/providers.ts";
import { ApiError, toApiErrorResponse, type Env, type StoredMessage } from "../../worker/src/types.ts";
export { TenantDO };

export class AgentDO extends RuntimeAgentDO {
  override async importV1HistoryWithInlineImages(...args: Parameters<RuntimeAgentDO["importV1HistoryWithInlineImages"]>) {
    this.requireFixtureImportCapability();
    return super.importV1HistoryWithInlineImages(...args);
  }

  override async appendV1HistoryChunk(...args: Parameters<RuntimeAgentDO["appendV1HistoryChunk"]>) {
    this.requireFixtureImportCapability();
    return super.appendV1HistoryChunk(...args);
  }

  private requireFixtureImportCapability() {
    const config = JSON.parse(this.ctx.storage.sql.exec<{ config_json: string }>("SELECT config_json FROM config WHERE id=1").one().config_json);
    if (config.key === "old-reader") throw new ApiError(503, "old_fixture_reader", "Old fixture lacks the new import capability");
  }

  fixtureMessages(): StoredMessage[] {
    return this.ctx.storage.sql.exec<{ seq: number; content_json: string; role: StoredMessage["role"]; run_id: string | null; created_at: number; tokens_est: number }>(
      "SELECT seq,role,run_id,content_json,created_at,tokens_est FROM messages ORDER BY seq",
    ).toArray().map(row => ({ seq: row.seq, role: row.role, runId: row.run_id,
      content: JSON.parse(row.content_json), createdAt: row.created_at, tokensEst: row.tokens_est }));
  }
}

export default {
  ...app,
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const match = /^\/_inline_fixture\/([^/]+)\/project$/.exec(new URL(request.url).pathname);
    if (!match) return app.fetch(request, env, ctx);
    try {
      const { provider, baseUrl } = await request.json() as { provider: string; baseUrl: string };
      const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(match[1]!)) as unknown as AgentDO;
      const models: Record<string, string> = { openai: "openai/fixture", "openai-responses": "openai-responses/fixture", anthropic: "anthropic/fixture", gemini: "gemini/fixture" };
      if (!models[provider] || !baseUrl.startsWith("http://127.0.0.1:")) return new Response(null, { status: 400 });
      const messages = buildConversationMessages(null, await stub.fixtureMessages());
      for await (const _ of streamModelResponse({ env, tenantId: "fixture", model: models[provider]!, messages,
        prefetchedProvider: { credentials: { provider, apiKey: "fixture-no-provider-key", baseUrl } } })) { /* consume exact adapter */ }
      return Response.json({ projected: messages.length });
    } catch (error) { return toApiErrorResponse(error); }
  },
};
