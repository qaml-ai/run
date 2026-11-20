import app, { AgentDO as RuntimeAgentDO, TenantDO as RuntimeTenantDO } from "../../worker/src/index.ts";
import { toApiErrorResponse, type Env } from "../../worker/src/types.ts";

export class TenantDO extends RuntimeTenantDO {
  override async updateAgentModel(): Promise<void> { throw new Error("Spend CAS must not write the tenant model index"); }
}

export class AgentDO extends RuntimeAgentDO {
  seed(status: string) {
    if (status === "active") Object.assign(this, { activeRunId: "fixture-active" });
    else this.ctx.storage.sql.exec(
      "INSERT INTO runs (id,status,prompt,started_at,spend_limit_usd) VALUES ('fixture-run',?,'fixture',1,0.25)", status,
    );
  }

  async fixtureState() {
    const sql = this.ctx.storage.sql;
    return {
      config: sql.exec<{ config_json: string }>("SELECT config_json FROM config WHERE id=1").one().config_json,
      runs: sql.exec("SELECT * FROM runs ORDER BY id").toArray(),
      messages: sql.exec("SELECT * FROM messages ORDER BY seq").toArray(),
      events: sql.exec("SELECT * FROM events ORDER BY seq").toArray(),
      changes: sql.exec<{ n: number }>("SELECT total_changes() AS n").one().n,
      alarm: await this.ctx.storage.getAlarm(),
    };
  }

  corruptCap() {
    const config = JSON.parse(this.ctx.storage.sql.exec<{ config_json: string }>("SELECT config_json FROM config WHERE id=1").one().config_json);
    config.spendLimitUsd = null;
    this.ctx.storage.sql.exec("UPDATE config SET config_json=? WHERE id=1", JSON.stringify(config));
    Object.assign(this, { cachedConfig: null });
  }

  resetForTest(): void { this.ctx.abort("synthetic cold spend CAS"); }
}

export default {
  ...app,
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const match = /^\/_spend_fixture\/([^/]+)\/([^/]+)$/.exec(new URL(request.url).pathname);
    if (!match) return app.fetch(request, env, ctx);
    const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(match[1]!)) as unknown as AgentDO;
    try {
      switch (match[2]) {
        case "seed": await stub.seed(await request.text()); break;
        case "state": return Response.json(await stub.fixtureState());
        case "corrupt": await stub.corruptCap(); break;
        case "scope": return Response.json(await stub.updateSpendLimitIfIdle(await request.json(), 0, 10));
        case "cold":
          try { await stub.resetForTest(); } catch { return new Response(null, { status: 204 }); }
          throw new Error("Fixture did not reset");
        default: return new Response(null, { status: 404 });
      }
      return new Response(null, { status: 204 });
    } catch (error) { return toApiErrorResponse(error); }
  },
};
