/** The source file tools remember at most 10,000 recently read/written files.
 * Keep that history in SQLite so evicting an idle agent cannot erase its CAS guard. */
export interface FileVersions {
  get(key: string): number | undefined;
  remember(key: string, version: number): void;
}

export class DurableFileVersions implements FileVersions {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec("CREATE TABLE IF NOT EXISTS file_seen(key TEXT PRIMARY KEY,version INTEGER NOT NULL,touched INTEGER NOT NULL)");
    storage.sql.exec("CREATE INDEX IF NOT EXISTS file_seen_touched ON file_seen(touched)");
  }

  get(key: string) {
    return [...this.storage.sql.exec<{ version: number }>("SELECT version FROM file_seen WHERE key=?", key)][0]?.version;
  }

  remember(key: string, version: number) {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "INSERT INTO file_seen(key,version,touched) VALUES(?,?,(SELECT coalesce(max(touched),0)+1 FROM file_seen)) ON CONFLICT(key) DO UPDATE SET version=excluded.version,touched=excluded.touched",
        key, version,
      );
      this.storage.sql.exec("DELETE FROM file_seen WHERE key IN (SELECT key FROM file_seen ORDER BY touched DESC LIMIT -1 OFFSET 10000)");
    });
  }
}
