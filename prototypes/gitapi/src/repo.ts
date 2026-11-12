// RepoCore: one git repository behind a programmable API. Refs, the object index and the raw bytes of every tree and
// commit live in SQLite (a Durable Object's, or node:sqlite on a node); blob bytes live in R2 "segments": one R2
// object per write, holding pack entries (type/size header + zlib) back to back, so a clone is the concatenation of
// byte ranges and nothing is ever recompressed. Writers are serialised by the caller (one DO per repo + a mutex).
//
// Nobody outside builds packs or trees: `commit` takes a file map, `merge` takes two branch names, and the git wire
// protocol is served read-only (upload-pack) for jobs.
import { mergeLines } from "./merge.ts";
import {
  CODE_TYPE, EMPTY_TREE, TYPE_CODE, ZERO, FLUSH, concat, encodeCommit, encodeTree, hashObject, inflateEntry, packEntry,
  parseCommit, parseTree, pkt, readPkts, text, utf8,
  type Commit, type Mode, type ObjectType, type Person, type Sha, type TreeEntry,
} from "./objects.ts";

export interface Sql { exec<T = Record<string, unknown>>(query: string, ...params: unknown[]): T[]; tx<T>(fn: () => T): T }
export interface Bucket {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string, range?: { offset: number; length: number }): Promise<Uint8Array | null>;
  delete(keys: string[]): Promise<void>;
}

export type FileChange = { content?: string; base64?: string; mode?: Mode; sha?: Sha } | null; // null deletes; sha: an existing blob
/** `expect` is per-file optimistic concurrency (path -> blob sha the writer read, null: must not exist), checked
 *  against the branch head, so writers of different files never conflict; `expectedHead` is the whole-branch CAS. */
export type CommitRequest = { branch: string; files: Record<string, FileChange>; message: string; author?: Person; expectedHead?: Sha | null; expect?: Record<string, Sha | null>; from?: string };
export type CommitResult = { commit: Sha; tree: Sha; parents: Sha[]; objectsWritten: number; bytesWritten: number };
export type MergeRequest = { into: string; from: string; expectedHead?: Sha; squash?: boolean; message?: string; author?: Person; deleteSource?: boolean };
export type Conflict = { path: string; base: Sha | null; ours: Sha | null; theirs: Sha | null; reason: string };
export type MergeResult = { status: "merged" | "fast-forward" | "up-to-date"; commit: Sha; tree: Sha } | { status: "conflict"; conflicts: Conflict[]; base: Sha; ours: Sha; theirs: Sha };
export type Run = { key: string; offset: number; length: number };
export type UploadPlan = { prefix: Uint8Array; pack: { count: number; runs: Run[]; bytes: number; cacheKey: string | null } | null };
export type DiffEntry = { path: string; status: "added" | "deleted" | "modified"; oldSha: Sha | null; newSha: Sha | null };

export class HttpError extends Error {
  readonly status: number; readonly body?: unknown;
  constructor(status: number, message: string, body?: unknown) { super(message); this.status = status; this.body = body; }
}

type ObjRow = { sha: string; type: number; size: number; seg: string | null; off: number; len: number; hlen: number; raw: ArrayBuffer | Uint8Array | null };
const INLINE_MAX = 1 << 20;
const DEFAULT_AUTHOR: Person = { name: "camelRun", email: "volumes@camelai.com" };
const bytesOf = (raw: ArrayBuffer | Uint8Array) => (raw instanceof Uint8Array ? raw : new Uint8Array(raw));

/** Objects created by one write, buffered into one segment. */
class SegmentWriter {
  readonly parts: Uint8Array[] = [];
  readonly rows: { sha: Sha; type: ObjectType; size: number; off: number; len: number; hlen: number; raw: Uint8Array | null }[] = [];
  readonly seen = new Map<Sha, Uint8Array | null>();
  bytes = 0;
  private readonly has: (sha: Sha) => boolean;
  constructor(has: (sha: Sha) => boolean) { this.has = has; }
  add(type: ObjectType, content: Uint8Array): Sha {
    const sha = hashObject(type, content);
    if (this.seen.has(sha) || this.has(sha)) return sha;
    const { entry, hlen } = packEntry(type, content);
    this.rows.push({ sha, type, size: content.byteLength, off: this.bytes, len: entry.byteLength, hlen, raw: type === "blob" ? null : content });
    this.seen.set(sha, type === "blob" ? null : content);
    this.parts.push(entry);
    this.bytes += entry.byteLength;
    return sha;
  }
}

export class RepoCore {
  private readonly sql: Sql; private readonly bucket: Bucket; private readonly prefix: string; private readonly now: () => number;
  constructor(sql: Sql, bucket: Bucket, prefix: string, now = () => Date.now()) {
    this.sql = sql; this.bucket = bucket; this.prefix = prefix; this.now = now;
    sql.exec(`CREATE TABLE IF NOT EXISTS refs (name TEXT PRIMARY KEY, sha TEXT NOT NULL, base TEXT, expires_at INTEGER, updated_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS objects (sha TEXT PRIMARY KEY, type INTEGER NOT NULL, size INTEGER NOT NULL, seg TEXT, off INTEGER NOT NULL, len INTEGER NOT NULL, hlen INTEGER NOT NULL, raw BLOB, created_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS segments (key TEXT PRIMARY KEY, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS worktree (branch TEXT NOT NULL, path TEXT NOT NULL, data BLOB, sha TEXT, mode TEXT NOT NULL, PRIMARY KEY (branch, path))`);
    sql.exec(`CREATE TABLE IF NOT EXISTS clones (key TEXT PRIMARY KEY, commit_sha TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
  }

  // ---------- refs ----------
  refs(): { name: string; sha: Sha; base: Sha | null; expiresAt: number | null }[] {
    return this.sql.exec<{ name: string; sha: string; base: string | null; expires_at: number | null }>(`SELECT name, sha, base, expires_at FROM refs ORDER BY name`)
      .map((r) => ({ name: r.name, sha: r.sha, base: r.base, expiresAt: r.expires_at }));
  }
  private ref(name: string): Sha | null { return this.sql.exec<{ sha: string }>(`SELECT sha FROM refs WHERE name = ?`, name)[0]?.sha ?? null; }
  /** A branch name, `refs/heads/x`, or a commit sha. */
  resolve(ref: string): Sha {
    const name = ref.startsWith("refs/") ? ref.slice(11) : ref;
    const sha = this.ref(name) ?? (/^[0-9a-f]{40}$/.test(ref) && this.hasObject(ref) ? ref : null);
    if (!sha) throw new HttpError(404, `no such ref ${ref}`);
    return sha;
  }
  private setRef(name: string, sha: Sha, expected: Sha | null | undefined, extra: { base?: Sha | null; expiresAt?: number | null } = {}) {
    const current = this.ref(name);
    if (expected !== undefined && current !== expected) throw new HttpError(409, `ref ${name} is at ${current ?? "nothing"}, expected ${expected ?? "nothing"}`, { current });
    if (current === null) this.sql.exec(`INSERT INTO refs (name, sha, base, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)`, name, sha, extra.base ?? null, extra.expiresAt ?? null, this.now());
    else this.sql.exec(`UPDATE refs SET sha = ?, updated_at = ? WHERE name = ?`, sha, this.now(), name);
  }

  createBranch(req: { name: string; from?: string; ttlSeconds?: number }) {
    if (!/^[A-Za-z0-9._\/-]+$/.test(req.name) || req.name.includes("..")) throw new HttpError(400, "bad branch name");
    const sha = this.resolve(req.from ?? "main");
    const expiresAt = req.ttlSeconds ? this.now() + req.ttlSeconds * 1000 : null;
    this.setRef(req.name, sha, null, { base: sha, expiresAt });
    return { name: req.name, sha, expiresAt };
  }
  deleteBranch(name: string, expected?: Sha) {
    const current = this.ref(name);
    if (!current) throw new HttpError(404, `no such branch ${name}`);
    if (expected && current !== expected) throw new HttpError(409, `branch ${name} moved`);
    this.sql.exec(`DELETE FROM refs WHERE name = ?`, name);
    return { deleted: name, sha: current };
  }
  /** Ephemeral branches past their expiry are dropped (their objects go at the next GC). Returns the next expiry. */
  expire(): { expired: string[]; next: number | null } {
    const now = this.now();
    const expired = this.sql.exec<{ name: string }>(`SELECT name FROM refs WHERE expires_at IS NOT NULL AND expires_at <= ?`, now).map((r) => r.name);
    for (const name of expired) this.sql.exec(`DELETE FROM refs WHERE name = ?`, name);
    return { expired, next: this.sql.exec<{ t: number | null }>(`SELECT MIN(expires_at) AS t FROM refs WHERE expires_at IS NOT NULL`)[0]?.t ?? null };
  }
  nextExpiry(): number | null { return this.sql.exec<{ t: number | null }>(`SELECT MIN(expires_at) AS t FROM refs WHERE expires_at IS NOT NULL`)[0]?.t ?? null; }
  extendBranch(name: string, ttlSeconds: number) {
    if (!this.ref(name)) throw new HttpError(404, `no such branch ${name}`);
    this.sql.exec(`UPDATE refs SET expires_at = ? WHERE name = ?`, this.now() + ttlSeconds * 1000, name);
  }

  // ---------- objects ----------
  private hasObject(sha: Sha) { return this.sql.exec(`SELECT 1 FROM objects WHERE sha = ?`, sha).length > 0; }
  private row(sha: Sha): ObjRow | null { return this.sql.exec<ObjRow>(`SELECT sha, type, size, seg, off, len, hlen, raw FROM objects WHERE sha = ?`, sha)[0] ?? null; }
  /** Trees and commits come from SQLite; the empty tree is implicit. */
  private rawMeta(sha: Sha, pending?: SegmentWriter): Uint8Array {
    if (sha === EMPTY_TREE) return new Uint8Array();
    const p = pending?.seen.get(sha);
    if (p) return p;
    const r = this.sql.exec<{ raw: ArrayBuffer | null }>(`SELECT raw FROM objects WHERE sha = ?`, sha)[0];
    if (!r?.raw) throw new Error(`missing tree/commit ${sha}`);
    return bytesOf(r.raw);
  }
  commitOf(sha: Sha): Commit { return parseCommit(this.rawMeta(sha)); }
  treeOf(sha: Sha, pending?: SegmentWriter): TreeEntry[] { return parseTree(this.rawMeta(sha, pending)); }
  async readBlob(sha: Sha): Promise<Uint8Array> {
    const r = this.row(sha);
    if (!r || !r.seg) throw new HttpError(404, `no such blob ${sha}`);
    const entry = await this.bucket.get(r.seg, { offset: r.off, length: r.len });
    if (!entry) throw new Error(`segment ${r.seg} missing`);
    return inflateEntry(entry, r.hlen);
  }

  private async flush(w: SegmentWriter, andThen?: () => void): Promise<string | null> {
    if (!w.rows.length) { andThen?.(); return null; }
    const key = `${this.prefix}/seg/${this.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    // Segments hold every entry (trees and commits too) so a clone is pure byte copies.
    await this.bucket.put(key, concat(w.parts));
    const now = this.now();
    this.sql.tx(() => {
      this.sql.exec(`INSERT INTO segments (key, bytes, created_at) VALUES (?, ?, ?)`, key, w.bytes, now);
      for (const r of w.rows) this.sql.exec(`INSERT OR IGNORE INTO objects (sha, type, size, seg, off, len, hlen, raw, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, r.sha, TYPE_CODE[r.type], r.size, key, r.off, r.len, r.hlen, r.raw, now);
      andThen?.();
    });
    return key;
  }

  // ---------- commit ----------
  /** A file map in, a commit out. `expectedHead` is a compare-and-swap (null: the branch must not exist yet). */
  async commit(req: CommitRequest): Promise<CommitResult> {
    const head = this.ref(req.branch);
    if (req.expectedHead !== undefined && head !== req.expectedHead) throw new HttpError(409, `branch ${req.branch} is at ${head ?? "nothing"}`, { current: head });
    const parentSha = head ?? (req.from ? this.resolve(req.from) : null);
    const baseTree = parentSha ? this.commitOf(parentSha).tree : EMPTY_TREE;
    for (const [path, sha] of Object.entries(req.expect ?? {})) {
      const current = this.lookup(baseTree, normalisePath(path));
      if ((current?.sha ?? null) !== sha) throw new HttpError(409, `${path} changed`, { path, current: current?.sha ?? null });
    }
    const w = new SegmentWriter((sha) => this.hasObject(sha));
    const changes = new Map<string, { sha: Sha; mode: Mode } | null>();
    for (const [rawPath, change] of Object.entries(req.files)) {
      const path = normalisePath(rawPath);
      if (change === null) { changes.set(path, null); continue; }
      if (change.sha) { if (!this.hasObject(change.sha)) throw new HttpError(400, `no blob ${change.sha}`); changes.set(path, { sha: change.sha, mode: change.mode ?? "100644" }); continue; }
      const bytes = change.base64 !== undefined ? new Uint8Array(Buffer.from(change.base64, "base64")) : utf8(change.content ?? "");
      changes.set(path, { sha: w.add("blob", bytes), mode: change.mode ?? "100644" });
    }
    const tree = this.writeTree(baseTree, changes, w) ?? w.add("tree", new Uint8Array());
    if (parentSha && tree === baseTree) return { commit: parentSha, tree, parents: this.commitOf(parentSha).parents, objectsWritten: 0, bytesWritten: 0 };
    const parents = parentSha ? [parentSha] : [];
    const commit = w.add("commit", encodeCommit({ tree, parents, author: req.author ?? DEFAULT_AUTHOR, message: req.message }));
    // Index rows and the ref move in one SQLite transaction after the segment is durable in R2; the ref CAS is
    // re-checked there, so a racing writer cannot be overwritten (the object also serialises writers).
    await this.flush(w, () => this.setRef(req.branch, commit, head));
    return { commit, tree, parents, objectsWritten: w.rows.length, bytesWritten: w.bytes };
  }

  /** Applies path changes below a tree; returns the new tree sha, or null when it ends up empty. Only the trees on
   *  changed paths are read and rewritten, so a one-file commit into 50k files touches depth-many rows. */
  private writeTree(treeSha: Sha | null, changes: Map<string, { sha: Sha; mode: Mode } | null>, w: SegmentWriter): Sha | null {
    const entries = new Map((treeSha ? this.treeOf(treeSha, w) : []).map((e) => [e.name, e]));
    const below = new Map<string, Map<string, { sha: Sha; mode: Mode } | null>>();
    for (const [path, change] of changes) {
      const slash = path.indexOf("/");
      if (slash < 0) {
        if (change === null) entries.delete(path);
        else entries.set(path, { name: path, mode: change.mode, sha: change.sha });
        continue;
      }
      const dir = path.slice(0, slash);
      if (!below.has(dir)) below.set(dir, new Map());
      below.get(dir)!.set(path.slice(slash + 1), change);
    }
    for (const [dir, sub] of below) {
      const existing = entries.get(dir);
      const child = this.writeTree(existing?.mode === "40000" ? existing.sha : null, sub, w);
      if (child) entries.set(dir, { name: dir, mode: "40000", sha: child });
      else entries.delete(dir);
    }
    if (!entries.size) return null;
    return w.add("tree", encodeTree([...entries.values()]));
  }

  // ---------- worktree: the working layer for agents' file tools ----------
  // Per-branch dirty rows in the same object: a write is one SQLite row (no R2, no commit); reads see dirty rows over
  // the branch head; `checkpoint` turns the rows into one commit. Files over INLINE_MAX go to R2 as their own segment
  // at write time (a DO row is ≤2 MB) and the row keeps only the blob sha.
  private wtRow(branch: string, path: string) { return this.sql.exec<{ data: ArrayBuffer | Uint8Array | null; sha: string | null; mode: Mode }>(`SELECT data, sha, mode FROM worktree WHERE branch = ? AND path = ?`, branch, path)[0]; }
  /** The blob sha a reader sees at `path` (dirty row first), null when absent: what a writer passes as `expect`. */
  wtStat(branch: string, rawPath: string): { sha: Sha | null; dirty: boolean } {
    const path = normalisePath(rawPath), row = this.wtRow(branch, path);
    if (row) return { sha: row.sha ?? (row.data ? hashObject("blob", bytesOf(row.data)) : null), dirty: true };
    const head = this.ref(branch);
    return { sha: head ? this.lookup(this.commitOf(head).tree, path)?.sha ?? null : null, dirty: false };
  }
  async wtWrite(branch: string, rawPath: string, bytes: Uint8Array | null, expect?: Sha | null, mode: Mode = "100644") {
    const path = normalisePath(rawPath);
    if (expect !== undefined && this.wtStat(branch, path).sha !== expect) throw new HttpError(409, `${path} changed`);
    if (bytes === null) { this.sql.exec(`INSERT OR REPLACE INTO worktree (branch, path, data, sha, mode) VALUES (?, ?, NULL, NULL, ?)`, branch, path, mode); return { path, sha: null }; }
    if (bytes.byteLength <= INLINE_MAX) { this.sql.exec(`INSERT OR REPLACE INTO worktree (branch, path, data, sha, mode) VALUES (?, ?, ?, NULL, ?)`, branch, path, bytes, mode); return { path, sha: hashObject("blob", bytes) }; }
    const w = new SegmentWriter((sha) => this.hasObject(sha));
    const sha = w.add("blob", bytes);
    await this.flush(w);
    this.sql.exec(`INSERT OR REPLACE INTO worktree (branch, path, data, sha, mode) VALUES (?, ?, X'', ?, ?)`, branch, path, sha, mode);
    return { path, sha };
  }
  async wtRead(branch: string, rawPath: string): Promise<{ sha: Sha; bytes: Uint8Array; dirty: boolean }> {
    const path = normalisePath(rawPath), row = this.wtRow(branch, path);
    if (row?.sha) return { sha: row.sha, bytes: await this.readBlob(row.sha), dirty: true };
    if (row && row.data) { const bytes = bytesOf(row.data); return { sha: hashObject("blob", bytes), bytes, dirty: true }; }
    if (row) throw new HttpError(404, `${path} deleted in the worktree`);
    const f = await this.readFile(branch, path);
    return { sha: f.sha, bytes: f.bytes, dirty: false };
  }
  wtStatus(branch: string) { return this.sql.exec<{ path: string; deleted: number }>(`SELECT path, (data IS NULL AND sha IS NULL) AS deleted FROM worktree WHERE branch = ? ORDER BY path`, branch); }
  async checkpoint(branch: string, message: string, author?: Person): Promise<CommitResult | { commit: null }> {
    const rows = this.sql.exec<{ path: string; data: ArrayBuffer | Uint8Array | null; sha: string | null; mode: Mode }>(`SELECT path, data, sha, mode FROM worktree WHERE branch = ?`, branch);
    if (!rows.length) return { commit: null };
    const files: Record<string, FileChange> = {};
    for (const r of rows) files[r.path] = r.sha ? { sha: r.sha, mode: r.mode } : r.data ? { base64: Buffer.from(bytesOf(r.data)).toString("base64"), mode: r.mode } : null;
    const result = await this.commit({ branch, files, message, author });
    this.sql.exec(`DELETE FROM worktree WHERE branch = ?`, branch);
    return result;
  }

  // ---------- reads ----------
  private lookup(treeSha: Sha, path: string): TreeEntry | null {
    let entry: TreeEntry = { mode: "40000", name: "", sha: treeSha };
    for (const part of path.split("/").filter(Boolean)) {
      if (entry.mode !== "40000") return null;
      const next = this.treeOf(entry.sha).find((e) => e.name === part);
      if (!next) return null;
      entry = next;
    }
    return entry;
  }
  async readFile(ref: string, path: string): Promise<{ sha: Sha; mode: Mode; bytes: Uint8Array; commit: Sha }> {
    const commit = this.resolve(ref);
    const entry = this.lookup(this.commitOf(commit).tree, normalisePath(path));
    if (!entry || entry.mode === "40000") throw new HttpError(404, `no file ${path} at ${ref}`);
    return { sha: entry.sha, mode: entry.mode, bytes: await this.readBlob(entry.sha), commit };
  }
  readTree(ref: string, path = "", recursive = false): { commit: Sha; tree: Sha; entries: { path: string; mode: Mode; sha: Sha; type: string }[] } {
    const commit = this.resolve(ref);
    const root = this.commitOf(commit).tree;
    const start = path ? this.lookup(root, normalisePath(path)) : { mode: "40000" as Mode, name: "", sha: root };
    if (!start || start.mode !== "40000") throw new HttpError(404, `no directory ${path} at ${ref}`);
    const out: { path: string; mode: Mode; sha: Sha; type: string }[] = [];
    const walk = (sha: Sha, prefix: string) => {
      for (const e of this.treeOf(sha)) {
        const p = prefix ? `${prefix}/${e.name}` : e.name;
        out.push({ path: p, mode: e.mode, sha: e.sha, type: e.mode === "40000" ? "tree" : "blob" });
        if (recursive && e.mode === "40000") walk(e.sha, p);
      }
    };
    walk(start.sha, "");
    return { commit, tree: start.sha, entries: out };
  }
  diff(from: string, to: string): { from: Sha; to: Sha; changes: DiffEntry[] } {
    const a = this.resolve(from), b = this.resolve(to);
    const changes: DiffEntry[] = [];
    this.diffTrees(this.commitOf(a).tree, this.commitOf(b).tree, "", changes);
    return { from: a, to: b, changes };
  }
  private diffTrees(a: Sha | null, b: Sha | null, prefix: string, out: DiffEntry[]) {
    if (a === b) return;
    const left = new Map((a ? this.treeOf(a) : []).map((e) => [e.name, e])), right = new Map((b ? this.treeOf(b) : []).map((e) => [e.name, e]));
    for (const name of new Set([...left.keys(), ...right.keys()])) {
      const l = left.get(name), r = right.get(name), path = prefix ? `${prefix}/${name}` : name;
      if (l?.sha === r?.sha && l?.mode === r?.mode) continue;
      const lDir = l?.mode === "40000", rDir = r?.mode === "40000";
      if (lDir || rDir) {
        this.diffTrees(lDir ? l!.sha : null, rDir ? r!.sha : null, path, out);
        if (l && !lDir) out.push({ path, status: "deleted", oldSha: l.sha, newSha: null });
        if (r && !rDir) out.push({ path, status: "added", oldSha: null, newSha: r.sha });
        continue;
      }
      out.push({ path, status: !l ? "added" : !r ? "deleted" : "modified", oldSha: l?.sha ?? null, newSha: r?.sha ?? null });
    }
  }
  log(ref: string, limit = 50): { sha: Sha; tree: Sha; parents: Sha[]; message: string; time: number; author: string }[] {
    const out = [];
    let sha: Sha | undefined = this.resolve(ref);
    while (sha && out.length < limit) {
      const c = this.commitOf(sha);
      out.push({ sha, tree: c.tree, parents: c.parents, message: c.message, time: c.time, author: c.author.replace(/ \d+ [+-]\d{4}$/, "") });
      sha = c.parents[0];
    }
    return out;
  }

  // ---------- merge ----------
  private isAncestor(maybe: Sha, of: Sha): boolean {
    const seen = new Set<Sha>(), stack = [of];
    while (stack.length) {
      const s = stack.pop()!;
      if (s === maybe) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      stack.push(...this.commitOf(s).parents);
    }
    return false;
  }
  /** A common ancestor by alternating BFS from both heads (the first commit both walks reach). */
  mergeBase(a: Sha, b: Sha): Sha | null {
    const seenA = new Set([a]), seenB = new Set([b]);
    let fa = [a], fb = [b];
    while (fa.length || fb.length) {
      for (const s of fa) if (seenB.has(s)) return s;
      for (const s of fb) if (seenA.has(s)) return s;
      fa = fa.flatMap((s) => this.commitOf(s).parents).filter((p) => !seenA.has(p) && seenA.add(p));
      fb = fb.flatMap((s) => this.commitOf(s).parents).filter((p) => !seenB.has(p) && seenB.add(p));
    }
    return null;
  }
  async merge(req: MergeRequest): Promise<MergeResult> {
    const ours = this.resolve(req.into), theirs = this.resolve(req.from);
    if (req.expectedHead && ours !== req.expectedHead) throw new HttpError(409, `branch ${req.into} moved`, { current: ours });
    const done = (r: MergeResult) => { if (req.deleteSource && r.status !== "conflict" && this.ref(req.from)) this.sql.exec(`DELETE FROM refs WHERE name = ?`, req.from); return r; };
    if (ours === theirs || this.isAncestor(theirs, ours)) return done({ status: "up-to-date", commit: ours, tree: this.commitOf(ours).tree });
    const base = this.mergeBase(ours, theirs);
    if (base === ours && !req.squash) { this.setRef(req.into, theirs, ours); return done({ status: "fast-forward", commit: theirs, tree: this.commitOf(theirs).tree }); }
    const w = new SegmentWriter((sha) => this.hasObject(sha));
    const conflicts: Conflict[] = [];
    const tree = (await this.mergeTrees(base ? this.commitOf(base).tree : null, this.commitOf(ours).tree, this.commitOf(theirs).tree, "", w, conflicts)) ?? w.add("tree", new Uint8Array());
    if (conflicts.length) return { status: "conflict", conflicts, base: base ?? ZERO, ours, theirs };
    const parents = req.squash ? [ours] : [ours, theirs];
    const commit = w.add("commit", encodeCommit({ tree, parents, author: req.author ?? DEFAULT_AUTHOR, message: req.message ?? `Merge ${req.from} into ${req.into}` }));
    await this.flush(w, () => this.setRef(req.into, commit, ours));
    return done({ status: "merged", commit, tree });
  }
  /** git's per-path rule, descending only into directories both sides changed; diff3 on lines for text files. */
  private async mergeTrees(b: Sha | null, o: Sha | null, t: Sha | null, prefix: string, w: SegmentWriter, conflicts: Conflict[]): Promise<Sha | null> {
    if (o === t) return o;
    if (b === o) return t;
    if (b === t) return o;
    const map = (sha: Sha | null) => new Map((sha ? this.treeOf(sha, w) : []).map((e) => [e.name, e]));
    const B = map(b), O = map(o), T = map(t);
    const out: TreeEntry[] = [];
    for (const name of new Set([...B.keys(), ...O.keys(), ...T.keys()])) {
      const be = B.get(name), oe = O.get(name), te = T.get(name), path = prefix ? `${prefix}/${name}` : name;
      const key = (e?: TreeEntry) => (e ? `${e.mode}:${e.sha}` : "-");
      let pick: TreeEntry | null | undefined;
      if (key(oe) === key(te)) pick = oe ?? null;
      else if (key(be) === key(oe)) pick = te ?? null;
      else if (key(be) === key(te)) pick = oe ?? null;
      else if (oe?.mode === "40000" && te?.mode === "40000") {
        const sha = await this.mergeTrees(be?.mode === "40000" ? be.sha : null, oe.sha, te.sha, path, w, conflicts);
        pick = sha ? { name, mode: "40000", sha } : null;
      } else if (oe && te && oe.mode !== "40000" && te.mode !== "40000" && (!be || be.mode !== "40000")) {
        const [bb, ob, tb] = await Promise.all([be ? this.readBlob(be.sha) : new Uint8Array(), this.readBlob(oe.sha), this.readBlob(te.sha)]);
        const binary = [bb, ob, tb].some((x) => x.subarray(0, 8000).includes(0));
        const merged = binary ? null : mergeLines(text(bb), text(ob), text(tb));
        if (merged?.ok) pick = { name, mode: oe.mode, sha: w.add("blob", utf8(merged.text)) };
        else { conflicts.push({ path, base: be?.sha ?? null, ours: oe.sha, theirs: te.sha, reason: binary ? "binary" : "overlapping edits" }); pick = oe; }
      } else {
        conflicts.push({ path, base: be?.sha ?? null, ours: oe?.sha ?? null, theirs: te?.sha ?? null, reason: !oe || !te ? "modify/delete" : "file/directory" });
        pick = oe ?? null;
      }
      if (pick) out.push(pick);
    }
    return out.length ? w.add("tree", encodeTree(out)) : null;
  }

  // ---------- git smart HTTP (read-only, for jobs) ----------
  advertise(): Uint8Array {
    const refs = this.refs();
    const caps = "multi_ack_detailed shallow no-progress allow-reachable-sha1-in-want allow-tip-sha1-in-want agent=camel-gitapi/0";
    const parts = [pkt("# service=git-upload-pack\n"), FLUSH];
    const main = refs.find((r) => r.name === "main") ?? refs[0];
    if (!main) parts.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
    else {
      parts.push(pkt(`${main.sha} HEAD\0${caps} symref=HEAD:refs/heads/${main.name}\n`));
      for (const r of refs) parts.push(pkt(`${r.sha} refs/heads/${r.name}\n`));
    }
    parts.push(FLUSH);
    return concat(parts);
  }

  /** upload-pack, stateless (v1): which objects to send, as byte ranges of segments; the caller streams them. */
  uploadPlan(body: Uint8Array): UploadPlan {
    const lines = readPkts(body);
    const wants = [...new Set(lines.filter((l) => l.startsWith("want ")).map((l) => l.slice(5, 45)))];
    const clientShallow = new Set(lines.filter((l) => l.startsWith("shallow ")).map((l) => l.slice(8, 48)));
    const deepenLine = lines.find((l) => l.startsWith("deepen "));
    const depth = deepenLine ? Number(deepenLine.slice(7)) : 0;
    const haves = lines.filter((l) => l.startsWith("have ")).map((l) => l.slice(5, 45)).filter((s) => this.hasObject(s));
    const done = lines.includes("done");
    for (const want of wants) if (!this.hasObject(want)) throw new HttpError(400, `not our ref ${want}`);

    // Commits to send: reachable from wants, stopping at haves' ancestry and at the requested depth.
    const haveAncestors = new Set<Sha>();
    for (const h of haves) { const st = [h]; while (st.length) { const s = st.pop()!; if (haveAncestors.has(s)) continue; haveAncestors.add(s); if (!clientShallow.has(s)) st.push(...this.commitOf(s).parents); } }
    const commits: Sha[] = [], shallowOut: Sha[] = [];
    const queue: [Sha, number][] = wants.map((s) => [s, 1]), seen = new Set<Sha>();
    while (queue.length) {
      const [s, d] = queue.shift()!;
      if (seen.has(s) || haveAncestors.has(s)) continue;
      seen.add(s); commits.push(s);
      const parents = this.commitOf(s).parents;
      if (depth && d >= depth) { if (parents.length) shallowOut.push(s); continue; }
      for (const p of parents) queue.push([p, d + 1]);
    }
    const prefixParts: Uint8Array[] = [];
    if (depth) { for (const s of shallowOut) prefixParts.push(pkt(`shallow ${s}\n`)); prefixParts.push(FLUSH); }
    // multi_ack_detailed, stateless: a round answers `ACK x common` per have we hold, `ACK x ready` once there is
    // one (we can always cut a pack from any common commit), then NAK; the client resends its commons with `done`.
    if (!done) {
      if (haves.length) { for (const h of haves) prefixParts.push(pkt(`ACK ${h} common\n`)); prefixParts.push(pkt(`ACK ${haves.at(-1)} ready\n`)); }
      // A round with no haves during a shallow clone gets only the shallow list (fetch-pack reads the next
      // response's shallow list straight after it).
      if (haves.length || !depth) prefixParts.push(pkt("NAK\n"));
      return { prefix: concat(prefixParts), pack: null };
    }
    prefixParts.push(pkt(haves.length ? `ACK ${haves.at(-1)}\n` : "NAK\n"));

    // Objects: every tree/blob of the new commits, minus what the client's newest have-tree already holds.
    const newest = haves.reduce<Sha | null>((best, h) => (!best || this.commitOf(h).time > this.commitOf(best).time ? h : best), null);
    const haveTree = newest ? this.commitOf(newest).tree : null;
    const need = new Set<Sha>(commits);
    const walk = (sha: Sha, other: Sha | null) => {
      if (sha === other || need.has(sha)) return;
      need.add(sha);
      const theirs = new Map((other ? this.treeOf(other) : []).map((e) => [e.name, e.sha]));
      for (const e of this.treeOf(sha)) {
        if (e.mode === "160000" || theirs.get(e.name) === e.sha) continue;
        if (e.mode === "40000") walk(e.sha, theirs.get(e.name) ?? null);
        else need.add(e.sha);
      }
    };
    for (const c of commits) walk(this.commitOf(c).tree, haveTree);
    need.delete(EMPTY_TREE);
    const cacheKey = !haves.length && wants.length === 1 && commits.length ? `${this.prefix}/clones/${wants[0]}-d${depth}.pack` : null;
    return { prefix: concat(prefixParts), pack: this.runsFor(need, cacheKey) };
  }
  private runsFor(need: Set<Sha>, cacheKey: string | null) {
    // Locations of the needed objects; for a big set one scan of the index beats a lookup per sha.
    const rows = need.size > 2000
      ? this.sql.exec<{ sha: string; seg: string; off: number; len: number }>(`SELECT sha, seg, off, len FROM objects`).filter((r) => need.has(r.sha))
      : [...need].map((sha) => ({ sha, ...this.sql.exec<{ seg: string; off: number; len: number }>(`SELECT seg, off, len FROM objects WHERE sha = ?`, sha)[0] }));
    if (rows.length !== need.size) throw new Error(`index is missing ${need.size - rows.length} objects`);
    rows.sort((a, b) => (a.seg < b.seg ? -1 : a.seg > b.seg ? 1 : a.off - b.off));
    // Coalesce: adjacent entries of one segment become one range read (an imported tree is a few long runs).
    const runs: Run[] = [];
    let bytes = 0;
    for (const r of rows) {
      bytes += r.len;
      const last = runs.at(-1);
      if (last && last.key === r.seg && last.offset + last.length === r.off) last.length += r.len;
      else runs.push({ key: r.seg, offset: r.off, length: r.len });
    }
    return { count: rows.length, runs, bytes, cacheKey };
  }
  cachedClone(key: string): boolean { return this.sql.exec(`SELECT 1 FROM clones WHERE key = ?`, key).length > 0; }
  recordClone(key: string, commit: Sha, bytes: number) { this.sql.exec(`INSERT OR REPLACE INTO clones (key, commit_sha, bytes, created_at) VALUES (?, ?, ?, ?)`, key, commit, bytes, this.now()); }

  // ---------- GC ----------
  /**
   * Mark from every ref (commit parents, trees, blobs); drop unreachable index rows older than `graceMs`; delete
   * segments with nothing live and rewrite those under `repackBelow` live; drop clone packs of commits no ref points
   * at. Run by the object's alarm after expiries, and under the same writer lock as commits.
   */
  async gc(opts: { graceMs?: number; repackBelow?: number } = {}) {
    const grace = opts.graceMs ?? 0, repackBelow = opts.repackBelow ?? 0.5, now = this.now();
    const live = new Set<Sha>([EMPTY_TREE]);
    const stack: [Sha, "commit" | "tree"][] = this.refs().map((r) => [r.sha, "commit"]);
    while (stack.length) {
      const [sha, kind] = stack.pop()!;
      if (live.has(sha)) continue;
      live.add(sha);
      if (kind === "commit") { const c = this.commitOf(sha); for (const p of c.parents) stack.push([p, "commit"]); stack.push([c.tree, "tree"]); }
      else for (const e of this.treeOf(sha)) { if (e.mode === "40000") stack.push([e.sha, "tree"]); else if (e.mode !== "160000") live.add(e.sha); }
    }
    const rows = this.sql.exec<{ sha: string; seg: string; off: number; len: number; created_at: number }>(`SELECT sha, seg, off, len, created_at FROM objects`);
    const dead = rows.filter((r) => !live.has(r.sha) && r.created_at <= now - grace);
    this.sql.tx(() => { for (const r of dead) this.sql.exec(`DELETE FROM objects WHERE sha = ?`, r.sha); });
    const deadSet = new Set(dead.map((r) => r.sha));
    const segs = this.sql.exec<{ key: string; bytes: number }>(`SELECT key, bytes FROM segments`);
    const liveBytes = new Map<string, number>();
    for (const r of rows) if (!deadSet.has(r.sha)) liveBytes.set(r.seg, (liveBytes.get(r.seg) ?? 0) + r.len);
    const deleted: string[] = [];
    let repacked = 0, reclaimed = 0;
    for (const s of segs) {
      const lb = liveBytes.get(s.key) ?? 0;
      if (lb === 0) { deleted.push(s.key); reclaimed += s.bytes; continue; }
      if (lb / s.bytes >= repackBelow) continue;
      const old = await this.bucket.get(s.key);
      if (!old) throw new Error(`segment ${s.key} missing`);
      const keep = rows.filter((r) => r.seg === s.key && !deadSet.has(r.sha));
      const key = `${this.prefix}/seg/${now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
      let off = 0;
      const moves: [string, number][] = [];
      const parts = keep.map((r) => { moves.push([r.sha, off]); off += r.len; return old.subarray(r.off, r.off + r.len); });
      await this.bucket.put(key, concat(parts)); // the new segment is durable before any row points at it
      this.sql.tx(() => { for (const [sha, at] of moves) this.sql.exec(`UPDATE objects SET seg = ?, off = ? WHERE sha = ?`, key, at, sha); this.sql.exec(`INSERT INTO segments (key, bytes, created_at) VALUES (?, ?, ?)`, key, off, now); });
      deleted.push(s.key); repacked++; reclaimed += s.bytes - off;
    }
    for (const key of deleted) this.sql.exec(`DELETE FROM segments WHERE key = ?`, key);
    const heads = new Set(this.refs().map((r) => r.sha));
    const staleClones = this.sql.exec<{ key: string; commit_sha: string; bytes: number }>(`SELECT key, commit_sha, bytes FROM clones`).filter((c) => !heads.has(c.commit_sha));
    for (const c of staleClones) { this.sql.exec(`DELETE FROM clones WHERE key = ?`, c.key); reclaimed += c.bytes; }
    await this.bucket.delete([...deleted, ...staleClones.map((c) => c.key)]);
    return { live: live.size, objectsDropped: dead.length, segmentsDeleted: deleted.length - repacked, segmentsRepacked: repacked, clonePacksDropped: staleClones.length, bytesReclaimed: reclaimed };
  }

  stats() {
    const o = this.sql.exec<{ n: number; raw: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(raw)), 0) AS raw FROM objects`)[0];
    const s = this.sql.exec<{ n: number; b: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM segments`)[0];
    const c = this.sql.exec<{ n: number; b: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM clones`)[0];
    return { objects: o.n, sqliteRawBytes: o.raw, segments: s.n, segmentBytes: s.b, clonePacks: c.n, clonePackBytes: c.b, refs: this.refs().length };
  }
  async destroy() {
    const keys = [...this.sql.exec<{ key: string }>(`SELECT key FROM segments`), ...this.sql.exec<{ key: string }>(`SELECT key FROM clones`)].map((r) => r.key);
    await this.bucket.delete(keys);
    for (const t of ["refs", "objects", "segments", "clones", "worktree"]) this.sql.exec(`DELETE FROM ${t}`);
  }
}

export function normalisePath(path: string): string {
  const parts = path.split("/").filter((p) => p && p !== ".");
  if (!parts.length || parts.some((p) => p === ".." || p === ".git")) throw new HttpError(400, `bad path ${path}`);
  return parts.join("/");
}
export { CODE_TYPE };
