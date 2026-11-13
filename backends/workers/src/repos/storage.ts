import { gitBlobSha1, sha256Hex } from "./git.ts";
export type CamelfsEnv = { CAMELFS?: { fetch(input: Request | string, init?: RequestInit): Promise<Response> }; CAMELFS_API_TOKEN?: string };
export const camelfsConfigured = (env: CamelfsEnv): boolean => !!env.CAMELFS && !!env.CAMELFS_API_TOKEN;
export type FileEntry = { path: string; blob: string; mode: string; size: number };
export type TreeEntry = FileEntry | { path: string; mode: "040000"; tree: string };
export type Change = { path: string; blob?: string; mode?: string; delete?: boolean };
export type CommitInput = { time?: number; parents: string[]; baseTree?: string | null; changes: Change[]; author: string; message: string; trailers: Record<string, string> };
export type CommitResult = { tree: string; commit: string; changed: number; bytes: number; parents: string[]; time: number };
export type CommitInfo = { tree: string; parents: string[]; author: string; message: string; trailers: Record<string, string>; time: number };
export type DiffChange = { path: string; status: "added" | "modified" | "deleted" | "mode"; oldBlob?: string; newBlob?: string; oldMode?: string; newMode?: string };
export type Conflict = { path: string; base?: string; ours?: string; theirs?: string; reason: "both_modified" | "delete_modify" | "binary" | "mode" };
export type MergeResult = { tree: string; merged: string[]; took: { ours: number; theirs: number } } | { conflicts: Conflict[] };
export type GrepInput = { tree: string; q: string; regex?: boolean; ignoreCase?: boolean; path?: string; limit?: number; context?: number };
export type GrepResult = { matches: { path: string; line: number; text: string; before?: string[]; after?: string[] }[]; files: number; truncated: boolean; indexed?: "now" };
export type BatchEntry = (FileEntry & { bytes: Uint8Array }) | { path: string; error: string };
export type ListOptions = { path?: string; recursive?: boolean; after?: string; limit?: number };
export interface StoragePlane {
  putBlob(lineage: string, bytes: Uint8Array): Promise<{ blob: string; sha256: string; size: number }>;
  openBlob(lineage: string, blob: string, tree: string, path: string, range?: string): Promise<Response>;
  readBlob(lineage: string, blob: string, tree: string, path: string, range?: string): Promise<Uint8Array>;
  readBatch(lineage: string, tree: string, paths: string[], maxBytes?: number): Promise<BatchEntry[]>;
  commit(lineage: string, input: CommitInput, idempotencyKey?: string): Promise<CommitResult>;
  listTree(lineage: string, tree: string, opts?: ListOptions): Promise<{ entries: TreeEntry[]; next?: string }>;
  listAll(lineage: string, tree: string, path?: string): Promise<TreeEntry[]>;
  getCommit(lineage: string, commit: string): Promise<CommitInfo>;
  diff(lineage: string, from: string, to: string, path?: string): Promise<{ changes: DiffChange[] }>;
  merge(lineage: string, input: { base: string; ours: string; theirs: string; mode: "merge" | "squash" }): Promise<MergeResult>;
  grep(lineage: string, input: GrepInput): Promise<GrepResult>;
}
export class StorageError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  /** The daemon's own message (redacted, bounded), and the StoragePlane call that failed: what makes a 4xx diagnosable. */
  readonly reason: string;
  op?: string;
  constructor(status: number, code: string, message = code, details?: unknown) {
    super(`camelFS status ${status}: ${message}`); this.name = "StorageError";
    this.status = status; this.code = code; this.details = details; this.reason = message;
  }
}
export function uploadTimeoutMs(size: number): number {
  return Math.min(60_000 + Math.ceil(size / (2 * 2 ** 20)) * 1000, 30 * 60_000);
}
async function body(response: Response, limit: number): Promise<Uint8Array> {
  const bad = () => new StorageError(response.status, "invalid_response", "malformed or oversized body");
  const reader = response.body?.getReader();
  if (!reader) throw bad();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw bad(); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  } catch { throw bad(); } finally { reader.releaseLock(); }
}
const query = (opts: object) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) if (v !== undefined) params.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
  return params.toString();
};
/** Binary-safe multipart parser. Delimiters are recognized only at MIME line boundaries. */
function multipart(bytes: Uint8Array, contentType: string): BatchEntry[] {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!/^multipart\/mixed\b/i.test(contentType) || !boundary) throw new StorageError(200, "invalid_response", "missing multipart boundary");
  const enc = new TextEncoder(), dec = new TextDecoder();
  const marker = enc.encode(`\r\n--${boundary[1] ?? boundary[2]}`);
  const find = (needle: Uint8Array, start: number) => {
    outer: for (let i = start; i <= bytes.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  };
  const first = enc.encode(`--${boundary[1] ?? boundary[2]}`);
  if (find(first, 0) !== 0) throw new StorageError(200, "invalid_response");
  let pos = first.length; const result: BatchEntry[] = [];
  while (bytes[pos] !== 45 || bytes[pos + 1] !== 45) {
    if (bytes[pos] !== 13 || bytes[pos + 1] !== 10) throw new StorageError(200, "invalid_response");
    const endHeaders = find(enc.encode("\r\n\r\n"), pos + 2);
    if (endHeaders < 0) throw new StorageError(200, "invalid_response");
    const headers = new Map(dec.decode(bytes.slice(pos + 2, endHeaders)).split("\r\n").map(line => {
      const i = line.indexOf(":"); return [line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()];
    }));
    let end = find(marker, endHeaders + 4);
    while (end >= 0 && !((bytes[end + marker.length] === 45 && bytes[end + marker.length + 1] === 45) ||
      (bytes[end + marker.length] === 13 && bytes[end + marker.length + 1] === 10))) end = find(marker, end + 1);
    if (end < 0 || !headers.has("x-camel-path")) throw new StorageError(200, "invalid_response");
    const path = headers.get("x-camel-path")!;
    if (headers.has("x-camel-error")) result.push({ path, error: headers.get("x-camel-error")! });
    else {
      const data = bytes.slice(endHeaders + 4, end), size = Number(headers.get("x-camel-size"));
      const blob = headers.get("x-camel-blob"), mode = headers.get("x-camel-mode");
      if (!blob || !/^[a-f0-9]{40}$/.test(blob) || !mode || !["100644", "100755", "120000"].includes(mode) || size !== data.length) throw new StorageError(200, "invalid_response");
      result.push({ path, blob, mode, size, bytes: data });
    }
    pos = end + marker.length;
  }
  return result;
}
export function camelfsStorage(env: CamelfsEnv): StoragePlane {
  if (!camelfsConfigured(env)) throw new StorageError(0, "not_configured");
  const token = env.CAMELFS_API_TOKEN!;
  const redact = (s: string) => s.split(token).join("***");
  const scrub = (v: unknown): unknown => typeof v === "string" ? redact(v) : Array.isArray(v) ? v.map(scrub) :
    v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [redact(k), scrub(x)])) : v;
  const root = (lineage: string) => `/v1/lineages/${encodeURIComponent(lineage)}`;
  async function request(path: string, init: RequestInit = {}) {
    try { return await env.CAMELFS!.fetch(`http://camelfs${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(60_000), headers: { authorization: `Bearer ${token}`, ...init.headers } }); }
    catch { throw new StorageError(0, "transport_error"); }
  }
  async function value(response: Response, limit = 1024 * 1024): Promise<any> {
    try { return JSON.parse(new TextDecoder().decode(await body(response, limit))); }
    catch { throw new StorageError(response.status, "invalid_response", "malformed or oversized body"); }
  }
  async function failure(response: Response, parsed?: any): Promise<never> {
    const v = parsed ?? await value(response), e = v?.error;
    const code = typeof e?.code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(e.code) ? redact(e.code) : "invalid_response";
    const message = typeof e?.message === "string" ? redact(e.message).replace(/[^\x20-\x7e]/g, "").slice(0, 160) : code;
    throw new StorageError(response.status, code, message, scrub(e?.details));
  }
  async function json(path: string, init?: RequestInit, limit?: number, conflict = false) {
    const response = await request(path, init), v = await value(response, limit);
    if (conflict && response.status === 409 && Array.isArray(v?.conflicts)) return v;
    if (conflict && response.status === 409 && v?.error?.code === "conflict" && Array.isArray(v.error.details?.conflicts)) return { conflicts: v.error.details.conflicts };
    if (!response.ok) return failure(response, v);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new StorageError(response.status, "invalid_response");
    return v;
  }
  const post = (input: unknown, key?: string): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(input) });
  const plane: StoragePlane = {
    async putBlob(lineage, bytes) {
      const [sha256, blob] = await Promise.all([sha256Hex(bytes), gitBlobSha1(bytes)]);
      const v = await json(`${root(lineage)}/blobs`, { method: "PUT", headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length), "X-Camel-Sha256": sha256 }, signal: AbortSignal.timeout(uploadTimeoutMs(bytes.length)), body: new Uint8Array(bytes) });
      if (v.sha256 !== sha256 || v.blob !== blob || v.size !== bytes.length) throw new StorageError(201, "blob_mismatch");
      return { blob, sha256, size: bytes.length };
    },
    async openBlob(lineage, blob, tree, path, range) {
      const r = await request(`${root(lineage)}/blobs/${encodeURIComponent(blob)}?${query({ tree, path })}`, { headers: range ? { Range: range } : {} });
      if (!r.ok) return failure(r);
      return r;
    },
    async readBlob(lineage, blob, tree, path, range) {
      const r = await plane.openBlob(lineage, blob, tree, path, range);
      try { return new Uint8Array(await r.arrayBuffer()); } catch { throw new StorageError(r.status, "read_failed"); }
    },
    async readBatch(lineage, tree, paths, maxBytes) {
      const r = await request(`${root(lineage)}/read`, post({ tree, paths, ...(maxBytes === undefined ? {} : { maxBytes }) }));
      if (!r.ok) return failure(r);
      const entries = multipart(await body(r, 64 * 1024 * 1024 + 1024 * 1024), r.headers.get("content-type") ?? "");
      if (entries.length !== paths.length || entries.some((e, i) => e.path !== paths[i])) throw new StorageError(r.status, "invalid_response");
      return entries;
    },
    commit: (l, input, key) => json(`${root(l)}/commits`, post({ ...input, time: input.time ?? Math.floor(Date.now() / 1000) }, key)),
    listTree: (l, tree, opts = {}) => json(`${root(l)}/trees/${encodeURIComponent(tree)}?${query(opts)}`, undefined, 64 * 1024 * 1024),
    async listAll(l, tree, path) {
      const entries: TreeEntry[] = []; let after: string | undefined;
      do {
        const page = await plane.listTree(l, tree, { path, recursive: true, after });
        entries.push(...page.entries);
        if (page.next && after !== undefined && page.next <= after) throw new StorageError(200, "invalid_response", "non-advancing cursor");
        after = page.next;
      } while (after);
      return entries;
    },
    getCommit: (l, commit) => json(`${root(l)}/commits/${encodeURIComponent(commit)}`),
    diff: (l, from, to, path) => json(`${root(l)}/diff?${query({ from, to, path })}`),
    merge: (l, input) => json(`${root(l)}/merge`, post(input), undefined, true),
    grep: (l, input) => json(`${root(l)}/grep?${query(input)}`),
  };
  // Every failure names the call it came from.
  for (const [op, fn] of Object.entries(plane) as [keyof StoragePlane, (...a: unknown[]) => Promise<unknown>][])
    (plane as unknown as Record<string, unknown>)[op] = async (...args: unknown[]) => {
      try { return await fn(...args); }
      catch (e) { if (e instanceof StorageError) e.op ??= op; throw e; }
    };
  return plane;
}
