// The volume: one branch of an Artifacts repo plus a working layer. SQLite holds the committed tree as an index
// (path -> blob sha, and the tree-object sha of every directory) and the layer as dirty rows over it; a read never
// leaves the object for a dirty or cached file, a write is one row, and a commit ships only the changed blobs,
// the trees on their paths and the commit as one thin pack, with the branch head as compare-and-swap. A fork is
// another volume on another branch of the same repo whose index is copied (rows, not bytes); merging it back is
// a three-way merge decided here and landed as a two-parent commit.
import { encodeCommit, encodeTree, hashObject, push, PushRejected, ZERO_SHA, type PackObject, type Sha, type TreeEntry } from "./git.ts";
import { mergeLines, planMerge, type TreeIndex } from "./merge.ts";
import type { Store } from "./store.ts";

/** The slice of a Durable Object's `ctx.storage.sql` the core uses (node:sqlite gets the same shape in tests). */
export interface Sql { exec<Row = Record<string, unknown>>(query: string, ...params: unknown[]): Row[] }

export type VolumeMeta = { repo: string; remote: string; branch: string; head: Sha | null; base: { volume: string; commit: Sha } | null };
export type Entry = { path: string; size: number; dirty: boolean };
export type Conflict = { path: string; ours: string; theirs: string };
export type MergeResult = { merged: true; commit: Sha; paths: string[] } | { merged: false; conflicts: Conflict[] };
export type IndexExport = { head: Sha | null; base: VolumeMeta["base"]; tree: { path: string; sha: Sha; size: number }[]; dirs: { path: string; sha: Sha }[]; baseTree: { path: string; sha: Sha }[] };

const AUTHOR = { name: "camelRun", email: "volumes@camelai.com" };
const decoder = new TextDecoder();
const encoder = new TextEncoder();

export class VolumeCore {
  private readonly sql: Sql;
  private readonly store: Store;
  constructor(sql: Sql, store: Store) {
    this.sql = sql; this.store = store;
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS tree (path TEXT PRIMARY KEY, sha TEXT NOT NULL, size INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS dirs (path TEXT PRIMARY KEY, sha TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS base_tree (path TEXT PRIMARY KEY, sha TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS dirty (path TEXT PRIMARY KEY, content BLOB, sha TEXT, size INTEGER NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS blobs (sha TEXT PRIMARY KEY, content BLOB NOT NULL)`);
  }

  private get(key: string): string | null { return this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key = ?`, key)[0]?.value ?? null; }
  private set(key: string, value: string | null) {
    if (value === null) this.sql.exec(`DELETE FROM meta WHERE key = ?`, key);
    else this.sql.exec(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, key, value);
  }

  meta(): VolumeMeta {
    const base = this.get("base");
    return { repo: this.get("repo") ?? "", remote: this.get("remote") ?? "", branch: this.get("branch") ?? "main", head: this.get("head"), base: base ? JSON.parse(base) : null };
  }

  /** A fresh volume on `branch` of `repo`: an empty tree, nothing pushed until the first commit. */
  init(meta: { repo: string; remote: string; branch: string }) {
    this.set("repo", meta.repo); this.set("remote", meta.remote); this.set("branch", meta.branch);
  }

  /**
   * A fork: the same repo, a new branch at the source's head, and the source's index copied as rows. No bytes move;
   * the branch is one ref update with an empty pack.
   */
  async initFork(meta: { repo: string; remote: string; branch: string; from: string; source: IndexExport }) {
    if (!meta.source.head) throw new Error("A fork needs a committed source");
    this.init(meta);
    for (const row of meta.source.tree) {
      this.sql.exec(`INSERT INTO tree (path, sha, size) VALUES (?, ?, ?)`, row.path, row.sha, row.size);
      this.sql.exec(`INSERT INTO base_tree (path, sha) VALUES (?, ?)`, row.path, row.sha);
    }
    for (const row of meta.source.dirs) this.sql.exec(`INSERT INTO dirs (path, sha) VALUES (?, ?)`, row.path, row.sha);
    const token = await this.store.token("write");
    await push(this.store.remote, token.plaintext, [{ ref: `refs/heads/${meta.branch}`, old: ZERO_SHA, new: meta.source.head }], []);
    this.set("head", meta.source.head);
    this.set("base", JSON.stringify({ volume: meta.from, commit: meta.source.head }));
  }

  exportIndex(): IndexExport {
    const meta = this.meta();
    return {
      head: meta.head, base: meta.base,
      tree: this.sql.exec<{ path: string; sha: Sha; size: number }>(`SELECT path, sha, size FROM tree`),
      dirs: this.sql.exec<{ path: string; sha: Sha }>(`SELECT path, sha FROM dirs`),
      baseTree: this.sql.exec<{ path: string; sha: Sha }>(`SELECT path, sha FROM base_tree`),
    };
  }

  list(prefix = ""): Entry[] {
    const committed = this.sql.exec<{ path: string; size: number }>(`SELECT path, size FROM tree WHERE path LIKE ? ESCAPE '\\'`, `${like(prefix)}%`);
    const dirty = this.sql.exec<{ path: string; size: number; removed: number }>(`SELECT path, size, (content IS NULL AND sha IS NULL) AS removed FROM dirty WHERE path LIKE ? ESCAPE '\\'`, `${like(prefix)}%`);
    const entries = new Map(committed.map((row) => [row.path, { path: row.path, size: row.size, dirty: false }]));
    for (const row of dirty) { if (row.removed) entries.delete(row.path); else entries.set(row.path, { path: row.path, size: row.size, dirty: true }); }
    return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  async read(path: string): Promise<Uint8Array | null> {
    const dirty = this.sql.exec<{ content: Uint8Array | null; sha: Sha | null }>(`SELECT content, sha FROM dirty WHERE path = ?`, path)[0];
    if (dirty) return dirty.content ? new Uint8Array(dirty.content) : dirty.sha ? this.blob(dirty.sha) : null;
    const row = this.sql.exec<{ sha: Sha }>(`SELECT sha FROM tree WHERE path = ?`, path)[0];
    return row ? this.blob(row.sha) : null;
  }

  /** A blob by id: the object's cache first, then the repo. */
  private async blob(sha: Sha): Promise<Uint8Array | null> {
    const cached = this.sql.exec<{ content: Uint8Array }>(`SELECT content FROM blobs WHERE sha = ?`, sha)[0];
    if (cached) return new Uint8Array(cached.content);
    const bytes = await this.store.readBlob(sha);
    if (bytes) this.sql.exec(`INSERT OR IGNORE INTO blobs (sha, content) VALUES (?, ?)`, sha, bytes);
    return bytes;
  }

  write(path: string, content: Uint8Array) {
    this.sql.exec(`INSERT INTO dirty (path, content, sha, size) VALUES (?, ?, NULL, ?) ON CONFLICT(path) DO UPDATE SET content = excluded.content, sha = NULL, size = excluded.size`, path, content, content.byteLength);
  }
  remove(path: string) {
    const exists = this.sql.exec(`SELECT 1 FROM tree WHERE path = ?`, path).length > 0;
    if (exists) this.sql.exec(`INSERT INTO dirty (path, content, sha, size) VALUES (?, NULL, NULL, 0) ON CONFLICT(path) DO UPDATE SET content = NULL, sha = NULL, size = 0`, path);
    else this.sql.exec(`DELETE FROM dirty WHERE path = ?`, path);
  }

  /** Land the working layer as one commit on the branch. Answers the head unchanged when nothing is dirty. */
  async commit(message: string, parents?: Sha[]): Promise<Sha> {
    const meta = this.meta();
    const dirty = this.sql.exec<{ path: string; content: Uint8Array | null; sha: Sha | null; size: number }>(`SELECT path, content, sha, size FROM dirty`);
    if (!dirty.length && meta.head) return meta.head;
    const objects: PackObject[] = [];
    const next = new Map<string, { sha: Sha; size: number } | null>();
    for (const row of dirty) {
      if (row.content) {
        const content = new Uint8Array(row.content);
        const sha = await hashObject("blob", content);
        objects.push({ type: "blob", content });
        next.set(row.path, { sha, size: content.byteLength });
      } else next.set(row.path, row.sha ? { sha: row.sha, size: row.size } : null);
    }
    // Every directory on a changed path is rebuilt, deepest first; the rest keep their tree ids.
    const changedDirs = new Set<string>([""]);
    for (const path of next.keys()) for (let dir = parent(path); dir !== null; dir = parent(dir)) changedDirs.add(dir);
    const dirShas = new Map(this.sql.exec<{ path: string; sha: Sha }>(`SELECT path, sha FROM dirs`).map((row) => [row.path, row.sha]));
    const files = new Map(this.sql.exec<{ path: string; sha: Sha; size: number }>(`SELECT path, sha, size FROM tree`).map((row) => [row.path, { sha: row.sha, size: row.size }]));
    for (const [path, entry] of next) { if (entry) files.set(path, entry); else files.delete(path); }
    const children = new Map<string, Set<string>>(); // dir -> immediate child dirs and files
    const dirsSeen = new Set<string>([""]);
    for (const path of files.keys()) {
      let child = path;
      for (let dir = parent(path); dir !== null; dir = parent(dir)) {
        if (!children.has(dir)) children.set(dir, new Set());
        children.get(dir)!.add(child);
        dirsSeen.add(dir);
        child = dir;
      }
    }
    const rebuilt = new Map<string, Sha>();
    for (const dir of [...changedDirs].sort((a, b) => depth(b) - depth(a))) {
      const entries: TreeEntry[] = [];
      for (const child of children.get(dir) ?? []) {
        const name = child.slice(dir ? dir.length + 1 : 0);
        const file = files.get(child);
        if (file) entries.push({ mode: "100644", name, sha: file.sha });
        else entries.push({ mode: "40000", name, sha: rebuilt.get(child) ?? dirShas.get(child)! });
      }
      const content = encodeTree(entries);
      const sha = await hashObject("tree", content);
      objects.push({ type: "tree", content });
      rebuilt.set(dir, sha);
    }
    const commit = encodeCommit({ tree: rebuilt.get("")!, parents: parents ?? (meta.head ? [meta.head] : []), message, author: AUTHOR });
    const sha = await hashObject("commit", commit);
    objects.push({ type: "commit", content: commit });
    const token = await this.store.token("write");
    await push(this.store.remote, token.plaintext, [{ ref: `refs/heads/${meta.branch}`, old: meta.head ?? ZERO_SHA, new: sha }], objects);
    // Landed: fold the layer into the index.
    for (const [path, entry] of next) {
      if (entry) this.sql.exec(`INSERT INTO tree (path, sha, size) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET sha = excluded.sha, size = excluded.size`, path, entry.sha, entry.size);
      else this.sql.exec(`DELETE FROM tree WHERE path = ?`, path);
    }
    for (const [dir, treeSha] of rebuilt) this.sql.exec(`INSERT INTO dirs (path, sha) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET sha = excluded.sha`, dir, treeSha);
    for (const dir of dirShas.keys()) if (!dirsSeen.has(dir)) this.sql.exec(`DELETE FROM dirs WHERE path = ?`, dir);
    for (const row of dirty) if (row.content) this.sql.exec(`INSERT OR IGNORE INTO blobs (sha, content) VALUES (?, ?)`, next.get(row.path)!.sha, row.content);
    this.sql.exec(`DELETE FROM dirty`);
    this.set("head", sha);
    return sha;
  }

  /**
   * Merge a fork (its exported index) into this volume: three-way over the fork's base, decided by path then by
   * line, landed as a commit with both heads as parents. A conflict lands nothing and answers both sides.
   */
  async merge(fork: IndexExport, message = "merge"): Promise<MergeResult> {
    const meta = this.meta();
    if (!fork.head || !fork.base) throw new Error("Not a fork");
    if (this.sql.exec(`SELECT 1 FROM dirty LIMIT 1`).length) throw new Error("Commit the working layer before merging");
    if (fork.base.commit === meta.head) {
      // Fast-forward: nothing changed here since the fork; the branch simply moves.
      const token = await this.store.token("write");
      await push(this.store.remote, token.plaintext, [{ ref: `refs/heads/${meta.branch}`, old: meta.head ?? ZERO_SHA, new: fork.head }], []);
      this.sql.exec(`DELETE FROM tree`); this.sql.exec(`DELETE FROM dirs`);
      for (const row of fork.tree) this.sql.exec(`INSERT INTO tree (path, sha, size) VALUES (?, ?, ?)`, row.path, row.sha, row.size);
      for (const row of fork.dirs) this.sql.exec(`INSERT INTO dirs (path, sha) VALUES (?, ?)`, row.path, row.sha);
      this.set("head", fork.head);
      return { merged: true, commit: fork.head, paths: [] };
    }
    const base: TreeIndex = new Map(fork.baseTree.map((row) => [row.path, row.sha]));
    const ours: TreeIndex = new Map(this.sql.exec<{ path: string; sha: Sha }>(`SELECT path, sha FROM tree`).map((row) => [row.path, row.sha]));
    const theirs: TreeIndex = new Map(fork.tree.map((row) => [row.path, row.sha]));
    const sizes = new Map(fork.tree.map((row) => [row.sha, row.size]));
    const { decisions } = planMerge(base, ours, theirs);
    const conflicts: Conflict[] = [];
    const paths: string[] = [];
    for (const decision of decisions) {
      paths.push(decision.path);
      if (decision.kind === "take") {
        if (decision.sha === null) this.sql.exec(`INSERT INTO dirty (path, content, sha, size) VALUES (?, NULL, NULL, 0)`, decision.path);
        else this.sql.exec(`INSERT INTO dirty (path, content, sha, size) VALUES (?, NULL, ?, ?)`, decision.path, decision.sha, sizes.get(decision.sha) ?? 0);
        continue;
      }
      const [b, o, t] = await Promise.all([decision.base ? this.blob(decision.base) : null, decision.ours ? this.blob(decision.ours) : null, decision.theirs ? this.blob(decision.theirs) : null]);
      const text = (bytes: Uint8Array | null) => (bytes && isText(bytes) ? decoder.decode(bytes) : null);
      const [bt, ot, tt] = [text(b), text(o), text(t)];
      const merged = o && t && ot !== null && tt !== null ? mergeLines(bt ?? "", ot, tt) : { ok: false as const, conflicts: 1 };
      if (merged.ok) this.write(decision.path, encoder.encode(merged.text));
      else conflicts.push({ path: decision.path, ours: ot ?? (o ? "<binary>" : "<removed>"), theirs: tt ?? (t ? "<binary>" : "<removed>") });
    }
    if (conflicts.length) { this.sql.exec(`DELETE FROM dirty`); return { merged: false, conflicts }; }
    if (!paths.length) return { merged: true, commit: meta.head!, paths };
    try {
      const commit = await this.commit(message, [meta.head!, fork.head]);
      return { merged: true, commit, paths };
    } catch (error) {
      this.sql.exec(`DELETE FROM dirty`);
      if (error instanceof PushRejected) throw new Error(`The branch moved during the merge; merge again (${error.message})`);
      throw error;
    }
  }

  token(scope: "read" | "write", ttlSeconds?: number) { return this.store.token(scope, ttlSeconds); }
}

const parent = (path: string): string | null => (path === "" ? null : path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const depth = (dir: string) => (dir === "" ? 0 : dir.split("/").length);
const like = (prefix: string) => prefix.replace(/[\\%_]/g, "\\$&");
function isText(bytes: Uint8Array) { const head = bytes.subarray(0, 8000); return !head.includes(0); }
