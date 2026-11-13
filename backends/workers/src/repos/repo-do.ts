import { DurableObject } from "cloudflare:workers";
import { guardAlarms } from "../alarm-guard.ts";
import { RepoError, check, normalizeRepoPath, refName, sha1, entry, version, ownership, page } from "./repo-policy.ts";
import type { Entry, Version, Ref, Fence } from "./repo-policy.ts";
export * from "./repo-policy.ts";

type Cas = { root?: string | null; ref: string; expect?: string | null; commit: Version; changes?: Record<string, Entry | null>; entries?: Entry[]; pathExpect?: Record<string, string | "none">; fence?: Fence; owner?: string | null; expiresAt?: number | null; who: string; why: string };
type CommitRow = Omit<Version, "parents" | "trailers"> & { parents: string; trailers: string };
type LogRow = { seq: number; ref: string; fromVersion: string | null; toVersion: string | null; who: string; why: string; at: number };
export class RepoDO extends DurableObject<{ TEST_MODE?: string }> {
  constructor(ctx: DurableObjectState, env: { TEST_MODE?: string }) {
    super(ctx, env);
    guardAlarms(this, ctx, "RepoDO", { test: env.TEST_MODE === "1" });
    ctx.storage.transactionSync(() => {
      for (const schema of [
        "meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        "refs(name TEXT PRIMARY KEY, version TEXT NOT NULL, tree TEXT NOT NULL, root TEXT, owner TEXT, expiresAt INTEGER, holder TEXT, leaseEpoch INTEGER NOT NULL DEFAULT 0, leaseDeadline INTEGER, updatedAt INTEGER NOT NULL)",
        "ref_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT, fromVersion TEXT, toVersion TEXT, who TEXT, why TEXT, at INTEGER)",
        "commits(version TEXT PRIMARY KEY, tree TEXT NOT NULL, parents TEXT NOT NULL, author TEXT, message TEXT, trailers TEXT NOT NULL, at INTEGER)",
        "commit_paths(version TEXT, path TEXT, PRIMARY KEY(version,path))",
        "commit_path_status(version TEXT PRIMARY KEY, truncated INTEGER NOT NULL)",
        "head(ref TEXT, path TEXT, blob TEXT, mode TEXT, size INTEGER, PRIMARY KEY(ref,path))",
        "watchers(ref TEXT, agent TEXT, PRIMARY KEY(ref,agent))",
        "events(seq INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT, version TEXT, at INTEGER)",
      ]) this.sql.exec(`CREATE TABLE IF NOT EXISTS ${schema}`);
    });
  }
  private get sql() { return this.ctx.storage.sql; }
  private now() { return Date.now(); }
  private rows<T extends Record<string, SqlStorageValue>>(query: string, ...args: SqlStorageValue[]): T[] { return this.sql.exec<T>(query, ...args).toArray(); }
  private meta() { return Object.fromEntries(this.rows<{ key: string; value: string }>("SELECT * FROM meta").map(r => [r.key, JSON.parse(r.value)])); }
  private alive() { const m = this.meta(); if (m.deleted) throw new RepoError("deleted", 410, "deleted"); if (!m.id) throw new RepoError("uninitialized", 409, "uninitialized"); }
  private getRef(name: string): Ref | null { refName(name); return this.rows<Ref>("SELECT * FROM refs WHERE name=?", name)[0] ?? null; }
  private needRef(name: string) { const r = this.getRef(name); if (!r) throw new RepoError("no-ref", 404, "no-ref"); return r; }
  private held(r: Ref) { return r.holder !== null && r.leaseDeadline !== null && r.leaseDeadline > this.now(); }
  private agents(ref: string) { return this.rows<{agent: string}>("SELECT agent FROM watchers WHERE ref=? ORDER BY agent", ref).map(r => r.agent); }
  private record(v: Version, paths: string[]) {
    const old = this.rows<CommitRow>("SELECT * FROM commits WHERE version=?", v.version)[0];
    if (old) { if (old.tree !== v.tree) throw new RepoError("commit conflict", 409, "conflict"); return; }
    this.sql.exec("INSERT INTO commits VALUES(?,?,?,?,?,?,?)", v.version, v.tree, JSON.stringify(v.parents), v.author, v.message, JSON.stringify(v.trailers), v.at);
    this.sql.exec("INSERT INTO commit_path_status VALUES(?,?)", v.version, paths.length > 10000 ? 1 : 0);
    if (paths.length <= 10000) for (const path of paths) this.sql.exec("INSERT INTO commit_paths VALUES(?,?)", v.version, path);
  }
  private append(ref: string, previous: string | null, next: string | null, who: string, why: string) {
    this.sql.exec("INSERT INTO ref_log(ref,fromVersion,toVersion,who,why,at) VALUES(?,?,?,?,?,?)", ref, previous, next, who, why, this.now());
    this.sql.exec("INSERT INTO events(ref,version,at) VALUES(?,?,?)", ref, next, this.now());
    this.sql.exec("DELETE FROM events WHERE seq NOT IN (SELECT seq FROM events ORDER BY seq DESC LIMIT 1000)");
  }
  private async arm() {
    const next = this.rows<{at: number | null}>("SELECT MIN(CASE WHEN holder IS NOT NULL AND leaseDeadline > expiresAt THEN leaseDeadline ELSE expiresAt END) at FROM refs WHERE expiresAt IS NOT NULL")[0].at;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next, this.now() + 1));
  }
  async init(input: { tenant: string; id: string; name: string; key?: string | null; lineage: string; createdAt: number; seed?: {version: Version; entries: Entry[]} }) {
    this.ctx.storage.transactionSync(() => {
      const old = this.meta();
      if (old.deleted) throw new RepoError("deleted", 410, "deleted");
      if (old.id) { if (old.id !== input.id || old.tenant !== input.tenant) throw new RepoError("conflict", 409, "conflict"); return; }
      check([input.tenant, input.id, input.name, input.lineage].every(s => typeof s === "string" && s.length > 0) && Number.isSafeInteger(input.createdAt));
      for (const [key, value] of Object.entries({ tenant: input.tenant, id: input.id, name: input.name, key: input.key ?? null, lineage: input.lineage, createdAt: input.createdAt, deleted: false })) this.sql.exec("INSERT INTO meta VALUES(?,?)", key, JSON.stringify(value));
      if (input.seed) this.apply({ref: "main", expect: null, commit: input.seed.version, entries: input.seed.entries, who: input.seed.version.author, why: "create"});
    });
    return this.info();
  }
  info() {
    const m = this.meta(); if (!m.id) throw new RepoError("uninitialized", 409, "uninitialized");
    const usage = this.rows<{bytes: number}>("SELECT COALESCE(SUM(size),0) bytes FROM (SELECT blob,MAX(size) size FROM head GROUP BY blob)")[0];
    return { tenant: m.tenant as string, id: m.id as string, name: m.name as string, key: m.key as string | null, lineage: m.lineage as string, createdAt: m.createdAt as number, deleted: Boolean(m.deleted), refs: this.refs(), bytes: usage.bytes, files: this.rows<{n: number}>("SELECT COUNT(*) n FROM head WHERE ref='main'")[0].n };
  }
  refs(): Ref[] { return this.rows<Ref>("SELECT * FROM refs ORDER BY name"); }
  ref(name: string) { return this.getRef(name); }
  private cached(input: { ref?: string; version?: string }) {
    if (input.version !== undefined) {
      sha1(input.version);
      const r = this.rows<Ref>("SELECT * FROM refs WHERE version=? ORDER BY name LIMIT 1", input.version)[0];
      if (!r) throw new RepoError("not-cached", 404, "not-cached"); return r;
    }
    return this.needRef(input.ref ?? "main");
  }
  private prefix(prefix?: string) {
    if (prefix === undefined || prefix === "") return "";
    const trailing = prefix.endsWith("/"); return normalizeRepoPath(trailing ? prefix.slice(0, -1) : prefix) + (trailing ? "/" : "");
  }
  private matches(path: string, prefix: string) { return !prefix || path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : prefix + "/"); }
  private head(ref: string): Entry[] { return this.rows<Entry>("SELECT path,blob,mode,size FROM head WHERE ref=? ORDER BY path", ref); }
  list(input: { ref?: string; version?: string; prefix?: string; after?: string; limit?: number } = {}) {
    const r = this.cached(input), prefix = this.prefix(input.prefix), limit = page(input.limit, 1000, 10000);
    if (input.after !== undefined) normalizeRepoPath(input.after);
    const subtree = prefix.endsWith("/") ? prefix : prefix + "/";
    const all = this.rows<Entry>(
      "SELECT path,blob,mode,size FROM head WHERE ref=? AND path>? AND (?='' OR path=? OR substr(path,1,length(?))=?) ORDER BY path LIMIT ?",
      r.name, input.after ?? "", prefix, prefix, subtree, subtree, limit + 1,
    );
    const entries = all.slice(0, limit);
    return { version: r.version, tree: r.tree, entries, next: all.length > limit ? entries.at(-1)!.path : null };
  }
  stat(ref: string, paths: string[]) {
    check(Array.isArray(paths) && paths.length <= 1000); const r = this.needRef(ref);
    const entries: Record<string, Entry | null> = Object.create(null);
    for (const input of paths) { const path = normalizeRepoPath(input); entries[path] = this.rows<Entry>("SELECT path,blob,mode,size FROM head WHERE ref=? AND path=?", ref, path)[0] ?? null; }
    return {version: r.version, tree: r.tree, entries: {...entries}};
  }
  /** The size of a blob some ref's head names, or null: a write may only name blobs the repo already reaches. */
  blobSize(blob: string): number | null { sha1(blob); return this.rows<{size: number}>("SELECT size FROM head WHERE blob=? LIMIT 1", blob)[0]?.size ?? null; }
  /** Bytes the given blobs would add: each distinct blob no ref's head names yet, once. */
  unseenBytes(blobs: {blob: string; size: number}[]): number {
    check(Array.isArray(blobs) && blobs.length <= 100000); const seen = new Set<string>(); let bytes = 0;
    for (const {blob, size} of blobs) { sha1(blob); if (seen.has(blob)) continue; seen.add(blob); if (!this.rows("SELECT 1 FROM head WHERE blob=? LIMIT 1", blob).length) bytes += size; }
    return bytes;
  }
  async cas(input: Cas) { const result = this.ctx.storage.transactionSync(() => this.apply(input)); await this.arm(); return result; }
  private apply(input: Cas) {
    this.alive(); refName(input.ref); version(input.commit); ownership(input.owner, input.expiresAt);
    check(input.root == null || (typeof input.root === "string" && /^[0-9a-f]{64}$/.test(input.root)), "bad-root");
    check(typeof input.who === "string" && typeof input.why === "string");
    check((input.changes !== undefined) !== (input.entries !== undefined));
    check(input.changes === undefined || (input.expect !== undefined && input.changes !== null && typeof input.changes === "object" && !Array.isArray(input.changes)));
    if (input.expect != null) sha1(input.expect);
    const r = this.getRef(input.ref), previous = r?.version ?? null;
    if (input.expect !== undefined && previous !== input.expect) throw new RepoError("stale", 412, "stale", {current: previous});
    const old = new Map(this.head(input.ref).map(e => [e.path, e]));
    for (const [inputPath, expected] of Object.entries(input.pathExpect ?? {})) {
      const path = normalizeRepoPath(inputPath); if (expected !== "none") sha1(expected);
      const current = old.get(path)?.blob ?? null;
      if (current !== (expected === "none" ? null : expected)) throw new RepoError("stale-path", 412, "stale-path", {path, current});
    }
    if (r && this.held(r)) { if (input.fence?.holder !== r.holder || input.fence?.epoch !== r.leaseEpoch) throw new RepoError("fenced", 409, "fenced"); }
    else if (input.fence) throw new RepoError("fenced", 409, "fenced");
    const existing = this.rows<CommitRow>("SELECT * FROM commits WHERE version=?", input.commit.version)[0];
    if (r && !existing) {
      const { parents } = input.commit, current = r.version;
      if (parents[0] !== current || parents.length > 2)
        throw new RepoError("bad_parent", 409, "bad_parent", { parents, current });
      if (parents[1] && !this.rows("SELECT version FROM commits WHERE version=?", parents[1]).length)
        throw new RepoError("unknown-parent", 400, "unknown-parent");
    }
    if (r && existing && r.version !== existing.version) this.requireFastForward(r.version, existing.version);
    const next = input.entries !== undefined ? new Map<string, Entry>() : new Map(old);
    const changed = new Set<string>();
    if (input.entries !== undefined) {
      check(Array.isArray(input.entries));
      for (const raw of input.entries) { const e = entry(raw); check(!next.has(e.path), "bad-path"); next.set(e.path, e); }
      for (const path of new Set([...old.keys(), ...next.keys()])) { const a = old.get(path), b = next.get(path); if (!a || !b || a.blob !== b.blob || a.mode !== b.mode || a.size !== b.size) changed.add(path); }
    } else for (const [rawPath, raw] of Object.entries(input.changes!)) {
      const path = normalizeRepoPath(rawPath); check(!changed.has(path), "bad-path"); changed.add(path);
      if (raw === null) next.delete(path); else { const e = entry(raw); check(e.path === path, "bad-path"); next.set(path, e); }
    }
    if (existing && existing.tree !== input.commit.tree) throw new RepoError("conflict", 409, "conflict");
    if (previous === input.commit.version) return {version: previous, previous, watchers: this.agents(input.ref)};
    this.record(input.commit, [...changed]);
    if (input.entries !== undefined) {
      this.sql.exec("DELETE FROM head WHERE ref=?", input.ref);
      for (const e of next.values()) this.sql.exec("INSERT INTO head VALUES(?,?,?,?,?)", input.ref, e.path, e.blob, e.mode, e.size);
    } else for (const path of changed) {
      const e = next.get(path);
      if (e) this.sql.exec("INSERT INTO head VALUES(?,?,?,?,?) ON CONFLICT(ref,path) DO UPDATE SET blob=excluded.blob,mode=excluded.mode,size=excluded.size", input.ref, path, e.blob, e.mode, e.size);
      else this.sql.exec("DELETE FROM head WHERE ref=? AND path=?", input.ref, path);
    }
    this.sql.exec("INSERT INTO refs VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET version=excluded.version,tree=excluded.tree,root=excluded.root,owner=excluded.owner,expiresAt=excluded.expiresAt,updatedAt=excluded.updatedAt", input.ref, input.commit.version, input.commit.tree, input.root ?? null, input.owner === undefined ? r?.owner ?? null : input.owner, input.expiresAt === undefined ? r?.expiresAt ?? null : input.expiresAt, r?.holder ?? null, r?.leaseEpoch ?? 0, r?.leaseDeadline ?? null, this.now());
    this.append(input.ref, previous, input.commit.version, input.who, input.why);
    return {version: input.commit.version, previous, watchers: this.agents(input.ref)};
  }
  async createRef(input: {name: string; from: string | {version: string}; owner?: string | null; expiresAt?: number | null; who: string; why: string}) {
    const result = this.ctx.storage.transactionSync(() => {
      this.alive(); refName(input.name); ownership(input.owner, input.expiresAt);
      check(typeof input.who === "string" && typeof input.why === "string");
      if (this.getRef(input.name)) throw new RepoError("exists", 409, "exists");
      const source = typeof input.from === "string" ? this.needRef(input.from) : this.cached(input.from);
      this.sql.exec("INSERT INTO refs VALUES(?,?,?,?,?,?,NULL,0,NULL,?)", input.name, source.version, source.tree, source.root, input.owner ?? null, input.expiresAt ?? null, this.now());
      this.sql.exec("INSERT INTO head SELECT ?,path,blob,mode,size FROM head WHERE ref=?", input.name, source.name);
      this.append(input.name, null, source.version, input.who, input.why);
      return this.needRef(input.name);
    });
    await this.arm(); return result;
  }
  private remove(r: Ref, why: string) {
    this.sql.exec("DELETE FROM head WHERE ref=?", r.name);
    this.sql.exec("DELETE FROM refs WHERE name=?", r.name);
    this.sql.exec("DELETE FROM watchers WHERE ref=?", r.name);
    this.append(r.name, r.version, null, "system", why);
  }
  async deleteRef(name: string, expect?: string) {
    this.ctx.storage.transactionSync(() => {
      this.alive(); const r = this.needRef(name); if (expect !== undefined) sha1(expect);
      if (expect !== undefined && r.version !== expect) throw new RepoError("stale", 412, "stale", {current: r.version});
      if (this.held(r)) throw new RepoError("held", 409, "held"); this.remove(r, "delete");
    }); await this.arm();
  }
  private truncated(id: string) { return this.rows<{truncated: number}>("SELECT truncated FROM commit_path_status WHERE version=?", id)[0]?.truncated === 1; }
  resolve(refOrVersion: string) {
    check(typeof refOrVersion === "string");
    const ref = this.rows<Ref>("SELECT * FROM refs WHERE name=?", refOrVersion)[0];
    if (ref) return {version: ref.version, tree: ref.tree, root: ref.root, ref: ref.name};
    const commit = this.rows<CommitRow>("SELECT * FROM commits WHERE version=?", refOrVersion)[0];
    if (!commit) throw new RepoError("no-ref", 404, "no-ref");
    const cached = this.rows<Ref>("SELECT * FROM refs WHERE version=? ORDER BY name LIMIT 1", refOrVersion)[0];
    return {version: commit.version, tree: commit.tree, root: cached?.root ?? null, ref: null};
  }
  async deleteOwned(owner: string) {
    const result = this.ctx.storage.transactionSync(() => {
      this.alive(); ownership(owner); check(typeof owner === "string");
      const deleted: string[] = [], held: string[] = [];
      for (const r of this.rows<Ref>("SELECT * FROM refs WHERE owner=? ORDER BY name", owner)) {
        if (this.held(r)) held.push(r.name); else { this.remove(r, "owner-deleted"); deleted.push(r.name); }
      }
      return {deleted, held};
    }); await this.arm(); return result;
  }
  private requireFastForward(current: string, target: string) {
    const queue = [target], queued = new Set(queue);
    for (let i = 0; i < queue.length; i++) {
      if (i === 50_000) throw new RepoError("not-fast-forward", 409, "not-fast-forward", { current, reason: "too_deep" });
      const id = queue[i];
      if (id === current) return;
      const row = this.rows<Pick<CommitRow, "parents">>("SELECT parents FROM commits WHERE version=?", id)[0];
      if (!row) continue;
      for (const parent of JSON.parse(row.parents) as string[]) {
        if (queued.has(parent)) continue;
        queued.add(parent);
        queue.push(parent);
      }
    }
    throw new RepoError("not-fast-forward", 409, "not-fast-forward", { current });
  }

  mergeBase(a: string, b: string): string | null {
    sha1(a); sha1(b);
    const queues = [[a], [b]], distances = [new Map([[a, 0]]), new Map([[b, 0]])];
    const offsets = [0, 0];
    const known = new Set<string>();
    while (offsets[0] < queues[0].length || offsets[1] < queues[1].length) {
      for (const side of [0, 1]) {
        if (offsets[side] >= queues[side].length) continue;
        const id = queues[side][offsets[side]++];
        const row = this.rows<CommitRow>("SELECT * FROM commits WHERE version=?", id)[0];
        if (!row) continue;
        known.add(id);
        for (const parent of JSON.parse(row.parents) as string[]) if (!distances[side].has(parent)) {
          distances[side].set(parent, distances[side].get(id)! + 1);
          queues[side].push(parent);
        }
      }
    }
    // Minimize total distance; SHA order breaks ties without depending on parent order.
    let best: string | null = null, distance = Infinity;
    for (const [id, left] of distances[0]) {
      const right = distances[1].get(id);
      if (right === undefined || !known.has(id)) continue;
      const total = left + right;
      if (total < distance || (total === distance && (best === null || id < best))) { best = id; distance = total; }
    }
    return best;
  }

  private decode(r: CommitRow): Version { return {version: r.version, tree: r.tree, parents: JSON.parse(r.parents), author: r.author, message: r.message, trailers: JSON.parse(r.trailers), at: r.at}; }
  commit(id: string) {
    sha1(id); const r = this.rows<CommitRow>("SELECT * FROM commits WHERE version=?", id)[0];
    return r ? {...this.decode(r), paths: this.truncated(r.version) ? null : this.rows<{path: string}>("SELECT path FROM commit_paths WHERE version=? ORDER BY path", id).map(r => r.path)} : null;
  }
  history(input: {ref?: string; from?: string; limit?: number; path?: string} = {}) {
    let id: string | null = input.from ?? this.needRef(input.ref ?? "main").version;
    sha1(id); const limit = page(input.limit, 50, 500), prefix = this.prefix(input.path), versions: Version[] = [], visited = new Set<string>();
    while (id && !visited.has(id)) {
      visited.add(id); const r: CommitRow | undefined = this.rows<CommitRow>("SELECT * FROM commits WHERE version=?", id)[0];
      if (!r) { id = null; break; }
      const v = this.decode(r);
      if (!prefix || this.truncated(r.version) || this.rows<{path: string}>("SELECT path FROM commit_paths WHERE version=?", id).some(p => this.matches(p.path, prefix))) versions.push(v);
      id = v.parents[0] ?? null;
      if (versions.length === limit) break;
    }
    if (id && (visited.has(id) || !this.rows("SELECT version FROM commits WHERE version=?", id).length)) id = null;
    return {versions, next: id};
  }
  log(input: {ref?: string; after?: number; limit?: number} = {}) {
    if (input.ref !== undefined) refName(input.ref);
    check(input.after === undefined || (Number.isSafeInteger(input.after) && input.after >= 0));
    return this.rows<LogRow>(`SELECT * FROM ref_log WHERE seq>? ${input.ref === undefined ? "" : "AND ref=?"} ORDER BY seq LIMIT ?`, input.after ?? 0, ...(input.ref === undefined ? [] : [input.ref]), page(input.limit, 50, 500));
  }
  private ttl(ttl: number) { check(Number.isSafeInteger(ttl) && ttl >= 1000 && ttl <= 600000, "bad-ttl"); }
  async acquire(input: {ref: string; holder: string; ttlMs: number}) {
    const result = this.ctx.storage.transactionSync(() => {
      this.alive(); this.ttl(input.ttlMs); check(typeof input.holder === "string" && input.holder.length > 0);
      const r = this.needRef(input.ref), live = this.held(r);
      if (live && r.holder !== input.holder) throw new RepoError("held", 409, "held");
      const epoch = live ? r.leaseEpoch : r.leaseEpoch + 1, deadline = this.now() + input.ttlMs;
      this.sql.exec("UPDATE refs SET holder=?,leaseEpoch=?,leaseDeadline=? WHERE name=?", input.holder, epoch, deadline, r.name);
      return {epoch, deadline};
    }); await this.arm(); return result;
  }
  private fenced(fence: Fence & {ref: string}) {
    const r = this.needRef(fence.ref);
    if (!this.held(r) || r.holder !== fence.holder || r.leaseEpoch !== fence.epoch) throw new RepoError("fenced", 409, "fenced"); return r;
  }
  async renew(fence: Fence & {ref: string}, ttlMs: number) {
    const result = this.ctx.storage.transactionSync(() => {
      this.alive(); this.ttl(ttlMs); const r = this.fenced(fence), deadline = this.now() + ttlMs;
      this.sql.exec("UPDATE refs SET leaseDeadline=? WHERE name=?", deadline, r.name); return {epoch: r.leaseEpoch, deadline};
    }); await this.arm(); return result;
  }
  async release(fence: Fence & {ref: string}) {
    this.ctx.storage.transactionSync(() => { this.alive(); const r = this.fenced(fence); this.sql.exec("UPDATE refs SET holder=NULL,leaseDeadline=NULL WHERE name=?", r.name); }); await this.arm();
  }
  watch(ref: string, agent: string) { this.ctx.storage.transactionSync(() => { this.alive(); this.needRef(ref); check(typeof agent === "string" && agent.length > 0); this.sql.exec("INSERT OR IGNORE INTO watchers VALUES(?,?)", ref, agent); }); }
  unwatch(ref: string, agent: string) { this.ctx.storage.transactionSync(() => { this.alive(); refName(ref); check(typeof agent === "string"); this.sql.exec("DELETE FROM watchers WHERE ref=? AND agent=?", ref, agent); }); }
  events(input: {after?: number; limit?: number} = {}) {
    check(input.after === undefined || (Number.isSafeInteger(input.after) && input.after >= 0));
    return this.rows<{seq: number; ref: string; version: string | null; at: number}>("SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?", input.after ?? 0, page(input.limit, 1000, 1000));
  }
  async delete() {
    this.ctx.storage.transactionSync(() => {
      const m = this.meta(); if (m.deleted) return; this.alive();
      for (const table of ["refs", "head", "watchers", "events", "commits", "commit_paths", "commit_path_status", "ref_log"]) this.sql.exec(`DELETE FROM ${table}`);
      this.sql.exec("UPDATE meta SET value='true' WHERE key='deleted'");
    }); await this.ctx.storage.deleteAlarm(); return {deleted: true as const};
  }
  async alarm() {
    this.ctx.storage.transactionSync(() => {
      this.alive();
      for (const r of this.rows<Ref>("SELECT * FROM refs WHERE expiresAt<=?", this.now())) if (!this.held(r)) this.remove(r, "expired");
    }); await this.arm();
  }
}
