import app, { AgentDO as RuntimeAgentDO, TenantDO } from "../../worker/src/index.ts";
import type { Env } from "../../worker/src/types.ts";

export { TenantDO };

export class AgentDO extends RuntimeAgentDO {
  async expireInputIn(seconds: number): Promise<void> {
    const expiresAt = Date.now() + seconds * 1000;
    this.ctx.storage.sql.exec("UPDATE inputs SET expires_at = ? WHERE status = 'pending'", expiresAt);
    await this.ctx.storage.setAlarm(expiresAt);
  }

  async accelerateWakeup(runId: string): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) throw new Error("The accepted turn did not arm a wake-up");
    const old = Date.now() - 360_000;
    this.ctx.storage.sql.exec("UPDATE runs SET started_at = ? WHERE id = ?", old, runId);
    this.ctx.storage.sql.exec("UPDATE events SET created_at = ? WHERE run_id = ?", old, runId);
    await this.ctx.storage.setAlarm(Date.now() + 250);
  }

  resetForTest(): void {
    this.ctx.abort("test isolate reset");
  }

  getStoredStatus(runId: string): string | null {
    // Inspect SQLite without invoking the runtime's cold-start queue recovery.
    return this.ctx.storage.sql.exec<{ status: string }>(
      "SELECT status FROM runs WHERE id = ?", runId,
    ).toArray()[0]?.status ?? null;
  }

  getStallMarker(): string | null {
    return this.ctx.storage.sql.exec<{ v: string }>(
      "SELECT v FROM runtime_kv WHERE k = 'last_stall_queued'",
    ).toArray()[0]?.v ?? null;
  }
}

export default {
  ...app,
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/test-alarm\/([^/]+)$/.exec(url.pathname);
    if (!match) return app.fetch(request, env, ctx);
    const stub = env.AGENT_DO.get(env.AGENT_DO.idFromName(match[1]!)) as unknown as AgentDO;
    const runId = url.searchParams.get("runId");
    if (request.method === "POST" && runId) {
      await stub.accelerateWakeup(runId);
      try {
        await stub.resetForTest();
      } catch {
        return new Response(null, { status: 204 });
      }
      return new Response("Fixture did not reset", { status: 500 });
    }
    if (request.method === "POST") {
      await stub.expireInputIn(1);
      return new Response(null, { status: 204 });
    }
    return Response.json(runId ? await stub.getStoredStatus(runId) : await stub.getStallMarker());
  },
};
