/** The source runtime's bounded display buffer, separate from a run's retained stream. */
export class RecentEvents {
  constructor(private readonly sql: SqlStorage) {
    sql.exec("CREATE TABLE IF NOT EXISTS camel_recent_events (id INTEGER PRIMARY KEY, data TEXT NOT NULL, bytes INTEGER NOT NULL, at INTEGER NOT NULL)");
  }
  append(id: number, event: unknown) {
    let data = JSON.stringify(event), bytes = new TextEncoder().encode(data).length;
    if (bytes > 2 * 1024 * 1024) {
      const original = event as { requestId?: string; type?: string; event?: { type?: string } };
      data = JSON.stringify({ type: "event", requestId: original.requestId ?? "", event: { type: "event_omitted", reason: "Event exceeded transport limit", was: original.event?.type ?? original.type } });
      bytes = new TextEncoder().encode(data).length;
    }
    this.sql.exec("INSERT INTO camel_recent_events VALUES (?,?,?,?)", id, data, bytes, Date.now());
    this.sql.exec("DELETE FROM camel_recent_events WHERE id NOT IN (SELECT id FROM camel_recent_events ORDER BY id DESC LIMIT 512)");
    let size = this.sql.exec<{ n: number }>("SELECT COALESCE(SUM(bytes),0) n FROM camel_recent_events").one().n;
    for (const row of this.sql.exec<{ id: number; bytes: number }>("SELECT id,bytes FROM camel_recent_events ORDER BY id").toArray()) {
      if (size <= 2 * 1024 * 1024) break;
      this.sql.exec("DELETE FROM camel_recent_events WHERE id=?", row.id);
      size -= row.bytes;
    }
  }
  read() {
    return this.sql.exec<{ id: number; data: string }>("SELECT id,data FROM camel_recent_events ORDER BY id").toArray().map(row => ({ id: row.id, data: JSON.parse(row.data) }));
  }
  lastActivity() {
    return this.sql.exec<{ at: number }>("SELECT at FROM camel_recent_events ORDER BY id DESC LIMIT 1").toArray()[0]?.at;
  }
}
