import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";
import type { Entry, Version } from "../src/repos/repo-policy.ts";
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") return {url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }", shortCircuit: true};
  return next(specifier, context);
} });
const { RepoDO, RepoError, repoErrorFrom, normalizeRepoPath } = await import("../src/repos/repo-do.ts");
hooks.deregister();
const id = (n: number) => n.toString(16).padStart(40, "0");
const v = (n: number, parents: number[] = []): Version => ({version: id(n), tree: id(n + 1000), parents: parents.map(id), author: "api:test", message: `commit ${n}`, trailers: {}, at: n});
const e = (path: string, n = 1, size = 5): Entry => ({path, blob: id(n), mode: "100644", size});
const init = {tenant: "t", id: "r", name: "repo", lineage: "t:r", createdAt: 1};
function fixture(t: {after(fn: () => void): void}) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const state = {clock: 100000, alarm: null as number | null};
  const sql = {exec(query: string, ...args: any[]) {
    const stmt = db.prepare(query);
    const rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []);
    return {toArray: () => rows, one: () => {assert.equal(rows.length, 1); return rows[0];}, [Symbol.iterator]: () => rows[Symbol.iterator]()};
  }};
  const ctx = {storage: {sql, transactionSync<T>(fn: () => T): T { db.exec("BEGIN"); try {const result = fn(); db.exec("COMMIT"); return result;} catch (err) {db.exec("ROLLBACK"); throw err;} }, setAlarm: async (at: number) => {state.alarm = at;}, deleteAlarm: async () => {state.alarm = null;}, getAlarm: async () => state.alarm}};
  const object = new RepoDO(ctx as never, {}); Object.assign(object, {now: () => state.clock});
  const cas = (n: number, parents: number[], entries: Entry[], extra = {}) => object.cas({ref: "main", commit: v(n, parents), entries, who: "api:test", why: "test", ...extra});
  return {object, db, state, cas};
}
function error(code: string, status?: number) { return (err: unknown) => {assert.ok(err instanceof RepoError); assert.equal(err.code, code); if (status) assert.equal(err.status, status); return true;}; }

test("init is idempotent, seed is optional, conflicts and lifecycle errors", async t => {
  const {object, cas} = fixture(t);
  await assert.rejects(cas(1, [], []), error("uninitialized", 409));
  assert.equal((await object.init(init)).refs.length, 0);
  assert.equal((await object.init({...init, name: "ignored"})).name, "repo");
  await assert.rejects(object.init({...init, tenant: "other"}), error("conflict", 409));
  assert.deepEqual(await cas(1, [], [e("a")], {expect: null}), {version: id(1), previous: null, watchers: []});
  assert.equal(object.info().files, 1);
  await assert.rejects(cas(2, [1], [], {expect: null}), err => {assert.ok(error("stale", 412)(err)); assert.equal((err as InstanceType<typeof RepoError>).detail?.current, id(1)); return true;});
  await object.delete(); assert.deepEqual(await object.delete(), {deleted: true});
  assert.equal(object.info().deleted, true);
  await assert.rejects(cas(2, [], []), error("deleted", 410));
  await assert.rejects(object.init(init), error("deleted"));
  assert.throws(() => object.watch("main", "agent"), error("deleted"));
});

test("delta, path expectations, full diff, no-op, parent checks and watchers", async t => {
  const {object, cas} = fixture(t); await object.init({...init, seed: {version: v(1), entries: [e("a"), e("b")]}});
  object.watch("main", "agent");
  await assert.rejects(object.cas({ref: "main", expect: id(1), commit: v(2, [1]), changes: {a: e("a", 2)}, pathExpect: {a: "none"}, who: "a", why: "b"}), error("stale_path", 412));
  assert.deepEqual((await object.cas({ref: "main", expect: id(1), commit: v(2, [1]), changes: {a: e("a", 2), b: null}, pathExpect: {a: id(1), missing: "none"}, who: "a", why: "b"})).watchers, ["agent"]);
  assert.deepEqual(object.commit(id(2))?.paths, ["a", "b"]);
  assert.equal(object.stat("main", ["a", "b"]).entries.b, null);
  await cas(3, [2], [e("a", 2), e("c")]); assert.deepEqual(object.commit(id(3))?.paths, ["c"]);
  const count = object.events().length;
  await cas(3, [2], [e("a", 2), e("c")]); assert.equal(object.events().length, count); assert.equal(object.log().length, count);
  await assert.rejects(cas(4, [3, 99], []), error("unknown_parent"));
  await assert.rejects(cas(3, [2], [], {commit: {...v(3, [2]), tree: id(999)}}), error("conflict"));
  object.unwatch("main", "agent");
});

test("lease renewal, release, takeover and fences", async t => {
  const {object, state, cas} = fixture(t); await object.init(init); await cas(1, [], []);
  const lease = await object.acquire({ref: "main", holder: "host", ttlMs: 1000}); assert.equal(lease.epoch, 1);
  assert.equal((await object.acquire({ref: "main", holder: "host", ttlMs: 2000})).epoch, 1);
  await assert.rejects(object.acquire({ref: "main", holder: "other", ttlMs: 1000}), error("held"));
  await assert.rejects(cas(2, [1], []), error("fenced"));
  await assert.rejects(object.deleteRef("main"), error("held"));
  await object.renew({ref: "main", holder: "host", epoch: 1}, 1000);
  state.clock += 1001;
  const next = await object.acquire({ref: "main", holder: "other", ttlMs: 1000}); assert.equal(next.epoch, 2);
  await assert.rejects(object.renew({ref: "main", holder: "host", epoch: 1}, 1000), error("fenced"));
  await cas(2, [1], [], {fence: {holder: "other", epoch: 2}});
  await object.release({ref: "main", holder: "other", epoch: 2});
  await assert.rejects(cas(3, [2], [], {fence: {holder: "other", epoch: 2}}), error("fenced"));
  await assert.rejects(object.acquire({ref: "main", holder: "h", ttlMs: 999}), error("bad_ttl"));
});

test("refs copy heads and roots, usage deduplicates blobs, resolve prefers names", async t => {
  const {object, cas} = fixture(t); await object.init(init);
  const root = "a".repeat(64); await cas(1, [], [e("a"), e("b")], {root});
  await object.createRef({name: "fork", from: "main", who: "a", why: "copy"});
  assert.equal(object.info().bytes, 5); assert.equal(object.info().files, 2);
  assert.equal(object.resolve("fork").root, root);
  await object.createRef({name: id(1), from: {version: id(1)}, who: "a", why: "copy"});
  assert.equal(object.resolve(id(1)).ref, id(1));
  await object.deleteRef(id(1)); await object.deleteRef("fork");
  await cas(2, [1], [e("a", 2, 10)]); assert.equal(object.ref("main")?.root, null);
  assert.deepEqual(object.resolve(id(1)), {version: id(1), tree: v(1).tree, root: null, ref: null});
  await assert.rejects(object.createRef({name: "old", from: {version: id(1)}, who: "a", why: "copy"}), error("not_cached"));
  assert.throws(() => object.list({version: id(1)}), error("not_cached"));
  await assert.rejects(object.deleteRef("main", id(1)), error("stale"));
  await object.deleteRef("main", id(2)); assert.equal(object.info().bytes, 0);
  assert.throws(() => object.resolve("missing"), error("no_ref"));
});

test("history walks first parents with path filters and paging; mergeBase walks all parents", async t => {
  const {object, cas} = fixture(t); await object.init(init);
  await cas(1, [], [e("a/x")]); await cas(2, [1], [e("a/x"), e("b")]); await cas(3, [2], [e("a/x", 2), e("b")]);
  assert.deepEqual(object.history({path: "a", limit: 1}).versions.map(v => v.version), [id(3)]);
  assert.equal(object.history({path: "a", limit: 1}).next, id(2));
  assert.deepEqual(object.history({path: "a", from: id(2)}).versions.map(v => v.version), [id(1)]);
  await cas(4, [1], [e("other")], {ref: "fork", expect: null});
  await cas(5, [3, 4], []);
  assert.equal(object.mergeBase(id(5), id(4)), id(4)); assert.equal(object.mergeBase(id(3), id(4)), id(1));
  assert.equal(object.mergeBase(id(3), id(999)), null);
});

test("list prefixes match whole segments and page by exclusive path", async t => {
  const {object, cas} = fixture(t); await object.init(init); await cas(1, [], [e("a"), e("a/b"), e("a/c"), e("ab")]);
  const first = object.list({prefix: "a", limit: 2}); assert.deepEqual(first.entries.map(e => e.path), ["a", "a/b"]); assert.equal(first.next, "a/b");
  assert.deepEqual(object.list({prefix: "a", after: first.next!}).entries.map(e => e.path), ["a/c"]);
  assert.deepEqual(object.list({prefix: "a/"}).entries.map(e => e.path), ["a/b", "a/c"]);
  assert.equal(object.list({version: id(1)}).entries.length, 4);
  assert.throws(() => object.list({ref: "absent"}), error("no_ref"));
});

test("expiry skips held refs and rearms at their deadline; deleteOwned reports held refs", async t => {
  const {object, cas, state} = fixture(t); await object.init(init); await cas(1, [], [], {owner: "job:x", expiresAt: state.clock + 500});
  await object.createRef({name: "fork", from: "main", owner: "job:x", who: "a", why: "copy"});
  await object.acquire({ref: "main", holder: "host", ttlMs: 1000});
  assert.equal(state.alarm, state.clock + 1000);
  assert.deepEqual(await object.deleteOwned("job:x"), {deleted: ["fork"], held: ["main"]});
  state.clock += 500; await object.alarm(); assert.ok(object.ref("main"));
  state.clock += 500; await object.alarm(); assert.equal(object.ref("main"), null); assert.equal(state.alarm, null);
  assert.equal(object.log().at(-1)?.why, "expired"); assert.equal(object.log().at(-1)?.toVersion, null);
});

test("validation and RepoError survive RPC's lossy error serialization", () => {
  const original = new RepoError("stale_path", 412, "stale_path", {current: id(1)});
  const decoded = repoErrorFrom(new Error(original.message)); assert.equal(decoded?.status, 412); assert.equal(decoded?.code, "stale_path"); assert.deepEqual(decoded?.detail, original.detail);
  assert.equal(repoErrorFrom(new Error("repo:400:bad_sha1:{}"))?.code, "bad_sha1");
  assert.equal(repoErrorFrom(new Error("other")), null); assert.equal(repoErrorFrom(new Error("repo:400:bad_path:{oops}")), null);
  assert.equal(normalizeRepoPath("//a/b"), "a/b");
  for (const p of ["a//b", "a/../b", ".git/x", "a/", "a\0", "é".repeat(128)]) assert.throws(() => normalizeRepoPath(p), error("bad_path"));
});

test("a SQL failure late in CAS rolls back commits, head, refs, logs and events", async t => {
  const {object, cas, db} = fixture(t); await object.init(init); await cas(1, [], [e("a")]);
  db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  await assert.rejects(cas(2, [1], [e("b")]), /injected failure/);
  assert.equal(object.commit(id(2)), null); assert.equal(object.ref("main")?.version, id(1));
  assert.deepEqual(object.list().entries.map(e => e.path), ["a"]); assert.equal(object.log().length, 1); assert.equal(object.events().length, 1);
});

test("large path sets are marked unknown and event retention is bounded", async t => {
  const {object, cas, db} = fixture(t); await object.init(init);
  await cas(1, [], Array.from({length: 10001}, (_, n) => e(`a/${n}`)));
  assert.equal(object.commit(id(1))?.paths, null); assert.equal(object.history({path: "unrelated"}).versions.length, 1);
  for (let n = 2; n <= 1002; n++) await cas(n, [n - 1], []);
  assert.equal(object.events().length, 1000); assert.equal(object.events()[0].seq, 3);
  await object.delete();
  for (const table of ["refs", "head", "watchers", "events", "commits", "commit_paths", "commit_path_status", "ref_log"]) assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0);
});

test("CAS rejects invalid metadata and normalized path aliases atomically", async t => {
  const {object, cas} = fixture(t); await object.init(init); await cas(1, [], []);
  for (const extra of [
    {ref: "a.lock"}, {owner: "invalid"}, {root: "bad"},
    {commit: {...v(2, [1]), message: "\0"}},
    {commit: {...v(2, [1]), trailers: {Bad: "line\nline"}}},
    {entries: [e("a"), e("/a")]}, {entries: [{...e("a"), size: -1}]},
  ]) await assert.rejects(cas(2, [1], [], extra), (err: unknown) => {assert.ok(err instanceof RepoError); assert.equal(err.status, 400); return true;});
  assert.equal(object.ref("main")?.version, id(1)); assert.equal(object.log().length, 1);
  await assert.rejects(object.cas({ref: "main", changes: {}, commit: v(2, [1]), who: "a", why: "b"}), error("bad_input"));
});

test("a fork's seed may name parents this repo never saw; history stops there", async t => {
  const {object} = fixture(t);
  await object.init({...init, seed: {version: v(7, [6]), entries: [e("a")]}});
  assert.equal(object.ref("main")?.version, id(7));
  assert.deepEqual(object.history().versions.map(x => x.version), [id(7)]);
  assert.equal(object.history().next, null);
});

test('all supported owner kinds including cache are accepted',async t=>{
  const {object,cas}=fixture(t);await object.init(init);await cas(1,[],[]);
  for(const kind of ['agent','workflow','job','user','api','cache'])await object.createRef({name:kind,from:'main',owner:`${kind}:x`,who:'api:test',why:'test'});
  await assert.rejects(object.createRef({name:'bad',from:'main',owner:'volume:x',who:'api:test',why:'test'}),error('bad_owner'));
});

test("new commits on an existing ref must start with the current version", async t => {
  const {object, cas} = fixture(t);
  await object.init(init);
  await cas(1, [], [e("a")]);
  await cas(2, [98, 99], [e("side")], {ref: "topic", expect: null});
  const state = () => [object.ref("main"), object.list().entries, object.log(), object.events()];
  const before = state();
  for (const parents of [[], [2], [2, 1], [1, 2, 2]]) {
    await assert.rejects(cas(3, parents, [e("b")]), err => {
      error("bad_parent", 409)(err);
      assert.deepEqual((err as InstanceType<typeof RepoError>).detail, { parents: parents.map(id), current: id(1) });
      return true;
    });
    assert.deepEqual(state(), before);
    assert.equal(object.commit(id(3)), null);
  }
  await cas(3, [1, 2], [e("b")]);
  assert.deepEqual(object.commit(id(3))?.parents, [id(1), id(2)]);
});

test("fast-forward follows all parents and reaches a current fork base without a commit row", async t => {
  const {object, cas, db} = fixture(t);
  await object.init(init);
  await cas(1, [], [e("a")]);
  await cas(2, [99, 1], [e("b")], {ref: "topic", expect: null});
  await cas(3, [2], [e("c")], {ref: "topic"});
  db.prepare("DELETE FROM commits WHERE version=?").run(id(1));
  await cas(3, [2], [e("c")], {expect: id(1)});
  assert.equal(object.ref("main")?.version, id(3));
});

test("fast-forward fails closed past 50,000 visited versions", async t => {
  const {object, cas, db} = fixture(t);
  await object.init(init);
  await cas(1, [], [e("a")]);
  const insert = db.prepare("INSERT INTO commits VALUES(?,?,?,?,?,?,?)");
  db.exec("BEGIN");
  for (let n = 2; n <= 50_001; n++) {
    const row = v(n, [n - 1]);
    insert.run(row.version, row.tree, JSON.stringify(row.parents), row.author, row.message, "{}", row.at);
  }
  db.exec("COMMIT");
  const state = () => [object.ref("main"), object.list().entries, object.log(), object.events()];
  const before = state();
  await assert.rejects(cas(50_001, [50_000], [e("b")]), err => {
    error("not_fast_forward", 409)(err);
    assert.deepEqual((err as InstanceType<typeof RepoError>).detail, { current: id(1), reason: "too_deep" });
    return true;
  });
  assert.deepEqual(state(), before);
});
