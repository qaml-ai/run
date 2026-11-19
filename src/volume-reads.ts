import { createHash } from "node:crypto";
import type { Storage } from "../shared/storage.ts";
import { HttpError } from "./http-error.ts";
import { guessContentType, sniffContentType } from "./files.ts";

export const CHUNK_BYTES = 1024 * 1024;
/** What one read of many files (GET /v1/volumes/:id/files?content=true) returns at most. */
export const READ_ALL_LIMITS = Object.freeze({ files: 1000, bytes: 16 * 1024 * 1024 });
/** `data` as text when it is valid UTF-8, else undefined. */
const utf8 = (data: Buffer) => { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data); } catch { return undefined; } };
export const VOLUME_LIMITS = Object.freeze({ fileBytes: 256 * 1024 * 1024, files: 100_000, mounts: 16, snapshots: 100, pinnedSnapshots: 10_000, changes: 1000, listing: 1000 });
/** A snapshot's labels: at most 16, keys of 1–64 characters, values of at most 256. */
export const LABEL_LIMITS = Object.freeze({ count: 16, key: 64, value: 256 });
/**
 * Snapshots the runtime makes of a directory for one tool call (file-arguments.ts) are named with this prefix. They are
 * not listed, do not count toward VOLUME_LIMITS.snapshots, and are deleted after their call; any left after a crash
 * go once they are TEMPORARY_SNAPSHOT_MS old, when the next is made.
 */
export const TEMPORARY_SNAPSHOT = "file-arg:";
/** `contentType` is absent on files written before content types were recorded. */
export interface FileEntry { version: number; size: number; chunks: string[]; updatedAt: number; by?: string; contentType?: string }
export interface SnapshotSummary { id: string; volume: string; name: string; seq: number; createdAt: number; files: number; bytes: number; pinned: boolean; labels: Record<string, string> }
export type TreeRecord =
  | { t: "base"; seq: number }
  | { t: "put"; seq: number; path: string; entry: FileEntry }
  | { t: "del"; seq: number; path: string; at: number; by?: string };

export const validVolumeId = (value: unknown): value is string => typeof value === "string" && /^vol_[a-f0-9]{24}$/.test(value);
export const treeKey = (id: string) => `volumes/${id}/tree`;
export const snapshotFilesKey = (id: string, snapshot: string) => `volumes/${id}/snapshots/${snapshot}`;
export const SNAPSHOT_COLUMNS = "id, volume, name, seq, created_at as \"createdAt\", files, bytes, pinned, labels";

type VolumeSql = { query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }> };
export type VolumeTree = { tree: Tree; seq: number; snapshot?: string };

export const chunkKey = (tenant: string, hash: string) => `chunks/${tenant}/${hash.slice(0, 2)}/${hash}`;

/** A path inside a volume: absolute, `/`-separated, no `.`/`..` or empty segments. */
export function normalizePath(input: unknown, label = "path"): string {
  if (typeof input !== "string" || input.length > 1024 || /[\x00-\x1f\x7f\\]/.test(input)) throw new HttpError(400, `Invalid ${label}`);
  const parts = input.split("/").filter(Boolean);
  if (parts.some(part => part === "." || part === ".." || Buffer.byteLength(part) > 255)) throw new HttpError(400, `Invalid ${label}: ${input}`);
  return `/${parts.join("/")}`;
}
export const parentOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const within = (path: string, directory: string) => directory === "/" || path === directory || path.startsWith(`${directory}/`);
export const relativeTo = (path: string, directory: string) => (directory === "/" ? path : path.slice(directory.length)).replace(/^\//, "");

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

/** The file tree in memory: path -> entry, plus each directory's children for listings. */
export class Tree {
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

export function statVolumeFile(tree: Tree, path: string) {
  const entry = tree.files.get(path);
  if (entry) return { type: "file" as const, path, ...entry };
  if (tree.children.has(path)) return { type: "directory" as const, path };
  throw new HttpError(404, `${path} does not exist`);
}

/** Files under `path` (optionally matching a glob relative to it), paged by `after`. */
export function listVolumeFiles(tree: Tree, args: { path?: unknown; glob?: string; after?: string; limit?: number }) {
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

/** A snapshot's files and the seq it was taken at; 404 for one this volume does not have. */
export async function snapshotFiles(db: VolumeSql, storage: Pick<Storage, "readBlob">, id: string, snapshot: unknown): Promise<{ files: [string, FileEntry][]; seq: number }> {
  const summary: SnapshotSummary | undefined = typeof snapshot === "string" && /^snap_[a-f0-9]{16}$/.test(snapshot)
    ? (await db.query<SnapshotSummary>(`select ${SNAPSHOT_COLUMNS} from volume_snapshots where id = $1 and volume = $2`, [snapshot, id])).rows[0] : undefined;
  const stored = summary && await storage.readBlob(snapshotFilesKey(id, summary.id));
  if (!summary || !stored) throw new HttpError(404, "Unknown snapshot");
  return { files: Object.entries(JSON.parse(Buffer.from(stored).toString("utf8")) as Record<string, FileEntry>), seq: summary.seq };
}
/** A snapshot as a tree, to list and read it as the volume is listed and read. */
export async function snapshotTree(db: VolumeSql, storage: Pick<Storage, "readBlob">, id: string, snapshot: unknown) {
  const { files, seq } = await snapshotFiles(db, storage, id, snapshot);
  const tree = new Tree();
  for (const [path, entry] of files) tree.put(path, entry);
  return { tree, seq, snapshot: snapshot as string };
}

/** Labels as given (a string map within LABEL_LIMITS), or a 400. */
export function labelsInput(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "labels is an object of strings");
  const entries = Object.entries(value);
  if (entries.length > LABEL_LIMITS.count) throw new HttpError(400, `At most ${LABEL_LIMITS.count} labels`);
  for (const [key, label] of entries) {
    if (!key || key.length > LABEL_LIMITS.key) throw new HttpError(400, `A label's key is 1–${LABEL_LIMITS.key} characters`);
    if (typeof label !== "string" || label.length > LABEL_LIMITS.value) throw new HttpError(400, `Label ${key} must be a string of at most ${LABEL_LIMITS.value} characters`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}
/** The volume's snapshots, oldest first; with `labels`, only those that have every one of them. */
export async function listVolumeSnapshots(db: VolumeSql, id: string, labels?: Record<string, string>): Promise<SnapshotSummary[]> {
  return (await db.query<SnapshotSummary>(`select ${SNAPSHOT_COLUMNS} from volume_snapshots where volume = $1 and name not like '${TEMPORARY_SNAPSHOT}%'${labels ? " and labels @> $2::jsonb" : ""} order by created_at, id`,
    labels ? [id, JSON.stringify(labels)] : [id])).rows;
}

/** Shared readers for the immutable file chunks used by both runtime backends. */
export class VolumeFiles {
  private readonly volumeReadStorage: Pick<Storage, "readBlob">;
  constructor(storage: Pick<Storage, "readBlob">) { this.volumeReadStorage = storage; }

  /**
   * Every file under `path` (and `glob`) with its contents, at one seq (or a snapshot's): text as `text`, other bytes
   * as base64 `data`, each with its sha256. Within READ_ALL_LIMITS, else a 413 that says to narrow it. Chunks never
   * change, so files listed at one seq read as they were then, whatever is written meanwhile.
   */
  async readAll(tenant: string, at: VolumeTree, args: { path?: unknown; glob?: string }) {
    const listing = listVolumeFiles(at.tree, { path: args.path, glob: args.glob, limit: READ_ALL_LIMITS.files });
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

  /** A file's content type: as recorded, else sniffed from its first bytes (files from before types were recorded). */
  async contentType(tenant: string, path: string, entry: Pick<FileEntry, "size" | "chunks" | "contentType">) {
    return entry.contentType ?? sniffContentType(await this.readRange(tenant, entry, 0, 512), path);
  }

  private async chunk(tenant: string, hash: string) {
    const data = await this.volumeReadStorage.readBlob(chunkKey(tenant, hash));
    if (!data || createHash("sha256").update(data).digest("hex") !== hash) throw new Error(`File content is missing or corrupt (chunk ${hash.slice(0, 12)})`);
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
}
