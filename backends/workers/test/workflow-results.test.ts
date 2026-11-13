import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fixture } from "./workflow-repo-fixture.ts";
import { registerHooks } from "node:module";

// The object's module extends DurableObject: a stand-in that keeps ctx and env, as the runtime's does.
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }", shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { WorkflowResults, cacheKey, RESULT_CACHE_LIMITS } = await import("../src/workflow-results.ts");
hooks.deregister();

function cache(t: { after(fn: () => void): void }, env = {} as any) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const sql = { exec(query: string, ...args: any[]) {
    const statement = db.prepare(query);
    if (/^\s*(SELECT|WITH)/i.test(query)) { const rows = statement.all(...args); return { toArray: () => rows, one: () => { assert.equal(rows.length, 1, query); return rows[0]; } }; }
    const { changes } = statement.run(...args);
    return { toArray: () => [], one: () => undefined, rowsWritten: Number(changes) };
  } } as unknown as SqlStorage;
  const state = { alarm: null as number | null, clock: 1_000_000 };
  const ctx = { storage: { sql, setAlarm: async (at: number) => { state.alarm = at; }, deleteAlarm: async () => { state.alarm = null; } } };
  const object = new WorkflowResults(ctx as never, env);
  Object.assign(object, { now: () => state.clock });
  return { object, state, db };
}

test("a result is kept once per kind and key: the first stays, a hit answers it with its source, too large is not kept", async t => {
  const { object } = cache(t);
  const key = cacheKey('{"prompt":"review a"}');
  assert.equal(await object.lookup("agent", key), undefined);
  assert.deepEqual(await object.put({ kind: "agent", key, source: "wf1:review:a:1", workflow: "wf1", value: { text: "first" } }), { stored: true });
  assert.deepEqual(await object.put({ kind: "agent", key, source: "wf2:review:a:1", workflow: "wf2", value: { text: "second" } }), { stored: false });
  assert.deepEqual(await object.lookup("agent", key), { value: { text: "first" }, source: "wf1:review:a:1" });
  assert.equal(await object.lookup("job", key), undefined, "the kind is part of the key");
  // Different base trees have different keys.
  assert.notEqual(cacheKey('{"prompt":"x","repo":"vol_1"}', 5), cacheKey('{"prompt":"x","repo":"vol_1"}', 6));
  assert.equal(await object.lookup("agent", cacheKey('{"prompt":"review a"}', 5)), undefined);
  const big = "x".repeat(RESULT_CACHE_LIMITS.entryBytes);
  assert.deepEqual(await object.put({ kind: "job", key: "big", source: "wf1:big:1", workflow: "wf1", value: big }), { stored: false });
  assert.equal(await object.lookup("job", "big"), undefined);
});


test("an entry lives 7 days from its last hit", async t => {
  const { object, state } = cache(t);
  await object.put({ kind: "job", key: "k", source: "wf1:k:1", workflow: "wf1", value: 1 });
  assert.equal(state.alarm, state.clock + RESULT_CACHE_LIMITS.ttlMs);
  state.clock += RESULT_CACHE_LIMITS.ttlMs - 1;
  assert.ok(await object.lookup("job", "k"), "a hit just before the expiry");
  state.clock += RESULT_CACHE_LIMITS.ttlMs - 1;
  await object.alarm();
  assert.ok(await object.lookup("job", "k"), "the hit gave it another 7 days");
  state.clock += RESULT_CACHE_LIMITS.ttlMs;
  await object.alarm();
  assert.equal(await object.lookup("job", "k"), undefined);
  assert.equal(state.alarm, null, "nothing left");
});

test("past its caps a scope drops the least recently hit first", async t => {
  const { object, state } = cache(t);
  await object.put({ kind: "agent", key: "old", source: "wf1:old:1", workflow: "wf1", value: 1 });
  for (let i = 0; i < RESULT_CACHE_LIMITS.entries - 1; i++) { state.clock += 1; await object.put({ kind: "job", key: `k${i}`, source: `wf1:k${i}:1`, workflow: "wf1", value: i }); }
  assert.equal(Number((await object.stats()).n), RESULT_CACHE_LIMITS.entries);
  state.clock += 1;
  assert.deepEqual(await object.put({ kind: "job", key: "one more", source: "wf2:x:1", workflow: "wf2", value: "x" }), { stored: true });
  assert.equal(await object.lookup("agent", "old"), undefined, "the least recently hit went");
});


test("cached forks are immutable versions retained by a three-day cache ref", async t => {
  const f = fixture(t), repo = await f.create(), head = await repo.stub.resolve('main');
  const { object, state, db } = cache(t, f.env);
  const fork = { tenant: 't', owner: 'api', repo: repo.repoId, version: head.version };
  await object.put({ kind: 'agent', key: 'tree-key', source: 'wf:k:1', workflow: 'wf', value: { text: 'ok' }, fork });
  const hit = await object.lookup('agent', 'tree-key');
  assert.deepEqual(hit?.fork, { repo: repo.repoId, version: head.version });
  const refs = await repo.stub.refs();
  const kept = refs.find(r => r.name.startsWith('cache/'))!;
  assert.match(kept.name, /^cache\/[0-9a-f]{16}$/);
  assert.equal(kept.owner, 'cache:t:api');
  assert.ok(kept.expiresAt! > Date.now() + RESULT_CACHE_LIMITS.forkEntryMs - 1000);
  state.clock += RESULT_CACHE_LIMITS.forkEntryMs;
  assert.equal(await object.lookup('agent', 'tree-key'), undefined);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='forks'").all().length, 0);
});

test('a ref left by eviction is replaced before caching a new fork version', async t => {
  const f = fixture(t), repo = await f.create(), head = await repo.stub.resolve('main');
  const {object,db} = cache(t,f.env);
  const entry = {kind:'agent',key:'same-key',source:'old:k:1',workflow:'old',value:{text:'old'},fork:{tenant:'t',owner:'api',repo:repo.repoId,version:head.version}};
  await object.put(entry);
  db.exec('DELETE FROM results');
  const edited = await f.write(repo,{'a':{bytes:new TextEncoder().encode('new')}});
  await object.put({...entry,source:'new:k:1',workflow:'new',value:{text:'new'},fork:{...entry.fork,version:edited.version}});
  const retained = (await repo.stub.refs()).find(r=>r.name.startsWith('cache/'))!;
  assert.equal(retained.version,edited.version);
  assert.equal((await object.lookup('agent','same-key'))!.fork!.version,edited.version);
});
