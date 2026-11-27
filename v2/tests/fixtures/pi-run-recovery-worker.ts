import app, { AgentDO as RuntimeAgentDO } from "../../worker/src/index.ts";
export { TenantDO, VoiceCallDO } from "../../worker/src/index.ts";
import type { Env } from "../../worker/src/types.ts";

type SettlementHook = (...args: unknown[]) => Promise<void>;

export class AgentDO extends RuntimeAgentDO {
  private pausedAt: "before-sync" | "after-sync" | null = null;
  private syncReads: Array<{ query: string; rowsRead: number }> = [];
  private wakeups = 0;

  async wakeForTest(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now());
  }

  override async alarm(): Promise<void> {
    await super.alarm();
    this.wakeups += 1;
  }

  instrumentSettlement(pauseAt: string | null): void {
    const engine = (this as unknown as {
      ensurePiEngine(): { syncRunEntriesFromPi: SettlementHook; recordRunRepoCommit: SettlementHook };
    }).ensurePiEngine();
    const sync = engine.syncRunEntriesFromPi.bind(engine);
    const recordCommit = engine.recordRunRepoCommit.bind(engine);
    const sleep = () => new Promise<void>((resolve) => setTimeout(resolve, 30_000));
    engine.syncRunEntriesFromPi = async (...args) => {
      if (pauseAt === "before-sync") {
        this.pausedAt = "before-sync";
        await sleep();
      }
      const sql = this.ctx.storage.sql;
      const exec = sql.exec.bind(sql);
      const reads: Array<{ query: string; cursor: { rowsRead: number } }> = [];
      sql.exec = <T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]) => {
        const cursor = exec<T>(query, ...bindings);
        if (/\b(?:FROM|JOIN)\s+pi_entries\b/i.test(query)) reads.push({ query, cursor });
        return cursor;
      };
      try {
        await sync(...args);
      } finally {
        sql.exec = exec;
        this.syncReads.push(...reads.map(({ query, cursor }) => ({ query, rowsRead: cursor.rowsRead })));
      }
    };
    engine.recordRunRepoCommit = async (...args) => {
      if (pauseAt === "after-sync") {
        this.pausedAt = "after-sync";
        await sleep();
      }
      await recordCommit(...args);
    };
  }

  makeBoundaryUnprovable(runId: string): void {
    const sql = this.ctx.storage.sql;
    const { id, entry } = sql.exec<{ id: number; entry: string }>(
      `SELECT id, json_extract(record, '$.entry') AS entry FROM pi_submissions
       WHERE json_extract(record, '$.requestId') = ? AND status = 'done'`,
      runId,
    ).one();
    sql.exec("UPDATE runs SET baseline_entry_id = NULL WHERE id = ?", runId);
    // Keep the settled receipt and the conversation entry, removing only their links to the start of this run.
    sql.exec("UPDATE pi_submissions SET record = json_remove(record, '$.entry') WHERE id = ?", id);
    sql.exec("UPDATE pi_entries SET record = json_remove(record, '$.data.runId') WHERE id = ?", Number(entry));
    sql.exec("UPDATE pi_entry_meta SET run_id = NULL WHERE entry_id = ? AND run_id = ?", Number(entry), runId);
  }

  seedOrphanRun(runId: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO runs (id, status, prompt, started_at) VALUES (?, 'running', 'Orphaned run', ?)",
      runId,
      Date.now(),
    );
  }

  readRecoveryState(runId: string | null) {
    const sql = this.ctx.storage.sql;
    return {
      pausedAt: this.pausedAt,
      wakeups: this.wakeups,
      subscribers: this.ctx.getWebSockets().length,
      syncReads: this.syncReads,
      history: sql.exec<{ count: number; tail: number }>(
        "SELECT count(*) AS count, max(id) AS tail FROM pi_entries",
      ).one(),
      run: runId === null ? null : sql.exec<{ status: string; baseline_entry_id: number | null }>(
        "SELECT status, baseline_entry_id FROM runs WHERE id = ?", runId,
      ).one(),
    };
  }

  resetForTest(): void {
    this.ctx.abort("test recovery isolate reset");
  }
}

export default {
  ...app,
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/test-recovery\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (!match) return app.fetch(request, env, ctx);
    const stub = env.AGENT_DO.getByName(match[1]!) as unknown as AgentDO;
    const runId = url.searchParams.get("runId");
    switch (match[2]) {
      case "state":
        return Response.json(await stub.readRecoveryState(runId));
      case "instrument":
        await stub.instrumentSettlement(url.searchParams.get("pauseAt"));
        break;
      case "legacy":
        await stub.makeBoundaryUnprovable(runId!);
        break;
      case "orphan":
        await stub.seedOrphanRun(runId!);
        break;
      case "wake":
        await stub.wakeForTest();
        break;
      case "reset":
        try {
          await stub.resetForTest();
        } catch {
          return new Response(null, { status: 204 });
        }
        throw new Error("Fixture did not reset");
      default:
        return new Response(null, { status: 404 });
    }
    return new Response(null, { status: 204 });
  },
};
