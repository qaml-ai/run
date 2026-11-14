import { RE2JS } from "re2js";
import { createServer } from "node:http";
import { EMPTY_TREE, gitHash, gitBlobSha1, sha256Hex, commitObject, parseCommit } from "../src/repos/git.ts";
import type { FileEntry, TreeEntry, Change, CommitInfo, CommitResult, DiffChange, Conflict, GrepResult } from "../src/repos/storage.ts";
type Tree = { bytes: Uint8Array; files: Map<string, FileEntry>; dirs: Map<string, string> };
type Node = { dirs: Map<string, Node>; files: Map<string, FileEntry> };
const node = (): Node => ({ dirs: new Map(), files: new Map() });
const ANCESTRY_LIMIT = 50000;
const json = (v: unknown, status = 200) => Response.json(v, { status });
class Fault extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, details?: unknown, message = code) { super(message); this.status = status; this.code = code; this.details = details; }
}
const bad = (code = "invalid_request", status = 400, details?: unknown, message?: string): never => { throw new Fault(status, code, details, message); };
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
  const writes = new Map<string, { result: CommitResult }>();
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
    // As the daemon: `author` is what the commit was made with, not the git identity line.
    return { tree: parsed.tree, parents: parsed.parents, author: parsed.author.slice(0, parsed.author.lastIndexOf(" <")), message: parsed.message, trailers: parsed.trailers,
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
        ...(old ? { oldBlob: old.blob, oldMode: old.mode } : {}), ...(next ? { newBlob: next.blob, newMode: next.mode } : {}),
        ...(old ? { oldSize: old.size } : {}), ...(next ? { newSize: next.size } : {}) } as DiffChange];
    });
  }
  // As the daemon (ancestry.go): a commit outside the lineage is 404 not_found naming it; a walk past
  // ANCESTRY_LIMIT distinct commits is 413 too_deep, never a false or null answer.
  const ancestryCommit = (l: string, id: string) => {
    if (!scope(l).commits.has(id)) bad("not_found", 404, { commit: id }, `commit ${id} not found`);
    return info(l, id);
  };
  function isAncestor(l: string, a: string, b: string): boolean {
    if (!scope(l).commits.has(a)) bad("not_found", 404, { commit: a }, `commit ${a} not found`);
    const seen = new Set<string>(), queue = [b];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      if (seen.size === ANCESTRY_LIMIT) bad("too_deep", 413);
      seen.add(id);
      if (id === a) return true;
      queue.push(...ancestryCommit(l, id).parents);
    }
    return false;
  }
  function mergeBase(l: string, a: string, b: string): { base: string; tree: string } | { base: null; tree: null } {
    const nodes = new Map<string, { parents: string[]; tree: string; time: number; generations: [number, number] }>();
    const queues: [string[], string[]] = [[a], [b]], seen = [new Set([a]), new Set([b])];
    for (let generation = 0; queues[0].length + queues[1].length; generation++) for (const side of [0, 1] as const) {
      const next: string[] = [];
      for (const id of queues[side]) {
        let n = nodes.get(id);
        if (!n) {
          if (nodes.size === ANCESTRY_LIMIT) bad("too_deep", 413);
          const c = ancestryCommit(l, id);
          n = { parents: c.parents, tree: c.tree, time: c.time, generations: [-1, -1] }; nodes.set(id, n);
        }
        n.generations[side] = generation;
        for (const p of n.parents) if (!seen[side].has(p)) { seen[side].add(p); next.push(p); }
      }
      queues[side] = next;
    }
    const dominated = new Set<string>(), queue: string[] = [];
    for (const n of nodes.values()) if (n.generations[0] >= 0 && n.generations[1] >= 0) queue.push(...n.parents);
    while (queue.length) { const id = queue.shift()!; if (dominated.has(id)) continue; dominated.add(id); queue.push(...nodes.get(id)!.parents); }
    let best: string | undefined;
    for (const [id, n] of nodes) {
      if (n.generations[0] < 0 || n.generations[1] < 0 || dominated.has(id)) continue;
      const b = best && nodes.get(best)!;
      if (!b || n.time > b.time || (n.time === b.time && id > best!)) best = id;
    }
    return best ? { base: best, tree: nodes.get(best)!.tree } : { base: null, tree: null };
  }
  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url), s = url.searchParams;
    calls.push(`${request.method} ${url.pathname}${url.search}`);
    if (request.headers.get("authorization") !== `Bearer ${token}`) bad("unauthorized", 401);
    const match = /^\/v1\/lineages\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (!match) bad("not_in_tree", 404);
    const l = decodeURIComponent(match![1]), route = match![2], own = scope(l);
    // Strict like the daemon's decoder (DisallowUnknownFields): an unknown or missing required field is a 400 naming it.
    const q = async (allowed: string[], required: string[] = []): Promise<any> => {
      let v: any;
      try { v = await request.json(); } catch { return bad(); }
      if (!v || typeof v !== "object" || Array.isArray(v)) bad();
      for (const k of Object.keys(v)) if (!allowed.includes(k)) bad("invalid_request", 400, { field: k }, `unknown field ${k}`);
      for (const k of required) if (!(k in v)) bad("invalid_request", 400, { field: k }, `missing field ${k}`);
      return v;
    };
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
      const input = await q(["tree", "paths", "maxBytes"], ["tree", "paths"]);
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
      const input = await q(["parents", "baseTree", "changes", "author", "message", "trailers", "time"], ["parents", "changes", "author", "message", "trailers", "time"]);
      // As the daemon (storage.go): a remembered Idempotency-Key replays its first answer whatever this body says.
      const key = request.headers.get("Idempotency-Key"), cacheKey = `${l}\0${key}`;
      if (key && writes.has(cacheKey)) return json(writes.get(cacheKey)!.result, 201);
      const parents: string[] = input.parents;
      if (!Number.isSafeInteger(input.time) || !Array.isArray(parents) || parents.length > 2 || parents.some(p => !hash(p)) || !Array.isArray(input.changes) ||
        typeof input.author !== "string" || !input.author || /[\r\n\0<>]/.test(input.author) || typeof input.message !== "string" ||
        !input.trailers || typeof input.trailers !== "object" || Array.isArray(input.trailers) || Object.entries(input.trailers).some(([k, v]) => !k || /[\r\n:]/.test(k) || typeof v !== "string" || /[\r\n]/.test(v))) bad();
      if (input.changes.length > 10000) bad("too_large", 413);
      const parentInfo = parents.map(p => info(l, p, true));
      const baseId = input.baseTree ?? parentInfo[0]?.tree ?? EMPTY_TREE;
      const base = tree(l, baseId, true), files = new Map(base.files);
      let named = 0; // As the daemon: `bytes` counts the blobs this commit names, not the whole tree.
      for (const c of input.changes as Change[]) {
        if (!c || !validPath(c.path) || (c.mode !== undefined && !["100644", "100755", "120000"].includes(c.mode))) bad();
        if (c.delete) { files.delete(c.path); continue; }
        const old = files.get(c.path), blob = c.blob ?? old?.blob;
        if (!blob || !own.blobs.has(blob)) bad("unknown_blob");
        if (c.blob) named += blobs.get(c.blob)!.length;
        files.set(c.path, { path: c.path, blob, mode: c.mode ?? old?.mode ?? "100644", size: blobs.get(blob)!.length });
      }
      const id = await build(l, files);
      const object = await commitObject({ tree: id, parents, author: input.author, at: input.time * 1000, message: input.message, trailers: input.trailers });
      commits.set(object.id, object.bytes); own.commits.add(object.id);
      const result = { tree: id, commit: object.id, changed: changes(base, trees.get(id)!).length,
        bytes: named, parents, time: input.time };
      if (key) writes.set(cacheKey, { result });
      return json(result, 201);
    }
    if (request.method === "GET" && (route === "merge-base" || (route.startsWith("commits/") && route.endsWith("/is-ancestor")))) {
      const ancestor = route !== "merge-base";
      const ids = ancestor ? [route.slice(8, -"/is-ancestor".length), s.get("of") ?? ""] : [s.get("a") ?? "", s.get("b") ?? ""];
      const fields = ancestor ? ["commit", "of"] : ["a", "b"];
      ids.forEach((id, i) => { if (!id) bad("invalid_request", 400, undefined, `missing field ${fields[i]}`); });
      for (const id of ids) if (!hash(id)) bad("invalid_request", 400, undefined, `invalid commit ${id}`);
      return json(ancestor ? { ancestor: isAncestor(l, ids[0], ids[1]) } : mergeBase(l, ids[0], ids[1]));
    }
    if (request.method === "GET" && route.startsWith("trees/") && route.endsWith("/entry")) {
      const id = route.slice(6, -"/entry".length), path = s.get("path") ?? "";
      if (!path) bad("invalid_request", 400, undefined, "missing field path");
      if (!validPath(path)) bad("invalid_request", 400, undefined, `invalid path ${path}`);
      if (!hash(id) || !own.trees.has(id)) bad("not_found", 404);
      const t = trees.get(id)!, file = t.files.get(path);
      if (file) return json(file);
      const parts = path.split("/"); let dir: Tree | undefined = t;
      for (const part of parts.slice(0, -1)) { const sub: string | undefined = dir.dirs.get(part); dir = sub ? trees.get(sub) : undefined; if (!dir) break; }
      const sub = dir?.dirs.get(parts.at(-1)!);
      return sub ? json({ path, mode: "040000", tree: sub }) : bad("not_in_tree", 404);
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
      const input = await q(["base", "ours", "theirs", "mode"], ["base", "ours", "theirs", "mode"]); if (!["merge", "squash"].includes(input.mode)) bad();
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
  async function checkpoint(mount: { lineage: string; tree: string; parent?: string }, jobId: string) {
    tree(mount.lineage, mount.tree, true);
    const parents = mount.parent ? [mount.parent] : [];
    const author = `job:${jobId}`, at = Date.now(), message = "job checkpoint";
    const object = await commitObject({ tree: mount.tree, parents, author, at, message, trailers: {} });
    commits.set(object.id, object.bytes);
    scope(mount.lineage).commits.add(object.id);
    return { commit: object.id, tree: mount.tree, root: "a".repeat(64), warm: true, mountMs: 0, applyMs: 0 };
  }
  return { fetch, blobs, trees, commits, calls, checkpoint };
}
export async function serveFakeCamelfsd(token: string) {
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
  return { url: `http://127.0.0.1:${address.port}`, checkpoint: fake.checkpoint, close: () => new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())) };
}
