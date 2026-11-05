import { DurableObject } from "cloudflare:workers";
export interface VolumeBindings {
  BUCKET: R2Bucket;
}
export type FileEntry = {
  path: string;
  version: number;
  size: number;
  key: string;
  contentType: string;
  updatedAt: number;
};
export class FileError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(`FILE_${status}:${message}`);
  }
}
export function normalizePath(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > 1024 ||
    /[\x00-\x1f\x7f\\]/.test(value)
  )
    throw new FileError("Invalid file path");
  const parts = value.split("/").filter(Boolean);
  if (
    parts.some(
      (part) =>
        part === "." ||
        part === ".." ||
        new TextEncoder().encode(part).length > 255,
    )
  )
    throw new FileError("Invalid file path");
  return "/" + parts.join("/");
}
export async function digest(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
/** Only the Worker can obtain this tenant-scoped object. SQLite orders tree changes;
 * immutable R2 objects are written first, so a crash can leave an orphan, never a dangling file. */
export class Volume extends DurableObject<VolumeBindings> {
  constructor(ctx: DurableObjectState, env: VolumeBindings) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS files(path TEXT PRIMARY KEY, version INTEGER NOT NULL, size INTEGER NOT NULL, key TEXT NOT NULL, contentType TEXT NOT NULL, updatedAt INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS changes(seq INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, kind TEXT NOT NULL, version INTEGER, size INTEGER, at INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, name TEXT NOT NULL, seq INTEGER NOT NULL, createdAt INTEGER NOT NULL, entries TEXT NOT NULL)",
    );
  }
  private sql() {
    return this.ctx.storage.sql;
  }
  private alive() {
    if (
      [...this.sql().exec("SELECT value FROM metadata WHERE key='deleted'")]
        .length
    )
      throw new FileError("Volume deleted", 410);
  }
  async initialize(tenant: string, id: string, name: string) {
    this.alive();
    const existing = [
      ...this.sql().exec<{
        value: string;
      }>("SELECT value FROM metadata WHERE key='tenant'"),
    ][0];
    if (existing && existing.value !== tenant)
      throw new FileError("Unknown volume", 404);
    this.ctx.storage.transactionSync(() => {
      for (const [key, value] of Object.entries({
        tenant,
        id,
        name,
        createdAt: String(Date.now()),
      }))
        this.sql().exec(
          "INSERT OR IGNORE INTO metadata VALUES(?,?)",
          key,
          value,
        );
    });
    return this.info();
  }
  info() {
    this.alive();
    const meta = Object.fromEntries(
      [
        ...this.sql().exec<{
          key: string;
          value: string;
        }>("SELECT * FROM metadata"),
      ].map((r) => [r.key, r.value]),
    );
    const totals = this.sql()
      .exec<{
        files: number;
        bytes: number;
      }>("SELECT count(*) files, coalesce(sum(size),0) bytes FROM files")
      .one();
    return {
      id: meta.id,
      name: meta.name,
      createdAt: Number(meta.createdAt),
      seq: this.sequence(),
      ...totals,
    };
  }
  private sequence() {
    return this.sql()
      .exec<{
        seq: number;
      }>("SELECT coalesce(max(seq),0) seq FROM changes")
      .one().seq;
  }
  stat(path: string, snapshot?: string): FileEntry {
    this.alive();
    path = normalizePath(path);
    const file = snapshot
      ? this.snapshotEntries(snapshot).find((file) => file.path === path)
      : [
          ...this.sql().exec<FileEntry>(
            "SELECT * FROM files WHERE path=?",
            path,
          ),
        ][0];
    if (!file) throw new FileError("File not found", 404);
    return file;
  }
  list(prefix = "/", snapshot?: string) {
    this.alive();
    prefix = normalizePath(prefix);
    const all = snapshot
      ? this.snapshotEntries(snapshot)
      : [
          ...this.sql().exec<FileEntry>(
            "SELECT * FROM files ORDER BY path LIMIT 10001",
          ),
        ];
    if (all.length > 10000)
      throw new FileError(
        "Listing exceeds 10000 files; partition the volume",
        413,
      );
    return all.filter(
      (f) =>
        prefix === "/" || f.path === prefix || f.path.startsWith(prefix + "/"),
    );
  }
  readSet(prefix = "/", snapshot?: string) {
    const files = this.list(prefix, snapshot);
    const seq = snapshot
      ? this.sql()
          .exec<{
            seq: number;
          }>("SELECT seq FROM snapshots WHERE id=?", snapshot)
          .one().seq
      : this.sequence();
    return { files, seq };
  }
  async read(path: string, snapshot?: string) {
    const file = this.stat(path, snapshot),
      object = await this.env.BUCKET.get(file.key);
    if (!object) throw new FileError("File object missing", 503);
    const bytes = new Uint8Array(await object.arrayBuffer());
    if ((await digest(bytes)) !== file.key.split("/").at(-1))
      throw new FileError("File integrity check failed", 503);
    return { file, bytes };
  }
  async write(
    path: string,
    bytes: Uint8Array,
    contentType = "application/octet-stream",
    expectedVersion?: number,
  ) {
    this.alive();
    path = normalizePath(path);
    if (path === "/") throw new FileError("A file needs a name");
    if (bytes.byteLength > 32 * 1024 * 1024)
      throw new FileError("File exceeds 32 MiB", 413);
    const tenant = this.sql()
      .exec<{
        value: string;
      }>("SELECT value FROM metadata WHERE key='tenant'")
      .one().value;
    const key = `files/${encodeURIComponent(tenant)}/${await digest(bytes)}`;
    await this.env.BUCKET.put(key, bytes, { httpMetadata: { contentType } });
    return this.ctx.storage.transactionSync(() => {
      this.alive();
      const previous = [
        ...this.sql().exec<FileEntry>("SELECT * FROM files WHERE path=?", path),
      ][0];
      if (
        expectedVersion !== undefined &&
        expectedVersion !== (previous?.version ?? 0)
      )
        throw new FileError("File version changed", 412);
      const version = this.sequence() + 1,
        updatedAt = Date.now();
      this.sql().exec(
        "INSERT OR REPLACE INTO files VALUES(?,?,?,?,?,?)",
        path,
        version,
        bytes.byteLength,
        key,
        contentType,
        updatedAt,
      );
      this.sql().exec(
        "INSERT INTO changes(seq,path,kind,version,size,at) VALUES(?,?,?,?,?,?)",
        version,
        path,
        "write",
        version,
        bytes.byteLength,
        updatedAt,
      );
      return {
        path,
        version,
        size: bytes.byteLength,
        key,
        contentType,
        updatedAt,
      };
    });
  }
  remove(path: string, expectedVersion?: number) {
    return this.ctx.storage.transactionSync(() => {
      const previous = this.stat(path);
      if (expectedVersion !== undefined && expectedVersion !== previous.version)
        throw new FileError("File version changed", 412);
      this.sql().exec("DELETE FROM files WHERE path=?", previous.path);
      this.sql().exec(
        "INSERT INTO changes(path,kind,at) VALUES(?,?,?)",
        previous.path,
        "delete",
        Date.now(),
      );
      return { path: previous.path, deleted: true, seq: this.sequence() };
    });
  }
  changes(since = 0) {
    this.alive();
    return {
      changes: [
        ...this.sql().exec(
          "SELECT * FROM changes WHERE seq>? ORDER BY seq LIMIT 1000",
          since,
        ),
      ],
      seq: this.sequence(),
    };
  }
  snapshot(name = "") {
    this.alive();
    return this.ctx.storage.transactionSync(() => {
      if (typeof name !== "string" || name.length > 256)
        throw new FileError("Invalid snapshot name");
      if (
        this.sql()
          .exec<{ count: number }>("SELECT count(*) AS count FROM snapshots")
          .one().count >= 100
      )
        throw new FileError("At most 100 snapshots per volume", 413);
      const id = "snap_" + crypto.randomUUID().replaceAll("-", ""),
        entries = this.list(),
        seq = this.sequence(),
        createdAt = Date.now();
      const serialized = JSON.stringify(entries);
      if (new TextEncoder().encode(serialized).length > 1024 * 1024)
        throw new FileError("Snapshot metadata exceeds 1 MiB", 413);
      this.sql().exec(
        "INSERT INTO snapshots VALUES(?,?,?,?,?)",
        id,
        name,
        seq,
        createdAt,
        serialized,
      );
      return {
        id,
        name,
        seq,
        createdAt,
        files: entries.length,
        bytes: entries.reduce((n, f) => n + f.size, 0),
      };
    });
  }
  snapshots() {
    this.alive();
    return [
      ...this.sql().exec(
        "SELECT id,name,seq,createdAt,json_array_length(entries) AS files FROM snapshots ORDER BY createdAt LIMIT 100",
      ),
    ];
  }
  private snapshotEntries(id: string): FileEntry[] {
    const row = [
      ...this.sql().exec<{
        entries: string;
      }>("SELECT entries FROM snapshots WHERE id=?", id),
    ][0];
    if (!row) throw new FileError("Snapshot not found", 404);
    return JSON.parse(row.entries);
  }
  restore(id: string) {
    this.alive();
    return this.ctx.storage.transactionSync(() => {
      const entries = this.snapshotEntries(id);
      this.sql().exec("DELETE FROM files");
      for (const f of entries) {
        const version = this.sequence() + 1;
        this.sql().exec(
          "INSERT INTO files VALUES(?,?,?,?,?,?)",
          f.path,
          version,
          f.size,
          f.key,
          f.contentType,
          Date.now(),
        );
        this.sql().exec(
          "INSERT INTO changes(seq,path,kind,version,size,at) VALUES(?,?,?,?,?,?)",
          version,
          f.path,
          "write",
          version,
          f.size,
          Date.now(),
        );
      }
      this.sql().exec(
        "INSERT INTO changes(path,kind,at) VALUES(?,?,?)",
        "/",
        "restore",
        Date.now(),
      );
      return { restored: true, seq: this.sequence() };
    });
  }
  delete() {
    this.sql().exec(
      "INSERT OR REPLACE INTO metadata VALUES('deleted',?)",
      String(Date.now()),
    );
    return { deleted: true };
  }
}
