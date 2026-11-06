/** Durable socket reservations for one tenant. Live agent objects reconcile their own IDs after waking. */
export class TenantWatchers {
  private readonly sql: SqlStorage;
  private readonly atomic: <T>(write: () => T) => T;
  private readonly now: () => number;
  constructor(sql: SqlStorage, atomic: <T>(write: () => T) => T, now = Date.now) {
    this.sql = sql;
    this.atomic = atomic;
    this.now = now;
    this.initialize();
  }
  initialize() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS event_watchers (id TEXT PRIMARY KEY, agent TEXT NOT NULL, expires_at INTEGER)");
    if (!this.sql.exec<{ name: string }>("PRAGMA table_info(event_watchers)").toArray().some(column => column.name === "expires_at"))
      this.sql.exec("ALTER TABLE event_watchers ADD COLUMN expires_at INTEGER");
    this.sql.exec("UPDATE event_watchers SET expires_at=? WHERE id LIKE 'poll:%' AND expires_at IS NULL", this.now() + 30_000);
  }
  private prune() {
    // JSON polls wait at most 25s. A 30-second lease recovers slots if their
    // serving isolate dies before finally; sockets never expire on a timer.
    this.sql.exec("DELETE FROM event_watchers WHERE expires_at <= ?", this.now());
  }
  canWatch(limit: number, agent?: string): boolean {
    this.prune();
    if (this.sql.exec<{ count: number }>("SELECT count(*) AS count FROM event_watchers").one().count >= limit) return false;
    return agent === undefined || this.sql.exec<{ count: number }>("SELECT count(*) AS count FROM event_watchers WHERE agent=?", agent).one().count < 32;
  }
  acquire(agent: string, id: string, limit: number): boolean {
    return this.atomic(() => {
      this.prune();
      const existing = this.sql.exec<{ agent: string }>("SELECT agent FROM event_watchers WHERE id=?", id).toArray()[0];
      if (existing) return existing.agent === agent;
      if (!this.canWatch(limit, agent)) return false;
      this.sql.exec("INSERT INTO event_watchers VALUES (?,?,?)", id, agent, id.startsWith("poll:") ? this.now() + 30_000 : null);
      return true;
    });
  }
  release(id: string): void {
    this.sql.exec("DELETE FROM event_watchers WHERE id=?", id);
  }
  reconcile(agent: string, activeIds: string[]): void {
    const active = new Set(activeIds);
    this.atomic(() => {
      // Poll requests release their own reservations in finally. A socket wake
      // cannot distinguish an active poll from one still returning its result.
      for (const row of this.sql.exec<{ id: string }>("SELECT id FROM event_watchers WHERE agent=? AND id NOT LIKE 'poll:%'", agent).toArray()) {
        if (!active.has(row.id)) this.release(row.id);
      }
    });
  }
}
