import { createHash, randomBytes } from "node:crypto";
import type { AppendLog } from "../shared/append-log.ts";
import type { Storage } from "../shared/storage.ts";
import { NotOwner } from "./client-sessions.ts";
import type { Db, Sql } from "./db.ts";
import { LostClaim, underClaim, type Claim, type Ownership } from "./ownership.ts";
import { HttpError } from "./http.ts";
import { deleteTail } from "./log-tail.ts";
import { errorText, type ToolDefinition } from "./protocol.ts";
import { safeError } from "./metrics.ts";
import { runVolumeTool, volumeToolDefinitions, type ToolContext } from "./volume-tools.ts";
import { declaredType, guessContentType, sniffContentType, validContentType } from "./files.ts";
import { clock } from "./node-context.ts";

/**
 * Volumes: shared file trees agents mount, without POSIX. A volume is an actor
 * like an agent: one node at a time owns it and orders its writes. Headers,
 * snapshot summaries and watchers are rows in Postgres (`volumes`,
 * `volume_snapshots`, `volume_watchers`); the rest is in Storage:
 *
 *   volumes/<id>/tree                    append log of file puts and deletes, folded into a base
 *   volumes/<id>/snapshots/<snap>        a snapshot's file map (a blob, written once)
 *   chunks/<tenant>/<aa>/<sha256>        file contents, 1 MiB content-addressed chunks
 *
 * File contents never pass through the owner: any node writes chunks, then asks
 * the owner to commit the path (conditional on a version). Readers ask the owner
 * for the path's chunk list and fetch the chunks themselves.
 */
export const CHUNK_BYTES = 1024 * 1024;
/** What one read of many files (GET /v1/volumes/:id/files?content=true) returns at most. */
export const READ_ALL_LIMITS = Object.freeze({ files: 1000, bytes: 16 * 1024 * 1024 });
/** `data` as text when it is valid UTF-8, else undefined. */
const utf8 = (data: Buffer) => { try { return new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { return undefined; } };
export const VOLUME_LIMITS = Object.freeze({ fileBytes: 256 * 1024 * 1024, files: 100_000, mounts: 16, snapshots: 100, changes: 1000, listing: 1000 });
/**
 * Snapshots the runtime makes of a directory for one tool call (file-arguments.ts) are named with this prefix. They are
 * not listed, do not count toward VOLUME_LIMITS.snapshots, and are deleted after their call; any left after a crash
 * go once they are TEMPORARY_SNAPSHOT_MS old, when the next is made.
 */
export const TEMPORARY_SNAPSHOT = "file-arg:";
const TEMPORARY_SNAPSHOT_MS = 15 * 60_000;
const FOLD_AFTER_RECORDS = 1024;
const NOTIFY_DELAY_MS = 1000;

export interface Mount { volumeId: string; path: string; mode: "ro" | "rw"; subpath?: string; notify?: boolean }
/** `contentType` is absent on files written before content types were recorded. */
export interface FileEntry { version: number; size: number; chunks: string[]; updatedAt: number; by?: string; contentType?: string }
export interface Change { seq: number; path: string; kind: "write" | "delete"; version?: number; size?: number; by?: string; at: number }
interface VolumeHeader { version: 1; id: string; tenant: string; name: string; createdAt: number; deleted?: number; origin?: { volume: string; snapshot?: string; seq: number } }
interface SnapshotSummary { id: string; volume: string; name: string; seq: number; createdAt: number; files: number; bytes: number }
interface Watcher { agent: string; tenant: string; mounts: { path: string; subpath: string }[] }
type TreeRecord =
  | { t: "base"; seq: number }
  | { t: "put"; seq: number; path: string; entry: FileEntry }
  | { t: "del"; seq: number; path: string; at: number; by?: string };
type Volume = {
  header: VolumeHeader; claim?: Claim; tree: Tree; seq: number; log: AppendLog<TreeRecord>;
  /** Writes are ordered through this chain. */
  queue: Promise<unknown>; active: number; lastActive: number; fault?: Error;
  changes: Change[]; pending: Change[]; notifying?: ReturnType<typeof setTimeout>;
};
export type VolumeRequest = { id: string; method: string; params: Record<string, unknown> };
export interface VolumeOptions {
  db: Db; storage: Storage;
  /** With ownership, one node at a time serves each volume. */
  ownership?: Ownership;
  /** Unload a volume (and give up ownership) after this long without use. */
  idleMs?: number;
  /** Run an operation on the node that owns a volume (a signed node-to-node POST). */
  peer?: (owner: string, path: string, body: unknown) => Promise<unknown>;
  /** Submit a request to an agent wherever it is served; wakes agents watching a volume. */
  deliver?: (agent: string, tenant: string, request: VolumeRequest) => Promise<unknown>;
  /**
   * What a tenant may still store, read before each write: its limit and the bytes it stores (undefined: no limit).
   * It throws to refuse every write (a spent balance).
   */
  quota?: (tenant: string) => Promise<{ limit: number; used: number } | undefined>;
}

/** 507 STORAGE_LIMIT: storing `adding` more bytes would take the tenant past `limit`. */
export function storageFull(quota: { limit: number; used: number }) {
  const gb = (bytes: number) => `${(bytes / 1e9).toFixed(2)} GB`;
  return new HttpError(507, `This account stores ${gb(quota.used)} of its ${gb(quota.limit)} storage limit, so it cannot store more; delete files or volumes to make room`, "STORAGE_LIMIT", { limit: quota.limit, used: quota.used });
}

export const validVolumeId = (value: unknown): value is string => typeof value === "string" && /^vol_[a-f0-9]{24}$/.test(value);
const newId = (prefix: string, bytes: number) => `${prefix}_${randomBytes(bytes).toString("hex")}`;
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const treeKey = (id: string) => `volumes/${id}/tree`;
const snapshotFilesKey = (id: string, snapshot: string) => `volumes/${id}/snapshots/${snapshot}`;
const header = (row: any): VolumeHeader => ({
  version: 1, id: row.id, tenant: row.tenant, name: row.name, createdAt: row.created_at,
  ...(row.deleted_at !== null ? { deleted: row.deleted_at } : {}), ...(row.origin ? { origin: row.origin } : {}),
});
const SNAPSHOT_COLUMNS = "id, volume, name, seq, created_at as \"createdAt\", files, bytes";
const chunkKey = (tenant: string, hash: string) => `chunks/${tenant}/${hash.slice(0, 2)}/${hash}`;

/** A path inside a volume: absolute, `/`-separated, no `.`/`..` or empty segments. */
export function normalizePath(input: unknown, label = "path"): string {
  if (typeof input !== "string" || input.length > 1024 || /[\x00-\x1f\x7f\\]/.test(input)) throw new HttpError(400, `Invalid ${label}`);
  const parts = input.split("/").filter(Boolean);
  if (parts.some(part => part === "." || part === ".." || Buffer.byteLength(part) > 255)) throw new HttpError(400, `Invalid ${label}: ${input}`);
  return `/${parts.join("/")}`;
}
const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const within = (path: string, directory: string) => directory === "/" || path === directory || path.startsWith(`${directory}/`);
const relativeTo = (path: string, directory: string) => (directory === "/" ? path : path.slice(directory.length)).replace(/^\//, "");

/** A glob over `/`-separated relative paths: `*`, `?`, `**`, and `{a,b}` alternatives. */
export function globRegex(pattern: string): RegExp {
  if (typeof pattern !== "string" || !pattern || pattern.length > 512) throw new HttpError(400, "Invalid glob pattern");
  const source = (text: string): string => {
    let out = "";
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (char === "*" && text[index + 1] === "*") {
        index++;
        if (text[index + 1] === "/") { index++; out += "(?:.*/)?"; } else out += ".*";
      } else if (char === "*") out += "[^/]*";
      else if (char === "?") out += "[^/]";
      else if (char === "{" && text.indexOf("}", index) > index) {
        const end = text.indexOf("}", index);
        out += `(?:${text.slice(index + 1, end).split(",").map(source).join("|")})`;
        index = end;
      } else out += char.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
    }
    return out;
  };
  return new RegExp(`^${source(pattern.replace(/^\/+/, ""))}$`);
}

/** A version precondition failed: the file changed since the caller read it. */
export class VersionConflict extends HttpError {
  current: number;
  constructor(path: string, expected: number, current: number) {
    super(412, expected === 0 ? `${path} already exists (version ${current})` : current === 0 ? `${path} no longer exists (expected version ${expected})` : `${path} is at version ${current}, not ${expected}`);
    this.current = current;
  }
}

/** The file tree in memory: path -> entry, plus each directory's children for listings. */
class Tree {
  readonly files = new Map<string, FileEntry>();
  readonly children = new Map<string, Set<string>>([["/", new Set()]]);
  bytes = 0;
  put(path: string, entry: FileEntry) {
    const previous = this.files.get(path);
    this.files.set(path, entry);
    this.bytes += entry.size - (previous?.size ?? 0);
    if (previous) return;
    for (let child = path, directory = parentOf(path); ; child = directory, directory = parentOf(directory)) {
      const names = this.children.get(directory);
      if (names) { names.add(nameOf(child)); break; }
      this.children.set(directory, new Set([nameOf(child)]));
    }
  }
  delete(path: string) {
    const previous = this.files.get(path);
    if (!previous) return;
    this.files.delete(path);
    this.bytes -= previous.size;
    for (let child = path, directory = parentOf(path); ; child = directory, directory = parentOf(directory)) {
      const names = this.children.get(directory)!;
      names.delete(nameOf(child));
      if (names.size || directory === "/") break;
      this.children.delete(directory);
    }
  }
  /** Files at or below `directory`, depth first in name order. */
  *walk(directory: string): Generator<[string, FileEntry]> {
    for (const name of [...this.children.get(directory) ?? []].sort()) {
      const path = directory === "/" ? `/${name}` : `${directory}/${name}`;
      const entry = this.files.get(path);
      if (entry) yield [path, entry];
      else yield* this.walk(path);
    }
  }
  /** Why `path` cannot be a file: it is a directory, or it is below a file. */
  conflict(path: string) {
    if (this.children.has(path)) return `${path} is a directory`;
    for (let directory = parentOf(path); directory !== "/"; directory = parentOf(directory)) {
      if (this.files.has(directory)) return `${directory} is a file`;
    }
  }
}

export class VolumeService {
  readonly db: Db;
  readonly storage: Storage;
  readonly options: VolumeOptions;
  private readonly loaded = new Map<string, Volume>();
  private readonly loading = new Map<string, Promise<Volume | undefined>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(options: VolumeOptions) {
    this.options = options;
    this.db = options.db;
    this.storage = options.storage;
    this.timer = setInterval(() => void this.tick(), Math.max(50, Math.min(5_000, Math.floor(this.idleMs / 2))));
    this.timer.unref();
    // A fenced node may already have been replaced: stop every volume at once.
    options.ownership?.onFence(() => {
      for (const volume of [...this.loaded.values()]) {
        volume.fault = new HttpError(503, "This node lost ownership of the volume; retry");
        this.loaded.delete(volume.header.id);
      }
    });
  }

  private get idleMs() { return this.options.idleMs ?? 5 * 60_000; }

  async create(tenant: string, input: { name?: unknown } = {}, id = newId("vol", 12)) {
    const name = input.name === undefined ? "volume" : input.name;
    if (typeof name !== "string" || !name.trim() || name.length > 120) throw new HttpError(400, "name must be 1–120 characters");
    const header: VolumeHeader = { version: 1, id, tenant, name: name.trim(), createdAt: Date.now() };
    if (!await this.writeNew(header)) throw new HttpError(409, `Volume ${id} already exists`);
    return this.summary(header);
  }

  /** Insert a new volume; false if one with its id already exists. */
  private async writeNew(header: VolumeHeader) {
    const { rowCount } = await this.db.query("insert into volumes (id, tenant, name, created_at, origin) values ($1, $2, $3, $4, $5) on conflict (id) do nothing",
      [header.id, header.tenant, header.name, header.createdAt, header.origin ? JSON.stringify(header.origin) : null]);
    return !!rowCount;
  }

  private summary(header: VolumeHeader, tree?: Tree, seq = 0) {
    return { id: header.id, name: header.name, createdAt: header.createdAt, ...(header.origin ? { origin: header.origin } : {}), seq, files: tree?.files.size ?? 0, bytes: tree?.bytes ?? 0 };
  }

  async list(tenant: string) {
    const { rows } = await this.db.query(`select id, name, created_at as "createdAt" from volumes where tenant = $1 and deleted_at is null order by created_at, id`, [tenant]);
    return rows as { id: string; name: string; createdAt: number }[];
  }

  /** Whether `id` is one of `tenant`'s volumes (one read). */
  async owns(id: string, tenant: string) {
    return validVolumeId(id) && !!(await this.db.query("select 1 from volumes where id = $1 and tenant = $2 and deleted_at is null", [id, tenant])).rowCount;
  }

  private async readHeader(id: string): Promise<VolumeHeader | undefined> {
    const row = (await this.db.query("select * from volumes where id = $1", [id])).rows[0];
    return row && header(row);
  }

  /** The live owner of a volume when it is another node (or, while draining, a peer to take it); undefined when this node serves it. */
  async ownerElsewhere(id: string): Promise<string | undefined> {
    const ownership = this.options.ownership;
    if (!ownership || this.loaded.has(id)) return undefined;
    const owner = await ownership.route(id);
    return owner !== ownership.node ? owner : undefined;
  }

  /** Run an owner operation here or on the owning node, following a moved volume a few times. */
  async call(id: string, tenant: string, op: string, args: Record<string, unknown> = {}): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      let owner: string | undefined;
      try {
        owner = await this.ownerElsewhere(id);
        if (!owner) return await this.handle(id, tenant, op, args);
        if (!this.options.peer) throw new NotOwner(owner);
        return await this.options.peer(owner, `/internal/volumes/${id}/ops`, { tenant, op, args });
      } catch (error) {
        const status = (error as HttpError).status;
        // The owner moved, is draining, or is unreachable: look it up afresh.
        if (owner && (status === undefined || status === 503)) this.options.ownership?.forget(id);
        if (status !== 503 || attempt >= 4) throw error;
        await clock().sleep(100 * 2 ** attempt);
      }
    }
  }

  private load(id: string): Promise<Volume | undefined> {
    const loaded = this.loaded.get(id);
    if (loaded) return Promise.resolve(loaded);
    let loading = this.loading.get(id);
    if (!loading) {
      loading = this.read(id).finally(() => this.loading.delete(id));
      this.loading.set(id, loading);
    }
    return loading;
  }

  private async read(id: string): Promise<Volume | undefined> {
    if (this.closed) throw new HttpError(503, "The runtime is stopping; retry");
    if (!validVolumeId(id) || !(await this.readHeader(id))) return undefined;
    // Take ownership before reading the log, so no other node appends meanwhile.
    const ownership = this.options.ownership;
    let claim: Claim | undefined;
    if (ownership) {
      const acquired = await ownership.acquire(id);
      if ("owner" in acquired) throw new NotOwner(acquired.owner);
      claim = acquired.claim;
    }
    try {
      const stored = await this.readHeader(id);
      if (!stored || stored.deleted) { if (claim) await ownership!.release(claim); return undefined; }
      const volume: Volume = { header: stored, claim, tree: new Tree(), seq: 0, log: this.storage.log<TreeRecord>(treeKey(id), claim), queue: Promise.resolve(), active: 0, lastActive: Date.now(), changes: [], pending: [] };
      for (const record of await volume.log.read()) this.apply(volume, record);
      if (claim && !ownership!.holds(claim)) throw new HttpError(503, "This node lost ownership of the volume; retry");
      this.loaded.set(id, volume);
      return volume;
    } catch (error) {
      if (claim) await ownership!.release(claim).catch(() => {});
      throw error;
    }
  }

  private apply(volume: Volume, record: TreeRecord) {
    volume.seq = Math.max(volume.seq, record.seq);
    if (record.t === "base") return;
    if (record.t === "put") volume.tree.put(record.path, record.entry);
    else volume.tree.delete(record.path);
    const change: Change = record.t === "put"
      ? { seq: record.seq, path: record.path, kind: "write", version: record.entry.version, size: record.entry.size, at: record.entry.updatedAt, ...(record.entry.by ? { by: record.entry.by } : {}) }
      : { seq: record.seq, path: record.path, kind: "delete", at: record.at, ...(record.by ? { by: record.by } : {}) };
    volume.changes.push(change);
    if (volume.changes.length > VOLUME_LIMITS.changes) volume.changes.shift();
    return change;
  }

  /** Write the volume's own rows under its claim; a lost claim fences the volume as a failed append does. */
  private async fenced<T>(volume: Volume, work: (sql: Sql) => Promise<T>): Promise<T> {
    try { return await underClaim(this.db, volume.claim, work); }
    catch (error) {
      if (error instanceof LostClaim) {
        volume.fault = error;
        if (this.loaded.get(volume.header.id) === volume) this.loaded.delete(volume.header.id);
      }
      throw error;
    }
  }

  /** Append a record durably, then apply it. A failed append fences the volume until it reloads. */
  private async commit(volume: Volume, record: TreeRecord) {
    if (volume.fault) throw volume.fault;
    volume.log.append(record);
    try { await volume.log.flush(true); }
    catch (error) {
      volume.fault = new HttpError(503, `Volume moved or storage failed; retry (${errorText(error)})`);
      if (this.loaded.get(volume.header.id) === volume) this.loaded.delete(volume.header.id);
      throw volume.fault;
    }
    const change = this.apply(volume, record)!;
    this.queueNotification(volume, change);
    if (volume.log.appendedSinceRewrite >= FOLD_AFTER_RECORDS) {
      await volume.log.rewrite(() => this.fold(volume)).catch(() => {});
    }
    return change;
  }

  private fold(volume: Volume): TreeRecord[] {
    return [{ t: "base", seq: volume.seq }, ...[...volume.tree.files].map(([path, entry]) => ({ t: "put" as const, seq: entry.version, path, entry }))];
  }

  /** Owner operations. `args` come from trusted runtime code (the API and tools), already authorized for `tenant`. */
  async handle(id: string, tenant: string, op: string, args: Record<string, any> = {}): Promise<any> {
    const volume = await this.load(id);
    if (!volume || volume.header.tenant !== tenant) throw new HttpError(404, `Unknown volume ${id}`);
    if (volume.fault) throw volume.fault;
    volume.active++;
    volume.lastActive = Date.now();
    try {
      if (op === "info") return this.summary(volume.header, volume.tree, volume.seq);
      if (op === "stat" || op === "list" || op === "readAll") {
        // As the volume is now, or as a snapshot of it was: one tree, so a listing and its reads agree.
        const at = args.snapshot === undefined ? { tree: volume.tree, seq: volume.seq } : await this.snapshotTree(id, args.snapshot);
        if (op === "stat") return this.stat(at.tree, normalizePath(args.path));
        if (op === "list") return this.listFiles(at.tree, args);
        return await this.readAll(volume.header.tenant, at, args);
      }
      if (op === "ls") return this.ls(volume, normalizePath(args.path));
      if (op === "changes") return this.changes(volume, Number(args.since ?? 0), args.prefix === undefined ? undefined : normalizePath(args.prefix));
      if (op === "snapshots") return this.snapshots(id);
      // Mutations run one at a time, in order.
      const run = volume.queue.then(() => this.mutate(volume, op, args));
      volume.queue = run.catch(() => {});
      return await run;
    } finally {
      volume.active--;
      volume.lastActive = Date.now();
    }
  }

  private stat(tree: Tree, path: string) {
    const entry = tree.files.get(path);
    if (entry) return { type: "file", path, ...entry };
    if (tree.children.has(path)) return { type: "directory", path };
    throw new HttpError(404, `${path} does not exist`);
  }

  private ls(volume: Volume, path: string) {
    const names = volume.tree.children.get(path);
    if (!names) throw new HttpError(404, volume.tree.files.has(path) ? `${path} is a file` : `${path} does not exist`);
    const entries = [...names].sort().slice(0, VOLUME_LIMITS.listing).map(name => {
      const child = path === "/" ? `/${name}` : `${path}/${name}`;
      const entry = volume.tree.files.get(child);
      return entry ? { name, type: "file", size: entry.size, version: entry.version, contentType: entry.contentType ?? guessContentType(name) } : { name, type: "directory" };
    });
    return { path, entries, ...(names.size > entries.length ? { truncated: true } : {}) };
  }

  /** Files under `path` (optionally matching a glob relative to it), paged by `after`. */
  private listFiles(tree: Tree, args: Record<string, any>) {
    const path = normalizePath(args.path ?? "/");
    const limit = Math.min(VOLUME_LIMITS.listing, Math.max(1, Number(args.limit ?? VOLUME_LIMITS.listing) || VOLUME_LIMITS.listing));
    const pattern = args.glob === undefined ? undefined : globRegex(args.glob);
    const files: ({ path: string } & FileEntry)[] = [];
    const single = tree.files.get(path);
    const source: Iterable<[string, FileEntry]> = single ? [[path, single]] : tree.walk(path);
    let passed = args.after === undefined;
    for (const [file, entry] of source) {
      if (!passed) { passed = file === args.after; continue; }
      if (pattern && !pattern.test(single ? nameOf(file) : relativeTo(file, path))) continue;
      if (files.length === limit) return { files, next: files.at(-1)!.path };
      files.push({ path: file, ...entry, contentType: entry.contentType ?? guessContentType(file) });
    }
    return { files };
  }

  private changes(volume: Volume, since: number, prefix?: string) {
    const oldest = volume.changes[0]?.seq ?? volume.seq + 1;
    return { seq: volume.seq, changes: volume.changes.filter(change => change.seq > since && (!prefix || within(change.path, prefix))), ...(since < oldest - 1 && since < volume.seq ? { gap: true } : {}) };
  }

  /** A snapshot's files and the seq it was taken at; 404 for one this volume does not have. */
  private async snapshotFiles(id: string, snapshot: unknown): Promise<{ files: [string, FileEntry][]; seq: number }> {
    const summary: SnapshotSummary | undefined = typeof snapshot === "string" && /^snap_[a-f0-9]{16}$/.test(snapshot)
      ? (await this.db.query(`select ${SNAPSHOT_COLUMNS} from volume_snapshots where id = $1 and volume = $2`, [snapshot, id])).rows[0] : undefined;
    const stored = summary && await this.storage.readBlob(snapshotFilesKey(id, summary.id));
    if (!summary || !stored) throw new HttpError(404, "Unknown snapshot");
    return { files: Object.entries(JSON.parse(Buffer.from(stored).toString("utf8")) as Record<string, FileEntry>), seq: summary.seq };
  }
  /** A snapshot as a tree, to list and read it as the volume is listed and read. */
  private async snapshotTree(id: string, snapshot: unknown) {
    const { files, seq } = await this.snapshotFiles(id, snapshot);
    const tree = new Tree();
    for (const [path, entry] of files) tree.put(path, entry);
    return { tree, seq, snapshot: snapshot as string };
  }

  /**
   * Every file under `path` (and `glob`) with its contents, at one seq (or a snapshot's): text as `text`, other bytes
   * as base64 `data`, each with its sha256. Within READ_ALL_LIMITS, else a 413 that says to narrow it. Chunks never
   * change, so files listed at one seq read as they were then, whatever is written meanwhile.
   */
  private async readAll(tenant: string, at: { tree: Tree; seq: number; snapshot?: string }, args: Record<string, any>) {
    const listing = this.listFiles(at.tree, { path: args.path, glob: args.glob, limit: READ_ALL_LIMITS.files });
    if (listing.next) throw new HttpError(413, `More than ${READ_ALL_LIMITS.files} files match; narrow prefix or glob`);
    const bytes = listing.files.reduce((total, file) => total + file.size, 0);
    if (bytes > READ_ALL_LIMITS.bytes) throw new HttpError(413, `The files that match are ${bytes} bytes, past the ${READ_ALL_LIMITS.bytes} one read returns; narrow prefix or glob, or read large files one at a time`);
    const files = await Promise.all(listing.files.map(async ({ chunks: _chunks, ...file }) => {
      const data = await this.readRange(tenant, { size: file.size, chunks: _chunks }, 0, file.size);
      const text = data.subarray(0, 8000).includes(0) ? undefined : utf8(data);
      return { ...file, sha256: createHash("sha256").update(data).digest("hex"), ...(text !== undefined ? { text } : { data: data.toString("base64") }) };
    }));
    return { seq: at.seq, ...(at.snapshot ? { snapshot: at.snapshot } : {}), files };
  }

  private async snapshots(id: string): Promise<SnapshotSummary[]> {
    return (await this.db.query(`select ${SNAPSHOT_COLUMNS} from volume_snapshots where volume = $1 and name not like '${TEMPORARY_SNAPSHOT}%' order by created_at, id`, [id])).rows;
  }

  private check(volume: Volume, path: string, ifMatch: unknown) {
    if (ifMatch === undefined || ifMatch === null) return;
    if (!Number.isSafeInteger(ifMatch) || (ifMatch as number) < 0) throw new HttpError(400, "version must be a non-negative integer (0: the file must not exist)");
    const current = volume.tree.files.get(path)?.version ?? 0;
    if (current !== ifMatch) throw new VersionConflict(path, ifMatch as number, current);
  }

  private async mutate(volume: Volume, op: string, args: Record<string, any>): Promise<any> {
    const id = volume.header.id;
    if (op === "commit") {
      const path = normalizePath(args.path);
      if (path === "/") throw new HttpError(400, "A file needs a name");
      const chunks = args.chunks as unknown;
      if (!Number.isSafeInteger(args.size) || args.size < 0 || args.size > VOLUME_LIMITS.fileBytes || !Array.isArray(chunks) || chunks.length !== Math.ceil(args.size / CHUNK_BYTES) || !chunks.every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))) throw new HttpError(400, "Invalid file content");
      if (args.contentType !== undefined && !validContentType(args.contentType)) throw new HttpError(400, "Invalid content type");
      this.check(volume, path, args.ifMatch);
      // Referred to now (a copy or move commits another file's chunks): a collection under way stands down.
      await this.touch(volume.header.tenant, chunks as string[]);
      const conflict = volume.tree.conflict(path);
      if (conflict) throw new HttpError(409, conflict);
      if (!volume.tree.files.has(path) && volume.tree.files.size >= VOLUME_LIMITS.files) throw new HttpError(507, `A volume holds at most ${VOLUME_LIMITS.files} files`);
      const seq = volume.seq + 1;
      const entry: FileEntry = { version: seq, size: args.size, chunks: chunks as string[], updatedAt: Date.now(), ...(typeof args.by === "string" ? { by: args.by } : {}), ...(args.contentType ? { contentType: args.contentType } : {}) };
      await this.commit(volume, { t: "put", seq, path, entry });
      return { path, ...entry };
    }
    if (op === "remove") {
      const path = normalizePath(args.path);
      if (!volume.tree.files.has(path)) throw new HttpError(404, `${path} does not exist`);
      this.check(volume, path, args.ifMatch);
      const change = await this.commit(volume, { t: "del", seq: volume.seq + 1, path, at: Date.now(), ...(typeof args.by === "string" ? { by: args.by } : {}) });
      return { path, deleted: true, seq: change.seq };
    }
    if (op === "snapshot") {
      // `directory`: a temporary snapshot of one directory for a tool call, within `limit` (runtime code only).
      const temporary = args.directory !== undefined;
      const name = args.name === undefined ? `seq ${volume.seq}` : args.name;
      if (typeof name !== "string" || !name.trim() || name.length > 120) throw new HttpError(400, "name must be 1–120 characters");
      if (temporary !== name.startsWith(TEMPORARY_SNAPSHOT)) throw new HttpError(400, `Snapshot names starting with ${TEMPORARY_SNAPSHOT} are the runtime's own`);
      let files: [string, FileEntry][] = [...volume.tree.files];
      if (temporary) {
        const directory = normalizePath(args.directory);
        const { files: most, bytes: budget } = args.limit as { files: number; bytes: number };
        files = [];
        let bytes = 0;
        for (const file of volume.tree.walk(directory)) {
          bytes += file[1].size;
          if (files.push(file) > most) throw new HttpError(413, `${directory} has more than ${most} files`);
          if (bytes > budget) throw new HttpError(413, `${directory} holds more than ${budget} bytes`);
        }
      }
      // Metadata only: the snapshot shares every chunk with the volume.
      const snapshot: SnapshotSummary = { id: newId("snap", 8), volume: id, name: name.trim(), seq: volume.seq, createdAt: Date.now(), files: files.length, bytes: files.reduce((sum, [, entry]) => sum + entry.size, 0) };
      // It refers to every chunk its files do: a collection under way stands down.
      await this.touch(volume.header.tenant, files.flatMap(([, entry]) => entry.chunks));
      // The file map can hold 100,000 entries, so it is a blob; the summary is a row.
      await this.storage.writeBlob(snapshotFilesKey(id, snapshot.id), Buffer.from(JSON.stringify(Object.fromEntries(files))));
      const stale = await this.fenced(volume, async sql => {
        const pattern = `${TEMPORARY_SNAPSHOT}%`;
        // Temporary ones a crash left behind go now; they and the rest count separately, so tool calls never fill a volume's snapshots.
        const left = temporary ? (await sql.query("delete from volume_snapshots where volume = $1 and name like $2 and created_at < $3 returning id", [id, pattern, Date.now() - TEMPORARY_SNAPSHOT_MS])).rows.map(row => row.id as string) : [];
        const count = (await sql.query(`select count(*) as count from volume_snapshots where volume = $1 and name ${temporary ? "" : "not "}like $2`, [id, pattern])).rows[0].count;
        if (count >= VOLUME_LIMITS.snapshots) throw new HttpError(409, temporary ? `${VOLUME_LIMITS.snapshots} tool calls are reading this volume's directories now; retry in a few minutes` : `A volume keeps at most ${VOLUME_LIMITS.snapshots} snapshots; delete one first`);
        await sql.query("insert into volume_snapshots (id, volume, name, seq, created_at, files, bytes) values ($1, $2, $3, $4, $5, $6, $7)",
          [snapshot.id, id, snapshot.name, snapshot.seq, snapshot.createdAt, snapshot.files, snapshot.bytes]);
        return left;
      });
      for (const old of stale) await this.storage.removeBlob(snapshotFilesKey(id, old)).catch(() => {});
      return snapshot;
    }
    if (op === "deleteSnapshot") {
      // Its file map goes with it; the chunks it held are collected once nothing else holds them.
      const snapshot = args.snapshot;
      if (typeof snapshot !== "string" || !(await this.fenced(volume, sql => sql.query("delete from volume_snapshots where id = $1 and volume = $2", [snapshot, id]))).rowCount) throw new HttpError(404, "Unknown snapshot");
      await this.storage.removeBlob(snapshotFilesKey(id, snapshot));
      return { deleted: true };
    }
    if (op === "fork") {
      let files: [string, FileEntry][] = [...volume.tree.files];
      let seq = volume.seq;
      if (args.snapshot !== undefined) ({ files, seq } = await this.snapshotFiles(id, args.snapshot));
      const name = args.name === undefined ? `${volume.header.name} (fork)` : args.name;
      if (typeof name !== "string" || !name.trim() || name.length > 120) throw new HttpError(400, "name must be 1–120 characters");
      // `into`: the id the fork takes (an agent fork's workspace, never a caller's), which a retry finds made already.
      const into = args.into;
      if (into !== undefined) {
        if (!validVolumeId(into)) throw new HttpError(400, "into must be a volume id");
        const made = await this.readHeader(into);
        if (made && (made.tenant !== volume.header.tenant || made.origin?.volume !== id || made.deleted)) throw new HttpError(409, `Volume ${into} already exists`);
        if (made) return this.summary(made);
      }
      // The fork refers to every chunk it copies (a snapshot's included): a collection under way stands down.
      await this.touch(volume.header.tenant, files.flatMap(([, entry]) => entry.chunks));
      const header: VolumeHeader = { version: 1, id: typeof into === "string" ? into : newId("vol", 12), tenant: volume.header.tenant, name: name.trim(), createdAt: Date.now(), origin: { volume: id, ...(args.snapshot ? { snapshot: args.snapshot } : {}), seq } };
      // The fork's tree starts as a folded copy of the source's metadata; chunks are shared. Written under
      // the new volume's own claim, which nothing else can hold yet.
      const ownership = this.options.ownership;
      const acquired = ownership && await ownership.acquire(header.id);
      if (acquired && !("claim" in acquired)) throw new HttpError(503, "The fork's new volume is taken; retry");
      const claim = acquired?.claim;
      try {
        // Made meanwhile by a retry that held the claim first: its files may have changed since, so they stay.
        const made = into !== undefined && await this.readHeader(header.id);
        if (made) return this.summary(made);
        const log = this.storage.log<TreeRecord>(treeKey(header.id), claim);
        await log.rewrite(() => [{ t: "base", seq }, ...files.map(([path, entry]) => ({ t: "put" as const, seq: entry.version, path, entry }))]);
        await log.close();
        await this.writeNew(header);
      } finally {
        if (claim) await ownership!.release(claim).catch(() => {});
      }
      const tree = new Tree();
      for (const [path, entry] of files) tree.put(path, entry);
      return this.summary(header, tree, seq);
    }
    if (op === "delete") {
      // Tail rows go before unloading, so nothing of a deleted volume is compacted into Storage.
      const deleted = await this.fenced(volume, async sql => {
        if (!(await sql.query("update volumes set deleted_at = $2 where id = $1 and deleted_at is null", [id, Date.now()])).rowCount) return false;
        await sql.query("delete from volume_snapshots where volume = $1", [id]);
        await sql.query("delete from volume_watchers where volume = $1", [id]);
        await deleteTail(sql, id);
        return true;
      });
      if (!deleted) throw new HttpError(404, `Unknown volume ${id}`);
      volume.fault = new HttpError(404, `Unknown volume ${id}`);
      await this.unload(volume);
      return { deleted: true };
    }
    throw new HttpError(400, `Unknown volume operation ${op}`);
  }

  /** Store content as chunks (from any node) and return what `commit` needs. */
  async store(tenant: string, source: Uint8Array | AsyncIterable<Uint8Array>, limit = VOLUME_LIMITS.fileBytes) {
    // Checked once, then against what this write adds: content already stored (the same chunks) still counts, so
    // a write near the limit may be refused that would have stored nothing new.
    const quota = await this.options.quota?.(tenant);
    if (quota && quota.used >= quota.limit) throw storageFull(quota);
    const chunks: string[] = [];
    let size = 0;
    let parts: Buffer[] = [];
    let buffered = 0;
    let writes: Promise<void>[] = [];
    const emit = async (piece: Buffer) => {
      const hash = sha256(piece);
      chunks.push(hash);
      // Touched before it is written (see storage-gc.ts): a collection deleting it meanwhile puts it back.
      writes.push(this.touch(tenant, [hash]).then(() => this.storage.writeBlob(chunkKey(tenant, hash), piece)).then(() => this.collectable(tenant, hash)));
      if (writes.length >= 4) { await Promise.all(writes); writes = []; }
    };
    for await (const data of source instanceof Uint8Array ? [source] : source) {
      size += data.byteLength;
      if (size > limit) throw new HttpError(413, `Files are limited to ${limit} bytes`);
      if (quota && quota.used + size > quota.limit) throw storageFull(quota);
      parts.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      buffered += data.byteLength;
      while (buffered >= CHUNK_BYTES) {
        const joined = Buffer.concat(parts);
        await emit(joined.subarray(0, CHUNK_BYTES));
        parts = [joined.subarray(CHUNK_BYTES)];
        buffered -= CHUNK_BYTES;
      }
    }
    if (buffered) await emit(Buffer.concat(parts));
    await Promise.all(writes);
    return { chunks, size };
  }

  /**
   * Save bytes (or a stream of them, a chunk at a time) to a path in a volume, from any node: its
   * content type is `contentType` when that says something, else sniffed from its first bytes and
   * name. `ifMatch` makes it conditional on a version (0: must not exist); `by` records who wrote it.
   */
  async put(tenant: string, id: string, path: string, source: Uint8Array | AsyncIterable<Uint8Array>, options: { contentType?: string; ifMatch?: number; by?: string; limit?: number } = {}): Promise<{ path: string } & FileEntry> {
    let head = source instanceof Uint8Array ? Buffer.from(source.subarray(0, 512)) : Buffer.alloc(0);
    const peek = async function* (stream: AsyncIterable<Uint8Array>) {
      for await (const data of stream) {
        if (head.length < 512) head = Buffer.concat([head, data.subarray(0, 512 - head.length)]);
        yield data;
      }
    };
    const stored = await this.store(tenant, source instanceof Uint8Array ? source : peek(source), options.limit);
    const contentType = declaredType(options.contentType) ?? sniffContentType(head, path);
    return this.call(id, tenant, "commit", { path, ...stored, contentType, ...(options.ifMatch !== undefined ? { ifMatch: options.ifMatch } : {}), ...(options.by ? { by: options.by } : {}) });
  }

  /**
   * Record that `hashes` were just written or referred to (storage-gc.ts): a collection of them that began before stands
   * down. Only chunks already collectable have a row to touch.
   */
  async touch(tenant: string, hashes: string[]) {
    if (!hashes.length) return;
    await this.db.query("update chunk_touches set at = $3 where tenant = $1 and hash = any($2::text[])", [tenant, [...new Set(hashes)], Date.now()]);
  }

  /** A chunk a write just stored: collectable once nothing refers to it (storage-gc.ts). */
  private async collectable(tenant: string, hash: string) {
    await this.db.query(`
      with added as (insert into chunk_touches (tenant, hash, at) values ($1, $2, $3) on conflict (tenant, hash) do update set at = excluded.at returning 1)
      insert into storage_gc (tenant) select $1 where exists (select from added) on conflict do nothing`, [tenant, hash, Date.now()]);
  }

  /** Keep `hashes` stored while `agent` exists: a FileRef it holds refers to them, whatever becomes of the file. */
  async pin(tenant: string, agent: string, hashes: string[]) {
    if (!hashes.length) return;
    await this.touch(tenant, hashes);
    await this.db.query("insert into chunk_pins (tenant, hash, agent) select $1, hash, $3 from unnest($2::text[]) as hash on conflict do nothing", [tenant, [...new Set(hashes)], agent]);
  }

  /** The chunks a volume's files refer to, read from its tree wherever it is served (storage-gc.ts). */
  async referencedChunks(id: string): Promise<Set<string>> {
    const loaded = this.loaded.get(id);
    const files = new Map<string, FileEntry>(loaded ? loaded.tree.files : []);
    if (!loaded) {
      const log = this.storage.log<TreeRecord>(treeKey(id));
      try {
        for (const record of await log.read()) {
          if (record.t === "put") files.set(record.path, record.entry);
          else if (record.t === "del") files.delete(record.path);
        }
      } finally { await log.close(); }
    }
    return new Set([...files.values()].flatMap(entry => entry.chunks));
  }

  /** The chunks a snapshot's file map refers to. */
  async snapshotChunks(id: string, snapshot: string): Promise<Set<string>> {
    const stored = await this.storage.readBlob(snapshotFilesKey(id, snapshot));
    if (!stored) return new Set();
    return new Set(Object.values(JSON.parse(Buffer.from(stored).toString("utf8")) as Record<string, FileEntry>).flatMap(entry => entry.chunks));
  }

  /** Remove a deleted volume's own objects: its tree and its snapshots' file maps (its chunks are collected as any). */
  async purge(id: string) {
    await this.storage.removeLog(treeKey(id));
    await this.storage.removeBlobs(`volumes/${id}/snapshots/`);
    await this.db.query("update volumes set purged_at = $2 where id = $1 and deleted_at is not null", [id, Date.now()]);
  }

  /** A file's content type: as recorded, else sniffed from its first bytes (files from before types were recorded). */
  async contentType(tenant: string, path: string, entry: Pick<FileEntry, "size" | "chunks" | "contentType">) {
    return entry.contentType ?? sniffContentType(await this.readRange(tenant, entry, 0, 512), path);
  }

  private async chunk(tenant: string, hash: string) {
    const data = await this.storage.readBlob(chunkKey(tenant, hash));
    if (!data || sha256(data) !== hash) throw new Error(`File content is missing or corrupt (chunk ${hash.slice(0, 12)})`);
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }

  /** Bytes [offset, offset + length) of a file, fetching only the chunks that overlap them. */
  async readRange(tenant: string, entry: Pick<FileEntry, "size" | "chunks">, offset: number, length: number): Promise<Buffer> {
    const end = Math.min(entry.size, offset + length);
    if (offset >= end) return Buffer.alloc(0);
    const first = Math.floor(offset / CHUNK_BYTES);
    const last = Math.floor((end - 1) / CHUNK_BYTES);
    const parts = await Promise.all(entry.chunks.slice(first, last + 1).map(hash => this.chunk(tenant, hash)));
    return Buffer.concat(parts).subarray(offset - first * CHUNK_BYTES, end - first * CHUNK_BYTES);
  }

  /** Stream bytes [start, end) one chunk at a time. */
  async *stream(tenant: string, entry: Pick<FileEntry, "size" | "chunks">, start = 0, end = entry.size) {
    for (let index = Math.floor(start / CHUNK_BYTES); index * CHUNK_BYTES < end; index++) {
      const data = await this.chunk(tenant, entry.chunks[index]);
      yield data.subarray(Math.max(0, start - index * CHUNK_BYTES), Math.min(data.length, end - index * CHUNK_BYTES));
    }
  }

  /** The id of an agent's default workspace volume, stable so re-provisioning finds it. */
  static workspaceOf(agent: string) { return `vol_${sha256(`workspace:${agent}`).slice(0, 24)}`; }

  /**
   * Validate an agent's mounts: the tenant's own volumes at distinct, non-nested
   * absolute paths. Without `requested`, the agent gets its own workspace volume at /workspace.
   */
  async mountsFor(tenant: string, agent: string, requested: unknown): Promise<Mount[]> {
    if (requested === undefined) {
      const id = VolumeService.workspaceOf(agent);
      await this.writeNew({ version: 1, id, tenant, name: "workspace", createdAt: Date.now() });
      if ((await this.readHeader(id))?.tenant !== tenant) throw new HttpError(409, "Workspace volume belongs to another tenant");
      return [{ volumeId: id, path: "/workspace", mode: "rw" }];
    }
    if (!Array.isArray(requested) || requested.length > VOLUME_LIMITS.mounts) throw new HttpError(400, `mounts must be an array of at most ${VOLUME_LIMITS.mounts}`);
    const mounts: Mount[] = [];
    for (const input of requested) {
      if (!input || typeof input !== "object" || Object.keys(input).some(key => !["volumeId", "path", "mode", "subpath", "notify"].includes(key))) throw new HttpError(400, "A mount is {volumeId, path, mode: \"ro\" | \"rw\", subpath?, notify?}");
      const { volumeId, mode, notify } = input as Record<string, unknown>;
      const path = normalizePath((input as Record<string, unknown>).path, "mount path");
      if (path === "/") throw new HttpError(400, "A mount path needs a name, like /workspace");
      if (mode !== "ro" && mode !== "rw") throw new HttpError(400, "mode must be ro or rw");
      if (notify !== undefined && typeof notify !== "boolean") throw new HttpError(400, "notify must be a boolean");
      if (!validVolumeId(volumeId) || !await this.owns(volumeId, tenant)) throw new HttpError(404, `Unknown volume ${String(volumeId)}`);
      if (mounts.some(other => within(path, other.path) || within(other.path, path))) throw new HttpError(400, `Mount path ${path} overlaps another mount`);
      const subpath = (input as Record<string, unknown>).subpath === undefined ? "/" : normalizePath((input as Record<string, unknown>).subpath, "subpath");
      mounts.push({ volumeId, path, mode, ...(subpath !== "/" ? { subpath } : {}), ...(notify ? { notify } : {}) });
    }
    return mounts;
  }

  /**
   * Record which volumes wake `agent` on change, after its mounts changed from `previous` to `next`.
   * The watches are the agent's, so they are written under its owner's `claim`.
   */
  async watch(agent: string, tenant: string, previous: Mount[], next: Mount[], claim: Claim | undefined) {
    const volumes = new Set([...previous, ...next].map(mount => mount.volumeId));
    await underClaim(this.db, claim, async sql => {
      for (const volumeId of volumes) {
        const mounts = next.filter(mount => mount.volumeId === volumeId && mount.notify).map(mount => ({ path: mount.path, subpath: mount.subpath ?? "/" }));
        if (mounts.length) {
          await sql.query("insert into volume_watchers (volume, agent, tenant, mounts) values ($1, $2, $3, $4) on conflict (volume, agent) do update set tenant = excluded.tenant, mounts = excluded.mounts",
            [volumeId, agent, tenant, JSON.stringify(mounts)]);
        } else if (previous.some(mount => mount.volumeId === volumeId && mount.notify)) await sql.query("delete from volume_watchers where volume = $1 and agent = $2", [volumeId, agent]);
      }
    });
  }

  /** Coalesce changes briefly, then prompt each watching agent once about the ones in its mounts. */
  private queueNotification(volume: Volume, change: Change) {
    if (!this.options.deliver) return;
    volume.pending.push(change);
    volume.notifying ??= setTimeout(() => {
      volume.notifying = undefined;
      const changes = volume.pending.splice(0);
      void this.notify(volume, changes).catch(error => console.error(JSON.stringify({ type: "volume_notify_failed", volume: volume.header.id, error: safeError(error) })));
    }, NOTIFY_DELAY_MS);
  }

  private async notify(volume: Volume, changes: Change[]) {
    const id = volume.header.id;
    const { rows } = await this.db.query("select agent, tenant, mounts from volume_watchers where volume = $1 order by agent", [id]);
    for (const watcher of rows as Watcher[]) {
      if (watcher.tenant !== volume.header.tenant) continue;
      // An agent is not woken by its own writes.
      const seen = changes.filter(change => change.by !== watcher.agent).flatMap(change => watcher.mounts
        .filter(mount => within(change.path, mount.subpath))
        .map(mount => `${mount.path}${change.path.slice(mount.subpath === "/" ? 0 : mount.subpath.length)} (${change.kind === "write" ? "written" : "deleted"})`));
      if (!seen.length) continue;
      const text = `Files changed in a mounted volume:\n${seen.slice(0, 50).join("\n")}${seen.length > 50 ? `\n...and ${seen.length - 50} more` : ""}`;
      try { await this.options.deliver!(watcher.agent, watcher.tenant, { id: `volume-${id}-${changes[0].seq}-${changes.at(-1)!.seq}`, method: "prompt", params: { text, allowDisconnected: true } }); }
      catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 404 || status === 410) await this.db.query("delete from volume_watchers where volume = $1 and agent = $2", [id, watcher.agent]);
        else throw error;
      }
    }
  }

  definitions() { return volumeToolDefinitions(); }
  tool(context: ToolContext, name: string, args: Record<string, unknown>, signal: AbortSignal) { return runVolumeTool(this, context, name, args, signal); }

  private async unload(volume: Volume) {
    if (this.loaded.get(volume.header.id) === volume) this.loaded.delete(volume.header.id);
    if (volume.notifying) {
      clearTimeout(volume.notifying);
      volume.notifying = undefined;
      await this.notify(volume, volume.pending.splice(0)).catch(() => {});
    }
    await volume.log.close().catch(() => {});
    if (volume.claim) await this.options.ownership!.release(volume.claim).catch(() => {});
  }

  /** Unload idle volumes. */
  private async tick() {
    const now = Date.now();
    for (const volume of [...this.loaded.values()]) {
      if (this.closed) return;
      if (!volume.active && !volume.notifying && now - volume.lastActive >= this.idleMs) await this.unload(volume);
    }
  }

  /** Give up every volume not in use now, so any node can serve it next. */
  async releaseIdle() {
    for (const volume of [...this.loaded.values()]) if (!volume.active && !volume.notifying) await this.unload(volume);
  }

  /** Volumes this node serves now. */
  get size() { return this.loaded.size; }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const volume of [...this.loaded.values()]) {
      await volume.queue;
      await this.unload(volume);
    }
  }
}
