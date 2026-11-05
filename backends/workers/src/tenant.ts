import { DurableObject } from "cloudflare:workers";
const agentOf = "CASE WHEN instr(id, ':') > 0 THEN substr(id, 1, instr(id, ':') - 1) ELSE id END";

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
      const alreadyBusy = sql.exec(`SELECT id FROM admitted WHERE ${agentOf}=? LIMIT 1`, id.split(":")[0]).toArray().length > 0;
      if (
        Number(
          sql
            .exec<{ count: number }>(`SELECT count(DISTINCT ${agentOf}) AS count FROM admitted`)
            .one().count,
        ) >= limit && !alreadyBusy
      )
        return false;
      sql.exec("INSERT OR IGNORE INTO admitted VALUES (?,?)", id, Date.now());
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
        .exec(`SELECT count(DISTINCT ${agentOf}) AS count FROM admitted`)
        .one().count,
    };
  }
}
