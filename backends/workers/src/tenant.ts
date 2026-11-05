import { DurableObject } from "cloudflare:workers";

/** One tenant serializes admission. No fleet registry, heartbeat or PG advisory lock. */
export class TenantAdmission extends DurableObject<Record<string, unknown>> {
  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS admitted (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS counters (key TEXT NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (key,window))",
    );
  }
  async acquire(id: string, limit = 1000): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      if (sql.exec("SELECT id FROM admitted WHERE id=?", id).toArray().length)
        return true;
      if (
        Number(
          sql
            .exec<{ count: number }>("SELECT count(*) AS count FROM admitted")
            .one().count,
        ) >= limit
      )
        return false;
      sql.exec("INSERT INTO admitted VALUES (?,?)", id, Date.now());
      return true;
    });
  }
  async release(id: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM admitted WHERE id=?", id);
  }
  async rate(key: string, limit = 1000, windowMs = 60_000): Promise<boolean> {
    const window = Math.floor(Date.now() / windowMs);
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec("DELETE FROM counters WHERE window < ?", window - 1);
      const current =
        sql
          .exec<{
            count: number;
          }>("SELECT count FROM counters WHERE key=? AND window=?", key, window)
          .toArray()[0]?.count ?? 0;
      if (current >= limit) return false;
      sql.exec(
        "INSERT INTO counters VALUES (?,?,1) ON CONFLICT(key,window) DO UPDATE SET count=count+1",
        key,
        window,
      );
      return true;
    });
  }
  async status() {
    return {
      active: this.ctx.storage.sql
        .exec("SELECT count(*) AS count FROM admitted")
        .one().count,
    };
  }
}
