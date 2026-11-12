// The HTTP surface, shared by the Worker (repo calls are Durable Object RPC) and the Node server (repo calls are
// direct). Pack bytes never pass through the repo object: it answers with a plan (byte ranges of segments) and the
// stateless front streams them from the bucket, hashing as it goes, and tees a full clone into a cached clone pack.
import { createHash } from "node:crypto";
import type { Bucket, CommitRequest, MergeRequest, UploadPlan } from "./repo.ts";
import { HttpError } from "./repo.ts";
import { concat, utf8 } from "./objects.ts";

export interface StreamBucket extends Bucket {
  getStream(key: string): Promise<ReadableStream<Uint8Array> | null>;
  putStream(key: string, stream: ReadableStream<Uint8Array>, length: number): Promise<void>;
}
type Awaitable<T> = T | Promise<T>;
/** The repo object's methods as the front sees them (sync in Node, RPC promises in the Worker). */
export interface RepoApi {
  refs(): Awaitable<unknown>;
  commit(req: CommitRequest): Awaitable<unknown>;
  createBranch(req: { name: string; from?: string; ttlSeconds?: number }): Awaitable<unknown>;
  extendBranch(name: string, ttlSeconds: number): Awaitable<unknown>;
  deleteBranch(name: string, expected?: string): Awaitable<unknown>;
  merge(req: MergeRequest): Awaitable<unknown>;
  readFile(ref: string, path: string): Awaitable<{ sha: string; mode: string; bytes: Uint8Array; commit: string }>;
  readTree(ref: string, path: string, recursive: boolean): Awaitable<unknown>;
  diff(from: string, to: string): Awaitable<unknown>;
  log(ref: string, limit: number): Awaitable<unknown>;
  advertise(): Awaitable<Uint8Array>;
  uploadPlan(body: Uint8Array): Awaitable<UploadPlan>;
  cachedClone(key: string): Awaitable<boolean>;
  recordClone(key: string, commit: string, bytes: number): Awaitable<void>;
  gc(opts: { graceMs?: number; repackBelow?: number }): Awaitable<unknown>;
  stats(): Awaitable<unknown>;
  destroy(): Awaitable<void>;
}

const CHUNK = 8 << 20, PREFETCH = 4;

/** `PACK` + entries read from segment ranges (in ≤8 MiB pieces, four in flight) + the SHA-1 trailer. */
export function packStream(plan: NonNullable<UploadPlan["pack"]>, bucket: Bucket): ReadableStream<Uint8Array> {
  const pieces: { key: string; offset: number; length: number }[] = [];
  for (const r of plan.runs) for (let o = 0; o < r.length; o += CHUNK) pieces.push({ key: r.key, offset: r.offset + o, length: Math.min(CHUNK, r.length - o) });
  const hash = createHash("sha1");
  const header = new Uint8Array(12);
  header.set(utf8("PACK"));
  new DataView(header.buffer).setUint32(4, 2);
  new DataView(header.buffer).setUint32(8, plan.count);
  let next = 0, started = false;
  const inflight: Promise<Uint8Array>[] = [];
  const fill = () => { while (inflight.length < PREFETCH && next < pieces.length) { const p = pieces[next++]; inflight.push(bucket.get(p.key, { offset: p.offset, length: p.length }).then((b) => { if (!b) throw new Error(`segment ${p.key} missing`); return b; })); } };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) { started = true; hash.update(header); controller.enqueue(header); fill(); return; }
      if (!inflight.length) { controller.enqueue(new Uint8Array(hash.digest())); controller.close(); return; }
      const bytes = await inflight.shift()!;
      fill();
      hash.update(bytes);
      controller.enqueue(bytes);
    },
  });
}
const packLength = (plan: NonNullable<UploadPlan["pack"]>) => 12 + plan.bytes + 20;

function prepend(prefix: Uint8Array, body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let sent = false;
  return new ReadableStream({
    async pull(c) {
      if (!sent) { sent = true; c.enqueue(prefix); return; }
      const { done, value } = await reader.read();
      if (done) c.close(); else c.enqueue(value);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });

export async function handle(request: Request, repoOf: (name: string) => RepoApi, bucket: StreamBucket, waitUntil: (p: Promise<unknown>) => void): Promise<Response> {
  const url = new URL(request.url);
  const started = performance.now();
  const timing = () => ({ "x-server-ms": (performance.now() - started).toFixed(1) });
  try {
    const git = url.pathname.match(/^\/git\/([A-Za-z0-9._-]+)\.git\/(info\/refs|git-upload-pack)$/);
    if (git) {
      const repo = repoOf(git[1]);
      if (git[2] === "info/refs") {
        if (url.searchParams.get("service") !== "git-upload-pack") return new Response("read-only: upload-pack only", { status: 403 });
        return new Response(await repo.advertise() as BodyInit, { headers: { "content-type": "application/x-git-upload-pack-advertisement", "cache-control": "no-cache" } });
      }
      const plan = await repo.uploadPlan(new Uint8Array(await request.arrayBuffer()));
      const headers = { "content-type": "application/x-git-upload-pack-result", "cache-control": "no-cache", ...timing() };
      if (!plan.pack) return new Response(plan.prefix as BodyInit, { headers });
      const key = plan.pack.cacheKey;
      if (key && (await repo.cachedClone(key))) {
        const cached = await bucket.getStream(key);
        if (cached) return new Response(prepend(plan.prefix, cached), { headers: { ...headers, "x-clone-cache": "hit" } });
      }
      let body = packStream(plan.pack, bucket);
      if (key) {
        // A full clone of one commit: serve it and keep a copy, so the next job's clone is one R2 read.
        const [serve, keep] = body.tee();
        body = serve;
        const length = packLength(plan.pack), commit = key.split("/clones/")[1].slice(0, 40);
        waitUntil(bucket.putStream(key, keep, length).then(() => repo.recordClone(key, commit, length)).catch((e) => console.error("clone cache put failed", e)));
      }
      return new Response(prepend(plan.prefix, body), { headers: { ...headers, "x-clone-cache": key ? "miss" : "fetch", "x-pack-objects": String(plan.pack.count), "x-pack-bytes": String(packLength(plan.pack)) } });
    }

    const m = url.pathname.match(/^\/repos\/([A-Za-z0-9._-]+)(?:\/([a-z]+)(?:\/(.*))?)?$/);
    if (!m) return json({ error: "not found" }, 404);
    const [, name, resource = "", rest = ""] = m;
    const repo = repoOf(name);
    const q = (k: string) => url.searchParams.get(k);
    const body = async <T>() => (await request.json()) as T;
    const method = request.method;
    let result: unknown;
    if (resource === "" && method === "DELETE") { await repo.destroy(); return new Response(null, { status: 204 }); }
    else if (resource === "refs" && method === "GET") result = await repo.refs();
    else if (resource === "commits" && method === "POST") result = await repo.commit(await body<CommitRequest>());
    else if (resource === "branches" && method === "POST") result = await repo.createBranch(await body());
    else if (resource === "branches" && method === "PATCH") result = await repo.extendBranch(decodeURIComponent(rest), (await body<{ ttlSeconds: number }>()).ttlSeconds);
    else if (resource === "branches" && method === "DELETE") result = await repo.deleteBranch(decodeURIComponent(rest), q("expected") ?? undefined);
    else if (resource === "merges" && method === "POST") {
      result = await repo.merge(await body<MergeRequest>());
      if ((result as { status: string }).status === "conflict") return json(result, 409, timing());
    } else if (resource === "files" && method === "GET") {
      const file = await repo.readFile(q("ref") ?? "main", decodeURIComponent(rest));
      return new Response(file.bytes as BodyInit, { headers: { "content-type": "application/octet-stream", "x-sha": file.sha, "x-mode": file.mode, "x-commit": file.commit, ...timing() } });
    } else if (resource === "tree" && method === "GET") result = await repo.readTree(q("ref") ?? "main", q("path") ?? "", q("recursive") === "1");
    else if (resource === "diff" && method === "GET") result = await repo.diff(q("from") ?? "", q("to") ?? "main");
    else if (resource === "log" && method === "GET") result = await repo.log(q("ref") ?? "main", Number(q("limit") ?? 50));
    else if (resource === "gc" && method === "POST") result = await repo.gc(await body());
    else if (resource === "stats" && method === "GET") result = await repo.stats();
    else return json({ error: "not found" }, 404);
    return json(result ?? { ok: true }, 200, timing());
  } catch (error) {
    const e = error as { status?: number; message?: string; body?: unknown; remote?: boolean };
    // DO RPC rethrows as a plain Error; HttpError's status rides in the message prefix.
    const status = error instanceof HttpError ? error.status : Number(/^HTTP (\d{3}):/.exec(e.message ?? "")?.[1] ?? 500);
    if (status === 500) console.error(error);
    return json({ error: (e.message ?? String(error)).replace(/^HTTP \d{3}: /, ""), ...(e.body ? { detail: e.body } : {}) }, status, timing());
  }
}

/** For RPC: errors cross the DO boundary as message strings only. */
export function rethrowable(error: unknown): never {
  if (error instanceof HttpError) throw new Error(`HTTP ${error.status}: ${error.message}`);
  throw error;
}
export { concat };
