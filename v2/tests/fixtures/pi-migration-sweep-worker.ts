import app, { AgentDO as RuntimeAgentDO, TenantDO, VoiceCallDO } from "../../worker/src/index.ts";
import { toApiErrorResponse, type Env } from "../../worker/src/types.ts";

export { TenantDO, VoiceCallDO };

export class AgentDO extends RuntimeAgentDO {
  inspectPiStorage(): { legacyMessagesCount: number; hasPiRoot: boolean; piEntriesCount: number } {
    const hasMessagesTable =
      this.ctx.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages' LIMIT 1")
        .toArray().length > 0;
    const legacyMessagesCount = hasMessagesTable
      ? Number(this.ctx.storage.sql.exec<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM messages").one().cnt)
      : 0;
    const hasPiConvTable =
      this.ctx.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pi_conversations' LIMIT 1",
        )
        .toArray().length > 0;
    const hasPiRoot =
      hasPiConvTable &&
      this.ctx.storage.sql
        .exec<{ id: number }>("SELECT id FROM pi_conversations WHERE id = 1 LIMIT 1")
        .toArray().length > 0;
    const hasPiEntriesTable =
      this.ctx.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pi_entries' LIMIT 1",
        )
        .toArray().length > 0;
    const piEntriesCount = hasPiEntriesTable
      ? Number(
          this.ctx.storage.sql
            .exec<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM pi_entries WHERE conversation_id = 1")
            .one().cnt,
        )
      : 0;
    return { legacyMessagesCount, hasPiRoot, piEntriesCount };
  }
}

export default {
  ...app,
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const inspectMatch = /^\/_migration_fixture\/([^/]+)\/inspect$/.exec(url.pathname);
    if (inspectMatch) {
      try {
        const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(inspectMatch[1]!)) as unknown as AgentDO;
        return Response.json(await stub.inspectPiStorage());
      } catch (err) {
        return toApiErrorResponse(err);
      }
    }
    return app.fetch(request, env, ctx);
  },
};
