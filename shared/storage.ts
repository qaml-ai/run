import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileAppendLog, type AppendLog, type CommitEffect } from "./append-log.ts";
import type { Claim } from "../src/ownership.ts";
import { buggify } from "../src/buggify.ts";
import { sometimes } from "../src/assert.ts";

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
  /** Delete a log's objects (segments, snapshots and blobs), for an actor that is gone. Its tail rows are the caller's. */
  removeLog(key: string): Promise<void>;
  /** Immutable binary objects, e.g. content-addressed chunks: writing a key that exists is a no-op. */
  readBlob(key: string): Promise<Uint8Array | undefined>;
  writeBlob(key: string, data: Uint8Array): Promise<void>;
  /** Delete every blob under `prefix` (a directory, ending in "/"), for an actor that is gone. */
  removeBlobs(prefix: string): Promise<void>;
  /** Delete one blob (a chunk nothing refers to any more); a key that is gone already is a no-op. */
  removeBlob(key: string): Promise<void>;
  /** Every stored object under `prefix`, with its size: for reconciling metered storage, not for reading state. */
  objects?(prefix: string): AsyncIterable<{ key: string; bytes: number }>;
  /** Whether every object this Storage creates or deletes is reported to its meter (single-host logs, appended files, are not). */
  metered?: boolean;
}

/**
 * Told the size of each object a Storage creates (positive) or deletes (negative), by
 * its key as `objects` lists it (a log's objects are `<log key>.log/<name>`), so what is
 * stored can be tracked as it changes rather than by listing it. Only objects that
 * were created count: rewriting an existing blob (a content-addressed chunk stored
 * already) or losing a race to create one reports nothing.
 */
export type StorageMeter = (key: string, bytes: number) => void;

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
export function fileStorage(root: string, options: { tail?: LogTail; meter?: StorageMeter } = {}): Storage {
  const path = (key: string, extension: string) => join(root, `${validKey(key)}${extension}`);
  const { meter } = options;
  const segments = (key: string) => meteredSegments(fileSegments(path(key, ".log")), key, meter);
  return {
    metered: !!(meter && options.tail),
    log: (key, claim) => options.tail ? segmentLog(segments(key), key, options.tail, claim) : fileAppendLog(path(key, ".jsonl")),
    async removeLog(key) {
      if (meter) await removeSegments(segments(key));
      await rm(path(key, ".log"), { recursive: true, force: true });
      await rm(path(key, ".jsonl"), { force: true });
    },
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
      try {
        try { await handle.writeFile(data); await handle.datasync(); } finally { await handle.close(); }
        // A link fails if the file exists, so of concurrent writers of a key (same key, same bytes) exactly one creates it.
        try { await link(temporary, file); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return; throw error; }
        meter?.(key, data.byteLength);
      } finally { await rm(temporary, { force: true }); }
    },
    async removeBlobs(prefix) {
      validKey(prefix.replace(/\/$/, ""));
      if (meter) for await (const { key, bytes } of this.objects!(prefix)) meter(key.replace(/\.bin$/, ""), -bytes);
      await rm(join(root, prefix), { recursive: true, force: true });
    },
    async removeBlob(key) {
      const file = path(key, ".bin");
      const size = await stat(file).then(found => found.size, () => undefined);
      if (size === undefined) return;
      await rm(file, { force: true });
      meter?.(key, -size);
    },
    async *objects(prefix) {
      let entries;
      try { entries = await readdir(join(root, prefix), { recursive: true, withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        if (!entry.isFile() || entry.name.endsWith(".tmp")) continue;
        const file = join(entry.parentPath, entry.name);
        try { yield { key: file.slice(root.length + 1), bytes: (await stat(file)).size }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    },
  };
}

function fileSegments(directory: string): SegmentStore {
  return {
    async list() {
      let names: string[] = [];
      try { names = await readdir(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const bytes = new Map<string, number>();
      await Promise.all(names.filter(name => /^((snapshot-)?\d+|blob-[a-f0-9]+)$/.test(name)).map(async name => {
        try { bytes.set(name, (await stat(join(directory, name))).size); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }));
      return {
        segments: names.filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b), bytes,
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

/**
 * In-process storage for tests. `puts` counts object writes, as S3 would bill them. `objects` are the store's contents:
 * nodes given the same share one bucket, each with its own tail and meter.
 */
export function memoryStorage(tail: LogTail, meter?: StorageMeter, objects: { logs: Map<string, Map<string, string>>; blobs: Map<string, Uint8Array> } = { logs: new Map(), blobs: new Map() }): Storage & { logs: Map<string, Map<string, string>>; blobs: Map<string, Uint8Array>; puts: number } {
  const { logs, blobs } = objects;
  const segments = (key: string) => meteredSegments(memorySegments(logs, validKey(key), () => storage.puts++), key, meter);
  const storage = {
    logs, blobs, puts: 0, metered: !!meter,
    log<T>(key: string, claim?: Claim) { return segmentLog<T>(segments(key), key, tail, claim); },
    async removeLog(key: string) { if (meter) await removeSegments(segments(key)); logs.delete(validKey(key)); },
    async readBlob(key: string) { const data = blobs.get(validKey(key)); return data && Uint8Array.from(data); },
    async writeBlob(key: string, data: Uint8Array) {
      if (blobs.has(validKey(key))) return;
      storage.puts++;
      blobs.set(key, Uint8Array.from(data));
      meter?.(key, data.byteLength);
    },
    async removeBlobs(prefix: string) {
      for (const [key, data] of blobs) if (key.startsWith(prefix)) { blobs.delete(key); meter?.(key, -data.byteLength); }
    },
    async removeBlob(key: string) {
      const data = blobs.get(validKey(key));
      if (!data) return;
      blobs.delete(key);
      meter?.(key, -data.byteLength);
    },
    async *objects(prefix: string) {
      for (const [key, objects] of logs) if (key.startsWith(prefix)) for (const [name, body] of objects) yield { key: `${key}.log/${name}`, bytes: Buffer.byteLength(body) };
      for (const [key, data] of blobs) if (key.startsWith(prefix)) yield { key, bytes: data.byteLength };
    },
  };
  return storage;
}

/**
 * The segment operations a log needs from an object store. Segment `n` holds
 * records through sequence `n`; a snapshot at `n` replaces everything up to `n`.
 * Objects are created once and never change.
 */
export interface Listing { segments: number[]; snapshots: number[]; bytes?: Map<string, number> }
export interface SegmentStore {
  /** `bytes`, when the store knows it cheaply, is each object's size (segments, snapshots and blobs), by name. */
  list(): Promise<Listing>;
  read(name: string): Promise<string>;
  /** Create a segment, snapshot or blob; throws PreconditionFailed if it already exists. */
  create(name: string, body: string): Promise<void>;
  /** `sizes`, the objects' sizes from a listing, is for metering (see `meteredSegments`). */
  remove(names: string[], sizes?: Map<string, number>): Promise<void>;
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
        bytes: new Map(names.map(name => [name, Buffer.byteLength(objects().get(name)!)])),
        snapshots: names.filter(name => name.startsWith("snapshot-")).map(name => Number(name.slice(9))).sort((a, b) => a - b),
      };
    },
    async read(name) { const body = objects().get(name); if (body === undefined) throw new Error(`Missing log object ${key}/${name}`); return body; },
    async create(name, body) { if (objects().has(name)) throw new PreconditionFailed(`${key}/${name}`); put(); objects().set(name, body); },
    async remove(names) { for (const name of names) objects().delete(name); },
  };
}

/**
 * `store` reporting to `meter` the objects it creates and removes, as `<key>.log/<name>`.
 * A removal's sizes come from a listing: the caller's, taken since the objects were
 * created, or a fresh one; a name not in it is gone already and counts nothing.
 */
export function meteredSegments(store: SegmentStore, key: string, meter?: StorageMeter): SegmentStore {
  if (!meter) return store;
  return {
    list: () => store.list(),
    read: name => store.read(name),
    async create(name, body) {
      await store.create(name, body);
      meter(`${key}.log/${name}`, Buffer.byteLength(body));
    },
    async remove(names, sizes) {
      const unique = [...new Set(names)];
      const known = sizes ?? (await store.list()).bytes ?? new Map<string, number>();
      await store.remove(unique, known);
      for (const name of unique) if (known.get(name)) meter(`${key}.log/${name}`, -known.get(name)!);
    },
  };
}

/** Remove every object of a log's store (for `removeLog`), sizes and all, so a meter hears of each. */
export async function removeSegments(store: SegmentStore) {
  const { bytes } = await store.list();
  if (bytes?.size) await store.remove([...bytes.keys()], bytes);
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
  /**
   * Insert rows; false when `claim` is no longer current (or another writer took a seq). `effects` run in the same
   * transaction, under the same fence, when it inserts them, and not when they were there already (a repeated append).
   */
  append(key: string, claim: Claim | undefined, rows: TailRow[], effects?: CommitEffect[]): Promise<boolean>;
  /**
   * One compaction at a time per log, holding `claim`: `fold` moves the rows to
   * Storage and returns the seq Storage now covers through; rows up to it are then
   * deleted. False when `claim` is no longer current.
   */
  compact(key: string, claim: Claim | undefined, fold: (rows: TailRow[]) => Promise<number>): Promise<boolean>;
  /** Run `work` while `claim` is current, and keep it current until `work` ends: no takeover meanwhile. False when it is not current. */
  whileHeld(key: string, claim: Claim | undefined, work: () => Promise<void>): Promise<boolean>;
}

const segmentName = (sequence: number) => String(sequence).padStart(12, "0");
const covered = ({ segments, snapshots }: { segments: number[]; snapshots: number[] }) => Math.max(-1, ...segments, ...snapshots);
/** Records above this go to Storage as blobs, so the tail stays small. */
const BLOB_BYTES = 64 * 1024;
/** A tail past either bound is compacted without waiting for the actor to unload. */
const TAIL_RECORDS = 512;
const TAIL_BYTES = 4 * 1024 * 1024;
/**
 * A compaction that would leave more than this many segments after the latest
 * snapshot, or segments larger in all than the snapshot (and than FOLD_BYTES),
 * writes a new snapshot instead: the whole log folded into one object. So a log
 * is at most a snapshot and FOLD_SEGMENTS segments, however often its actor
 * wakes, and folding costs at most about twice the log's size in writes.
 */
export const FOLD_SEGMENTS = 8;
const FOLD_BYTES = 4 * 1024 * 1024;
/** Objects a read fetches at once. */
const READ_PARALLELISM = 8;

/** `work` over `items` with at most `limit` running at once; results in order. */
async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const index = next++; results[index] = await work(items[index]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

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
  /** The buffered records' effects, committed with them. */
  let effects: CommitEffect[] = [];
  let next: number | undefined;
  let appended = 0;
  /** What this writer knows is in the tail above Storage. */
  let tailRecords = 0, tailBytes = 0;
  let fenced: Error | undefined;
  /** A write failed, and its batch, back at the front of the buffer, may have landed at `next`: tried again, it goes there again. */
  let retrying = false;
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
  /** What Storage holds per `listing`: the latest snapshot's records, then later segments', fetched a few at a time. */
  const stored = async (listing: Listing): Promise<T[]> => {
    const snapshot = listing.snapshots.at(-1);
    const names = [
      ...(snapshot === undefined ? [] : [`snapshot-${segmentName(snapshot)}`]),
      ...listing.segments.filter(sequence => snapshot === undefined || sequence > snapshot).map(segmentName),
    ];
    const texts = await mapLimit(names, READ_PARALLELISM, name => store.read(name));
    const records: T[] = snapshot === undefined ? [] : JSON.parse(texts.shift()!);
    for (const text of texts) for (const line of text.split("\n")) if (line) records.push(JSON.parse(line));
    return records;
  };

  async function insert(texts: string[], snapshot: boolean, effects: CommitEffect[]) {
    const first = await position();
    const rows = await Promise.all(texts.map(async (text, index): Promise<TailRow> => {
      if (Buffer.byteLength(text) <= BLOB_BYTES) return { seq: first + index, snapshot, body: text, blob: null };
      const hash = createHash("sha256").update(text).digest("hex");
      // Content-addressed, so a blob another (even stale) writer created is the same bytes.
      try { await store.create(`blob-${hash}`, text); } catch (error) { if (!(error instanceof PreconditionFailed)) throw error; }
      return { seq: first + index, snapshot, body: null, blob: hash };
    }));
    if (!await tail.append(key, claim, rows, effects)) throw fence();
    next = first + rows.length;
    tailRecords += rows.length;
    for (const row of rows) tailBytes += row.body?.length ?? 0;
  }

  async function compact() {
    if (fenced) throw fenced;
    if (!tailRecords) return;
    const blobs: string[] = [];
    let superseded: string[] = [];
    let sizes: Map<string, number> | undefined;
    const held = await tail.compact(key, claim, async rows => {
      const listing = await store.list();
      sizes = listing.bytes;
      const through = covered(listing);
      const fresh = rows.filter(row => row.seq > through);
      for (const row of rows) if (row.blob) blobs.push(`blob-${row.blob}`);
      if (!fresh.length) return through;
      const last = fresh.at(-1)!.seq;
      const texts = await Promise.all(fresh.map(body));
      const start = fresh.findLastIndex(row => row.snapshot);
      const base = listing.snapshots.at(-1);
      const pending = listing.segments.filter(sequence => base === undefined || sequence > base);
      const size = (name: string) => listing.bytes?.get(name) ?? 0;
      const pendingBytes = pending.reduce((sum, sequence) => sum + size(segmentName(sequence)), 0) + texts.reduce((sum, text) => sum + Buffer.byteLength(text) + 1, 0);
      const fold = pending.length >= FOLD_SEGMENTS || pendingBytes > Math.max(FOLD_BYTES, base === undefined ? 0 : size(`snapshot-${segmentName(base)}`));
      sometimes(fold, "a compaction folded a log into a snapshot");
      if (start < 0 && !fold) await store.create(segmentName(last), texts.join("\n") + "\n");
      else {
        // A rewrite among the rows replaces everything before it; otherwise fold Storage's records and the rows into one snapshot.
        const records = start >= 0 ? JSON.parse(texts[start]) : await stored(listing);
        for (const text of texts.slice(start + 1)) records.push(JSON.parse(text));
        await store.create(`snapshot-${segmentName(last)}`, JSON.stringify(records));
        superseded = [...listing.segments.map(segmentName), ...listing.snapshots.map(item => `snapshot-${segmentName(item)}`)];
      }
      return last;
    });
    if (!held) throw fence();
    tailRecords = tailBytes = 0;
    // Only after the rows are gone: until then a reader may still need what these replace. And only while the
    // claim holds: blobs are content-addressed, so a next owner's rows may name the same blob again. Should
    // the claim be gone, the objects stay behind as garbage.
    if (superseded.length || blobs.length) await tail.whileHeld(key, claim, () => store.remove([...new Set([...superseded, ...blobs])], sizes));
  }

  const write = async () => {
    if (fenced) throw fenced;
    if (!buffer.length) return;
    const batch = buffer, done = effects;
    buffer = [];
    effects = [];
    try { await insert(batch, false, done); retrying = false; }
    catch (error) {
      if (!fenced) { buffer = batch.concat(buffer); effects = done.concat(effects); retrying = true; }
      throw error;
    }
    if (tailRecords >= TAIL_RECORDS || tailBytes >= TAIL_BYTES || buggify("storage.compact.now")) void serialize(compact).catch(() => {});
  };

  return {
    // Serialized with writes, so a read beside a live writer never moves its position back.
    read: () => serialize(async () => {
      // The tail first: a compaction between the two reads then shows up in Storage, never in neither.
      let rows: TailRow[], listing: Listing, records: T[];
      for (let attempt = 1; ; attempt++) {
        rows = await tail.rows(key);
        listing = await store.list();
        // A compaction elsewhere (this log's owner, when this reader is not it) may fold and delete what was listed: read again.
        try { records = await stored(listing); break; }
        catch (error) { if (attempt >= 3) throw error; }
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
      // A batch being retried goes where it may have landed already, not after itself.
      if (!retrying) next = Math.max(through, rows.at(-1)?.seq ?? -1) + 1;
      return records;
    }),
    append(record, effect) {
      if (closing) throw new Error("Append log closed");
      buffer.push(JSON.stringify(record));
      if (effect) effects.push(effect);
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
        // A failed batch with effects is written again first, as a flush would: whether it had landed decides
        // whether its effects ran, so they run once.
        if (retrying && effects.length) await write();
        const records = snapshot();
        // The snapshot holds the buffered records: their effects commit with it.
        const carried = effects;
        buffer = [];
        effects = [];
        // A failed write's batch is dropped here, not written again: wherever it landed, the snapshot goes after it.
        if (retrying) { next = undefined; retrying = false; }
        // Nor is a failed snapshot tried again, and it may have landed too (its answer lost): the next write finds
        // its position afresh rather than colliding with it.
        try { await insert([JSON.stringify(records)], true, carried); }
        // Its effects are dropped with it: they committed if it landed, and its records are lost with them if not.
        catch (error) { next = undefined; throw error; }
        appended = 0;
      });
    },
    get appendedSinceRewrite() { return appended; },
    close(discard = false) {
      if (timer) { clearTimeout(timer); timer = undefined; }
      if (discard && !closing) { buffer = []; effects = []; }
      return closing ??= serialize(async () => { if (discard) return; await write(); await compact(); }).catch(() => {});
    },
  };
}
