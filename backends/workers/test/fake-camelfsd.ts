import { RE2JS } from "re2js";
import { record, tokenVerifier, validHolder } from "./camelfs-token.ts";
import type { CamelfsTokenOptions, Holder } from "./camelfs-token.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const faultResponse = (e: Fault) =>
  json({ error: { code: e.code, message: e.message, ...(e.details === undefined ? {} : { details: e.details }) } }, e.status);
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
// Use the same line merge as the daemon for co-edited text.
function mergeFile(data: Uint8Array[]) {
  const dir = mkdtempSync(join(tmpdir(), "fake-camelfs-merge-"));
  try {
    const paths = data.map((bytes, i) => {
      const path = join(dir, String(i));
      writeFileSync(path, bytes);
      return path;
    });
    try { return execFileSync("git", ["merge-file", "-p", ...paths], { maxBuffer: 64 * 1024 ** 2 }); }
    catch (error) {
      if (record(error) && typeof error.status === "number" && error.status > 0 && error.status <= 127) return undefined;
      throw error;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** All objects and lineage membership remain local to this fake. Commit time comes from the request. */
type FakeOptions = CamelfsTokenOptions & {
  now?: () => number;
  beforeWriteMove?: () => Promise<void>;
};
type Ref = {
  name: string; version: string; tree: string; root?: string; owner: string;
  expiresAt?: number; holder?: Holder; leaseEpoch: number; leaseDeadline?: number;
  createdAt: number; createdBy: string; updatedAt: number;
};
type Lineage = {
  metadata?: { tenant: string; kind: string; defaultBranch: string };
  deleted?: boolean;
  refs: Map<string, Ref>;
  epochs: Map<string, number>;
  watchers: Map<string, Set<string>>;
  replays: Map<string, { name?: string; response: Promise<Response> }>;
  blobs: Set<string>; trees: Set<string>; commits: Set<string>;
};
const validName = (name: unknown): name is string => typeof name === "string" && name.length <= 200 &&
  /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(name) &&
  name.split("/").every(segment => segment !== "." && segment !== ".." && !segment.endsWith(".lock"));
const validOwner = (value: unknown): value is string => typeof value === "string" &&
  /^(agent|workflow|job|user|api|cache):[A-Za-z0-9._:-]{1,200}$/.test(value);
const isHeld = (ref: Ref, now: number) => ref.holder !== undefined && ref.leaseDeadline! > now;
const isLive = (ref: Ref, now: number) => ref.expiresAt === undefined || ref.expiresAt > now || isHeld(ref, now);
const requireHash = (value: unknown): string => hash(value) ? value : bad();

function fields(value: unknown, allowed: string[], required: string[] = []) {
  if (!record(value)) return bad();
  for (const k of Object.keys(value)) if (!allowed.includes(k)) bad("invalid_request", 400, { field: k }, `unknown field ${k}`);
  for (const k of required) if (!(k in value)) bad("invalid_request", 400, { field: k }, `missing field ${k}`);
  return value;
}

export function fakeCamelfsd(token: string, options: FakeOptions = {}) {
  const now = options.now ?? Date.now;
  const verifyToken = tokenVerifier(options);
  const blobs = new Map<string, Uint8Array>(), trees = new Map<string, Tree>(), commits = new Map<string, Uint8Array>();
  const lineages = new Map<string, Lineage>();
  const writes = new Map<string, { result: CommitResult }>();
  const commitInfo = new Map<string, CommitInfo>();
  const calls: string[] = [];
  const scope = (l: string) => {
    if (!lineages.has(l)) lineages.set(l, { blobs: new Set(), trees: new Set(), commits: new Set(), refs: new Map(), epochs: new Map(), watchers: new Map(), replays: new Map() });
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
    const cached = commitInfo.get(id);
    if (cached) return cached;
    const parsed = parseCommit(commits.get(id)!);
    // As the daemon: `author` is what the commit was made with, not the git identity line.
    const value = { tree: parsed.tree, parents: parsed.parents, author: parsed.author.slice(0, parsed.author.lastIndexOf(" <")), message: parsed.message, trailers: parsed.trailers,
      time: Number(/> (-?\d+) \+0000$/.exec(parsed.author)?.[1]) };
    commitInfo.set(id, value);
    return value;
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
  async function makeCommit(l: string, input: Record<string, unknown>): Promise<CommitResult> {
    const own = scope(l);
    const { parents, changes: edits, time, author, message, trailers } = input;
    if (typeof time !== "number" || !Number.isSafeInteger(time) || !Array.isArray(parents) || parents.length > 2 || parents.some(p => !hash(p)) || !Array.isArray(edits) ||
      typeof author !== "string" || !author || /[\r\n\0<>]/.test(author) || typeof message !== "string" ||
      !record(trailers) || Object.entries(trailers).some(([k, v]) => !k || /[\r\n:]/.test(k) || typeof v !== "string" || /[\r\n]/.test(v))) return bad();
    if (edits.length > 10000) bad("too_large", 413);
    const parentIds: string[] = parents;
    const parentInfo = parentIds.map(p => info(l, p, true));
    const baseId = input.baseTree ?? parentInfo[0]?.tree ?? EMPTY_TREE;
    const base = tree(l, requireHash(baseId), true), files = new Map(base.files);
    let named = 0; // As the daemon: `bytes` counts the blobs this commit names, not the whole tree.
    for (const c of edits as Change[]) {
      if (!c || !validPath(c.path) || (c.mode !== undefined && !["100644", "100755", "120000"].includes(c.mode))) bad();
      if (c.delete) { files.delete(c.path); continue; }
      const old = files.get(c.path), blob = c.blob ?? old?.blob;
      if (!blob || !own.blobs.has(blob)) bad("unknown_blob");
      if (c.blob) named += blobs.get(c.blob)!.length;
      files.set(c.path, { path: c.path, blob, mode: c.mode ?? old?.mode ?? "100644", size: blobs.get(blob)!.length });
    }
    const id = await build(l, files);
    const object = await commitObject({ tree: id, parents: parentIds, author, at: time * 1000, message, trailers: trailers as Record<string, string> });
    commits.set(object.id, object.bytes); own.commits.add(object.id);
    return { tree: id, commit: object.id, changed: changes(base, trees.get(id)!).length,
      bytes: named, parents: parentIds, time };
  }
  async function mergeTrees(l: string, base: Tree, ours: Tree, theirs: Tree) {
    const pending = new Map<string, Uint8Array>();
    const files = new Map<string, FileEntry>(), conflicts: Conflict[] = [], merged: string[] = [], took = { ours: 0, theirs: 0 };
    for (const path of [...new Set([...base.files.keys(), ...ours.files.keys(), ...theirs.files.keys()])].sort(compare)) {
      const b = base.files.get(path), o = ours.files.get(path), t = theirs.files.get(path); let chosen: FileEntry | undefined;
      if (same(o, t)) chosen = o;
      else if (same(b, o)) { chosen = t; took.theirs++; }
      else if (same(b, t)) { chosen = o; took.ours++; }
      else {
        let reason: Conflict["reason"] | undefined;
        if (!o || !t) reason = "delete_modify";
        else if (o.mode !== t.mode && b?.mode !== o.mode && b?.mode !== t.mode) reason = "mode";
        else {
          const mode = o.mode === b?.mode ? t.mode : o.mode;
          if (o.blob === t.blob || t.blob === b?.blob) chosen = { ...o, mode };
          else if (o.blob === b?.blob) chosen = { ...t, mode };
          else {
            const data = [o, b, t].map(entry => entry ? blobs.get(entry.blob)! : new Uint8Array());
            if (data.some(bytes => bytes.subarray(0, 8192).includes(0))) reason = "binary";
            else {
              const bytes = mergeFile(data);
              if (bytes) {
                const blob = await gitBlobSha1(bytes);
                pending.set(blob, bytes);
                chosen = { path, blob, mode, size: bytes.length };
              } else reason = "both_modified";
            }
          }
        }
        if (reason) {
          conflicts.push({ path, ...(b && { base: b.blob }), ...(o && { ours: o.blob }), ...(t && { theirs: t.blob }), reason });
          continue;
        }
      }
      if (chosen) files.set(path, chosen);
      if (!same(b, chosen)) merged.push(path);
    }
    // A file on one side and a directory on the other is also a path conflict.
    const paths = [...files.keys()].sort(compare);
    for (const path of paths) for (const parent of path.split("/").slice(0, -1).map((_, i) => path.split("/").slice(0, i + 1).join("/"))) {
      if (files.has(parent)) conflicts.push({ path: parent, reason: "both_modified" });
    }
    if (!conflicts.length) for (const [blob, bytes] of pending) {
      blobs.set(blob, bytes);
      scope(l).blobs.add(blob);
    }
    return { files, conflicts, merged, took };
  }
  const mergeConflict = (conflicts: Conflict[]) => faultResponse(new Fault(409, "conflict", { conflicts }));
  type Claims = ReturnType<typeof verifyToken>;
  type ReadBody = (allowed: string[], required?: string[]) => Promise<Record<string, unknown>>;
  const deny = (reason: string) => bad("forbidden", 403, undefined, reason);
  function authenticate(authorization: string | null, lineage: string, write: boolean): Claims {
    let claims: Claims;
    try { claims = verifyToken(authorization, now()); }
    catch (error) { return bad("unauthorized", 401, undefined, (error as Error).message); }
    if (claims.lin !== lineage) deny("token lineage does not match");
    if (write && claims.acc !== "w") deny("write access required");
    return claims;
  }

  // Ref walks differ from §9.4: an unrecorded parent is a dead end, and the
  // current version can match before there is a record for it.
  function reaches(l: string, current: string, target: string): boolean {
    const seen = new Set<string>(), queue = [target];
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      if (seen.has(id)) continue;
      if (seen.size === ANCESTRY_LIMIT) bad("not_fast_forward", 409, { current, reason: "too_deep" });
      seen.add(id);
      if (id === current) return true;
      if (scope(l).commits.has(id)) queue.push(...info(l, id).parents);
    }
    return false;
  }

  function usage(l: string, ref: Ref, target: string, quota: unknown) {
    // Fake quota B: mark distinct blobs at all live heads on each move and
    // treat writtenSince as zero.
    const targetFiles = tree(l, target).files;
    const distinct = new Map<string, number>();
    const add = (files: Map<string, FileEntry>) => {
      for (const { blob, size } of files.values()) distinct.set(blob, size);
    };
    add(targetFiles);
    const at = now();
    for (const other of scope(l).refs.values()) {
      if (other.name !== ref.name && isLive(other, at)) add(tree(l, other.tree).files);
    }
    const bytes = [...distinct.values()].reduce((total, size) => total + size, 0);
    if (quota !== undefined) {
      const { limitBytes, otherBytes } = fields(quota, ["limitBytes", "otherBytes"], ["limitBytes", "otherBytes"]);
      if (typeof limitBytes !== "number" || !Number.isSafeInteger(limitBytes) || limitBytes < 0 ||
          typeof otherBytes !== "number" || !Number.isSafeInteger(otherBytes) || otherBytes < 0) return bad();
      if (otherBytes + bytes > limitBytes) bad("storage_limit", 507, { limit: limitBytes });
    }
    return { bytes, files: targetFiles.size };
  }

  function move(l: string, ref: Ref, version: string, commit: { tree: string; parents: string[] },
    quota: unknown, root?: string, newCommit = false) {
    if (version !== ref.version) {
      if (newCommit) {
        const { parents } = commit;
        if (parents[0] !== ref.version || parents.length > 2) bad("bad_parent", 409, { parents, current: ref.version });
      } else if (!reaches(l, ref.version, version)) bad("not_fast_forward", 409, { current: ref.version });
    }
    const counts = usage(l, ref, commit.tree, quota);
    if (version !== ref.version) scope(l).refs.set(ref.name, {
      ...ref, version, tree: commit.tree, root, updatedAt: now(),
    });
    return { version, tree: commit.tree, ...counts };
  }

  async function writeChanges(l: string, input: unknown) {
    if (!Array.isArray(input)) return bad();
    if (input.length > 10000) bad("too_large", 413);
    let inlineBytes = 0;
    const parsed = input.map(raw => {
      const c = fields(raw, ["path", "blob", "text", "base64", "delete", "mode", "expectBlob"], ["path"]);
      const { path, text, base64, blob, mode, expectBlob } = c;
      if (!validPath(path) || (expectBlob !== undefined && expectBlob !== "none" && !hash(expectBlob)) ||
          (c.delete !== undefined && typeof c.delete !== "boolean") ||
          (mode !== undefined && mode !== "100644" && mode !== "100755" && mode !== "120000")) return bad();
      const sources = [text, base64, blob].filter(value => value !== undefined).length;
      if (sources > 1 || (c.delete && (sources || mode !== undefined)) ||
          (text !== undefined && typeof text !== "string") || (blob !== undefined && !hash(blob))) return bad();
      if (base64 !== undefined && (typeof base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64))) return bad();
      const bytes = typeof text === "string" ? Buffer.from(text) : typeof base64 === "string" ? Buffer.from(base64, "base64") : undefined;
      inlineBytes += bytes?.length ?? 0;
      return { path, blob: blob as string | undefined, mode, delete: c.delete, expectBlob, bytes };
    });
    if (inlineBytes > 8 * 1024 ** 2) bad("too_large", 413);
    return Promise.all(parsed.map(async ({ bytes, ...change }) => {
      if (!bytes) return change;
      const blob = await gitBlobSha1(bytes);
      blobs.set(blob, bytes);
      scope(l).blobs.add(blob);
      return { ...change, blob };
    }));
  }

  async function handleRefs(l: string, route: string, request: Request, claims: Claims, q: ReadBody) {
    const { method } = request, search = new URL(request.url).searchParams;
    const own = scope(l);
    const create = route === "refs" && method === "POST";
    const rawRoute = new URL(request.url).pathname.split("/").slice(4).join("/");
    const match = /^refs\/(.*?)(?:\/(cas|write|merge|restore|lease\/renew|lease|watchers\/([^/]+)))?$/.exec(rawRoute);
    const op = method === "GET" ? undefined : match?.[2];
    const watcher = op?.startsWith("watchers/") ? decodeURIComponent(match![3]) : undefined;
    // GET always takes the full name. A plain DELETE can also target slash names.
    let name: unknown = method === "GET" && match ? route.slice(5) : match && decodeURIComponent(match[1]);
    if (method === "DELETE" && match && op !== "lease" && !watcher) name = route.slice(5);
    const runtimeOnly = !!watcher || op === "lease" || op === "lease/renew" || (!route && method === "DELETE");
    if (runtimeOnly && !/^runtime:.+/.test(claims.sub)) deny("runtime subject required");
    if (method !== "GET" && !create && !match && claims.fence) deny("fence requires one exact ref");
    const authorizeRef = (candidate: unknown): string => {
      if (!validName(candidate)) return bad();
      if (method !== "GET") {
        const { refs, fence } = claims;
        if (fence && (refs.length !== 1 || refs[0] !== candidate)) deny("fence requires one exact ref");
        if (!refs.some(pattern => glob(pattern.replace(/\*+/g, "*")).test(candidate))) deny("token does not cover ref");
      }
      return candidate;
    };
    // POST refs must be parsed to discover the resource for authorization.
    // For replay, authorize the original name before returning its response.
    const key = request.headers.get("Idempotency-Key");
    const replayKey = `${method}\0${route}\0${key}`;
    const cached = key && method !== "GET" ? own.replays.get(replayKey) : undefined;
    if (match) name = authorizeRef(name);
    if (cached) {
      if (cached.name) authorizeRef(cached.name);
      return (await cached.response).clone();
    }
    const createInput = create ? await q(["name", "version", "owner", "expiresAt"], ["name", "version", "owner"]) : undefined;
    if (createInput) name = authorizeRef(createInput.name);
    // Another create with the same key may have completed while reading JSON.
    const pending = key && method !== "GET" ? own.replays.get(replayKey) : undefined;
    if (pending) {
      if (pending.name) authorizeRef(pending.name);
      return (await pending.response).clone();
    }

    const noBodyFields = async () => {
      const body = await request.text();
      if (!body) return;
      let value: unknown;
      try { value = JSON.parse(body); } catch { return bad(); }
      fields(value, []);
    };
    const refs = () => [...own.refs.values()].filter(ref => isLive(ref, now())).sort((a, b) => compare(a.name, b.name));
    const absent = () => bad("ref_not_found", 404);
    const current = (name: string) => {
      if (own.deleted) bad("lineage_deleted", 410);
      const ref = own.refs.get(name);
      return ref && isLive(ref, now()) ? ref : absent();
    };
    const unheld = (ref: Ref) => { if (isHeld(ref, now())) bad("held", 409); };
    const checkFence = (ref: Ref, required = true) => {
      const { fence } = claims;
      if (isHeld(ref, now())) {
        const { host, boot, mount } = ref.holder!;
        if (fence?.epoch !== ref.leaseEpoch || fence.holder.host !== host ||
            fence.holder.boot !== boot || fence.holder.mount !== mount) bad("fenced", 409);
      } else if (required || fence) bad("fenced", 409);
    };
    const remove = (name: string) => {
      own.refs.delete(name);
      own.watchers.delete(name);
    };
    const stale = (ref: Ref) => bad("stale", 412, { current: ref.version });
    const checked = (ref: Ref, expect: unknown) => {
      if (expect !== undefined && requireHash(expect) !== ref.version) stale(ref);
    };
    const ttl = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 600000 ? value : bad();

    async function run(): Promise<Response> {
      if (method === "DELETE" || (method === "PUT" && watcher)) await noBodyFields();
      if (own.deleted) bad("lineage_deleted", 410);
      if (!route) {
        if (method === "PUT") {
          const { tenant, kind, defaultBranch } = await q(["tenant", "kind", "defaultBranch"], ["tenant", "kind", "defaultBranch"]);
          if (typeof tenant !== "string" || !tenant || (kind !== "workspace" && kind !== "image") || !validName(defaultBranch)) return bad();
          if (own.deleted) bad("lineage_deleted", 410);
          if (own.metadata && own.metadata.tenant !== tenant) bad("lineage_conflict", 409, { tenant: own.metadata.tenant });
          if (own.metadata) return json(own.metadata);
          own.metadata = { tenant, kind, defaultBranch };
          return json(own.metadata, 201);
        }
        if (method === "GET") return own.metadata ? json(own.metadata) : absent();
        if (method === "DELETE") {
          const held = refs().filter(ref => isHeld(ref, now())).map(ref => ref.name);
          if (held.length) bad("held", 409, { held });
          own.refs.clear();
          own.watchers.clear();
          own.deleted = true;
          return new Response(null, { status: 204 });
        }
      }
      if (route === "refs") {
        if (method === "GET") {
          const limit = Number(search.get("limit") ?? 1000);
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) bad();
          const prefix = search.get("prefix") ?? "", after = search.get("after") ?? "";
          const matching = refs().filter(ref => ref.name.startsWith(prefix) && compare(ref.name, after) > 0);
          const page = matching.slice(0, limit);
          return json({ refs: page, ...(matching.length > limit ? { next: page.at(-1)!.name } : {}) });
        }
        if (method === "DELETE") {
          const owner = search.get("owner");
          if (!validOwner(owner)) bad();
          const deleted: string[] = [], held: string[] = [];
          for (const ref of refs()) {
            if (ref.owner !== owner) continue;
            if (isHeld(ref, now())) held.push(ref.name);
            else { remove(ref.name); deleted.push(ref.name); }
          }
          return json({ deleted, held });
        }
        if (createInput) {
          const { version, owner, expiresAt } = createInput;
          if (typeof name !== "string" || !validOwner(owner) ||
              (expiresAt !== undefined && !Number.isSafeInteger(expiresAt))) return bad();
          const at = now(), c = info(l, requireHash(version), true), existing = own.refs.get(name);
          if (existing && isLive(existing, at)) bad("ref_exists", 409);
          const ref: Ref = { name, version: version as string, tree: c.tree, owner, expiresAt: expiresAt as number | undefined,
            leaseEpoch: own.epochs.get(name) ?? 0, createdBy: claims.sub, createdAt: at, updatedAt: at };
          own.refs.set(name, ref);
          own.watchers.delete(name);
          return json(ref, 201);
        }
      }
      if (typeof name !== "string") return absent();
      if (method === "GET") return json(current(name));
      if (watcher && (method === "PUT" || method === "DELETE")) {
        if (!validOwner(watcher)) bad();
        current(name);
        const set = own.watchers.get(name) ?? new Set<string>();
        if (method === "PUT") set.add(watcher);
        else set.delete(watcher);
        own.watchers.set(name, set);
        return new Response(null, { status: 204 });
      }
      if (op === "lease" && method === "POST") {
        const { holder, ttlMs } = await q(["holder", "ttlMs"], ["holder", "ttlMs"]);
        if (!validHolder(holder)) return bad();
        const duration = ttl(ttlMs), ref = current(name);
        unheld(ref);
        const epoch = ref.leaseEpoch + 1, deadline = now() + duration;
        own.epochs.set(name, epoch);
        own.refs.set(name, { ...ref, holder, leaseEpoch: epoch, leaseDeadline: deadline });
        return json({ epoch, deadline, version: ref.version, tree: ref.tree });
      }
      if (op === "lease/renew" && method === "POST") {
        const { ttlMs } = await q(["ttlMs"], ["ttlMs"]);
        const duration = ttl(ttlMs), ref = current(name);
        checkFence(ref);
        const deadline = now() + duration;
        own.refs.set(name, { ...ref, leaseDeadline: deadline });
        return json({ deadline });
      }
      if (method === "DELETE") {
        const ref = current(name);
        if (op === "lease") {
          checkFence(ref);
          own.refs.set(name, { ...ref, holder: undefined, leaseDeadline: undefined });
        } else {
          unheld(ref);
          checked(ref, search.get("expect") ?? undefined);
          remove(name);
        }
        return new Response(null, { status: 204 });
      }
      if (method !== "POST") return absent();
      if (op === "cas") {
        const { commit, expect, root, quota } = await q(["commit", "expect", "root", "quota"], ["commit", "expect"]);
        if (root !== undefined && (typeof root !== "string" || !/^[a-f0-9]{64}$/.test(root))) return bad();
        const version = requireHash(commit), ref = current(name);
        checkFence(ref, false);
        checked(ref, expect);
        const c = info(l, version, true);
        // After stale and fence (they win): a commit with more than two parents is never a move (C3a).
        if (c.parents.length > 2) bad("bad_parent", 409, { parents: c.parents, current: ref.version });
        const diff = changes(tree(l, ref.tree), tree(l, c.tree));
        // This route names a recorded object. The one-call routes can validate
        // rule 1 because they construct the commit for the move themselves.
        return json({ ...move(l, ref, version, c, quota, root), parents: c.parents, diff });
      }
      const metadata = ["author", "message", "time", "trailers"];
      const required = ["author", "message", "time"];
      if (op === "write") {
        const input = await q([...metadata, "changes", "expect", "quota"], [...required, "changes"]);
        let ref = current(name);
        unheld(ref);
        checked(ref, input.expect);
        const edits = await writeChanges(l, input.changes);
        const checkPaths = (ref: Ref) => {
          const base = tree(l, ref.tree);
          for (const edit of edits) {
            const blob = base.files.get(edit.path)?.blob ?? null;
            if (edit.expectBlob !== undefined && blob !== (edit.expectBlob === "none" ? null : edit.expectBlob)) {
              bad("stale", 412, { current: ref.version, path: edit.path, blob });
            }
          }
          return base;
        };
        for (let attempt = 0; ; attempt++) {
          const base = checkPaths(ref);
          const c = await makeCommit(l, { ...input, changes: edits, parents: [ref.version], trailers: input.trailers ?? {} });
          await options.beforeWriteMove?.();
          const latest = current(name);
          unheld(latest);
          if (latest.version === ref.version) {
            const changed = changes(base, tree(l, c.tree)).map(({ oldMode, newMode, ...change }) => ({ ...change, mode: newMode ?? oldMode }));
            return json({ ...move(l, latest, c.commit, c, input.quota, undefined, true), parents: c.parents, time: c.time, changed }, 201);
          }
          if (input.expect !== undefined) stale(latest);
          checkPaths(latest);
          if (attempt === 1) stale(latest);
          ref = latest;
        }
      }
      if (op === "merge" || op === "restore") {
        const operationFields = op === "merge" ? ["theirs", "mode"] : ["version"];
        const input = await q([...metadata, ...operationFields, "quota"], [...required, ...operationFields]);
        const ref = current(name);
        unheld(ref);
        const finish = (c: { commit: string; tree: string; parents: string[] }, extra = {}) => {
          const latest = current(name);
          unheld(latest);
          if (ref.version !== latest.version) stale(latest);
          return json({ ...move(l, latest, c.commit, c, input.quota, undefined, true), ...extra }, 201);
        };
        if (op === "restore") {
          const old = info(l, requireHash(input.version), true);
          return finish(await makeCommit(l, { ...input, parents: [ref.version], baseTree: old.tree, changes: [], trailers: input.trailers ?? {} }));
        }
        const { mode } = input;
        if (mode !== "merge" && mode !== "ff-only" && mode !== "squash") bad();
        const theirs = requireHash(input.theirs), target = info(l, theirs, true);
        const ff = reaches(l, ref.version, theirs);
        if (ff && mode !== "squash") {
          // A fast-forward needed no 3-way merge: merged is empty; took counts the paths changed from head to theirs.
          const changed = changes(tree(l, ref.tree), tree(l, target.tree)).length;
          return json({ ...move(l, ref, theirs, target, input.quota), ff, merged: [], took: { ours: 0, theirs: changed } }, 201);
        }
        if (mode === "ff-only") bad("not_fast_forward", 409, { current: ref.version });
        const base = mergeBase(l, ref.version, theirs);
        const merged = await mergeTrees(l, tree(l, base.tree ?? EMPTY_TREE, true), tree(l, ref.tree), tree(l, target.tree));
        if (merged.conflicts.length) return mergeConflict(merged.conflicts);
        const baseTree = await build(l, merged.files);
        const c = await makeCommit(l, { ...input, parents: mode === "squash" ? [ref.version] : [ref.version, theirs],
          baseTree, changes: [], trailers: input.trailers ?? {} });
        return finish(c, { ff: false, merged: merged.merged, took: merged.took });
      }
      return absent();
    }

    if (!key || method === "GET") return run();
    const response = run().then(result => {
      if (!result.ok) own.replays.delete(replayKey);
      return result;
    }, error => {
      own.replays.delete(replayKey);
      throw error;
    });
    own.replays.set(replayKey, { name: typeof name === "string" ? name : undefined, response });
    return (await response).clone();
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url), s = url.searchParams;
    calls.push(`${request.method} ${url.pathname}${url.search}`);
    const authorization = request.headers.get("authorization");
    const match = /^\/v1\/lineages\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!match) bad("not_in_tree", 404);
    let l: string, route: string;
    try { l = decodeURIComponent(match![1]); route = decodeURIComponent(match![2] ?? ""); }
    catch { return bad(); }
    const own = scope(l);
    // A replayed lineage DELETE (same Idempotency-Key) answers its first 204; anything else on a deleted lineage is 410.
    const replayedDelete = request.method === "DELETE" && !route && own.replays.has(`DELETE\0\0${request.headers.get("Idempotency-Key")}`);
    if (own.deleted && !replayedDelete) bad("lineage_deleted", 410);
    const readBody: ReadBody = async (allowed, required = []) => {
      let value: unknown;
      try { value = await request.json(); } catch { return bad(); }
      return fields(value, allowed, required);
    };
    const refRoute = !route || route === "refs" || route.startsWith("refs/");
    if (refRoute || authorization !== `Bearer ${token}`) {
      const reads = request.method === "GET" || request.method === "HEAD" || (request.method === "POST" && route === "read");
      const claims = authenticate(authorization, l, !reads);
      if (refRoute) return handleRefs(l, route, request, claims, readBody);
    }
    const q: (allowed: string[], required?: string[]) => Promise<any> = readBody;
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
      const key = request.headers.get("Idempotency-Key"), cacheKey = `${l}\0${key}`;
      if (key && writes.has(cacheKey)) return json(writes.get(cacheKey)!.result, 201);
      const result = await makeCommit(l, input);
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
      const input = await q(["base", "ours", "theirs", "mode"], ["base", "ours", "theirs", "mode"]);
      if (!["merge", "squash"].includes(input.mode)) bad();
      const { files, conflicts, merged, took } = await mergeTrees(l, tree(l, input.base, true), tree(l, input.ours, true), tree(l, input.theirs, true));
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
    catch (e) { if (e instanceof Fault) return faultResponse(e); throw e; }
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
export async function serveFakeCamelfsd(token: string, options?: FakeOptions) {
  const fake = fakeCamelfsd(token, options);
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
