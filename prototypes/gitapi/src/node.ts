// The same API on a plain node: node:sqlite per repo, segments as files under a data directory, node:http in front.
// This is the self-host shape (and how the bench measures CPU per request: process.cpuUsage around each one).
//   node --experimental-strip-types src/node.ts <dataDir> [port]
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, createReadStream, createWriteStream, openSync, readSync, closeSync, existsSync, statSync } from "node:fs";
import { writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { RepoCore, type Sql } from "./repo.ts";
import { handle, type RepoApi, type StreamBucket } from "./http.ts";

export function fsBucket(root: string): StreamBucket {
  const path = (key: string) => join(root, key);
  return {
    async put(key, bytes) { await mkdir(dirname(path(key)), { recursive: true }); await writeFile(path(key), bytes); },
    async get(key, range) {
      if (!existsSync(path(key))) return null;
      if (!range) return new Uint8Array(await readFile(path(key)));
      const fd = openSync(path(key), "r"), out = new Uint8Array(range.length);
      try { readSync(fd, out, 0, range.length, range.offset); } finally { closeSync(fd); }
      return out;
    },
    async delete(keys) { await Promise.all(keys.map((k) => rm(path(k), { force: true }))); },
    async getStream(key) { return existsSync(path(key)) ? (Readable.toWeb(createReadStream(path(key))) as ReadableStream<Uint8Array>) : null; },
    async putStream(key, stream, length) {
      await mkdir(dirname(path(key)), { recursive: true });
      await stream.pipeTo(Writable.toWeb(createWriteStream(path(key))) as WritableStream<Uint8Array>);
      if (statSync(path(key)).size !== length) throw new Error("clone pack length mismatch");
    },
  };
}

export function sqliteAt(file: string): Sql {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  const cache = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  return { exec: (q, ...p) => { let s = cache.get(q); if (!s) { s = db.prepare(q); cache.set(q, s); } return (/^\s*SELECT/i.test(q) ? s.all(...(p as never[])) : (s.run(...(p as never[])), [])) as never; } };
}

const WRITES = new Set(["commit", "merge", "gc", "destroy", "createBranch", "extendBranch"]);

export function startServer(dataDir: string, port: number) {
  mkdirSync(join(dataDir, "db"), { recursive: true });
  const bucket = fsBucket(join(dataDir, "objects"));
  const repos = new Map<string, { core: RepoCore; lock: Promise<unknown> }>();
  const open = (name: string) => {
    let r = repos.get(name);
    if (!r) { r = { core: new RepoCore(sqliteAt(join(dataDir, "db", `${name}.sqlite`)), bucket, `gitapi/${name}`), lock: Promise.resolve() }; repos.set(name, r); }
    return r;
  };
  const repoOf = (name: string): RepoApi => new Proxy({}, {
    get: (_t, method: string) => (...args: unknown[]) => {
      const r = open(name);
      const run = () => (r.core[method as keyof RepoCore] as (...a: unknown[]) => unknown).apply(r.core, args);
      if (!WRITES.has(method)) return run();
      const p = r.lock.then(run, run); r.lock = p.catch(() => undefined); return p;
    },
  }) as RepoApi;
  // Ephemeral branches: expire + GC once a second.
  const timer = setInterval(() => { for (const r of repos.values()) { const { expired } = r.core.expire(); if (expired.length) r.lock = r.lock.then(() => r.core.gc({ graceMs: 0 })).catch((e) => console.error(e)); } }, 1000);
  const last: Record<string, number> = {};
  const server = createServer(async (req, res) => {
    if (req.url === "/_cpu") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(last)); return; }
    const cpu = process.cpuUsage();
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const request = new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: chunks.length ? Buffer.concat(chunks) : undefined });
    const response = await handle(request, repoOf, bucket, (p) => void p);
    const headers = Object.fromEntries(response.headers);
    const used = process.cpuUsage(cpu);
    headers["x-cpu-ms"] = ((used.user + used.system) / 1000).toFixed(1); // before the body streams: the op itself
    res.writeHead(response.status, headers);
    if (response.body) for await (const c of response.body as unknown as AsyncIterable<Uint8Array>) res.write(c);
    res.end();
    const total = process.cpuUsage(cpu);
    // CPU of the whole request including the streamed body (the pack), keyed by route kind for the bench.
    last[`${req.method} ${(req.url ?? "").replace(/\?.*/, "").replace(/^\/(repos|git)\/[^/]+/, "")}`] = (total.user + total.system) / 1000;
  });
  server.listen(port);
  return { server, close: () => { clearInterval(timer); server.close(); } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] ?? "./data", port = Number(process.argv[3] ?? 8793);
  startServer(dir, port);
  console.error(`gitapi on http://127.0.0.1:${port} (data ${dir})`);
}
