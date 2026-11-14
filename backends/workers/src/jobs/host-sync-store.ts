// TEMPORARY(job-surface): deleted with the Volume DO after claude/delete-job-surface lands
// A job's host-side sync record (hosts.ts HostJob): its token, hashed, until when, and its manifest, one row per file
// in the job object's own SQLite. A manifest of 100,000 files is far past one stored value's size, and a fetch reads
// only its own row.
import { createHash, timingSafeEqual } from "node:crypto";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export type SyncEntry = { path: string; size: number; sha256: string; key: string };

export class HostSyncStore {
  private readonly sql: SqlStorage;
  constructor(sql: SqlStorage) {
    this.sql = sql;
    sql.exec("CREATE TABLE IF NOT EXISTS host_sync (idx INTEGER PRIMARY KEY, path TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, key TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS host_sync_meta (id INTEGER PRIMARY KEY, hash TEXT NOT NULL, expires_at INTEGER NOT NULL)");
  }
  /** A new record (any earlier one replaced): the token's hash, until when, and the files in their manifest order. */
  put(token: string, expiresAt: number, entries: Iterable<SyncEntry>) {
    this.clear();
    this.sql.exec("INSERT INTO host_sync_meta (id, hash, expires_at) VALUES (1, ?, ?)", digest(token), expiresAt);
    let index = 0;
    for (const entry of entries) this.sql.exec("INSERT INTO host_sync (idx, path, size, sha256, key) VALUES (?, ?, ?, ?, ?)", index++, entry.path, entry.size, entry.sha256, entry.key);
    return index;
  }
  /** The file at `index` for a bearer of the token, while it lasts; undefined: refused (401) or no such file (404). */
  file(token: string, index: number, now = Date.now()): { ok: false; status: 401 | 404 } | { ok: true; size: number; key: string } {
    const meta = this.sql.exec<{ hash: string; expires_at: number }>("SELECT hash, expires_at FROM host_sync_meta WHERE id = 1").toArray()[0];
    if (!meta || meta.expires_at <= now || !same(digest(token), meta.hash)) return { ok: false, status: 401 };
    const row = this.sql.exec<{ size: number; key: string }>("SELECT size, key FROM host_sync WHERE idx = ?", index).toArray()[0];
    return row ? { ok: true, size: Number(row.size), key: row.key } : { ok: false, status: 404 };
  }
  clear() {
    this.sql.exec("DELETE FROM host_sync_meta");
    this.sql.exec("DELETE FROM host_sync");
  }
}
