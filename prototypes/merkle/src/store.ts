// The Merkle volume store: one per lineage (a volume and every fork, job and cache entry made from it).
//
//   refs      name -> commit/root. A volume, a fork, a running job, a result-cache entry and a GitHub mirror are all
//             just refs. A fork is one INSERT (O(1), no bytes, no pins).
//   trees     every tree object of every version, authoritative here (a 50k-file version is ~1k trees, ~2 MB, and
//             each new version adds only the trees on changed paths). Mirrored to R2 for jobs and disaster recovery.
//   commits   history: one commit per checkpoint/merge, parents as in git.
//   blobs     the index of file contents held in R2 (`b/<sha>`), with the time each was registered.
//   work      the working layer: per ref, path -> blob (null = removed) since the last checkpoint.
//   tombstones R2 keys collected and not yet deleted.
//
// Retention is reachability: an object lives while some unexpired ref reaches it (through `historyDepth` commits of
// history, the ref's tree, a fork's merge base, or a working-layer row), or while it is younger than `graceMs` (an
// upload whose working-layer row has not landed yet). Nothing else keeps or frees anything: no pins, no snapshot TTLs,
// no per-feature janitors. Every mutation of the tables happens in a synchronous block (no await), so the collector's
// mark-and-condemn step, which is synchronous too, can never interleave with one; see `gc()` for the one async gap
// (deleting from R2) and how writers wait it out.
import { decodeCommit, decodeTree, EMPTY_TREE, EMPTY_TREE_SHA, encodeCommit, encodeTree, hashObject, isTree, type Entry, type Mode, type Sha } from "./objects.ts";
import { mergeLines } from "./lines.ts";

export interface Sql {
  exec<T = Record<string, unknown>>(query: string, ...params: unknown[]): T[];
  txn<T>(fn: () => T): T;
}
export interface Blobs {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(keys: string[]): Promise<void>;
}
export type RefKind = "volume" | "fork" | "job" | "cache" | "mirror";
export type Ref = { name: string; kind: RefKind; commit: Sha; root: Sha; base: Sha | null; owner: string | null; expiresAt: number | null };
export type Change = { path: string; sha: Sha | null; mode?: Mode };
export type Options = { now?: () => number; graceMs?: number; historyDepth?: number; mirrorTrees?: boolean };
export type GcStats = { markMs: number; sweepMs: number; liveTrees: number; liveBlobs: number; deletedTrees: number; deletedBlobs: number; deletedCommits: number; deletedBytes: number };

const blobKey = (sha: Sha) => `b/${sha}`;
const treeKey = (sha: Sha) => `t/${sha}`;
const bytesOf = (v: unknown) => (v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer));

export class StoreError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export class MerkleStore {
  private readonly now: () => number;
  private readonly graceMs: number;
  private readonly historyDepth: number;
  private readonly mirrorTrees: boolean;
  /** The R2 deletes of the current sweep; a writer re-uploading a collected blob waits for them (see `putBlob`). */
  private sweeping: Promise<void> | null = null;
  /** Counters for the bench: bytes and objects written to and read from R2 by this instance. */
  readonly io = { putBytes: 0, puts: 0, getBytes: 0, gets: 0 };

  private readonly sql: Sql;
  private readonly r2: Blobs;
  constructor(sql: Sql, r2: Blobs, options: Options = {}) {
    this.sql = sql; this.r2 = r2;
    this.now = options.now ?? Date.now;
    this.graceMs = options.graceMs ?? 15 * 60_000;
    this.historyDepth = options.historyDepth ?? 64;
    this.mirrorTrees = options.mirrorTrees ?? true;
    for (const ddl of [
      "CREATE TABLE IF NOT EXISTS refs(name TEXT PRIMARY KEY, kind TEXT NOT NULL, commit_sha TEXT NOT NULL, root TEXT NOT NULL, base TEXT, owner TEXT, expires_at INTEGER)",
      "CREATE TABLE IF NOT EXISTS trees(sha TEXT PRIMARY KEY, body BLOB NOT NULL)",
      "CREATE TABLE IF NOT EXISTS commits(sha TEXT PRIMARY KEY, tree TEXT NOT NULL, parents TEXT NOT NULL, body BLOB NOT NULL)",
      "CREATE TABLE IF NOT EXISTS blobs(sha TEXT PRIMARY KEY, size INTEGER NOT NULL, created_at INTEGER NOT NULL)",
      "CREATE TABLE IF NOT EXISTS work(ref TEXT NOT NULL, path TEXT NOT NULL, sha TEXT, mode TEXT, PRIMARY KEY(ref, path))",
      "CREATE TABLE IF NOT EXISTS tombstones(key TEXT PRIMARY KEY)",
    ]) sql.exec(ddl);
    sql.exec("INSERT OR IGNORE INTO trees VALUES(?,?)", EMPTY_TREE_SHA, EMPTY_TREE);
  }

  // ---- objects ----------------------------------------------------------------------------------------------------

  tree(sha: Sha): Entry[] {
    const row = this.sql.exec<{ body: unknown }>("SELECT body FROM trees WHERE sha=?", sha)[0];
    if (!row) throw new StoreError(`tree ${sha} missing`, 500);
    return decodeTree(bytesOf(row.body));
  }
  treeBody(sha: Sha): Uint8Array | null {
    const row = this.sql.exec<{ body: unknown }>("SELECT body FROM trees WHERE sha=?", sha)[0];
    return row ? bytesOf(row.body) : null;
  }
  commitBody(sha: Sha): Uint8Array | null {
    const row = this.sql.exec<{ body: unknown }>("SELECT body FROM commits WHERE sha=?", sha)[0];
    return row ? bytesOf(row.body) : null;
  }

  /** Store a file's bytes in R2 under their git blob id. A blob already held is not uploaded again. */
  async putBlob(bytes: Uint8Array): Promise<Sha> {
    const sha = hashObject("blob", bytes);
    if (this.sql.exec("SELECT 1 FROM blobs WHERE sha=?", sha).length) {
      // Refresh the registration so a collector running before the caller's ref/work row lands keeps it (grace).
      this.sql.exec("UPDATE blobs SET created_at=? WHERE sha=?", this.now(), sha);
      return sha;
    }
    // A blob the collector condemned may still have its R2 delete in flight: an upload now could land before that
    // delete and be erased by it. Wait for the sweep (it owns every delete of this prefix) before uploading again.
    if (this.sql.exec("SELECT 1 FROM tombstones WHERE key=?", blobKey(sha)).length) await this.sweep();
    this.sql.exec("INSERT OR REPLACE INTO blobs VALUES(?,?,?)", sha, bytes.byteLength, this.now());
    await this.r2.put(blobKey(sha), bytes);
    this.io.puts++; this.io.putBytes += bytes.byteLength;
    return sha;
  }
  async getBlob(sha: Sha): Promise<Uint8Array> {
    const bytes = await this.r2.get(blobKey(sha));
    if (!bytes) throw new StoreError(`blob ${sha} missing`, 500);
    this.io.gets++; this.io.getBytes += bytes.byteLength;
    return bytes;
  }

  // ---- refs ---------------------------------------------------------------------------------------------------------

  ref(name: string): Ref {
    const row = this.sql.exec<{ name: string; kind: RefKind; commit_sha: Sha; root: Sha; base: Sha | null; owner: string | null; expires_at: number | null }>(
      "SELECT * FROM refs WHERE name=?", name)[0];
    if (!row) throw new StoreError(`no ref ${name}`, 404);
    return { name: row.name, kind: row.kind, commit: row.commit_sha, root: row.root, base: row.base, owner: row.owner, expiresAt: row.expires_at };
  }
  refs(): Ref[] {
    return this.sql.exec<{ name: string }>("SELECT name FROM refs ORDER BY name").map((r) => this.ref(r.name));
  }

  createVolume(name: string): Ref {
    return this.sql.txn(() => {
      if (this.sql.exec("SELECT 1 FROM refs WHERE name=?", name).length) return this.ref(name);
      const commit = this.writeCommit(EMPTY_TREE_SHA, [], `create ${name}`);
      this.sql.exec("INSERT INTO refs VALUES(?,?,?,?,?,?,?)", name, "volume", commit, EMPTY_TREE_SHA, null, null, null);
      return this.ref(name);
    });
  }

  /**
   * A new ref at `source`'s current version: a workflow child's fork, a job's view, a result-cache entry, a mirror.
   * O(1): one row. The source's working layer is checkpointed first, so the fork sees what the source sees.
   * `expiresAt` is for job refs only: the job's own hard deadline, after which a crashed host's ref stops holding.
   */
  async fork(source: string, name: string, opts: { kind?: RefKind; owner?: string; expiresAt?: number } = {}): Promise<Ref> {
    await this.checkpoint(source);
    return this.sql.txn(() => {
      const from = this.ref(source);
      this.sql.exec("INSERT OR REPLACE INTO refs VALUES(?,?,?,?,?,?,?)", name, opts.kind ?? "fork", from.commit, from.root, from.root, opts.owner ?? null, opts.expiresAt ?? null);
      return this.ref(name);
    });
  }

  /** Drop a ref (and its working layer). Everything only it reached becomes collectable; nothing else to release. */
  deleteRef(name: string) {
    this.sql.txn(() => { this.sql.exec("DELETE FROM refs WHERE name=?", name); this.sql.exec("DELETE FROM work WHERE ref=?", name); });
  }
  /** Every ref an owner holds (a workflow's forks), in one statement. */
  deleteOwned(owner: string) {
    this.sql.txn(() => {
      this.sql.exec("DELETE FROM work WHERE ref IN (SELECT name FROM refs WHERE owner=?)", owner);
      this.sql.exec("DELETE FROM refs WHERE owner=?", owner);
    });
  }

  // ---- working layer --------------------------------------------------------------------------------------------------

  async write(ref: string, path: string, bytes: Uint8Array, mode: Mode = "100644") {
    path = normalize(path);
    this.ref(ref);
    const sha = await this.putBlob(bytes);
    this.sql.exec("INSERT OR REPLACE INTO work VALUES(?,?,?,?)", ref, path, sha, mode);
    return sha;
  }
  remove(ref: string, path: string) {
    path = normalize(path);
    this.ref(ref);
    this.sql.exec("INSERT OR REPLACE INTO work VALUES(?,?,?,?)", ref, path, null, null);
  }
  /** The entry a path resolves to in the ref's working view (layer over its root). */
  stat(ref: string, path: string): { sha: Sha; mode: Mode } | null {
    path = normalize(path);
    const row = this.sql.exec<{ sha: Sha | null; mode: Mode }>("SELECT sha, mode FROM work WHERE ref=? AND path=?", ref, path)[0];
    if (row) return row.sha ? { sha: row.sha, mode: row.mode } : null;
    const entry = this.resolve(this.ref(ref).root, path);
    return entry && !isTree(entry) ? { sha: entry.sha, mode: entry.mode } : null;
  }
  async read(ref: string, path: string): Promise<Uint8Array | null> {
    const entry = this.stat(ref, path);
    return entry ? this.getBlob(entry.sha) : null;
  }
  list(ref: string, prefix = ""): Map<string, Sha> {
    prefix = prefix ? normalize(prefix) : "";
    const out = new Map<string, Sha>();
    const r = this.ref(ref);
    const start = prefix ? this.resolve(r.root, prefix) : { mode: "40000" as Mode, name: "", sha: r.root };
    if (start && isTree(start)) this.walk(start.sha, prefix, (p, e) => { out.set(p, e.sha); });
    for (const row of this.sql.exec<{ path: string; sha: Sha | null }>("SELECT path, sha FROM work WHERE ref=? AND path>=? AND path<?", ref, prefix, prefix + "￿"))
      row.sha ? out.set(row.path, row.sha) : out.delete(row.path);
    return out;
  }
  dirty(ref: string) { return this.sql.exec<{ n: number }>("SELECT count(*) n FROM work WHERE ref=?", ref)[0].n; }

  /**
   * Turn the ref's working layer into a new root and commit, atomically (one synchronous block). New trees are then
   * mirrored to R2 (the tables are authoritative; the mirror serves jobs and recovery). Returns the new version.
   */
  async checkpoint(ref: string, message = "checkpoint"): Promise<{ commit: Sha; root: Sha; changed: number; newTrees: number; syncMs: number; mirrorMs: number }> {
    const t0 = performance.now();
    const result = this.sql.txn(() => {
      const r = this.ref(ref);
      const rows = this.sql.exec<{ path: string; sha: Sha | null; mode: Mode | null }>("SELECT path, sha, mode FROM work WHERE ref=?", ref);
      if (!rows.length) return { commit: r.commit, root: r.root, changed: 0, created: [] as Sha[] };
      const created: Sha[] = [];
      const root = this.apply(r.root, rows.map((w) => ({ path: w.path, sha: w.sha, mode: w.mode ?? undefined })), created);
      const commit = root === r.root ? r.commit : this.writeCommit(root, [r.commit], message);
      this.sql.exec("UPDATE refs SET commit_sha=?, root=? WHERE name=?", commit, root, ref);
      this.sql.exec("DELETE FROM work WHERE ref=?", ref);
      return { commit, root, changed: rows.length, created: [...created, commit] };
    });
    const t1 = performance.now();
    await this.mirror(result.created);
    return { commit: result.commit, root: result.root, changed: result.changed, newTrees: Math.max(0, result.created.length - 1), syncMs: +(t1 - t0).toFixed(2), mirrorMs: +(performance.now() - t1).toFixed(2) };
  }

  // ---- merge ----------------------------------------------------------------------------------------------------------

  /**
   * `commit()` of a fork: three-way merge of `source` into `target` over the fork's base. Trees are compared by hash, so
   * the walk only descends where both sides changed; whole subtrees are taken by reference. Paths both sides changed
   * are merged by diff3 on lines. Any conflict: nothing is written and each path is answered. Otherwise one merge
   * commit (parents: target, source) lands on `target`, and the fork's base moves to what it merged.
   */
  async merge(target: string, source: string): Promise<{ commit: Sha; root: Sha; lineMerged: number } | { conflicts: string[] }> {
    await this.checkpoint(target);
    await this.checkpoint(source);
    for (;;) {
      const ours = this.ref(target), theirs = this.ref(source);
      const base = theirs.base ?? EMPTY_TREE_SHA;
      if (theirs.root === base) return { commit: ours.commit, root: ours.root, lineMerged: 0 };
      const plan = this.plan(base, ours.root, theirs.root);
      if (plan.conflicts.length) return { conflicts: plan.conflicts };
      // Content merges are the only awaits; their results are uploaded blobs (protected by grace until the commit).
      const merged: Change[] = [];
      const conflicts: string[] = [];
      for (const c of plan.contested) {
        const [b, o, t] = await Promise.all([c.base ? this.getBlob(c.base) : new Uint8Array(), this.getBlob(c.ours), this.getBlob(c.theirs)]);
        if ([b, o, t].some((x) => x.includes(0))) { conflicts.push(c.path); continue; }
        const result = mergeLines(td.decode(b), td.decode(o), td.decode(t));
        if (!result.ok) { conflicts.push(c.path); continue; }
        merged.push({ path: c.path, sha: await this.putBlob(te.encode(result.text)), mode: c.mode });
      }
      if (conflicts.length) return { conflicts };
      const landed = this.sql.txn(() => {
        const now = this.ref(target);
        if (now.commit !== ours.commit || this.ref(source).commit !== theirs.commit) return null; // moved while we read: plan again
        const created: Sha[] = [];
        const root = this.apply(ours.root, [...plan.changes, ...merged], created);
        const commit = this.writeCommit(root, [ours.commit, theirs.commit], `merge ${source} into ${target}`);
        this.sql.exec("UPDATE refs SET commit_sha=?, root=? WHERE name=?", commit, root, target);
        this.sql.exec("UPDATE refs SET base=? WHERE name=?", theirs.root, source);
        return { commit, root, created: [...created, commit] };
      });
      if (!landed) continue;
      await this.mirror(landed.created);
      return { commit: landed.commit, root: landed.root, lineMerged: merged.length };
    }
  }

  /**
   * The structural three-way merge, synchronous and writing nothing: the changes to apply on `ours` (whole subtrees
   * where only theirs moved), the paths both sides changed as files (for diff3), and hard conflicts.
   */
  plan(base: Sha, ours: Sha, theirs: Sha) {
    const changes: Change[] = [], contested: { path: string; base: Sha | null; ours: Sha; theirs: Sha; mode: Mode }[] = [], conflicts: string[] = [];
    const same = (a: Entry | null, b: Entry | null) => (a === null ? b === null : b !== null && a.sha === b.sha && a.mode === b.mode);
    const visit = (path: string, b: Entry | null, o: Entry | null, t: Entry | null) => {
      if (same(o, t) || same(b, t)) return; // theirs agrees with ours, or did not touch it
      if (same(b, o)) { changes.push({ path, sha: t?.sha ?? null, mode: t?.mode }); return; } // only theirs moved
      if (o && t && isTree(o) && isTree(t)) {
        const bt = b && isTree(b) ? this.byName(b.sha) : new Map<string, Entry>();
        const ot = this.byName(o.sha), tt = this.byName(t.sha);
        for (const name of new Set([...bt.keys(), ...ot.keys(), ...tt.keys()]))
          visit(path ? `${path}/${name}` : name, bt.get(name) ?? null, ot.get(name) ?? null, tt.get(name) ?? null);
        return;
      }
      if (o && t && !isTree(o) && !isTree(t) && (!b || !isTree(b))) { contested.push({ path, base: b?.sha ?? null, ours: o.sha, theirs: t.sha, mode: o.mode }); return; }
      conflicts.push(path); // modify/delete, file/directory
    };
    const root = (sha: Sha): Entry => ({ mode: "40000", name: "", sha });
    visit("", root(base), root(ours), root(theirs));
    return { changes, contested, conflicts };
  }

  /** Blob-level differences between two roots, descending only into subtrees whose hashes differ. */
  diff(a: Sha, b: Sha, prefix = "", out: { path: string; from: Sha | null; to: Sha | null }[] = []) {
    if (a === b) return out;
    const x = this.byName(a), y = this.byName(b);
    for (const name of new Set([...x.keys(), ...y.keys()])) {
      const p = prefix ? `${prefix}/${name}` : name, ex = x.get(name), ey = y.get(name);
      if (ex && ey && ex.sha === ey.sha) continue;
      if (ex && ey && isTree(ex) && isTree(ey)) { this.diff(ex.sha, ey.sha, p, out); continue; }
      if (ex && ey && !isTree(ex) && !isTree(ey)) { out.push({ path: p, from: ex.sha, to: ey.sha }); continue; }
      if (ex) isTree(ex) ? this.walk(ex.sha, p, (q, e) => { out.push({ path: q, from: e.sha, to: null }); }) : out.push({ path: p, from: ex.sha, to: null });
      if (ey) isTree(ey) ? this.walk(ey.sha, p, (q, e) => { out.push({ path: q, from: null, to: e.sha }); }) : out.push({ path: p, from: null, to: ey.sha });
    }
    return out;
  }

  // ---- collection -----------------------------------------------------------------------------------------------------

  /**
   * Mark and sweep. The mark, and the removal of every unreachable row (with an R2 tombstone per object), is one
   * synchronous block: no write, checkpoint, fork or merge can interleave with it. The R2 deletes come after, in
   * batches; a writer that needs a condemned blob back waits for them (`putBlob`). Roots: every unexpired ref (its
   * tree, its fork base, `historyDepth` commits of history) and every working-layer row; plus blobs registered within
   * `graceMs` (an upload whose row has not landed: the only time-based rule, and it is bounded by request lifetime).
   */
  async gc(opts: { graceMs?: number } = {}): Promise<GcStats> {
    const grace = opts.graceMs ?? this.graceMs;
    const t0 = performance.now();
    const marked = this.sql.txn(() => {
      const now = this.now();
      // A job ref past its job's hard deadline (a host that died without releasing it) stops holding anything.
      this.sql.exec("DELETE FROM work WHERE ref IN (SELECT name FROM refs WHERE expires_at <= ?)", now);
      this.sql.exec("DELETE FROM refs WHERE expires_at <= ?", now);
      const liveCommits = new Set<Sha>(), liveTrees = new Set<Sha>([EMPTY_TREE_SHA]), liveBlobs = new Set<Sha>();
      const roots: Sha[] = [];
      for (const r of this.sql.exec<{ commit_sha: Sha; root: Sha; base: Sha | null }>("SELECT commit_sha, root, base FROM refs WHERE expires_at IS NULL OR expires_at > ?", now)) {
        roots.push(r.root); if (r.base) roots.push(r.base);
        let frontier = [r.commit_sha];
        for (let depth = 0; depth < this.historyDepth && frontier.length; depth++) {
          const next: Sha[] = [];
          for (const c of frontier) {
            if (liveCommits.has(c)) continue;
            const body = this.commitBody(c);
            if (!body) continue; // beyond a previous horizon: history was cut there
            liveCommits.add(c);
            const parsed = decodeCommit(body);
            roots.push(parsed.tree); next.push(...parsed.parents);
          }
          frontier = next;
        }
      }
      const stack = roots;
      while (stack.length) {
        const sha = stack.pop()!;
        if (liveTrees.has(sha)) continue; // shared subtrees (every fork's unchanged dirs) are walked once
        liveTrees.add(sha);
        for (const e of this.tree(sha)) isTree(e) ? stack.push(e.sha) : liveBlobs.add(e.sha);
      }
      for (const w of this.sql.exec<{ sha: Sha | null }>("SELECT sha FROM work WHERE sha IS NOT NULL")) liveBlobs.add(w.sha!);
      const deadBlobs = this.sql.exec<{ sha: Sha; size: number }>("SELECT sha, size FROM blobs WHERE created_at < ?", now - grace).filter((b) => !liveBlobs.has(b.sha));
      const deadTrees = this.sql.exec<{ sha: Sha }>("SELECT sha FROM trees").filter((t) => !liveTrees.has(t.sha));
      const deadCommits = this.sql.exec<{ sha: Sha }>("SELECT sha FROM commits").filter((c) => !liveCommits.has(c.sha));
      for (const b of deadBlobs) { this.sql.exec("DELETE FROM blobs WHERE sha=?", b.sha); this.sql.exec("INSERT OR IGNORE INTO tombstones VALUES(?)", blobKey(b.sha)); }
      for (const t of deadTrees) { this.sql.exec("DELETE FROM trees WHERE sha=?", t.sha); if (this.mirrorTrees) this.sql.exec("INSERT OR IGNORE INTO tombstones VALUES(?)", treeKey(t.sha)); }
      for (const c of deadCommits) { this.sql.exec("DELETE FROM commits WHERE sha=?", c.sha); if (this.mirrorTrees) this.sql.exec("INSERT OR IGNORE INTO tombstones VALUES(?)", treeKey(c.sha)); }
      return { liveTrees: liveTrees.size, liveBlobs: liveBlobs.size, deletedTrees: deadTrees.length, deletedBlobs: deadBlobs.length, deletedCommits: deadCommits.length, deletedBytes: deadBlobs.reduce((n, b) => n + b.size, 0) };
    });
    const t1 = performance.now();
    await this.sweep();
    return { markMs: Math.round(t1 - t0), sweepMs: Math.round(performance.now() - t1), ...marked };
  }

  /** Delete every tombstoned key from R2, 1,000 at a time. One sweep at a time; callers share the running one. */
  sweep(): Promise<void> {
    if (this.sweeping) return this.sweeping;
    this.sweeping = (async () => {
      for (;;) {
        const keys = this.sql.exec<{ key: string }>("SELECT key FROM tombstones LIMIT 1000").map((r) => r.key);
        if (!keys.length) return;
        await this.r2.delete(keys);
        for (const k of keys) this.sql.exec("DELETE FROM tombstones WHERE key=?", k);
      }
    })().finally(() => { this.sweeping = null; });
    return this.sweeping;
  }

  stats() {
    const one = (q: string) => Object.values(this.sql.exec(q)[0])[0] as number;
    return {
      refs: one("SELECT count(*) FROM refs"), trees: one("SELECT count(*) FROM trees"), treeBytes: one("SELECT coalesce(sum(length(body)),0) FROM trees"),
      commits: one("SELECT count(*) FROM commits"), blobs: one("SELECT count(*) FROM blobs"), blobBytes: one("SELECT coalesce(sum(size),0) FROM blobs"),
      work: one("SELECT count(*) FROM work"), tombstones: one("SELECT count(*) FROM tombstones"),
    };
  }

  // ---- internals ------------------------------------------------------------------------------------------------------

  resolve(root: Sha, path: string): Entry | null {
    let entry: Entry = { mode: "40000", name: "", sha: root };
    for (const part of path.split("/")) {
      if (!isTree(entry)) return null;
      const next = this.tree(entry.sha).find((e) => e.name === part);
      if (!next) return null;
      entry = next;
    }
    return entry;
  }
  walk(tree: Sha, prefix: string, visit: (path: string, e: Entry) => void) {
    for (const e of this.tree(tree)) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      isTree(e) ? this.walk(e.sha, p, visit) : visit(p, e);
    }
  }
  private byName(sha: Sha) { return new Map(this.tree(sha).map((e) => [e.name, e])); }

  /** Path-copying update: rewrite only the trees on changed paths, bottom-up. A change may set a whole subtree. */
  apply(root: Sha, changes: Change[], created: Sha[]): Sha {
    type Node = { leaf?: Change; kids: Map<string, Node> };
    const trie: Node = { kids: new Map() };
    for (const c of changes) {
      let node = trie;
      for (const part of c.path.split("/")) {
        if (!node.kids.has(part)) node.kids.set(part, { kids: new Map() });
        node = node.kids.get(part)!;
      }
      node.leaf = c; node.kids.clear();
    }
    const rewrite = (sha: Sha | null, node: Node): Sha | null => {
      const entries = new Map((sha ? this.tree(sha) : []).map((e) => [e.name, e]));
      for (const [name, kid] of node.kids) {
        if (kid.leaf) {
          if (kid.leaf.sha === null) entries.delete(name);
          else entries.set(name, { mode: kid.leaf.mode ?? "100644", name, sha: kid.leaf.sha });
          continue;
        }
        const existing = entries.get(name);
        const child = rewrite(existing && isTree(existing) ? existing.sha : null, kid);
        child === null ? entries.delete(name) : entries.set(name, { mode: "40000", name, sha: child });
      }
      if (!entries.size) return null;
      const body = encodeTree([...entries.values()]);
      const out = hashObject("tree", body);
      if (out !== sha && !this.sql.exec("SELECT 1 FROM trees WHERE sha=?", out).length) {
        this.sql.exec("INSERT INTO trees VALUES(?,?)", out, body);
        created.push(out);
      }
      return out;
    };
    return rewrite(root, trie) ?? EMPTY_TREE_SHA;
  }

  private writeCommit(tree: Sha, parents: Sha[], message: string): Sha {
    const body = encodeCommit({ tree, parents, message, at: this.now() });
    const sha = hashObject("commit", body);
    this.sql.exec("INSERT OR IGNORE INTO commits VALUES(?,?,?,?)", sha, tree, JSON.stringify(parents), body);
    return sha;
  }

  private async mirror(shas: Sha[]) {
    if (!this.mirrorTrees || !shas.length) return;
    await Promise.all(shas.map(async (sha) => {
      const body = this.treeBody(sha) ?? this.commitBody(sha);
      if (!body) return; // collected already
      await this.r2.put(treeKey(sha), body);
      this.io.puts++; this.io.putBytes += body.byteLength;
    }));
  }
}

const te = new TextEncoder(), td = new TextDecoder();
export function normalize(path: string) {
  const parts = path.split("/").filter((p) => p && p !== ".");
  if (!parts.length || parts.some((p) => p === "..")) throw new StoreError(`bad path ${path}`);
  return parts.join("/");
}
