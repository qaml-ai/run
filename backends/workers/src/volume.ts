// TEMPORARY(job-surface): deleted with the Volume DO after claude/delete-job-surface lands
import { guardAlarms } from "./alarm-guard.ts";
import { DurableObject } from "cloudflare:workers";
import { HttpError } from "./errors.ts";
import { FileError, normalizePath } from "./file-errors.ts";
export { digest } from "./file-errors.ts";
import {
  labelsInput as sourceLabelsInput,
  VOLUME_LIMITS,
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
const labelsInput = (value: unknown) => policy(() => sourceLabelsInput(value));
export interface VolumeBindings {
  BUCKET: R2Bucket;
  VOLUMES: DurableObjectNamespace<Volume>;
  TEST_MODE?: string;
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
const DAY = 86400_000;
/** Read legacy trees and keep temporary snapshots alive for jobs that consume them. */
export class Volume extends DurableObject<VolumeBindings> {
  constructor(ctx: DurableObjectState, env: VolumeBindings) {
    super(ctx, env);
    guardAlarms(this, ctx, "Volume", { test: (env as { TEST_MODE?: unknown }).TEST_MODE === "1" });
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
  list(prefix = "/", snapshot?: string) {
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
    return all
      .filter(
        (f) => prefix === "/" || f.path === prefix || f.path.startsWith(prefix + "/"),
      )
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  readSet(
    prefix = "/",
    snapshot?: string,
  ): { files: FileEntry[]; seq: number; snapshot?: string } {
    return {
      files: this.list(prefix, snapshot),
      seq: snapshot ? this.snapshotSummary(snapshot).seq : this.sequence(),
      ...(snapshot ? { snapshot } : {}),
    };
  }
  async snapshot(
    name?: string,
    options: {
      pinned?: boolean;
      labels?: Record<string, string>;
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
  /** Inside a transaction: a snapshot of the volume as it is now. */
  private takeSnapshot(
    name: string | undefined,
    options: {
      pinned?: boolean;
      labels?: Record<string, string>;
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
      entries = this.list();
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
  /**
   * The owner of a fork's base pins. Not `fork:<id>`: the route before metadata-only forks pinned and then unpinned that
   * name around its copy, and an old route finishing mid-deploy must not release a new fork's base.
   */
  private forkOwner() {
    return `fork-base:${this.meta("id")!}`;
  }
  private peer(volume: string) {
    return this.env.VOLUMES.getByName(`${this.meta("tenant")!}:${volume}`);
  }
  async unpin(owner: string) {
    this.sql().exec("DELETE FROM pins WHERE owner=?", owner);
    for (const { volume } of [...this.sql().exec<{ volume: string }>("SELECT volume FROM forwarded_pins WHERE owner=?", owner)]) {
      await this.peer(volume).unpin(owner);
      this.sql().exec("DELETE FROM forwarded_pins WHERE owner=? AND volume=?", owner, volume);
    }
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
  private async collectGarbage(now = Date.now(), grace = DAY) {
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
}
