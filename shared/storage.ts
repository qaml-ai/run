import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileAppendLog, type AppendLog } from "./append-log.ts";
import type { Claim } from "../src/ownership.ts";

/**
 * The data plane: bulk state that is appended or written once. Coordination and
 * small mutable metadata are in Postgres (see src/db.ts). Keys are slash-separated
 * paths without extensions, e.g. "sessions/client_ab12/transcript".
 *
 * - `fileStorage` keeps the single-host layout (`<key>.jsonl`, `<key>.bin`).
 * - `s3Storage` makes state independent of any host. A log's hot records go to
 *   a `LogTail` (Postgres) and are compacted into immutable segment objects
 *   (see `segmentLog`), so appends never cost an object write.
 */
export interface Storage {
  /** `claim` fences appends: once it is no longer current, every write fails. */
  log<T>(key: string, claim?: Claim): AppendLog<T>;
  /** Immutable binary objects, e.g. content-addressed chunks: writing a key that exists is a no-op. */
  readBlob(key: string): Promise<Uint8Array | undefined>;
  writeBlob(key: string, data: Uint8Array): Promise<void>;
}

export class PreconditionFailed extends Error {
  constructor(key: string) { super(`Conditional write lost for ${key}: another writer changed it`); this.name = "PreconditionFailed"; }
}

export const validKey = (key: string) => {
  if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/.test(key) || key.split("/").some(part => part === "." || part === "..")) throw new Error(`Invalid storage key: ${key}`);
  return key;
};

/**
 * Files under `root`. By default one process owns the directory (the single-host
 * layout). With a `tail`, several processes (or hosts on a shared filesystem) can
 * share logs: they are segment files plus the tail, as on S3.
 */
export function fileStorage(root: string, options: { tail?: LogTail } = {}): Storage {
  const path = (key: string, extension: string) => join(root, `${validKey(key)}${extension}`);
  return {
    log: (key, claim) => options.tail ? segmentLog(fileSegments(path(key, ".log")), key, options.tail, claim) : fileAppendLog(path(key, ".jsonl")),
    async readBlob(key) {
      try { return await readFile(path(key, ".bin")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    },
    async writeBlob(key, data) {
      const file = path(key, ".bin");
      if (await stat(file).then(() => true, () => false)) return;
      await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(data); await handle.datasync(); } finally { await handle.close(); }
      // Same key, same bytes: a concurrent writer's rename is harmless.
      await rename(temporary, file);
    },
  };
}

function fileSegments(directory: string): SegmentStore {
  return {
    async list() {
      let names: string[] = [];
      try { names = await readdir(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      return {
        segments: names.filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b),
        snapshots: names.filter(name => /^snapshot-\d+$/.test(name)).map(name => Number(name.slice(9))).sort((a, b) => a - b),
      };
    },
    read: name => readFile(join(directory, name), "utf8"),
    async create(name, body) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      let file;
      try { file = await open(join(directory, name), "wx", 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new PreconditionFailed(`${directory}/${name}`); throw error; }
      try { await file.writeFile(body, "utf8"); await file.datasync(); } finally { await file.close(); }
    },
    async remove(names) { await Promise.all(names.map(name => rm(join(directory, name), { force: true }))); },
  };
}

/** In-process storage for tests. `puts` counts object writes, as S3 would bill them. */
export function memoryStorage(tail: LogTail): Storage & { logs: Map<string, Map<string, string>>; blobs: Map<string, Uint8Array>; puts: number } {
  const logs = new Map<string, Map<string, string>>();
  const blobs = new Map<string, Uint8Array>();
  const storage = {
    logs, blobs, puts: 0,
    log<T>(key: string, claim?: Claim) { return segmentLog<T>(memorySegments(logs, validKey(key), () => storage.puts++), key, tail, claim); },
    async readBlob(key: string) { const data = blobs.get(validKey(key)); return data && Uint8Array.from(data); },
    async writeBlob(key: string, data: Uint8Array) { if (!blobs.has(validKey(key))) { storage.puts++; blobs.set(key, Uint8Array.from(data)); } },
  };
  return storage;
}

/**
 * The segment operations a log needs from an object store. Segment `n` holds
 * records through sequence `n`; a snapshot at `n` replaces everything up to `n`.
 * Objects are created once and never change.
 */
export interface SegmentStore {
  list(): Promise<{ segments: number[]; snapshots: number[] }>;
  read(name: string): Promise<string>;
  /** Create a segment, snapshot or blob; throws PreconditionFailed if it already exists. */
  create(name: string, body: string): Promise<void>;
  remove(names: string[]): Promise<void>;
}

function memorySegments(logs: Map<string, Map<string, string>>, key: string, put: () => void): SegmentStore {
  const objects = () => {
    let entry = logs.get(key);
    if (!entry) { entry = new Map(); logs.set(key, entry); }
    return entry;
  };
  return {
    async list() {
      const names = [...objects().keys()];
      return {
        segments: names.filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b),
        snapshots: names.filter(name => name.startsWith("snapshot-")).map(name => Number(name.slice(9))).sort((a, b) => a - b),
      };
    },
    async read(name) { const body = objects().get(name); if (body === undefined) throw new Error(`Missing log object ${key}/${name}`); return body; },
    async create(name, body) { if (objects().has(name)) throw new PreconditionFailed(`${key}/${name}`); put(); objects().set(name, body); },
    async remove(names) { for (const name of names) objects().delete(name); },
  };
}


/** One record (or, for a snapshot, the JSON array of records it replaces the log with) in a log's tail. */
export interface TailRow { seq: number; snapshot: boolean; body: string | null; blob: string | null }

/**
 * Where a log's recent records live until compaction moves them to Storage:
 * Postgres (src/log-tail.ts). Writes by a writer whose claim is no longer current
 * fail in the same statement, so a stale owner can never interleave with the next.
 */
export interface LogTail {
  /** The log's rows in seq order. */
  rows(key: string): Promise<TailRow[]>;
  last(key: string): Promise<number | undefined>;
  /** Insert rows; false when `claim` is no longer current (or another writer took a seq). */
  append(key: string, claim: Claim | undefined, rows: TailRow[]): Promise<boolean>;
  /**
   * One compaction at a time per log, holding `claim`: `fold` moves the rows to
   * Storage and returns the seq Storage now covers through; rows up to it are then
   * deleted. False when `claim` is no longer current.
   */
  compact(key: string, claim: Claim | undefined, fold: (rows: TailRow[]) => Promise<number>): Promise<boolean>;
}

const segmentName = (sequence: number) => String(sequence).padStart(12, "0");
const covered = ({ segments, snapshots }: { segments: number[]; snapshots: number[] }) => Math.max(-1, ...segments, ...snapshots);
/** Records above this go to Storage as blobs, so the tail stays small. */
const BLOB_BYTES = 64 * 1024;
/** A tail past either bound is compacted without waiting for the actor to unload. */
const TAIL_RECORDS = 512;
const TAIL_BYTES = 4 * 1024 * 1024;

/**
 * An AppendLog over immutable segments plus a hot tail. Every record has a
 * sequence number. Flushes insert tail rows (one round trip); segment `n` holds
 * records through `n`, and a snapshot at `n` replaces everything through `n`.
 * Compaction (on close, or when the tail passes its bounds) writes the tail's
 * rows as one segment, or one snapshot if a rewrite is among them, then deletes
 * the rows. Reads take Storage, then tail rows above what it covers, so a crash
 * between the two steps of a compaction repeats no record.
 * Non-durable flushes are coalesced briefly to save round trips. A writer whose
 * append is rejected is fenced: every later write fails.
 */
export function segmentLog<T>(store: SegmentStore, key: string, tail: LogTail, claim?: Claim, options: { coalesceMs?: number } = {}): AppendLog<T> {
  let buffer: string[] = [];
  let next: number | undefined;
  let appended = 0;
  /** What this writer knows is in the tail above Storage. */
  let tailRecords = 0, tailBytes = 0;
  let fenced: Error | undefined;
  let closing: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();
  const serialize = <R>(work: () => Promise<R>): Promise<R> => {
    const result = chain.then(work);
    chain = result.then(() => {}, () => {});
    return result;
  };
  const fence = () => fenced ??= new PreconditionFailed(`${key} (another owner is appending)`);
  const position = async () => next ??= Math.max(covered(await store.list()), await tail.last(key) ?? -1) + 1;
  const body = (row: TailRow) => row.body ?? store.read(`blob-${row.blob}`);

  async function insert(texts: string[], snapshot: boolean) {
    const first = await position();
    const rows = await Promise.all(texts.map(async (text, index): Promise<TailRow> => {
      if (Buffer.byteLength(text) <= BLOB_BYTES) return { seq: first + index, snapshot, body: text, blob: null };
      const hash = createHash("sha256").update(text).digest("hex");
      // Content-addressed, so a blob another (even stale) writer created is the same bytes.
      try { await store.create(`blob-${hash}`, text); } catch (error) { if (!(error instanceof PreconditionFailed)) throw error; }
      return { seq: first + index, snapshot, body: null, blob: hash };
    }));
    if (!await tail.append(key, claim, rows)) throw fence();
    next = first + rows.length;
    tailRecords += rows.length;
    for (const row of rows) tailBytes += row.body?.length ?? 0;
  }

  async function compact() {
    if (fenced) throw fenced;
    if (!tailRecords) return;
    const blobs: string[] = [];
    let superseded: string[] = [];
    const held = await tail.compact(key, claim, async rows => {
      const listing = await store.list();
      const through = covered(listing);
      const fresh = rows.filter(row => row.seq > through);
      for (const row of rows) if (row.blob) blobs.push(`blob-${row.blob}`);
      if (!fresh.length) return through;
      const last = fresh.at(-1)!.seq;
      const texts = await Promise.all(fresh.map(body));
      const start = fresh.findLastIndex(row => row.snapshot);
      if (start < 0) await store.create(segmentName(last), texts.join("\n") + "\n");
      else {
        await store.create(`snapshot-${segmentName(last)}`, JSON.stringify([...JSON.parse(texts[start]), ...texts.slice(start + 1).map(text => JSON.parse(text))]));
        superseded = [...listing.segments.map(segmentName), ...listing.snapshots.map(item => `snapshot-${segmentName(item)}`)];
      }
      return last;
    });
    if (!held) throw fence();
    tailRecords = tailBytes = 0;
    // Only after the rows are gone: until then a reader may still need what these replace.
    await store.remove([...superseded, ...blobs]);
  }

  const write = async () => {
    if (fenced) throw fenced;
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    try { await insert(batch, false); }
    catch (error) { if (!fenced) buffer = batch.concat(buffer); throw error; }
    if (tailRecords >= TAIL_RECORDS || tailBytes >= TAIL_BYTES) void serialize(compact).catch(() => {});
  };

  return {
    // Serialized with writes, so a read beside a live writer never moves its position back.
    read: () => serialize(async () => {
      // The tail first: a compaction between the two reads then shows up in Storage, never in neither.
      const rows = await tail.rows(key);
      const listing = await store.list();
      const snapshot = listing.snapshots.at(-1);
      let records: T[] = snapshot === undefined ? [] : JSON.parse(await store.read(`snapshot-${segmentName(snapshot)}`));
      for (const sequence of listing.segments) {
        if (snapshot !== undefined && sequence <= snapshot) continue;
        for (const line of (await store.read(segmentName(sequence))).split("\n")) if (line) records.push(JSON.parse(line));
      }
      const through = covered(listing);
      // Rows at or below `through` are left by a compaction that stopped before deleting them.
      tailRecords = rows.length;
      tailBytes = 0;
      for (const row of rows) {
        tailBytes += row.body?.length ?? 0;
        if (row.seq <= through) continue;
        const parsed = JSON.parse(await body(row));
        if (row.snapshot) records = parsed;
        else records.push(parsed);
      }
      next = Math.max(through, rows.at(-1)?.seq ?? -1) + 1;
      return records;
    }),
    append(record) {
      if (closing) throw new Error("Append log closed");
      buffer.push(JSON.stringify(record));
      appended++;
    },
    flush(durable = false) {
      if (!durable && (options.coalesceMs ?? 250) > 0) {
        timer ??= setTimeout(() => { timer = undefined; void serialize(write).catch(() => {}); }, options.coalesceMs ?? 250);
        return Promise.resolve();
      }
      if (timer) { clearTimeout(timer); timer = undefined; }
      return serialize(write);
    },
    rewrite(snapshot) {
      return serialize(async () => {
        if (fenced) throw fenced;
        const records = snapshot();
        buffer = [];
        await insert([JSON.stringify(records)], true);
        appended = 0;
      });
    },
    get appendedSinceRewrite() { return appended; },
    close() {
      if (timer) { clearTimeout(timer); timer = undefined; }
      return closing ??= serialize(async () => { await write(); await compact(); }).catch(() => {});
    },
  };
}
