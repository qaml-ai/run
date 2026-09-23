import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { AppendLog } from "../shared/append-log.ts";
import type { Lease, LeaseStore } from "../shared/leases.ts";
import { PreconditionFailed, type Storage } from "../shared/storage.ts";
import { NotOwner } from "./client-sessions.ts";
import { HttpError } from "./http.ts";
import { errorText, type ToolDefinition } from "./protocol.ts";
import { runVolumeTool, volumeToolDefinitions, type ToolContext } from "./volume-tools.ts";

/**
 * Volumes: shared file trees agents mount, without POSIX. A volume is an actor
 * like an agent: one node at a time holds its lease and orders its writes.
 *
 *   volumes/<id>                         header (tenant, name, tombstone)
 *   volumes/<id>/tree                    append log of file puts and deletes, folded into a base
 *   volumes/<id>/snapshots/<snap>        snapshot summary; its file map is in snapshot-files/<snap>
 *   volumes/<id>/watchers/<agent>        mounts that wake an agent when files change
 *   volumes/index/<tenant>/<id>          the tenant's volumes
 *   chunks/<tenant>/<aa>/<sha256>        file contents, 1 MiB content-addressed chunks
 *
 * File contents never pass through the owner: any node writes chunks, then asks
 * the owner to commit the path (conditional on a version). Readers ask the owner
 * for the path's chunk list and fetch the chunks themselves.
 */
export const CHUNK_BYTES = 1024 * 1024;
export const VOLUME_LIMITS = Object.freeze({ fileBytes: 256 * 1024 * 1024, files: 100_000, mounts: 16, snapshots: 100, changes: 1000, listing: 1000 });
const FOLD_AFTER_RECORDS = 1024;
const NOTIFY_DELAY_MS = 1000;

export interface Mount { volumeId: string; path: string; mode: "ro" | "rw"; subpath?: string; notify?: boolean }
export interface FileEntry { version: number; size: number; chunks: string[]; updatedAt: number; by?: string }
export interface Change { seq: number; path: string; kind: "write" | "delete"; version?: number; size?: number; by?: string; at: number }
interface VolumeHeader { version: 1; id: string; tenant: string; name: string; createdAt: number; deleted?: number; origin?: { volume: string; snapshot?: string; seq: number } }
interface SnapshotSummary { id: string; volume: string; name: string; seq: number; createdAt: number; files: number; bytes: number }
interface Watcher { agent: string; tenant: string; mounts: { path: string; subpath: string }[] }
type TreeRecord =
  | { t: "base"; seq: number }
  | { t: "put"; seq: number; path: string; entry: FileEntry }
  | { t: "del"; seq: number; path: string; at: number; by?: string };
type Volume = {
  header: VolumeHeader; lease?: Lease; tree: Tree; seq: number; log: AppendLog<TreeRecord>;
  /** Writes are ordered through this chain. */
  queue: Promise<unknown>; active: number; lastActive: number; fault?: Error;
  changes: Change[]; pending: Change[]; notifying?: ReturnType<typeof setTimeout>;
};
export type VolumeRequest = { id: string; method: string; params: Record<string, unknown> };
export interface VolumeOptions {
  storage: Storage;
  /** With leases, one node at a time serves each volume, identified by `node`. */
  leases?: LeaseStore; node?: string; leaseTtlMs?: number;
  /** Unload a volume (and release its lease) after this long without use. */
  idleMs?: number;
  /** Run an operation on the node that owns a volume (a signed node-to-node POST). */
  peer?: (owner: string, path: string, body: unknown) => Promise<unknown>;
  /** Submit a request to an agent wherever it is served; wakes agents watching a volume. */
  deliver?: (agent: string, tenant: string, request: VolumeRequest) => Promise<unknown>;
}

export const validVolumeId = (value: unknown): value is string => typeof value === "string" && /^vol_[a-f0-9]{24}$/.test(value);
const newId = (prefix: string, bytes: number) => `${prefix}_${randomBytes(bytes).toString("hex")}`;
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const headerKey = (id: string) => `volumes/${id}`;
const treeKey = (id: string) => `volumes/${id}/tree`;
const indexKey = (tenant: string, id = "") => `volumes/index/${tenant}/${id}`;
const snapshotKey = (id: string, snapshot = "") => `volumes/${id}/snapshots/${snapshot}`;
const snapshotFilesKey = (id: string, snapshot: string) => `volumes/${id}/snapshot-files/${snapshot}`;
const watcherKey = (id: string, agent = "") => `volumes/${id}/watchers/${agent}`;
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
  readonly storage: Storage;
  readonly options: VolumeOptions;
  private readonly loaded = new Map<string, Volume>();
  private readonly loading = new Map<string, Promise<Volume | undefined>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(options: VolumeOptions) {
    this.options = options;
    this.storage = options.storage;
    this.timer = setInterval(() => void this.tick(), Math.max(50, Math.min(Math.floor(this.leaseTtl / 3), Math.floor(this.idleMs / 2))));
    this.timer.unref();
  }

  private get leaseTtl() { return this.options.leaseTtlMs ?? 30_000; }
  private get idleMs() { return this.options.idleMs ?? 5 * 60_000; }
  private get node() { return this.options.node ?? "local"; }

  async create(tenant: string, input: { name?: unknown } = {}, id = newId("vol", 12)) {
    const name = input.name === undefined ? "volume" : input.name;
    if (typeof name !== "string" || !name.trim() || name.length > 120) throw new HttpError(400, "name must be 1–120 characters");
    const header: VolumeHeader = { version: 1, id, tenant, name: name.trim(), createdAt: Date.now() };
    await this.writeNew(header);
    return this.summary(header);
  }

  private async writeNew(header: VolumeHeader) {
    await this.storage.writeJson(headerKey(header.id), header, null);
    await this.storage.writeJson(indexKey(header.tenant, header.id), { id: header.id, name: header.name, createdAt: header.createdAt });
  }

  private summary(header: VolumeHeader, tree?: Tree, seq = 0) {
    return { id: header.id, name: header.name, createdAt: header.createdAt, ...(header.origin ? { origin: header.origin } : {}), seq, files: tree?.files.size ?? 0, bytes: tree?.bytes ?? 0 };
  }

  async list(tenant: string) {
    const keys = await this.storage.listJson(indexKey(tenant));
    const entries = await Promise.all(keys.map(key => this.storage.readJson<{ id: string; name: string; createdAt: number }>(key)));
    return entries.flatMap(entry => entry ? [entry.value] : []).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Whether `id` is one of `tenant`'s volumes (one read). */
  async owns(id: string, tenant: string) {
    return validVolumeId(id) && !!await this.storage.readJson(indexKey(tenant, id));
  }

  /** The live owner of a volume when it is another node; undefined when this node can serve it. */
  async ownerElsewhere(id: string): Promise<string | undefined> {
    if (!this.options.leases || this.loaded.has(id)) return undefined;
    const lease = await this.options.leases.get(id);
    return lease?.live && lease.owner !== this.node ? lease.owner : undefined;
  }

  /** Run an owner operation here or on the owning node, following a moved volume a few times. */
  async call(id: string, tenant: string, op: string, args: Record<string, unknown> = {}): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        const owner = await this.ownerElsewhere(id);
        if (!owner) return await this.handle(id, tenant, op, args);
        if (!this.options.peer) throw new NotOwner(owner);
        return await this.options.peer(owner, `/internal/volumes/${id}/ops`, { tenant, op, args });
      } catch (error) {
        if ((error as HttpError).status !== 503 || attempt >= 4) throw error;
        await sleep(100 * 2 ** attempt);
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
    if (!validVolumeId(id) || !(await this.storage.readJson<VolumeHeader>(headerKey(id)))) return undefined;
    // Take ownership before reading the log, so no other node appends meanwhile.
    let lease: Lease | undefined;
    if (this.options.leases) {
      const acquired = await this.options.leases.acquire(id, this.node, this.leaseTtl);
      if ("heldBy" in acquired) throw new NotOwner(acquired.heldBy.owner);
      lease = acquired.lease;
    }
    try {
      const stored = await this.storage.readJson<VolumeHeader>(headerKey(id));
      if (!stored || stored.value.deleted) { if (lease) await this.options.leases!.release(lease); return undefined; }
      const volume: Volume = { header: stored.value, lease, tree: new Tree(), seq: 0, log: this.storage.log<TreeRecord>(treeKey(id)), queue: Promise.resolve(), active: 0, lastActive: Date.now(), changes: [], pending: [] };
      for (const record of await volume.log.read()) this.apply(volume, record);
      this.loaded.set(id, volume);
      return volume;
    } catch (error) {
      if (lease) await this.options.leases!.release(lease).catch(() => {});
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
      if (op === "stat") return this.stat(volume, normalizePath(args.path));
      if (op === "ls") return this.ls(volume, normalizePath(args.path));
      if (op === "list") return this.listFiles(volume, args);
      if (op === "changes") return this.changes(volume, Number(args.since ?? 0));
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

  private stat(volume: Volume, path: string) {
    const entry = volume.tree.files.get(path);
    if (entry) return { type: "file", path, ...entry };
    if (volume.tree.children.has(path)) return { type: "directory", path };
    throw new HttpError(404, `${path} does not exist`);
  }

  private ls(volume: Volume, path: string) {
    const names = volume.tree.children.get(path);
    if (!names) throw new HttpError(404, volume.tree.files.has(path) ? `${path} is a file` : `${path} does not exist`);
    const entries = [...names].sort().slice(0, VOLUME_LIMITS.listing).map(name => {
      const child = path === "/" ? `/${name}` : `${path}/${name}`;
      const entry = volume.tree.files.get(child);
      return entry ? { name, type: "file", size: entry.size, version: entry.version } : { name, type: "directory" };
    });
    return { path, entries, ...(names.size > entries.length ? { truncated: true } : {}) };
  }

  /** Files under `path` (optionally matching a glob relative to it), paged by `after`. */
  private listFiles(volume: Volume, args: Record<string, any>) {
    const path = normalizePath(args.path ?? "/");
    const limit = Math.min(VOLUME_LIMITS.listing, Math.max(1, Number(args.limit ?? VOLUME_LIMITS.listing) || VOLUME_LIMITS.listing));
    const pattern = args.glob === undefined ? undefined : globRegex(args.glob);
    const files: ({ path: string } & FileEntry)[] = [];
    const single = volume.tree.files.get(path);
    const source: Iterable<[string, FileEntry]> = single ? [[path, single]] : volume.tree.walk(path);
    let passed = args.after === undefined;
    for (const [file, entry] of source) {
      if (!passed) { passed = file === args.after; continue; }
      if (pattern && !pattern.test(single ? nameOf(file) : relativeTo(file, path))) continue;
      if (files.length === limit) return { files, next: files.at(-1)!.path };
      files.push({ path: file, ...entry });
    }
    return { files };
  }

  private changes(volume: Volume, since: number) {
    const oldest = volume.changes[0]?.seq ?? volume.seq + 1;
    return { seq: volume.seq, changes: volume.changes.filter(change => change.seq > since), ...(since < oldest - 1 && since < volume.seq ? { gap: true } : {}) };
  }

  private async snapshots(id: string) {
    const keys = await this.storage.listJson(snapshotKey(id));
    const entries = await Promise.all(keys.map(key => this.storage.readJson<SnapshotSummary>(key)));
    return entries.flatMap(entry => entry ? [entry.value] : []).sort((a, b) => a.createdAt - b.createdAt);
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
      this.check(volume, path, args.ifMatch);
      const conflict = volume.tree.conflict(path);
      if (conflict) throw new HttpError(409, conflict);
      if (!volume.tree.files.has(path) && volume.tree.files.size >= VOLUME_LIMITS.files) throw new HttpError(507, `A volume holds at most ${VOLUME_LIMITS.files} files`);
      const seq = volume.seq + 1;
      const entry: FileEntry = { version: seq, size: args.size, chunks: chunks as string[], updatedAt: Date.now(), ...(typeof args.by === "string" ? { by: args.by } : {}) };
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
      if ((await this.storage.listJson(snapshotKey(id))).length >= VOLUME_LIMITS.snapshots) throw new HttpError(409, `A volume keeps at most ${VOLUME_LIMITS.snapshots} snapshots; delete one first`);
      const name = args.name === undefined ? `seq ${volume.seq}` : args.name;
      if (typeof name !== "string" || !name.trim() || name.length > 120) throw new HttpError(400, "name must be 1–120 characters");
      // Metadata only: the snapshot shares every chunk with the volume.
      const snapshot: SnapshotSummary = { id: newId("snap", 8), volume: id, name: name.trim(), seq: volume.seq, createdAt: Date.now(), files: volume.tree.files.size, bytes: volume.tree.bytes };
      await this.storage.writeJson(snapshotFilesKey(id, snapshot.id), Object.fromEntries(volume.tree.files), null);
      await this.storage.writeJson(snapshotKey(id, snapshot.id), snapshot, null);
      return snapshot;
    }
    if (op === "deleteSnapshot") {
      if (typeof args.snapshot !== "string" || !/^snap_[a-f0-9]{16}$/.test(args.snapshot) || !await this.storage.readJson(snapshotKey(id, args.snapshot))) throw new HttpError(404, "Unknown snapshot");
      await this.storage.deleteJson(snapshotKey(id, args.snapshot));
      await this.storage.deleteJson(snapshotFilesKey(id, args.snapshot));
      return { deleted: true };
    }
    if (op === "fork") {
      let files: [string, FileEntry][] = [...volume.tree.files];
      let seq = volume.seq;
      if (args.snapshot !== undefined) {
        const summary = typeof args.snapshot === "string" && /^snap_[a-f0-9]{16}$/.test(args.snapshot) ? await this.storage.readJson<SnapshotSummary>(snapshotKey(id, args.snapshot)) : undefined;
        const stored = summary && await this.storage.readJson<Record<string, FileEntry>>(snapshotFilesKey(id, args.snapshot));
        if (!summary || !stored) throw new HttpError(404, "Unknown snapshot");
        files = Object.entries(stored.value);
        seq = summary.value.seq;
      }
      const name = args.name === undefined ? `${volume.header.name} (fork)` : args.name;
      if (typeof name !== "string" || !name.trim() || name.length > 120) throw new HttpError(400, "name must be 1–120 characters");
      const header: VolumeHeader = { version: 1, id: newId("vol", 12), tenant: volume.header.tenant, name: name.trim(), createdAt: Date.now(), origin: { volume: id, ...(args.snapshot ? { snapshot: args.snapshot } : {}), seq } };
      // The fork's tree starts as a folded copy of the source's metadata; chunks are shared.
      const log = this.storage.log<TreeRecord>(treeKey(header.id));
      await log.rewrite(() => [{ t: "base", seq }, ...files.map(([path, entry]) => ({ t: "put" as const, seq: entry.version, path, entry }))]);
      await log.close();
      await this.writeNew(header);
      const tree = new Tree();
      for (const [path, entry] of files) tree.put(path, entry);
      return this.summary(header, tree, seq);
    }
    if (op === "delete") {
      const stored = await this.storage.readJson<VolumeHeader>(headerKey(id));
      if (!stored) throw new HttpError(404, `Unknown volume ${id}`);
      await this.storage.writeJson(headerKey(id), { ...stored.value, deleted: Date.now() }, stored.version);
      await this.storage.deleteJson(indexKey(volume.header.tenant, id));
      for (const key of [...await this.storage.listJson(snapshotKey(id)), ...await this.storage.listJson(`volumes/${id}/snapshot-files/`), ...await this.storage.listJson(watcherKey(id))]) await this.storage.deleteJson(key);
      volume.fault = new HttpError(404, `Unknown volume ${id}`);
      await this.unload(volume);
      return { deleted: true };
    }
    throw new HttpError(400, `Unknown volume operation ${op}`);
  }

  /** Store content as chunks (from any node) and return what `commit` needs. */
  async store(tenant: string, source: Uint8Array | AsyncIterable<Uint8Array>, limit = VOLUME_LIMITS.fileBytes) {
    const chunks: string[] = [];
    let size = 0;
    let parts: Buffer[] = [];
    let buffered = 0;
    let writes: Promise<void>[] = [];
    const emit = async (piece: Buffer) => {
      const hash = sha256(piece);
      chunks.push(hash);
      writes.push(this.storage.writeBlob(chunkKey(tenant, hash), piece));
      if (writes.length >= 4) { await Promise.all(writes); writes = []; }
    };
    for await (const data of source instanceof Uint8Array ? [source] : source) {
      size += data.byteLength;
      if (size > limit) throw new HttpError(413, `Files are limited to ${limit} bytes`);
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
      const existing = await this.storage.readJson<VolumeHeader>(headerKey(id));
      if (existing && existing.value.tenant !== tenant) throw new HttpError(409, "Workspace volume belongs to another tenant");
      if (!existing) {
        try { await this.create(tenant, { name: "workspace" }, id); }
        catch (error) { if (!(error instanceof PreconditionFailed)) throw error; }
      }
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

  /** Record which volumes wake `agent` on change, after its mounts changed from `previous` to `next`. */
  async watch(agent: string, tenant: string, previous: Mount[], next: Mount[]) {
    const volumes = new Set([...previous, ...next].map(mount => mount.volumeId));
    for (const volumeId of volumes) {
      const mounts = next.filter(mount => mount.volumeId === volumeId && mount.notify).map(mount => ({ path: mount.path, subpath: mount.subpath ?? "/" }));
      if (mounts.length) await this.storage.writeJson(watcherKey(volumeId, agent), { agent, tenant, mounts } satisfies Watcher);
      else if (previous.some(mount => mount.volumeId === volumeId && mount.notify)) await this.storage.deleteJson(watcherKey(volumeId, agent));
    }
  }

  /** Coalesce changes briefly, then prompt each watching agent once about the ones in its mounts. */
  private queueNotification(volume: Volume, change: Change) {
    if (!this.options.deliver) return;
    volume.pending.push(change);
    volume.notifying ??= setTimeout(() => {
      volume.notifying = undefined;
      const changes = volume.pending.splice(0);
      void this.notify(volume, changes).catch(error => console.error(JSON.stringify({ type: "volume_notify_failed", volume: volume.header.id, error: errorText(error) })));
    }, NOTIFY_DELAY_MS);
  }

  private async notify(volume: Volume, changes: Change[]) {
    const id = volume.header.id;
    for (const key of await this.storage.listJson(watcherKey(id))) {
      const watcher = (await this.storage.readJson<Watcher>(key))?.value;
      if (!watcher || watcher.tenant !== volume.header.tenant) continue;
      // An agent is not woken by its own writes.
      const seen = changes.filter(change => change.by !== watcher.agent).flatMap(change => watcher.mounts
        .filter(mount => within(change.path, mount.subpath))
        .map(mount => `${mount.path}${change.path.slice(mount.subpath === "/" ? 0 : mount.subpath.length)} (${change.kind === "write" ? "written" : "deleted"})`));
      if (!seen.length) continue;
      const text = `Files changed in a mounted volume:\n${seen.slice(0, 50).join("\n")}${seen.length > 50 ? `\n...and ${seen.length - 50} more` : ""}`;
      try { await this.options.deliver!(watcher.agent, watcher.tenant, { id: `volume-${id}-${changes[0].seq}-${changes.at(-1)!.seq}`, method: "prompt", params: { text } }); }
      catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 404 || status === 410) await this.storage.deleteJson(key);
        else throw error;
      }
    }
  }

  definitions(mounts: Mount[], taken: ToolDefinition[]) { return volumeToolDefinitions(mounts).filter(tool => !taken.some(other => other.name === tool.name)); }
  tool(context: ToolContext, name: string, args: Record<string, unknown>, signal: AbortSignal) { return runVolumeTool(this, context, name, args, signal); }

  private async unload(volume: Volume) {
    if (this.loaded.get(volume.header.id) === volume) this.loaded.delete(volume.header.id);
    if (volume.notifying) {
      clearTimeout(volume.notifying);
      volume.notifying = undefined;
      await this.notify(volume, volume.pending.splice(0)).catch(() => {});
    }
    await volume.log.close().catch(() => {});
    if (volume.lease) await this.options.leases!.release(volume.lease).catch(() => {});
  }

  /** Renew leases (fencing volumes whose lease was lost) and unload idle volumes. */
  private async tick() {
    const now = Date.now();
    for (const volume of [...this.loaded.values()]) {
      if (this.closed) return;
      if (!volume.active && !volume.notifying && now - volume.lastActive >= this.idleMs) { await this.unload(volume); continue; }
      if (!volume.lease) continue;
      const renewed = await this.options.leases!.renew(volume.lease, this.leaseTtl).catch(() => undefined);
      if (renewed) { volume.lease = renewed; continue; }
      volume.fault = new HttpError(503, "This node lost ownership of the volume; retry");
      if (this.loaded.get(volume.header.id) === volume) this.loaded.delete(volume.header.id);
    }
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const volume of [...this.loaded.values()]) {
      await volume.queue;
      await this.unload(volume);
    }
  }
}
