// Job snapshots on a host (docs/design/job-hosts-plan.md, slice 5): the cache of snapshots a host holds, and the save.
//
// - The cache: a directory on the host's NVMe (fake mode: a temporary one), one entry per snapshot id, bounded by bytes
//   and evicted least recently used first. A miss downloads the archive from the runtime (the job's token), checks its size and
//   sha256 as it streams, and unpacks it: a Firecracker host's into the job's ext4 (gunzip), a fake host's into a
//   directory (tar). An entry booting a VM is pinned, so it is never evicted under a clone. The cache lives as long as
//   the agent: it is emptied when the agent starts.
// - The save: the VM's disk, exported (vm.ts Vm.export) as one gzip archive, hashed, and uploaded through the runtime in
//   parts (each with its Content-Length; the runtime writes them into an R2 multipart upload), then completed with its
//   size and sha256. A saved snapshot is also adopted into the cache, so the next job from it skips the download.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, openAsBlob, renameSync } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";
import { CACHED_REPORT_MAX, SNAPSHOT_MAX_BYTES } from "../shared/job-host-protocol.ts";

export { SNAPSHOT_MAX_BYTES };
/** The cache's default bound: what it holds unpacked, past which it evicts. */
export const SNAPSHOT_CACHE_BYTES = 200 * 1024 ** 3;
const SNAPSHOT_ID = /^[A-Za-z0-9._-]{1,128}\/hs_[A-Za-z0-9_-]{16,64}$/;

export type SnapshotRef = { id: string; url: string; token: string; sha256: string; size: number };
type Entry = { path: string; bytes: number; used: number; pins: number; sha256: string };

const sha256File = async (path: string) => {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) { hash.update(chunk as Buffer); size += (chunk as Buffer).length; }
  return { sha256: hash.digest("hex"), size };
};
/** What a cache entry holds on disk: a file's size, or a directory's files'. */
async function bytesOf(path: string): Promise<number> {
  const info = await stat(path);
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of await readdir(path)) total += await bytesOf(join(path, name)).catch(() => 0);
  return total;
}

export type SnapshotCacheOptions = {
  dir: string;
  /** "firecracker": an archive is a gzipped ext4; "fake": a gzipped tar of a directory. */
  kind: "fake" | "firecracker";
  maxBytes?: number;
  fetcher?: typeof fetch;
  /** Hears each download's size and time (what the host measures as throughput). */
  log?: (line: Record<string, unknown>) => void;
};

export class SnapshotCache {
  private readonly entries = new Map<string, Entry>();
  /** Use order: a counter, so two uses in one millisecond still order. */
  private clock = 0;
  private readonly loading = new Map<string, Promise<void>>();
  private ready?: Promise<void>;
  private readonly options: SnapshotCacheOptions;
  constructor(options: SnapshotCacheOptions) { this.options = options; }
  get dir() { return this.options.dir; }

  /** Empty the directory once, on first use: what an earlier agent left is not trusted, nor counted. */
  private init() {
    return this.ready ??= (async () => { await rm(this.options.dir, { recursive: true, force: true }); await mkdir(this.options.dir, { recursive: true }); })();
  }
  /** An entry's path: the id hashed, so no id names a path outside the directory. */
  private pathFor(id: string) { return join(this.options.dir, createHash("sha256").update(id).digest("hex").slice(0, 32) + (this.options.kind === "firecracker" ? ".ext4" : "")); }

  /** A path in the cache's directory for a file of the caller's (a save's archive), never an entry's name. */
  async scratch(name: string) {
    await this.init();
    return join(this.options.dir, `${name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100)}.${process.pid}.gz`);
  }

  /** The ids held, most recently used first, at most CACHED_REPORT_MAX: what the host reports for placement. */
  ids() { return [...this.entries].sort(([, a], [, b]) => b.used - a.used).slice(0, CACHED_REPORT_MAX).map(([id]) => id); }
  /** The bytes held. */
  bytes() { return [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0); }

  /**
   * A snapshot's unpacked base, pinned until `release`: from the cache, or downloaded, checked and unpacked first. Two
   * jobs from one snapshot share one download.
   */
  async acquire(ref: SnapshotRef): Promise<{ path: string; release(): void }> {
    if (!SNAPSHOT_ID.test(ref.id) || !/^[0-9a-f]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.size) || ref.size < 1 || ref.size > SNAPSHOT_MAX_BYTES)
      throw new Error("Invalid snapshot reference");
    await this.init();
    for (;;) {
      const entry = this.entries.get(ref.id);
      if (entry) {
        // Its archive's digest is part of what the handle says: a handle that names a held id with another digest is not
        // the snapshot held (each save has its own id), and is refused rather than served from the copy.
        if (entry.sha256 !== ref.sha256) throw new Error("the snapshot failed its integrity check");
        entry.pins++; entry.used = ++this.clock;
        let released = false;
        return { path: entry.path, release: () => { if (released) return; released = true; entry.pins--; this.trim(); } };
      }
      const loading = this.loading.get(ref.id);
      if (loading) { await loading; continue; }
      const load = this.download(ref).finally(() => this.loading.delete(ref.id));
      this.loading.set(ref.id, load);
      await load;
    }
  }

  private async download(ref: SnapshotRef) {
    const archive = `${this.pathFor(ref.id)}.download`;
    try {
      const began = Date.now();
      const response = await (this.options.fetcher ?? fetch)(ref.url, { headers: { authorization: `Bearer ${ref.token}` }, signal: AbortSignal.timeout(30 * 60_000) });
      if (!response.ok || !response.body) {
        throw new Error(`the runtime answered ${response.status}${await reason(response)}`);
      }
      const hash = createHash("sha256");
      let size = 0;
      const counted = async function* (body: AsyncIterable<Uint8Array>) {
        for await (const chunk of body) {
          size += chunk.byteLength;
          if (size > ref.size) throw new Error("the snapshot is larger than its handle says");
          hash.update(chunk);
          yield chunk;
        }
      };
      await pipeline(Readable.fromWeb(response.body as never), counted, createWriteStream(archive));
      if (size !== ref.size || hash.digest("hex") !== ref.sha256) throw new Error("the snapshot failed its integrity check");
      this.options.log?.({ type: "jobhost_snapshot_downloaded", bytes: size, ms: Date.now() - began });
      await this.unpack(ref.id, archive, ref.sha256);
    } finally {
      await rm(archive, { force: true });
    }
  }

  /** Unpack a checked archive into the entry for `id`, and count it. */
  private async unpack(id: string, archive: string, sha256: string) {
    const path = this.pathFor(id), partial = `${path}.unpacking`;
    await rm(partial, { recursive: true, force: true });
    try {
      if (this.options.kind === "firecracker") await pipeline(createReadStream(archive), createGunzip(), createWriteStream(partial));
      else {
        await mkdir(partial, { recursive: true });
        await promisify(execFile)("tar", ["-xzf", archive, "-C", partial, "--no-same-owner"]);
      }
      await rm(path, { recursive: true, force: true });
      await rename(partial, path);
    } catch (error) {
      await rm(partial, { recursive: true, force: true });
      throw new Error(`the snapshot could not be unpacked: ${error instanceof Error ? error.message.slice(0, 200) : "unknown"}`);
    }
    this.entries.set(id, { path, bytes: await bytesOf(path), used: ++this.clock, pins: 0, sha256 });
    this.trim();
  }

  /** A snapshot this host just saved: kept from its archive, no download. Best effort: a failure only costs a download later. */
  async adopt(id: string, archive: string, sha256: string) {
    if (!SNAPSHOT_ID.test(id) || this.entries.has(id)) return;
    await this.init();
    await this.unpack(id, archive, sha256);
  }

  /** Evict the least recently used unpinned entries while the cache holds more than its bound. */
  private trim() {
    const max = this.options.maxBytes ?? SNAPSHOT_CACHE_BYTES;
    let total = this.bytes();
    for (const [id, entry] of [...this.entries].sort(([, a], [, b]) => a.used - b.used)) {
      if (total <= max) break;
      if (entry.pins > 0) continue;
      this.entries.delete(id);
      total -= entry.bytes;
      // Moved aside at once (a download of the same id may write its path next), then removed.
      const gone = `${entry.path}.evicted-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try { renameSync(entry.path, gone); } catch { continue; }
      void rm(gone, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** A refusal's reason, from the runtime's JSON error (short). */
async function reason(response: Response) {
  const error = await response.json().then((body: { error?: unknown }) => body?.error, () => undefined);
  return typeof error === "string" ? `: ${error.slice(0, 200)}` : "";
}

/**
 * Upload a saved archive through the runtime: each `partBytes` of it (the last shorter) PUT to `url`/parts/<n> from 1,
 * each a Blob slice read from disk with its Content-Length, tried up to three times; then POST `url`/complete with its
 * size and sha256. Answers both. `failAfterParts` (tests): stop after that many parts, as a host that dies mid-upload.
 */
export async function uploadSnapshot(archive: string, save: { url: string; token: string; partBytes: number }, options: { fetcher?: typeof fetch; failAfterParts?: number; log?: (line: Record<string, unknown>) => void } = {}) {
  const fetcher = options.fetcher ?? fetch, began = Date.now();
  const { sha256, size } = await sha256File(archive);
  if (size > SNAPSHOT_MAX_BYTES) throw new Error(`The snapshot is ${size} bytes, over ${SNAPSHOT_MAX_BYTES}`);
  if (!Number.isInteger(save.partBytes) || save.partBytes < 1) throw new Error("Invalid part size");
  const file = await openAsBlob(archive), authorization = `Bearer ${save.token}`;
  const parts = Math.max(1, Math.ceil(size / save.partBytes));
  for (let n = 1; n <= parts; n++) {
    if (options.failAfterParts !== undefined && n > options.failAfterParts) throw new Error(`stopped after ${options.failAfterParts} parts (test)`);
    for (let attempt = 1; ; attempt++) {
      const response = await fetcher(`${save.url}/parts/${n}`, { method: "PUT", headers: { authorization }, body: file.slice((n - 1) * save.partBytes, n * save.partBytes), signal: AbortSignal.timeout(10 * 60_000) })
        .catch((error: unknown) => error as Error);
      if (response instanceof Response && response.ok) { await response.body?.cancel().catch(() => {}); break; }
      // A refusal (4xx) is final; a lost connection or a 5xx is tried again.
      if (attempt >= 3 || (response instanceof Response && response.status < 500)) throw new Error(`part ${n}: ${response instanceof Response ? `the runtime answered ${response.status}${await reason(response)}` : response.message.slice(0, 200)}`);
    }
  }
  const done = await fetcher(`${save.url}/complete`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ size, sha256 }), signal: AbortSignal.timeout(5 * 60_000) });
  if (!done.ok) throw new Error(`completing it: the runtime answered ${done.status}${await reason(done)}`);
  options.log?.({ type: "jobhost_snapshot_uploaded", bytes: size, parts, ms: Date.now() - began });
  return { sha256, size };
}
