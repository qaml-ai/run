import { RE2JS } from "re2js";
import { createServer } from "node:http";
import { EMPTY_TREE, gitHash, gitBlobSha1, sha256Hex, commitObject, parseCommit } from "../src/repos/git.ts";
import type { FileEntry, TreeEntry, Change, CommitInfo, CommitResult, DiffChange, Conflict, GrepResult } from "../src/repos/storage.ts";
type Tree = { bytes: Uint8Array; files: Map<string, FileEntry>; dirs: Map<string, string> };
type Node = { dirs: Map<string, Node>; files: Map<string, FileEntry> };
const node = (): Node => ({ dirs: new Map(), files: new Map() });
const json = (v: unknown, status = 200) => Response.json(v, { status });
class Fault extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, details?: unknown) { super(code); this.status = status; this.code = code; this.details = details; }
}
const bad = (code = "invalid_request", status = 400, details?: unknown): never => { throw new Fault(status, code, details); };
const validPath = (p: unknown): p is string => typeof p === "string" && !!p && !/[\0\r\n]/.test(p) && !p.split("/").some(s => !s || s === "." || s === ".." || s === ".git");
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const same = (a?: FileEntry, b?: FileEntry) => a?.blob === b?.blob && a?.mode === b?.mode;
const under = (p: string, prefix: string) => !prefix || p === prefix || p.startsWith(prefix + "/");
function glob(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") { i++; if (pattern[i + 1] === "/") { i++; source += "(?:.*/)?"; } else source += ".*"; }
    else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else source += c.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}
/** All objects and lineage membership remain local to this fake. Commit time comes from the request. */
export function fakeCamelfsd(token: string) {
  const blobs = new Map<string, Uint8Array>(), trees = new Map<string, Tree>(), commits = new Map<string, Uint8Array>();
  const lineages = new Map<string, { blobs: Set<string>; trees: Set<string>; commits: Set<string> }>();
  const writes = new Map<string, { input: string; result: CommitResult }>();
  const calls: string[] = [];
  const scope = (l: string) => {
    if (!lineages.has(l)) lineages.set(l, { blobs: new Set(), trees: new Set(), commits: new Set() });
    return lineages.get(l)!;
  };
  function tree(l: string, id: string, write = false): Tree {
    if (!hash(id)) bad();
    if (id === EMPTY_TREE && write) return { bytes: new Uint8Array(), files: new Map(), dirs: new Map() };
    if (!scope(l).trees.has(id)) return bad(write ? "unknown_tree" : "not_in_tree", write ? 400 : 404);
    return trees.get(id)!;
  }
  function info(l: string, id: string, write = false): CommitInfo {
    if (!hash(id)) bad();
    if (!scope(l).commits.has(id)) return bad(write ? "unknown_commit" : "not_in_tree", write ? 400 : 404);
    const parsed = parseCommit(commits.get(id)!);
    return { tree: parsed.tree, parents: parsed.parents, author: parsed.author, message: parsed.message, trailers: parsed.trailers,
      time: Number(/> (-?\d+) \+0000$/.exec(parsed.author)?.[1]) };
  }
  async function build(l: string, files: Map<string, FileEntry>): Promise<string> {
    const top = node();
    for (const [p, entry] of files) {
      let n = top; const parts = p.split("/");
      for (const part of parts.slice(0, -1)) {
        if (n.files.has(part)) bad();
        if (!n.dirs.has(part)) n.dirs.set(part, node());
        n = n.dirs.get(part)!;
      }
      const name = parts.at(-1)!;
      if (n.dirs.has(name)) bad();
      n.files.set(name, entry);
    }
    // Stage objects so a path conflict cannot leave partial writes.
    const pending = new Map<string, Tree>();
    async function encode(n: Node): Promise<string> {
      const entries = [...n.files].map(([name, f]) => ({ name, mode: f.mode, id: f.blob }));
      const dirs = new Map<string, string>();
      const flat = new Map<string, FileEntry>();
      for (const [name, f] of n.files) flat.set(name, { ...f, path: name });
      for (const [name, dir] of n.dirs) {
        const id = await encode(dir); dirs.set(name, id); entries.push({ name, mode: "40000", id });
        for (const [p, f] of pending.get(id)!.files) flat.set(`${name}/${p}`, { ...f, path: `${name}/${p}` });
      }
      entries.sort((a, b) => compare(a.name + (a.mode === "40000" ? "/" : ""), b.name + (b.mode === "40000" ? "/" : "")));
      const bytes = Buffer.concat(entries.flatMap(e => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.id, "hex")]));
      const id = await gitHash("tree", bytes); pending.set(id, { bytes, files: flat, dirs }); return id;
    }
    const id = await encode(top);
    for (const [id, obj] of pending) { trees.set(id, obj); scope(l).trees.add(id); }
    return id;
  }
  function changes(a: Tree, b: Tree, prefix = ""): DiffChange[] {
    return [...new Set([...a.files.keys(), ...b.files.keys()])].sort(compare).flatMap(path => {
      const old = a.files.get(path), next = b.files.get(path);
      if (!under(path, prefix) || same(old, next)) return [];
      return [{ path, status: !old ? "added" : !next ? "deleted" : old.blob !== next.blob ? "modified" : "mode",
        ...(old ? { oldBlob: old.blob, oldMode: old.mode } : {}), ...(next ? { newBlob: next.blob, newMode: next.mode } : {}) } as DiffChange];
    });
  }
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url), s = url.searchParams;
    calls.push(`${request.method} ${url.pathname}${url.search}`);
    if (request.headers.get("authorization") !== `Bearer ${token}`) bad("unauthorized", 401);
    const match = /^\/v1\/lineages\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (!match) bad("not_in_tree", 404);
    const l = decodeURIComponent(match![1]), route = match![2], own = scope(l);
    const q = async (): Promise<any> => { try { const v = await request.json(); if (!v || typeof v !== "object" || Array.isArray(v)) bad(); return v; } catch { return bad(); } };
    if (request.method === "PUT" && route === "blobs") {
      const length = request.headers.get("content-length");
      if (length && Number(length) > 5 * 1024 ** 3) bad("too_large", 413);
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.length > 5 * 1024 ** 3) bad("too_large", 413);
      const sha256 = await sha256Hex(bytes), blob = await gitBlobSha1(bytes);
      if (request.headers.has("X-Camel-Sha256") && request.headers.get("X-Camel-Sha256") !== sha256) bad("blob_mismatch");
      const existed = own.blobs.has(blob); blobs.set(blob, bytes); own.blobs.add(blob);
      return json({ blob, sha256, size: bytes.length }, existed ? 200 : 201);
    }
    if (request.method === "GET" && route.startsWith("blobs/")) {
      const blob = route.slice(6), path = s.get("path") ?? "";
      const f = tree(l, s.get("tree") ?? "").files.get(path);
      if (!f || f.blob !== blob) bad("not_in_tree", 404);
      const bytes = blobs.get(blob)!; let data = bytes, status = 200;
      const range = request.headers.get("range"), headers: Record<string, string> = { "X-Camel-Blob": blob, "X-Camel-Size": String(bytes.length), "Content-Type": "application/octet-stream" };
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!m || (!m[1] && !m[2])) bad("invalid_request", 416);
        const start = m![1] ? Number(m![1]) : Math.max(0, bytes.length - Number(m![2]));
        const end = m![1] && m![2] ? Math.min(Number(m![2]), bytes.length - 1) : bytes.length - 1;
        if (start > end || start >= bytes.length) bad("invalid_request", 416);
        data = bytes.slice(start, end + 1); status = 206; headers["Content-Range"] = `bytes ${start}-${end}/${bytes.length}`;
      }
      return new Response(data, { status, headers });
    }
    if (request.method === "POST" && route === "read") {
      const input = await q();
      if (!Array.isArray(input.paths) || input.paths.some((p: unknown) => !validPath(p)) || (input.maxBytes !== undefined && (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0))) bad();
      if (input.paths.length > 256) bad("too_large", 413, { path: input.paths[256] });
      // Unknown trees produce the same per-path misses as inaccessible paths.
      const files = own.trees.has(input.tree) ? trees.get(input.tree)!.files : new Map<string, FileEntry>();
      const cap = Math.min(input.maxBytes ?? 64 * 1024 ** 2, 64 * 1024 ** 2); let total = 0;
      const boundary = "camel-" + crypto.randomUUID(); const parts: Buffer[] = [];
      for (const path of input.paths as string[]) {
        const f = files.get(path);
        let header = `--${boundary}\r\nX-Camel-Path: ${path}\r\n`;
        if (!f) header += "X-Camel-Error: not_in_tree\r\n\r\n";
        else {
          total += f.size; if (total > cap) bad("too_large", 413, { path });
          header += `X-Camel-Blob: ${f.blob}\r\nX-Camel-Mode: ${f.mode}\r\nX-Camel-Size: ${f.size}\r\n\r\n`;
        }
        parts.push(Buffer.from(header), f ? Buffer.from(blobs.get(f.blob)!) : Buffer.alloc(0), Buffer.from("\r\n"));
      }
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      return new Response(Buffer.concat(parts), { headers: { "content-type": `multipart/mixed; boundary="${boundary}"` } });
    }
    if (request.method === "POST" && route === "commits") {
      const input = await q(); const parents = input.parents ?? (input.parent ? [input.parent] : []);
      if (!Number.isSafeInteger(input.time) || !Array.isArray(parents) || parents.length > 2 || parents.some(p => !hash(p)) || !Array.isArray(input.changes) ||
        typeof input.author !== "string" || !input.author || /[\r\n\0<>]/.test(input.author) || typeof input.message !== "string" ||
        !input.trailers || typeof input.trailers !== "object" || Array.isArray(input.trailers) || Object.entries(input.trailers).some(([k, v]) => !k || /[\r\n:]/.test(k) || typeof v !== "string" || /[\r\n]/.test(v))) bad();
      if (input.changes.length > 10000) bad("too_large", 413);
      const key = request.headers.get("Idempotency-Key"), fingerprint = JSON.stringify(input), cacheKey = `${l}\0${key}`;
      if (key && writes.has(cacheKey)) {
        const previous = writes.get(cacheKey)!;
        if (previous.input !== fingerprint) bad();
        return json(previous.result, 201);
      }
      const parentInfo = parents.map(p => info(l, p, true));
      const baseId = input.baseTree ?? parentInfo[0]?.tree ?? EMPTY_TREE;
      const base = tree(l, baseId, true), files = new Map(base.files);
      for (const c of input.changes as Change[]) {
        if (!c || !validPath(c.path) || (c.mode !== undefined && !["100644", "100755", "120000"].includes(c.mode))) bad();
        if (c.delete) { files.delete(c.path); continue; }
        const old = files.get(c.path), blob = c.blob ?? old?.blob;
        if (!blob || !own.blobs.has(blob)) bad("unknown_blob");
        files.set(c.path, { path: c.path, blob, mode: c.mode ?? old?.mode ?? "100644", size: blobs.get(blob)!.length });
      }
      const id = await build(l, files);
      const object = await commitObject({ tree: id, parents, author: input.author, at: input.time * 1000, message: input.message, trailers: input.trailers });
      commits.set(object.id, object.bytes); own.commits.add(object.id);
      const result = { tree: id, commit: object.id, changed: changes(base, trees.get(id)!).length,
        bytes: [...files.values()].reduce((n, f) => n + f.size, 0), parents, time: input.time };
      if (key) writes.set(cacheKey, { input: fingerprint, result });
      return json(result, 201);
    }
    if (request.method === "GET" && route.startsWith("commits/")) return json(info(l, route.slice(8)));
    if (request.method === "GET" && route.startsWith("trees/")) {
      const t = tree(l, route.slice(6)), prefix = s.get("path") ?? "", recursive = s.get("recursive") === "1";
      if (prefix && !validPath(prefix)) bad();
      const limit = Number(s.get("limit") ?? 10000); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) bad();
      let selected = t;
      if (prefix) for (const part of prefix.split("/")) { const id = selected.dirs.get(part); if (!id) bad("not_in_tree", 404); selected = trees.get(id)!; }
      const full = (p: string) => prefix ? `${prefix}/${p}` : p;
      const entries: TreeEntry[] = recursive ? [...selected.files.values()].map(f => ({ ...f, path: full(f.path) })) :
        [...[...selected.files.values()].filter(f => !f.path.includes("/")).map(f => ({ ...f, path: full(f.path) })),
          ...[...selected.dirs].map(([p, tree]) => ({ path: full(p), mode: "040000" as const, tree }))];
      const sorted = entries.filter(e => !s.get("after") || compare(e.path, s.get("after")!) > 0).sort((a, b) => compare(a.path, b.path));
      const page = sorted.slice(0, limit);
      return json({ entries: page, ...(sorted.length > limit ? { next: page.at(-1)!.path } : {}) });
    }
    if (request.method === "GET" && route === "diff") return json({ changes: changes(tree(l, s.get("from") ?? ""), tree(l, s.get("to") ?? ""), s.get("path") ?? "") });
    if (request.method === "POST" && route === "merge") {
      const input = await q(); if (!["merge", "squash"].includes(input.mode)) bad();
      const base = tree(l, input.base, true), ours = tree(l, input.ours, true), theirs = tree(l, input.theirs, true);
      const files = new Map<string, FileEntry>(), conflicts: Conflict[] = [], merged: string[] = [], took = { ours: 0, theirs: 0 };
      for (const path of [...new Set([...base.files.keys(), ...ours.files.keys(), ...theirs.files.keys()])].sort(compare)) {
        const b = base.files.get(path), o = ours.files.get(path), t = theirs.files.get(path); let chosen: FileEntry | undefined;
        if (same(o, t)) chosen = o;
        else if (same(b, o)) { chosen = t; took.theirs++; }
        else if (same(b, t)) { chosen = o; took.ours++; }
        else { conflicts.push({ path, ...(b ? { base: b.blob } : {}), ...(o ? { ours: o.blob } : {}), ...(t ? { theirs: t.blob } : {}), reason: !o || !t ? "delete_modify" : o.blob === t.blob ? "mode" : "both_modified" }); continue; }
        if (chosen) files.set(path, chosen);
        if (!same(b, chosen)) merged.push(path);
      }
      // A file on one side and a directory on the other is also a path conflict.
      const paths = [...files.keys()].sort(compare);
      for (const path of paths) for (const parent of path.split("/").slice(0, -1).map((_, i) => path.split("/").slice(0, i + 1).join("/"))) {
        if (files.has(parent)) conflicts.push({ path: parent, reason: "both_modified" });
      }
      if (conflicts.length) return json({ error: { code: "conflict", message: "conflict" }, conflicts }, 409);
      return json({ tree: await build(l, files), merged, took });
    }
    if (request.method === "GET" && route === "grep") {
      const t = tree(l, s.get("tree") ?? ""), q = s.get("q"); if (q === null) bad();
      const limit = Number(s.get("limit") ?? 2000), context = Number(s.get("context") ?? 0);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000 || !Number.isSafeInteger(context) || context < 0) bad();
      let re: RE2JS | undefined;
      try { if (s.get("regex") === "1") re = RE2JS.compile(q!, s.get("ignoreCase") === "1" ? RE2JS.CASE_INSENSITIVE : 0); } catch { bad(); }
      const filter = s.has("path") ? glob(s.get("path")!) : undefined, matches: GrepResult["matches"] = []; let files = 0, truncated = false;
      for (const f of [...t.files.values()].sort((a, b) => compare(a.path, b.path))) {
        if (filter && !filter.test(f.path)) continue; files++;
        const lines = new TextDecoder().decode(blobs.get(f.blob)!).split("\n"); if (lines.at(-1) === "") lines.pop();
        for (let i = 0; i < lines.length; i++) {
          const text = lines[i], yes = re ? re.test(text) : s.get("ignoreCase") === "1" ? text.toLowerCase().includes(q!.toLowerCase()) : text.includes(q!);
          if (!yes) continue;
          if (matches.length === limit) { truncated = true; continue; }
          matches.push({ path: f.path, line: i + 1, text, ...(context ? { before: lines.slice(Math.max(0, i - context), i), after: lines.slice(i + 1, i + 1 + context) } : {}) });
        }
      }
      return json({ matches, files, truncated });
    }
    return bad("not_in_tree", 404);
  }
  async function fetch(request: Request): Promise<Response> {
    try { return await handle(request); }
    catch (e) { if (e instanceof Fault) return json({ error: { code: e.code, message: e.message, ...(e.details === undefined ? {} : { details: e.details }) } }, e.status); throw e; }
  }
  return { fetch, blobs, trees, commits, calls };
}
export async function serveFakeCamelfsd(token: string): Promise<{ url: string; close: () => Promise<void> }> {
  const fake = fakeCamelfsd(token);
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const response = await fake.fetch(new Request(`http://camelfs${req.url}`, { method: req.method, headers: req.headers as Record<string, string>,
        ...(req.method !== "GET" && req.method !== "HEAD" ? { body: Buffer.concat(chunks) } : {}) }));
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing server address");
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())) };
}
