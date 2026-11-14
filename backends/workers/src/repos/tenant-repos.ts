import { RepoError, check, page } from './repo-policy.ts';
export type RepoRow = {
  id: string;
  name: string;
  key: string | null;
  lineage: string;
  createdAt: number;
  deletedAt: number | null;
  bytes: number;
  files: number;
};
export class TenantRepos {
  private readonly storage: DurableObjectStorage;
  constructor(storage: DurableObjectStorage) { this.storage = storage; this.initialize(); }
  initialize() { this.storage.sql.exec('CREATE TABLE IF NOT EXISTS repos(id TEXT PRIMARY KEY, name TEXT NOT NULL, key TEXT UNIQUE, lineage TEXT NOT NULL, createdAt INTEGER NOT NULL, deletedAt INTEGER, bytes INTEGER NOT NULL DEFAULT 0, files INTEGER NOT NULL DEFAULT 0)'); }
  row(id: string) { return this.storage.sql.exec<RepoRow>('SELECT * FROM repos WHERE id=?', id).toArray()[0] ?? null; }
  register(row: RepoRow, sourceId?: string) {
    return this.storage.transactionSync(() => {
      const old = this.row(row.id);
      if (old)
        return { row: old, existing: true };
      // A fork whose source was deleted during its tier reads must not revive the lineage.
      if (sourceId !== undefined) {
        const source = this.row(sourceId);
        if (!source || source.deletedAt !== null || source.lineage !== row.lineage)
          throw new RepoError('no_repo', 404, 'no_repo');
      }
      this.storage.sql.exec('INSERT INTO repos VALUES(?,?,?,?,?,?,?,?)', row.id, row.name, row.key, row.lineage, row.createdAt, row.deletedAt, row.bytes, row.files);
      return { row, existing: false };
    });
  }
  list(input: {
    after?: string;
    limit?: number;
  } = {}) {
    const limit = page(input.limit, 100, 1000);
    const cursor = input.after ? this.row(input.after) : null;
    check(!input.after || cursor, 'bad_cursor');
    const rows = this.storage.sql.exec<RepoRow>('SELECT * FROM repos WHERE deletedAt IS NULL AND (createdAt>? OR (createdAt=? AND id>?)) ORDER BY createdAt,id LIMIT ?', cursor?.createdAt ?? -1, cursor?.createdAt ?? -1, cursor?.id ?? '', limit + 1).toArray();
    return { repos: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1].id : null };
  }
  deleted(id: string) {
    this.storage.sql.exec('UPDATE repos SET deletedAt=COALESCE(deletedAt,?) WHERE id=?', Date.now(), id);
  }
  markTierRepoDeleted(id: string) {
    return this.storage.transactionSync(() => {
      const row = this.row(id);
      if (!row) throw new RepoError('no_repo', 404, 'no_repo');
      this.deleted(id);
      return this.storage.sql.exec(
        'SELECT 1 FROM repos WHERE lineage=? AND deletedAt IS NULL LIMIT 1', row.lineage,
      ).toArray().length === 0;
    });
  }
  usage(id: string, bytes: number, files: number, lineage = false) { check(Number.isSafeInteger(bytes) && bytes >= 0 && Number.isSafeInteger(files) && files >= 0); this.storage.sql.exec('UPDATE repos SET bytes=?,files=? WHERE ' + (lineage ? 'lineage=(SELECT lineage FROM repos WHERE id=?)' : 'id=?'), bytes, files, id); }
  used(exclude = "") {
    return this.storage.sql.exec<{
      bytes: number;
    }>('SELECT COALESCE(SUM(bytes),0) bytes FROM (SELECT MAX(bytes) bytes FROM repos WHERE deletedAt IS NULL AND lineage<>? GROUP BY lineage)', exclude).one().bytes;
  }
}
