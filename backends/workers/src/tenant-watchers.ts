/** Durable socket reservations for one tenant. Live agent objects reconcile their own IDs after waking. */
export class TenantWatchers {
  constructor(private readonly sql: SqlStorage, private readonly atomic: <T>(write: () => T) => T) {
    this.initialize();
  }
  initialize() {
    this.sql.exec("CREATE TABLE IF NOT EXISTS event_watchers (id TEXT PRIMARY KEY, agent TEXT NOT NULL)");
  }
  canWatch(limit: number, agent?: string): boolean {
    if (this.sql.exec<{ count: number }>("SELECT count(*) AS count FROM event_watchers").one().count >= limit) return false;
    return agent === undefined || this.sql.exec<{ count: number }>("SELECT count(*) AS count FROM event_watchers WHERE agent=?", agent).one().count < 32;
  }
  acquire(agent: string, id: string, limit: number): boolean {
    return this.atomic(() => {
      const existing = this.sql.exec<{ agent: string }>("SELECT agent FROM event_watchers WHERE id=?", id).toArray()[0];
      if (existing) return existing.agent === agent;
      if (!this.canWatch(limit, agent)) return false;
      this.sql.exec("INSERT INTO event_watchers VALUES (?,?)", id, agent);
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
