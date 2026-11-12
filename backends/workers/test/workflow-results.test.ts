import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";

// The object's module extends DurableObject: a stand-in that keeps ctx and env, as the runtime's does.
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }", shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { WorkflowResults, cacheKey, RESULT_CACHE_LIMITS } = await import("../src/workflow-results.ts");
hooks.deregister();

function cache(t: { after(fn: () => void): void }, deleted: (tenant: string, fork: string) => void = () => {}) {
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
  const object = new WorkflowResults(ctx as never, {} as never);
  Object.assign(object, { now: () => state.clock, deleteFork: async (tenant: string, fork: string) => deleted(tenant, fork) });
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
  // The repo's version is part of an agent's key on a fork: another version is another key.
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

test("a fork has one owner: its workflow until it ends, then the cache if an entry names it, which deletes it when the entry goes", async t => {
  const deleted: string[] = [];
  let failing = 1;
  const { object, state } = cache(t, (tenant, fork) => { if (failing-- > 0) throw new Error("storage down"); deleted.push(`${tenant}/${fork}`); });
  const fork = { tenant: "acme", volume: "vol_f" };
  await object.put({ kind: "agent", key: "k", source: "wf1:k:1", workflow: "wf1", value: { fork: { volume: "vol_f" } }, fork });
  assert.equal(await object.adopt("vol_f", "acme"), true, "an entry names it: the cache owns it now");
  // The entry is evicted (expired): the fork is deleted, again after a failure.
  state.clock += RESULT_CACHE_LIMITS.ttlMs;
  await object.alarm();
  assert.deepEqual(deleted, []);
  assert.equal(state.alarm, state.clock + RESULT_CACHE_LIMITS.retryMs);
  state.clock = state.alarm!;
  await object.alarm();
  assert.deepEqual(deleted, ["acme/vol_f"]);

  // No entry names it: the workflow keeps (deletes) it, and a put naming it after that is refused.
  assert.equal(await object.adopt("vol_g", "acme"), false);
  assert.deepEqual(await object.put({ kind: "agent", key: "late", source: "wf2:late:1", workflow: "wf2", value: 1, fork: { tenant: "acme", volume: "vol_g" } }), { stored: false });
  assert.equal(await object.lookup("agent", "late"), undefined);

  // Its base moved on (a commit landed): the entries go, and the workflow deletes the fork.
  await object.put({ kind: "agent", key: "m", source: "wf3:m:1", workflow: "wf3", value: 1, fork: { tenant: "acme", volume: "vol_m" } });
  assert.equal(await object.adopt("vol_m", "acme", true), false);
  assert.equal(await object.lookup("agent", "m"), undefined);

  // A fork no workflow handed over (an entry naming any volume, the owner's repo say) is never deleted here.
  await object.put({ kind: "agent", key: "forged", source: "wf5:x:1", workflow: "wf5", value: 1, fork: { tenant: "acme", volume: "vol_owners_repo" } });
  state.clock += RESULT_CACHE_LIMITS.ttlMs;
  await object.alarm();
  assert.equal(await object.lookup("agent", "forged"), undefined);
  assert.ok(!deleted.includes("acme/vol_owners_repo"), "only a fork its workflow handed over is the cache's to delete");

  // An entry naming a fork lives at most forkEntryMs, hits or not (its base snapshot's life).
  await object.put({ kind: "agent", key: "n", source: "wf4:n:1", workflow: "wf4", value: 1, fork: { tenant: "acme", volume: "vol_n" } });
  assert.equal(await object.adopt("vol_n", "acme"), true);
  for (let day = 1; day < 6; day++) { state.clock += 86_400_000; assert.ok(await object.lookup("agent", "n")); }
  state.clock += 86_400_000;
  await object.alarm();
  assert.equal(await object.lookup("agent", "n"), undefined);
  assert.ok(deleted.includes("acme/vol_n"));
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
