import { guardAlarms } from "./alarm-guard.ts";
import { DurableObject } from "cloudflare:workers";
import { HttpError } from "./errors.ts";
import { deleteNativeFile, recordNativeFile, type NativeStorageBindings } from "./tenant-storage.ts";
import {
  normalizePath as sourceNormalizePath,
  labelsInput as sourceLabelsInput,
  VOLUME_LIMITS,
  COMMIT_LIMITS,
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
export interface VolumeBindings extends NativeStorageBindings {
  BUCKET: R2Bucket;
  VOLUMES: DurableObjectNamespace<Volume>;
  TEST_MODE?: string;
}
/** One file of an atomic commit: `key` names content this volume owns (an upload or a reused blob); none removes the path. */
export type CommitFile = {
  path: string;
  version: number;
  key?: string;
  size?: number;
  sha256?: string;
  contentType?: string;
};
export type CommitConflict = { path: string; headVersion: number };
export type CommitResult =
  | { conflicts: CommitConflict[] }
  | { seq: number; files: FileEntry[]; removed: string[]; snapshot?: Snapshot };
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
export type Snapshot = {
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
    guardAlarms(this, ctx, "Volume", { test: (env as { TEST_MODE?: unknown }).TEST_MODE === "1" });
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS camelfs_trees(snapshot TEXT PRIMARY KEY, lineage TEXT NOT NULL, tree TEXT NOT NULL, createdAt INTEGER NOT NULL)");
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
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS temporary_snapshots(id TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL)");
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
    // A pin on content another volume owns is kept there; this records where, so unpin finds it.
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS forwarded_pins(owner TEXT NOT NULL,volume TEXT NOT NULL,expiresAt INTEGER,PRIMARY KEY(owner,volume))",
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
  /** Immutable snapshots keep their imported tree so later jobs send only its reference. */
  camelfsTree(snapshot: string): { tree: string; lineage: string } | null {
    return this.sql().exec<{ tree: string; lineage: string }>("SELECT tree,lineage FROM camelfs_trees WHERE snapshot=?", snapshot).toArray()[0] ?? null;
  }
  setCamelfsTree(snapshot: string, lineage: string, tree: string): void {
    this.sql().exec("INSERT OR REPLACE INTO camelfs_trees VALUES(?,?,?,?)", snapshot, lineage, tree, Date.now());
  }
  latestCamelfsTree(): string | null {
    return this.sql().exec<{ tree: string }>("SELECT tree FROM camelfs_trees ORDER BY createdAt DESC LIMIT 1").toArray()[0]?.tree ?? null;
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
        await recordNativeFile(this.env, this.meta("tenant")!, key, object.size);
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
        throw new FileError(expectedVersion === 0 ? `${path} already exists (version ${previous?.version ?? 0})` : !previous ? `${path} no longer exists (expected version ${expectedVersion})` : `${path} is at version ${previous.version}, not ${expectedVersion}`, 412);
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
        throw new FileError(expectedVersion === 0 ? `${path} already exists (version ${previous?.version ?? 0})` : !previous ? `${path} no longer exists (expected version ${expectedVersion})` : `${path} is at version ${previous.version}, not ${expectedVersion}`, 412);
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
  /**
   * Write and remove named files as one change: every expected version is checked and every file written in one
   * transaction, or nothing is written and the answer names each path whose head version differs. A `snapshot` is
   * taken in the same transaction, so it holds exactly this commit over what was there.
   */
  commit(
    files: CommitFile[],
    snapshot?: { name?: string; pinned?: boolean; labels?: Record<string, string> },
  ): CommitResult {
    return this.ctx.storage.transactionSync(() => {
      this.alive();
      if (!Array.isArray(files) || !files.length || files.length > COMMIT_LIMITS.files)
        throw new FileError(`A commit names 1 to ${COMMIT_LIMITS.files} files`);
      const named = new Set<string>();
      const batch = files.map((file) => {
        const path = normalizePath(file.path);
        if (path === "/") throw new FileError("A file needs a name");
        if (named.has(path)) throw new FileError(`${path} is named twice`);
        named.add(path);
        if (!Number.isSafeInteger(file.version) || file.version < 0)
          throw new FileError("version must be a non-negative integer (0: the file must not exist)");
        if (file.key === undefined && file.version === 0)
          throw new FileError(`Removing ${path} takes its version`);
        return { ...file, path };
      });
      const head = (path: string) =>
        [...this.sql().exec<FileEntry>("SELECT * FROM files WHERE path=?", path)][0];
      const conflicts = batch.flatMap((file) => {
        const version = head(file.path)?.version ?? 0;
        return version === file.version ? [] : [{ path: file.path, headVersion: version }];
      });
      if (conflicts.length) return { conflicts };
      // Removals first, so a path one frees can take another's file or directory.
      const removed: string[] = [];
      for (const file of batch.filter((f) => f.key === undefined)) {
        this.sql().exec("DELETE FROM files WHERE path=?", file.path);
        this.record(file.path, "delete");
        removed.push(file.path);
      }
      const written: FileEntry[] = [];
      for (const file of batch.filter((f) => f.key !== undefined)) {
        if (![...this.sql().exec("SELECT 1 FROM objects WHERE key=?", file.key!)].length)
          throw new FileError("Unknown upload", 400);
        if (!Number.isSafeInteger(file.size) || file.size! < 0 || file.size! > VOLUME_LIMITS.fileBytes)
          throw new FileError("File exceeds byte limit", 413);
        this.pathConflict(file.path);
        const previous = head(file.path);
        if (!previous && this.info().files >= VOLUME_LIMITS.files)
          throw new FileError("Volume file limit reached", 507);
        const entry: FileEntry = {
          path: file.path,
          version: this.sequence() + 1,
          size: file.size!,
          key: file.key!,
          contentType: file.contentType ?? "application/octet-stream",
          updatedAt: Date.now(),
          ...(file.sha256 ? { sha256: file.sha256 } : {}),
        };
        this.sql().exec(
          "INSERT OR REPLACE INTO files(path,version,size,key,contentType,updatedAt,sha256) VALUES(?,?,?,?,?,?,?)",
          entry.path,
          entry.version,
          entry.size,
          entry.key,
          entry.contentType,
          entry.updatedAt,
          entry.sha256 ?? null,
        );
        this.record(entry.path, "write", entry);
        written.push(entry);
      }
      const taken = snapshot
        ? this.takeSnapshot(snapshot.name, { pinned: snapshot.pinned, labels: snapshot.labels })
        : undefined;
      return { seq: this.sequence(), files: written, removed, ...(taken ? { snapshot: taken } : {}) };
    });
  }
  /** Why `path` cannot be a file now: it is a directory, or below a file. Indexed, unlike `conflict`. */
  private pathConflict(path: string) {
    if ([...this.sql().exec("SELECT 1 FROM files WHERE path>? AND path<? LIMIT 1", path + "/", path + "0")].length)
      throw new FileError(`${path} is a directory`, 409);
    for (let parent = path.slice(0, path.lastIndexOf("/")); parent; parent = parent.slice(0, parent.lastIndexOf("/")))
      if ([...this.sql().exec("SELECT 1 FROM files WHERE path=?", parent)].length)
        throw new FileError(`${parent} is a file`, 409);
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
    await recordNativeFile(this.env, this.meta("tenant")!, key, bytes.byteLength);
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
        throw new FileError(expectedVersion === 0 ? `${path} already exists (version ${previous?.version ?? 0})` : !previous ? `${path} no longer exists (expected version ${expectedVersion})` : `${path} is at version ${previous.version}, not ${expectedVersion}`, 412);
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
  async snapshot(
    name?: string,
    options: {
      pinned?: boolean;
      labels?: Record<string, string>;
      given?: FileEntry[];
      expiresAt?: number;
    } = {},
  ) {
    this.alive();
    const snapshot = this.ctx.storage.transactionSync(() => this.takeSnapshot(name, options));
    if (options.expiresAt) {
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > options.expiresAt) await this.ctx.storage.setAlarm(options.expiresAt);
    }
    return snapshot;
  }
  /** Inside a transaction: a snapshot of the volume as it is now (or of `given`). */
  private takeSnapshot(
    name: string | undefined,
    options: {
      pinned?: boolean;
      labels?: Record<string, string>;
      given?: FileEntry[];
      expiresAt?: number;
    },
  ): Snapshot {
    name = name === undefined ? `seq ${this.sequence()}` : name;
    if (typeof name !== "string" || !name.trim() || name.length > 120)
      throw new FileError("name must be 1–120 characters");
    if (options.pinned !== undefined && typeof options.pinned !== "boolean")
      throw new FileError("pinned is true or false");
    const pinned = options.pinned ?? false,
      labels =
        options.labels === undefined ? {} : labelsInput(options.labels),
      cap = pinned ? VOLUME_LIMITS.pinnedSnapshots : VOLUME_LIMITS.snapshots;
    if (this.snapshots(undefined, true).filter((s) => s.pinned === pinned).length >= cap)
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
    if (options.expiresAt) this.sql().exec("INSERT INTO temporary_snapshots VALUES(?,?)", id, options.expiresAt);
    return this.snapshotSummary(id);
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
  snapshots(labels?: Record<string, string>, includeTemporary = false) {
    this.alive();
    if (labels) labels = labelsInput(labels);
    return [
      ...this.sql().exec<{ id: string }>(
        "SELECT id FROM snapshots ORDER BY createdAt,id",
      ),
    ]
      .map((s) => this.snapshotSummary(s.id))
      .filter(s => includeTemporary || !s.name.startsWith("[tool-call]"))
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
  /**
   * Make this new volume a fork: its files are the source's entries, sharing their content. The content stays where it
   * is, pinned by this fork (`fork:<id>`) in the volume that owns each blob until this fork is deleted.
   */
  async seed(
    entries: FileEntry[],
    origin: { volume: string; snapshot?: string; seq: number },
  ): Promise<VolumeInfo> {
    this.alive();
    if (this.info().files)
      throw new FileError("Destination volume is not empty", 409);
    if (entries.length > VOLUME_LIMITS.files)
      throw new FileError("Volume file limit reached", 507);
    const tenantPrefix = `files/${encodeURIComponent(this.meta("tenant")!)}/`;
    for (const entry of entries)
      if (!entry.key.startsWith(tenantPrefix)) throw new FileError("Invalid source", 403);
    // Pinned before the files point at them, so a crash leaves at worst a pin this fork's deletion releases.
    await this.pin(this.forkOwner(), entries.map((entry) => entry.key));
    this.ctx.storage.transactionSync(() => {
      this.alive();
      if (this.info().files)
        throw new FileError("Destination volume is not empty", 409);
      for (const entry of entries) {
        this.sql().exec(
          "INSERT INTO files(path,version,size,key,contentType,updatedAt,sha256) VALUES(?,?,?,?,?,?,?)",
          entry.path,
          entry.version,
          entry.size,
          entry.key,
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
    });
    return this.info();
  }
  /**
   * The owner of a fork's base pins. Not `fork:<id>`: the route before metadata-only forks pinned and then unpinned that
   * name around its copy, and an old route finishing mid-deploy must not release a new fork's base.
   */
  private forkOwner() {
    return `fork-base:${this.meta("id")!}`;
  }
  /** The volume whose collection owns a blob (the one named in its key), or undefined for this one. */
  private ownerOf(key: string) {
    const self = this.meta("id"), tenant = this.meta("tenant");
    if (!self || !tenant) return undefined;
    const [root, keyTenant, volume] = key.split("/");
    if (root !== "files" || keyTenant !== encodeURIComponent(tenant) || !volume) return undefined;
    const owner = decodeURIComponent(volume);
    return owner === self ? undefined : owner;
  }
  private peer(volume: string) {
    return this.env.VOLUMES.getByName(`${this.meta("tenant")!}:${volume}`);
  }
  /** Keep blobs while `owner` holds them. A blob another volume owns (a fork's base) is pinned in that volume. */
  async pin(owner: string, keys: string[], expiresAt?: number) {
    if (!owner || keys.length > VOLUME_LIMITS.files)
      throw new FileError("Invalid pin");
    const elsewhere = new Map<string, string[]>(),
      local: string[] = [];
    for (const key of new Set(keys)) {
      const volume = this.ownerOf(key);
      if (volume === undefined) local.push(key);
      else if (elsewhere.has(volume)) elsewhere.get(volume)!.push(key);
      else elsewhere.set(volume, [key]);
    }
    this.ctx.storage.transactionSync(() => {
      for (const key of local)
        this.sql().exec(
          "INSERT OR REPLACE INTO pins VALUES(?,?,?)",
          owner,
          key,
          expiresAt ?? null,
        );
      // Recorded before the remote pin, so an unpin after a crash still reaches it.
      for (const volume of elsewhere.keys())
        // Kept as long as the longest pin it records (NULL: until unpinned), then collected with expired pins.
        this.sql().exec(
          "INSERT INTO forwarded_pins VALUES(?,?,?) ON CONFLICT(owner,volume) DO UPDATE SET expiresAt=CASE WHEN forwarded_pins.expiresAt IS NULL OR excluded.expiresAt IS NULL THEN NULL ELSE max(forwarded_pins.expiresAt,excluded.expiresAt) END",
          owner,
          volume,
          expiresAt ?? null,
        );
    });
    for (const [volume, owned] of elsewhere) await this.peer(volume).pin(owner, owned, expiresAt);
    if (local.length) await this.scheduleCollection();
    // A record of an expiring pin kept elsewhere is collected by this volume's own alarm, which may have none yet.
    if (elsewhere.size && expiresAt !== undefined) await this.alarmBy(expiresAt);
  }
  async hasPin(owner: string, key: string): Promise<boolean> {
    const volume = this.ownerOf(key);
    if (volume !== undefined) return this.peer(volume).hasPin(owner, key);
    return [...this.sql().exec("SELECT 1 FROM pins WHERE owner=? AND key=? AND (expiresAt IS NULL OR expiresAt>?)", owner, key, Date.now())].length > 0;
  }
  async unpin(owner: string) {
    if (this.env.TEST_MODE === "1" && Number(this.meta("test:fail-unpin") ?? 0) > 0) {
      this.sql().exec("UPDATE metadata SET value=value-1 WHERE key='test:fail-unpin'");
      throw new FileError("Injected unpin failure", 503);
    }
    this.sql().exec("DELETE FROM pins WHERE owner=?", owner);
    for (const { volume } of [...this.sql().exec<{ volume: string }>("SELECT volume FROM forwarded_pins WHERE owner=?", owner)]) {
      await this.peer(volume).unpin(owner);
      this.sql().exec("DELETE FROM forwarded_pins WHERE owner=? AND volume=?", owner, volume);
    }
  }
  /** Local tests only (TEST_MODE): fail the next `times` unpins here, to exercise the release retry. */
  testFailUnpin(times: number) {
    if (this.env.TEST_MODE !== "1") throw new FileError("Not found", 404);
    this.sql().exec("INSERT OR REPLACE INTO metadata VALUES('test:fail-unpin',?)", String(times));
  }
  /** Local tests only (TEST_MODE): pin every current file as `owner`, as another route would. */
  async testPinFiles(owner: string, expiresAt?: number) {
    if (this.env.TEST_MODE !== "1") throw new FileError("Not found", 404);
    await this.pin(owner, this.list().map((file) => file.key), expiresAt);
  }
  /** Local tests only (TEST_MODE): run the alarm now, as if it had fired. */
  async testRunAlarm() {
    if (this.env.TEST_MODE !== "1") throw new FileError("Not found", 404);
    await this.alarm();
    return { alarm: await this.ctx.storage.getAlarm() };
  }
  /** Local tests only (TEST_MODE): when the alarm is set to fire, or null. */
  testAlarm() {
    if (this.env.TEST_MODE !== "1") throw new FileError("Not found", 404);
    return this.ctx.storage.getAlarm().then((alarm) => ({ alarm }));
  }
  /** Local tests only (TEST_MODE): what the forwarded pin records hold. */
  testForwardedPins() {
    if (this.env.TEST_MODE !== "1") throw new FileError("Not found", 404);
    return [...this.sql().exec<{ owner: string; volume: string; expiresAt: number | null }>("SELECT * FROM forwarded_pins ORDER BY owner,volume")];
  }
  /** A deleted fork lets go of its base; retried by the alarm until every owning volume has heard. */
  private async releaseFork() {
    if (!this.meta("id") || !this.meta("tenant")) return true;
    try {
      await this.unpin(this.forkOwner());
      return true;
    } catch (error) {
      console.error("fork pin release failed; the alarm retries", error);
      return false;
    }
  }
  /** The alarm fires by `at` at the latest. */
  private async alarmBy(at: number) {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > at) await this.ctx.storage.setAlarm(at);
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
    // The pins they record expired in their own volumes too.
    this.sql().exec("DELETE FROM forwarded_pins WHERE expiresAt IS NOT NULL AND expiresAt<=?", now);
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
      await deleteNativeFile(this.env, this.meta("tenant")!, row.key);
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
    for (const { id } of this.sql().exec<{id:string}>("SELECT id FROM temporary_snapshots WHERE expiresAt<=?", Date.now())) {
      this.sql().exec("DELETE FROM snapshots WHERE id=?", id);
      this.sql().exec("DELETE FROM snapshot_options WHERE id=?", id);
      this.sql().exec("DELETE FROM temporary_snapshots WHERE id=?", id);
    }
    const released = !this.meta("deleted") || (await this.releaseFork());
    await this.collectGarbage();
    if (!released) await this.ctx.storage.setAlarm(Date.now() + 10 * 60_000);
    else if (
      this.sql().exec<{ n: number }>("SELECT count(*) n FROM objects").one().n
    )
      await this.ctx.storage.setAlarm(Date.now() + DAY);
    // Records of expiring pins kept elsewhere are collected when the first of them expires.
    const next = this.sql().exec<{ at: number | null }>("SELECT min(expiresAt) at FROM forwarded_pins WHERE expiresAt IS NOT NULL").one().at;
    if (next !== null) await this.alarmBy(next);
  }
  /** Erase metadata after account deletion has removed the volume's live files. */
  async purgeAccountData(tenant: string) {
    const owner = this.meta("tenant");
    if (!this.meta("deleted") || owner && owner !== tenant)
      throw new FileError("Account purge requires the owned, deleted volume", 403);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.sql().exec("CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.sql().exec("INSERT OR REPLACE INTO metadata VALUES('deleted',?)", String(Date.now()));
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
    // A fork's base is held for as long as the fork lives, and no longer.
    if (!(await this.releaseFork())) await this.ctx.storage.setAlarm(Date.now() + 10 * 60_000);
    else await this.scheduleCollection();
    return { deleted: true };
  }
}
