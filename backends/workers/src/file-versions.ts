/** The source file tools remember at most 10,000 recently read/written files.
 * Keep that history in SQLite so evicting an idle agent cannot erase its CAS guard. */
export interface FileVersions {
  get(key: string): string | undefined;
  remember(key: string, version: string): void;
}

export class DurableFileVersions implements FileVersions {
  constructor(private readonly storage: DurableObjectStorage) {
    storage.sql.exec("CREATE TABLE IF NOT EXISTS file_seen_blobs(key TEXT PRIMARY KEY,version TEXT NOT NULL,touched INTEGER NOT NULL)");
    storage.sql.exec("CREATE INDEX IF NOT EXISTS file_seen_blobs_touched ON file_seen_blobs(touched)");
  }

  get(key: string) {
    return [...this.storage.sql.exec<{ version: string }>("SELECT version FROM file_seen_blobs WHERE key=?", key)][0]?.version;
  }

  remember(key: string, version: string) {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "INSERT INTO file_seen_blobs(key,version,touched) VALUES(?,?,(SELECT coalesce(max(touched),0)+1 FROM file_seen_blobs)) ON CONFLICT(key) DO UPDATE SET version=excluded.version,touched=excluded.touched",
        key, version,
      );
      this.storage.sql.exec("DELETE FROM file_seen_blobs WHERE key IN (SELECT key FROM file_seen_blobs ORDER BY touched DESC LIMIT -1 OFFSET 10000)");
    });
  }
}
