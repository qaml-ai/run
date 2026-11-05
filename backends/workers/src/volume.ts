import { DurableObject } from "cloudflare:workers";
import { HttpError } from "./errors.ts";
import {
  normalizePath as sourceNormalizePath,
  labelsInput as sourceLabelsInput,
  VOLUME_LIMITS,
  globRegex as sourceGlobRegex,
} from "./volume-policy.ts";
const policy = <T>(run: () => T): T => {
  try {
    return run();
  } catch (error) {
    if (error instanceof HttpError)
      throw new FileError(error.message, error.status);
    throw error;
  }
};
export const normalizePath = (value: unknown) =>
  policy(() => sourceNormalizePath(value));
const labelsInput = (value: unknown) => policy(() => sourceLabelsInput(value));
const globRegex = (value: string) => policy(() => sourceGlobRegex(value));
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
  sha256?: string;
};
export type VolumeInfo = {
  id: string;
  name: string;
  createdAt: number;
  seq: number;
  files: number;
  bytes: number;
  origin?: { volume: string; snapshot?: string; seq: number };
};
type Snapshot = {
  id: string;
  volume: string;
  name: string;
  seq: number;
  createdAt: number;
  files: number;
  bytes: number;
  pinned: boolean;
  labels: Record<string, string>;
};
export class FileError extends HttpError {
  constructor(message: string, status = 400) {
    super(status, `FILE_${status}:${message}`);
  }
}
export async function digest(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
const DAY = 86400_000;
/** One volume orders metadata in SQLite. Unique immutable R2 keys mean collection
 * never races a later upload of the same bytes, and never sweeps another volume. */
export class Volume extends DurableObject<VolumeBindings> {
  private copies = new Map<string, Promise<VolumeInfo>>();
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
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS snapshot_options(id TEXT PRIMARY KEY, pinned INTEGER NOT NULL DEFAULT 0, labels TEXT NOT NULL DEFAULT '{}')",
    );
    const columns = [
      ...ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(files)"),
    ];
    if (!columns.some((c) => c.name === "sha256"))
      ctx.storage.sql.exec("ALTER TABLE files ADD COLUMN sha256 TEXT");
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS objects(key TEXT PRIMARY KEY, createdAt INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS gc_candidates(key TEXT PRIMARY KEY, firstSeen INTEGER NOT NULL)",
    );
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS pins(owner TEXT NOT NULL,key TEXT NOT NULL,expiresAt INTEGER,PRIMARY KEY(owner,key))",
    );
  }
  private sql() {
    return this.ctx.storage.sql;
  }
  private meta(key: string) {
    return [
      ...this.sql().exec<{ value: string }>(
        "SELECT value FROM metadata WHERE key=?",
        key,
      ),
    ][0]?.value;
  }
  private alive() {
    if (this.meta("deleted")) throw new FileError("Volume deleted", 410);
  }
  async initialize(
    tenant: string,
    id: string,
    name: string,
    createdAt = Date.now(),
    origin?: { volume: string; snapshot?: string; seq: number },
  ): Promise<VolumeInfo> {
    this.alive();
    if (this.meta("tenant") && this.meta("tenant") !== tenant)
      throw new FileError("Unknown volume", 404);
    this.ctx.storage.transactionSync(() => {
      for (const [key, value] of Object.entries({
        tenant,
        id,
        name,
        createdAt: String(createdAt),
        ...(origin ? { origin: JSON.stringify(origin) } : {}),
      }))
        this.sql().exec(
          "INSERT OR IGNORE INTO metadata VALUES(?,?)",
          key,
          value,
        );
    });
    return this.info();
  }
  info(): VolumeInfo {
    this.alive();
    const totals = this.sql()
      .exec<{ files: number; bytes: number }>(
        "SELECT count(*) files,coalesce(sum(size),0) bytes FROM files",
      )
      .one();
    return {
      id: this.meta("id")!,
      name: this.meta("name")!,
      createdAt: Number(this.meta("createdAt")),
      seq: this.sequence(),
      ...totals,
      ...(this.meta("origin")
        ? { origin: JSON.parse(this.meta("origin")!) }
        : {}),
    };
  }
  private sequence() {
    return this.sql()
      .exec<{ seq: number }>("SELECT coalesce(max(seq),0) seq FROM changes")
      .one().seq;
  }
  private record(path: string, kind: string, file?: FileEntry) {
    this.sql().exec(
      "INSERT INTO changes(path,kind,version,size,at) VALUES(?,?,?,?,?)",
      path,
      kind,
      file?.version ?? null,
      file?.size ?? null,
      Date.now(),
    );
  }
  stat(path: string, snapshot?: string): FileEntry {
    this.alive();
    path = normalizePath(path);
    const file = snapshot
      ? this.snapshotEntries(snapshot).find((f) => f.path === path)
      : [
          ...this.sql().exec<FileEntry>(
            "SELECT * FROM files WHERE path=?",
            path,
          ),
        ][0];
    if (!file) throw new FileError("File not found", 404);
    return file;
  }
  list(prefix = "/", snapshot?: string, glob?: string) {
    this.alive();
    prefix = normalizePath(prefix);
    const all = snapshot
      ? this.snapshotEntries(snapshot)
      : [
          ...this.sql().exec<FileEntry>(
            "SELECT * FROM files ORDER BY path LIMIT 100001",
          ),
        ];
    if (all.length > VOLUME_LIMITS.files)
      throw new FileError("Volume file limit reached", 507);
    const pattern = glob ? globRegex(glob) : undefined;
    return all
      .filter(
        (f) =>
          (prefix === "/" ||
            f.path === prefix ||
            f.path.startsWith(prefix + "/")) &&
          (!pattern ||
            pattern.test(
              (prefix === "/" ? f.path : f.path.slice(prefix.length)).replace(
                /^\//,
                "",
              ),
            )),
      )
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  readSet(
    prefix = "/",
    snapshot?: string,
    glob?: string,
  ): { files: FileEntry[]; seq: number; snapshot?: string } {
    return {
      files: this.list(prefix, snapshot, glob),
      seq: snapshot ? this.snapshotSummary(snapshot).seq : this.sequence(),
      ...(snapshot ? { snapshot } : {}),
    };
  }
  /** A resumable copy owns one immutable read set until it is released. */
  async claimReadSet(owner: string, expiresAt = Date.now() + DAY): Promise<{ files: FileEntry[]; seq: number }> {
    this.alive();
    if (!/^[A-Za-z0-9:_-]{1,200}$/.test(owner)) throw new FileError("Invalid read-set owner");
    const result = this.ctx.storage.transactionSync(() => {
      const key = `read-set:${owner}`, prior = this.meta(key);
      if (prior === "released") throw new FileError("Read set was released", 409);
      if (prior) return JSON.parse(prior) as { files: FileEntry[]; seq: number };
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + DAY)
        throw new FileError("Invalid read-set expiry");
      const captured = { ...this.readSet(), expiresAt }, serialized = JSON.stringify(captured);
      if (new TextEncoder().encode(serialized).length > 16 * 1024 * 1024)
        throw new FileError("Read-set metadata exceeds 16 MiB", 413);
      this.sql().exec("INSERT INTO metadata VALUES(?,?)", key, serialized);
      for (const file of captured.files)
        this.sql().exec("INSERT OR IGNORE INTO pins VALUES(?,?,?)", key, file.key, expiresAt);
      return captured;
    });
    await this.scheduleCollection();
    return result;
  }
  releaseReadSet(owner: string) {
    if (!/^[A-Za-z0-9:_-]{1,200}$/.test(owner)) throw new FileError("Invalid read-set owner");
    this.ctx.storage.transactionSync(() => {
      const key = `read-set:${owner}`;
      this.sql().exec("DELETE FROM pins WHERE owner=?", key);
      // A concurrent late retry must not capture newer files under this owner.
      this.sql().exec("INSERT OR REPLACE INTO metadata VALUES(?,?)", key, "released");
    });
  }
  /** One resumable copy per owner; completed retries never write files again. */
  copyReadSet(owner: string, entries: FileEntry[], failAfter?: number): Promise<VolumeInfo> {
    const running = this.copies.get(owner);
    if (running) return running;
    const task = this.copyReadSetOnce(owner, entries, failAfter);
    this.copies.set(owner, task);
    void task.finally(() => this.copies.delete(owner)).catch(() => {});
    return task;
  }
  private async copyReadSetOnce(owner: string, entries: FileEntry[], failAfter?: number) {
    this.alive();
    if (!/^[A-Za-z0-9:_-]{1,200}$/.test(owner) || entries.length > VOLUME_LIMITS.files)
      throw new FileError("Invalid copy owner or read set");
    const marker = `copy-read-set:${owner}`, fingerprint = await digest(new TextEncoder().encode(JSON.stringify(entries)));
    const prior = this.meta(marker);
    if (prior) {
      const saved = JSON.parse(prior);
      if (saved.fingerprint !== fingerprint) throw new FileError("Copy read set changed", 409);
      if (saved.complete) return this.info();
    } else this.sql().exec("INSERT INTO metadata VALUES(?,?)", marker, JSON.stringify({ fingerprint }));
    for (const [index, entry] of entries.entries()) {
      const hash = entry.sha256 ?? entry.key.split("/").at(-1)!;
      if (!entry.key.startsWith(`files/${encodeURIComponent(this.meta("tenant")!)}/`) || !/^[a-f0-9]{64}$/.test(hash))
        throw new FileError("Invalid copy source", 403);
      const current = [...this.sql().exec<FileEntry>("SELECT * FROM files WHERE path=?", entry.path)][0];
      if (current && (current.sha256 !== hash || current.size !== entry.size || current.contentType !== entry.contentType))
        throw new FileError("Copy destination changed", 409);
      if (!current) {
        const object = await this.env.BUCKET.get(entry.key);
        if (!object) throw new FileError("Copy source object missing", 503);
        const key = await this.beginUpload();
        await this.env.BUCKET.put(key, object.body, { httpMetadata: { contentType: entry.contentType } });
        this.commitUpload(entry.path, key, entry.size, hash, entry.contentType, 0);
      }
      if (failAfter === index + 1) throw new FileError("Injected fork interruption after a file", 503);
    }
    this.sql().exec("INSERT OR REPLACE INTO metadata VALUES(?,?)", marker, JSON.stringify({ fingerprint, complete: true }));
    return this.info();
  }
  async read(path: string, snapshot?: string, maxBytes?: number) {
    const file = this.stat(path, snapshot);
    if (maxBytes !== undefined && file.size > maxBytes)
      throw new FileError("Tool file exceeds byte limit", 413);
    const object = await this.env.BUCKET.get(file.key);
    if (!object) throw new FileError("File object missing", 503);
    const bytes = new Uint8Array(await object.arrayBuffer());
    if ((await digest(bytes)) !== (file.sha256 ?? file.key.split("/").at(-1)))
      throw new FileError("File integrity check failed", 503);
    return { file, bytes };
  }
  private conflict(path: string) {
    const files = this.list();
    if (files.some((f) => f.path.startsWith(path + "/")))
      throw new FileError(`${path} is a directory`, 409);
    if (files.some((f) => path.startsWith(f.path + "/")))
      throw new FileError("A parent path is a file", 409);
  }
  private freshKey(hash: string) {
    return `files/${encodeURIComponent(this.meta("tenant")!)}/${encodeURIComponent(this.meta("id")!)}/${crypto.randomUUID()}/${hash}`;
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
      throw new FileError("Buffered file exceeds 32 MiB", 413);
    const stored = await this.storeDetached(bytes, contentType);
    const key = stored.key;
    return this.ctx.storage.transactionSync(() => {
      this.alive();
      this.conflict(path);
      const previous = [
        ...this.sql().exec<FileEntry>("SELECT * FROM files WHERE path=?", path),
      ][0];
      if (
        expectedVersion !== undefined &&
        expectedVersion !== (previous?.version ?? 0)
      )
        throw new FileError("File version changed", 412);
      if (!previous && this.info().files >= VOLUME_LIMITS.files)
        throw new FileError("Volume file limit reached", 507);
      const file = {
        path,
        version: this.sequence() + 1,
        size: bytes.byteLength,
        key,
        contentType,
        updatedAt: Date.now(),
      };
      this.sql().exec(
        "INSERT OR REPLACE INTO files(path,version,size,key,contentType,updatedAt) VALUES(?,?,?,?,?,?)",
        path,
        file.version,
        file.size,
        key,
        contentType,
        file.updatedAt,
      );
      this.record(path, "write", file);
      return file;
    });
  }
  async beginUpload(): Promise<string> {
    this.alive();
    const key = this.freshKey("body");
    this.sql().exec("INSERT INTO objects VALUES(?,?)", key, Date.now());
    await this.scheduleCollection();
    return key;
  }
  commitUpload(
    path: string,
    key: string,
    size: number,
    sha256: string,
    contentType: string,
    expectedVersion?: number,
  ): FileEntry {
    return this.ctx.storage.transactionSync(() => {
      this.alive();
      path = normalizePath(path);
      if (path === "/") throw new FileError("A file needs a name");
      this.conflict(path);
      if (
        ![...this.sql().exec("SELECT key FROM objects WHERE key=?", key)].length
      )
        throw new FileError("Unknown upload", 400);
      if (size > VOLUME_LIMITS.fileBytes)
        throw new FileError("File exceeds byte limit", 413);
      const previous = [
        ...this.sql().exec<FileEntry>("SELECT * FROM files WHERE path=?", path),
      ][0];
      if (
        expectedVersion !== undefined &&
        expectedVersion !== (previous?.version ?? 0)
      )
        throw new FileError("File version changed", 412);
      if (!previous && this.info().files >= VOLUME_LIMITS.files)
        throw new FileError("Volume file limit reached", 507);
      const file = {
        path,
        key,
        size,
        sha256,
        contentType,
        version: this.sequence() + 1,
        updatedAt: Date.now(),
      };
      this.sql().exec(
        "INSERT OR REPLACE INTO files(path,version,size,key,contentType,updatedAt,sha256) VALUES(?,?,?,?,?,?,?)",
        path,
        file.version,
        size,
        key,
        contentType,
        file.updatedAt,
        sha256,
      );
      this.record(path, "write", file);
      return file;
    });
  }
  async storeDetached(
    bytes: Uint8Array,
    contentType = "application/octet-stream",
  ) {
    this.alive();
    if (bytes.byteLength > 32 * 1024 * 1024)
      throw new FileError("Buffered file exceeds 32 MiB", 413);
    const key = this.freshKey(await digest(bytes));
    this.sql().exec("INSERT INTO objects VALUES(?,?)", key, Date.now());
    await this.env.BUCKET.put(key, bytes, { httpMetadata: { contentType } });
    await this.scheduleCollection();
    return {
      path: "/",
      version: 0,
      size: bytes.byteLength,
      key,
      contentType,
      updatedAt: Date.now(),
    };
  }
  remove(path: string, expectedVersion?: number) {
    return this.ctx.storage.transactionSync(() => {
      const previous = this.stat(path);
      if (expectedVersion !== undefined && expectedVersion !== previous.version)
        throw new FileError("File version changed", 412);
      this.sql().exec("DELETE FROM files WHERE path=?", previous.path);
      this.record(previous.path, "delete");
      return { path: previous.path, deleted: true, seq: this.sequence() };
    });
  }
  changes(since = 0, prefix = "/") {
    this.alive();
    prefix = normalizePath(prefix);
    if (!Number.isSafeInteger(since) || since < 0)
      throw new FileError("Invalid change cursor");
    const seq = this.sequence(),
      oldest = Math.max(1, seq - VOLUME_LIMITS.changes + 1);
    return {
      changes: [
        ...this.sql().exec<{ path: string }>(
          "SELECT * FROM changes WHERE seq>? AND seq>=? ORDER BY seq LIMIT 1000",
          since,
          oldest,
        ),
      ].filter(
        (f) =>
          prefix === "/" ||
          f.path === prefix ||
          f.path.startsWith(prefix + "/"),
      ),
      seq,
      ...(since < oldest - 1 ? { gap: true } : {}),
    };
  }
  snapshot(
    name?: string,
    options: {
      pinned?: boolean;
      labels?: Record<string, string>;
      given?: FileEntry[];
    } = {},
  ) {
    this.alive();
    return this.ctx.storage.transactionSync(() => {
      name = name === undefined ? `seq ${this.sequence()}` : name;
      if (typeof name !== "string" || !name.trim() || name.length > 120)
        throw new FileError("name must be 1–120 characters");
      if (options.pinned !== undefined && typeof options.pinned !== "boolean")
        throw new FileError("pinned is true or false");
      const pinned = options.pinned ?? false,
        labels =
          options.labels === undefined ? {} : labelsInput(options.labels),
        cap = pinned ? VOLUME_LIMITS.pinnedSnapshots : VOLUME_LIMITS.snapshots;
      if (this.snapshots().filter((s) => s.pinned === pinned).length >= cap)
        throw new FileError(
          `A volume keeps at most ${cap} ${pinned ? "pinned " : ""}snapshots`,
          409,
        );
      const id = "snap_" + crypto.randomUUID().replaceAll("-", "").slice(0, 16),
        entries = options.given ?? this.list();
      const seq = this.sequence(),
        createdAt = Date.now(),
        serialized = JSON.stringify(entries);
      if (new TextEncoder().encode(serialized).length > 16 * 1024 * 1024)
        throw new FileError("Snapshot metadata exceeds 16 MiB", 413);
      this.sql().exec(
        "INSERT INTO snapshots VALUES(?,?,?,?,?)",
        id,
        name.trim(),
        seq,
        createdAt,
        serialized,
      );
      this.sql().exec(
        "INSERT INTO snapshot_options VALUES(?,?,?)",
        id,
        pinned ? 1 : 0,
        JSON.stringify(labels),
      );
      return this.snapshotSummary(id);
    });
  }
  private snapshotSummary(id: string): Snapshot {
    const row = [
      ...this.sql().exec<{
        id: string;
        name: string;
        seq: number;
        createdAt: number;
        entries: string;
        pinned: number;
        labels: string;
      }>(
        "SELECT s.*,coalesce(o.pinned,0) pinned,coalesce(o.labels,'{}') labels FROM snapshots s LEFT JOIN snapshot_options o ON s.id=o.id WHERE s.id=?",
        id,
      ),
    ][0];
    if (!row) throw new FileError("Snapshot not found", 404);
    const entries = JSON.parse(row.entries) as FileEntry[];
    return {
      id: row.id,
      volume: this.meta("id")!,
      name: row.name,
      seq: row.seq,
      createdAt: row.createdAt,
      files: entries.length,
      bytes: entries.reduce((n, f) => n + f.size, 0),
      pinned: !!row.pinned,
      labels: JSON.parse(row.labels),
    };
  }
  snapshots(labels?: Record<string, string>) {
    this.alive();
    if (labels) labels = labelsInput(labels);
    return [
      ...this.sql().exec<{ id: string }>(
        "SELECT id FROM snapshots ORDER BY createdAt,id",
      ),
    ]
      .map((s) => this.snapshotSummary(s.id))
      .filter(
        (s) =>
          !labels ||
          Object.entries(labels).every(
            ([key, value]) => s.labels[key] === value,
          ),
      );
  }
  updateSnapshot(
    id: string,
    options: { pinned?: boolean; labels?: Record<string, string> },
  ) {
    this.alive();
    const current = this.snapshotSummary(id);
    if (options.pinned !== undefined && typeof options.pinned !== "boolean")
      throw new FileError("pinned is true or false");
    if (options.pinned === undefined && options.labels === undefined)
      throw new FileError("Give pinned or labels");
    if (
      options.pinned === true &&
      !current.pinned &&
      this.snapshots().filter((s) => s.pinned).length >=
        VOLUME_LIMITS.pinnedSnapshots
    )
      throw new FileError("Pinned snapshot limit reached", 409);
    this.sql().exec(
      "INSERT OR REPLACE INTO snapshot_options VALUES(?,?,?)",
      id,
      (options.pinned ?? current.pinned) ? 1 : 0,
      JSON.stringify(
        options.labels === undefined
          ? current.labels
          : labelsInput(options.labels),
      ),
    );
    return this.snapshotSummary(id);
  }
  deleteSnapshot(id: string, force = false) {
    this.alive();
    if (this.snapshotSummary(id).pinned && !force)
      throw new FileError(
        "The snapshot is pinned: unpin it first, or delete it with force",
        409,
      );
    this.sql().exec("DELETE FROM snapshots WHERE id=?", id);
    this.sql().exec("DELETE FROM snapshot_options WHERE id=?", id);
    return { deleted: true };
  }
  private snapshotEntries(id: string): FileEntry[] {
    const row = [
      ...this.sql().exec<{ entries: string }>(
        "SELECT entries FROM snapshots WHERE id=?",
        id,
      ),
    ][0];
    if (!row) throw new FileError("Snapshot not found", 404);
    return JSON.parse(row.entries);
  }
  restore(id: string) {
    this.alive();
    return this.ctx.storage.transactionSync(() => {
      const entries = this.snapshotEntries(id),
        current = this.list();
      let removed = 0,
        written = 0;
      for (const file of current)
        if (!entries.some((e) => e.path === file.path)) {
          this.sql().exec("DELETE FROM files WHERE path=?", file.path);
          this.record(file.path, "delete");
          removed++;
        }
      for (const f of entries) {
        const prior = current.find((e) => e.path === f.path);
        if (prior?.key === f.key && prior.contentType === f.contentType)
          continue;
        const file = {
          ...f,
          version: this.sequence() + 1,
          updatedAt: Date.now(),
        };
        this.sql().exec(
          "INSERT OR REPLACE INTO files(path,version,size,key,contentType,updatedAt,sha256) VALUES(?,?,?,?,?,?,?)",
          file.path,
          file.version,
          file.size,
          file.key,
          file.contentType,
          file.updatedAt,
          file.sha256 ?? null,
        );
        this.record(file.path, "write", file);
        written++;
      }
      return { snapshot: id, seq: this.sequence(), written, removed };
    });
  }
  /** Copy immutable bytes into this volume's ownership before the source pin expires. */
  async seed(
    entries: FileEntry[],
    origin: { volume: string; snapshot?: string; seq: number },
  ): Promise<VolumeInfo> {
    this.alive();
    if (this.info().files)
      throw new FileError("Destination volume is not empty", 409);
    for (const entry of entries) {
      if (
        !entry.key.startsWith(
          `files/${encodeURIComponent(this.meta("tenant")!)}/`,
        )
      )
        throw new FileError("Invalid source", 403);
      const object = await this.env.BUCKET.get(entry.key);
      if (!object) throw new FileError("Source object missing", 503);
      const key = this.freshKey(entry.key.split("/").at(-1)!);
      this.sql().exec("INSERT INTO objects VALUES(?,?)", key, Date.now());
      await this.env.BUCKET.put(key, object.body, {
        httpMetadata: { contentType: entry.contentType },
      });
      this.sql().exec(
        "INSERT INTO files(path,version,size,key,contentType,updatedAt,sha256) VALUES(?,?,?,?,?,?,?)",
        entry.path,
        entry.version,
        entry.size,
        key,
        entry.contentType,
        entry.updatedAt,
        entry.sha256 ?? null,
      );
      this.sql().exec(
        "INSERT OR IGNORE INTO changes(seq,path,kind,version,size,at) VALUES(?,?,?,?,?,?)",
        entry.version,
        entry.path,
        "write",
        entry.version,
        entry.size,
        entry.updatedAt,
      );
    }
    this.sql().exec(
      "INSERT OR REPLACE INTO metadata VALUES('origin',?)",
      JSON.stringify(origin),
    );
    await this.scheduleCollection();
    return this.info();
  }
  async pin(owner: string, keys: string[], expiresAt?: number) {
    if (!owner || keys.length > VOLUME_LIMITS.files)
      throw new FileError("Invalid pin");
    this.ctx.storage.transactionSync(() => {
      for (const key of new Set(keys))
        this.sql().exec(
          "INSERT OR REPLACE INTO pins VALUES(?,?,?)",
          owner,
          key,
          expiresAt ?? null,
        );
    });
    await this.scheduleCollection();
  }
  unpin(owner: string) {
    this.sql().exec("DELETE FROM pins WHERE owner=?", owner);
  }
  private async scheduleCollection() {
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + DAY);
  }
  async collectGarbage(now = Date.now(), grace = DAY) {
    this.sql().exec("UPDATE metadata SET value='released' WHERE key LIKE 'read-set:%' AND json_valid(value) AND json_extract(value,'$.expiresAt')<=?", now);
    this.sql().exec(
      "DELETE FROM pins WHERE expiresAt IS NOT NULL AND expiresAt<=?",
      now,
    );
    const held = new Set(
      [...this.sql().exec<{ key: string }>("SELECT key FROM files")].map(
        (f) => f.key,
      ),
    );
    for (const row of this.sql().exec<{ entries: string }>(
      "SELECT entries FROM snapshots",
    ))
      for (const f of JSON.parse(row.entries) as FileEntry[]) held.add(f.key);
    for (const row of this.sql().exec<{ key: string }>("SELECT key FROM pins"))
      held.add(row.key);
    const candidates = [
      ...this.sql().exec<{ key: string; firstSeen: number }>(
        "SELECT * FROM gc_candidates",
      ),
    ];
    for (const candidate of candidates)
      if (held.has(candidate.key))
        this.sql().exec("DELETE FROM gc_candidates WHERE key=?", candidate.key);
    const stale = candidates.filter(
      (c) => !held.has(c.key) && c.firstSeen <= now - grace,
    );
    for (const row of stale) {
      await this.env.BUCKET.delete(row.key);
      this.sql().exec("DELETE FROM objects WHERE key=?", row.key);
      this.sql().exec("DELETE FROM gc_candidates WHERE key=?", row.key);
    }
    for (const row of this.sql().exec<{ key: string }>(
      "SELECT key FROM objects",
    ))
      if (!held.has(row.key))
        this.sql().exec(
          "INSERT OR IGNORE INTO gc_candidates VALUES(?,?)",
          row.key,
          now,
        );
    return {
      removed: stale.length,
      held: held.size,
      candidates: this.sql()
        .exec<{ n: number }>("SELECT count(*) n FROM gc_candidates")
        .one().n,
    };
  }
  async alarm() {
    await this.collectGarbage();
    if (
      this.sql().exec<{ n: number }>("SELECT count(*) n FROM objects").one().n
    )
      await this.ctx.storage.setAlarm(Date.now() + DAY);
  }
  async delete() {
    this.ctx.storage.transactionSync(() => {
      this.sql().exec(
        "INSERT OR REPLACE INTO metadata VALUES('deleted',?)",
        String(Date.now()),
      );
      this.sql().exec("DELETE FROM files");
      this.sql().exec("DELETE FROM snapshots");
      this.sql().exec("DELETE FROM snapshot_options");
    });
    await this.scheduleCollection();
    return { deleted: true };
  }
}
