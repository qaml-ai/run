import type { Message as PiAiMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import app, { AgentDO as RuntimeAgentDO, TenantDO } from "../../worker/src/index.ts";
import { parsePiModelRef, streamPiModel } from "../../worker/src/pi/models.ts";
import { ApiError, toApiErrorResponse, type Env } from "../../worker/src/types.ts";
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

  fixturePiMessages(): PiAiMessage[] {
    const legacyCount = this.ctx.storage.sql
      .exec<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM messages")
      .one().cnt;
    if (legacyCount !== 0) {
      throw new Error(`Expected 0 rows in legacy messages table after direct pi-durable import, got ${legacyCount}`);
    }
    const rows = this.ctx.storage.sql
      .exec<{ record: string }>("SELECT record FROM pi_entries WHERE conversation_id = 1 ORDER BY id ASC")
      .toArray();
    const out: PiAiMessage[] = [];
    for (const row of rows) {
      const entry = JSON.parse(row.record) as EntryRecord;
      if (entry.model) out.push(...entry.model);
    }
    return out;
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
      const models: Record<string, string> = {
        openai: "openai/fixture",
        "openai-responses": "openai-responses/fixture",
        anthropic: "anthropic/fixture",
        gemini: "gemini/fixture",
      };
      const targetModel = models[provider];
      if (!targetModel || !baseUrl.startsWith("http://127.0.0.1:")) return new Response(null, { status: 400 });
      const ref = parsePiModelRef(targetModel, env);
      const messages = await stub.fixturePiMessages();
      for await (const _ of streamPiModel({
        env,
        tenantId: "fixture",
        model: targetModel,
        messages,
        prefetchedCredentials: {
          [ref.provider]: {
            provider: ref.provider,
            apiKey: "fixture-no-provider-key",
            baseUrl,
            ...(provider === "openai" ? { apiStyle: "openai-chat" as const } : {}),
          },
        },
      })) { /* consume exact pi-ai adapter */ }
      return Response.json({ projected: messages.length });
    } catch (error) { return toApiErrorResponse(error); }
  },
};
