import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { AgentDO as RuntimeAgentDO } from "../../worker/src/agent-do.ts";
import type { Env } from "../../worker/src/types.ts";

export interface HistoryFixtureEntry {
  id: number;
  conversationId: number;
  kind: string;
  head?: number;
  model?: unknown[];
  data?: Record<string, unknown>;
}

export interface HistoryFixtureRows {
  entries: HistoryFixtureEntry[];
  metadata: Array<{ id: number; runId: string | null; meta: Record<string, unknown> }>;
}

export class AgentDO extends RuntimeAgentDO {
  private historyQueries: Array<{ query: string; cursor: SqlStorageCursor<Record<string, SqlStorageValue>> }> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const storage = ctx.storage;
    const sql = storage.sql;
    const trackedSql = {
      exec: <T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) => {
        const cursor = sql.exec<T>(query, ...bindings);
        this.historyQueries?.push({ query, cursor });
        return cursor;
      },
    };
    // Instrument the real SQLite cursors used by AgentDO, including reads whose
    // result rows are discarded. Keep the original storage for seeding Pi.
    this.ctx = new Proxy(this.ctx, {
      get: (target, property) => property === "storage" ? new Proxy(storage, {
        get: (storageTarget, storageProperty) => {
          if (storageProperty === "sql" && this.historyQueries) return trackedSql;
          const value = Reflect.get(storageTarget, storageProperty, storageTarget);
          return typeof value === "function" ? value.bind(storageTarget) : value;
        },
      }) : Reflect.get(target, property, target),
    });
  }

  async seedHistory(rows: HistoryFixtureRows): Promise<void> {
    await this.getHistory(); // Initialize CamelRun tables in the same way as a normal history call.
    const storage = this.ctx.storage;
    const pi = await openDurableObjectSqliteStorage(storage, { prefix: "pi_" });
    await pi.close(BACKGROUND_CONTEXT);
    storage.transactionSync(() => {
      storage.sql.exec("INSERT INTO pi_conversations (id, record) VALUES (1, '{\"id\":1}')");
      this.appendHistoryRows(rows);
    });
  }

  appendHistoryRows(rows: HistoryFixtureRows): void {
    const sql = this.ctx.storage.sql;
    for (const entry of rows.entries) {
      sql.exec(
        "INSERT INTO pi_entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, ?, 1, ?)",
        entry.id, entry.conversationId, entry.head ?? null, JSON.stringify(entry),
      );
    }
    for (const { id, runId, meta } of rows.metadata) {
      sql.exec(
        "INSERT INTO pi_entry_meta (entry_id, run_id, meta_json, repo_commit) VALUES (?, ?, ?, 'fixture_commit')",
        id, runId, JSON.stringify(meta),
      );
    }
  }

  async trackedHistory(opts: { after?: number; before?: number; limit?: number }) {
    const queries: NonNullable<AgentDO["historyQueries"]> = [];
    this.historyQueries = queries;
    try {
      const history = await this.getHistory(opts);
      return {
        history,
        reads: queries.map(({ query, cursor }) => ({ query, rows: cursor.rowsRead })),
      };
    } finally {
      this.historyQueries = null;
    }
  }
}

export default {
  async fetch(request: Request, env: { TEST_HISTORY: DurableObjectNamespace<AgentDO> }) {
    const url = new URL(request.url);
    const stub = env.TEST_HISTORY.getByName("long-history");
    if (url.pathname === "/seed") {
      await stub.seedHistory(await request.json() as HistoryFixtureRows);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/append") {
      await stub.appendHistoryRows(await request.json() as HistoryFixtureRows);
      return new Response(null, { status: 204 });
    }
    const before = url.searchParams.get("before");
    const after = url.searchParams.get("after");
    const limit = url.searchParams.get("limit");
    return Response.json(await stub.trackedHistory({
      before: before === "latest" ? Number.MAX_SAFE_INTEGER : before === null ? undefined : Number(before),
      after: after === null ? undefined : Number(after),
      limit: limit === null ? undefined : Number(limit),
    }));
  },
};
