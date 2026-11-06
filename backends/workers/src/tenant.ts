import { DurableObject } from "cloudflare:workers";
import { TenantWatchers } from "./tenant-watchers.ts";
import { TenantStorage } from "./tenant-storage.ts";
const agentOf = "CASE WHEN instr(id, ':') > 0 THEN substr(id, 1, instr(id, ':') - 1) ELSE id END";

/** One tenant serializes admission. No fleet registry, heartbeat or PG advisory lock. */
export class TenantAdmission extends DurableObject<Record<string, unknown>> {
  private readonly watchers: TenantWatchers;
  private readonly files: TenantStorage;
  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    this.watchers = new TenantWatchers(ctx.storage.sql, write => ctx.storage.transactionSync(write));
    this.files = new TenantStorage(ctx.storage, env.BUCKET as R2Bucket);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS admitted (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS creations (token TEXT PRIMARY KEY, id TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS counters (key TEXT NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (key,window))",
    );
  }
  /** Short startup reservations fence concurrent creates without retaining idle agents. */
  async reserveCreation(id: string, token: string, limit: number): Promise<boolean> {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS creations (token TEXT PRIMARY KEY, id TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec("DELETE FROM creations WHERE expires_at <= ?", Date.now());
      const busy = sql.exec<{ count: number }>(`SELECT count(*) AS count FROM (SELECT ${agentOf} AS agent FROM admitted UNION SELECT id AS agent FROM creations) WHERE agent <> ?`, id).one().count;
      if (busy >= limit) return false;
      sql.exec("INSERT INTO creations VALUES (?,?,?)", token, id, Date.now() + 60_000);
      return true;
    });
  }
  async releaseCreation(token: string): Promise<void> {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS creations (token TEXT PRIMARY KEY, id TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("DELETE FROM creations WHERE token=?", token);
  }
  async acquire(id: string, limit = 1000): Promise<boolean> {
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const alreadyBusy = sql.exec(`SELECT id FROM admitted WHERE ${agentOf}=? LIMIT 1`, id.split(":")[0]).toArray().length > 0;
      if (
        Number(
          sql
            .exec<{ count: number }>(`SELECT count(*) AS count FROM (SELECT ${agentOf} AS agent FROM admitted UNION SELECT id AS agent FROM creations WHERE expires_at > ?) WHERE agent <> ?`, Date.now(), id.split(":")[0])
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
  async canWatch(limit: number, agent?: string): Promise<boolean> {
    return this.watchers.canWatch(limit, agent);
  }
  async acquireWatcher(agent: string, id: string, limit: number): Promise<boolean> {
    return this.watchers.acquire(agent, id, limit);
  }
  async releaseWatcher(id: string): Promise<void> {
    this.watchers.release(id);
  }
  async reconcileWatchers(agent: string, activeIds: string[]): Promise<void> {
    this.watchers.reconcile(agent, activeIds);
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
  nativeStorageUsed(tenant: string) { return this.files.used(tenant); }
  recordNativeFile(tenant: string, key: string, bytes: number) { return this.files.record(tenant, key, bytes); }
  deleteNativeFile(tenant: string, key: string) { return this.files.deleted(tenant, key); }
  alarm() { return this.files.alarm(); }
  /** Called after account deletion has stopped and purged every owned agent. */
  async purgeAccountData() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.watchers.initialize();
    // Keep the reusable object's empty schema: old delayed releases stay harmless.
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS admitted (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS creations (token TEXT PRIMARY KEY, id TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counters (key TEXT NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (key,window))");
  }
  async status() {
    return {
      active: this.ctx.storage.sql
        .exec(`SELECT count(DISTINCT ${agentOf}) AS count FROM admitted`)
        .one().count,
    };
  }
}
