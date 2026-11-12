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

function cache(t: { after(fn: () => void): void }, released: (workflow: string, fork: string) => void = () => {}) {
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
  const env = { WORKFLOWS: { getByName: (workflow: string) => ({ forkReleased: async (fork: string) => released(workflow, fork) }) } };
  const object = new WorkflowResults(ctx as never, env as never);
  (object as unknown as { now: () => number }).now = () => state.clock;
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

test("an entry lives 7 days from its last hit; when it goes, its fork's workflow is told, again until it answers", async t => {
  const told: string[] = [];
  let failing = 1;
  const { object, state } = cache(t, (workflow, fork) => { if (failing-- > 0) throw new Error("the workflow is down"); told.push(`${workflow}/${fork}`); });
  await object.put({ kind: "agent", key: "k", source: "wf1:k:1", workflow: "wf1", value: { text: "t", fork: { volume: "vol_f" } }, fork: "vol_f" });
  assert.equal(state.alarm, state.clock + RESULT_CACHE_LIMITS.ttlMs);
  state.clock += RESULT_CACHE_LIMITS.ttlMs - 1;
  assert.ok(await object.lookup("agent", "k"), "a hit just before the expiry");
  state.clock += RESULT_CACHE_LIMITS.ttlMs - 1;
  await object.alarm();
  assert.ok(await object.lookup("agent", "k"), "the hit gave it another 7 days");
  state.clock += RESULT_CACHE_LIMITS.ttlMs;
  await object.alarm();
  assert.equal(await object.lookup("agent", "k"), undefined);
  assert.deepEqual(told, [], "the first release failed");
  assert.equal(state.alarm, state.clock + RESULT_CACHE_LIMITS.releaseRetryMs, "and is tried again later");
  state.clock = state.alarm!;
  await object.alarm();
  assert.deepEqual(told, ["wf1/vol_f"]);
  assert.equal(state.alarm, null, "nothing left");
});

test("past its caps a scope drops the least recently hit first; a fork still named by another entry is not released", async t => {
  const told: string[] = [];
  const { object, state } = cache(t, (_workflow, fork) => { told.push(fork); });
  await object.put({ kind: "agent", key: "old", source: "wf1:old:1", workflow: "wf1", value: 1, fork: "vol_shared" });
  state.clock += 1;
  await object.put({ kind: "agent", key: "same fork", source: "wf1:same:1", workflow: "wf1", value: 2, fork: "vol_shared" });
  for (let i = 0; i < RESULT_CACHE_LIMITS.entries - 2; i++) { state.clock += 1; await object.put({ kind: "job", key: `k${i}`, source: `wf1:k${i}:1`, workflow: "wf1", value: i }); }
  assert.equal(Number((await object.stats()).n), RESULT_CACHE_LIMITS.entries);
  state.clock += 1;
  assert.deepEqual(await object.put({ kind: "job", key: "one more", source: "wf2:x:1", workflow: "wf2", value: "x" }), { stored: true });
  assert.equal(await object.lookup("agent", "old"), undefined, "the least recently hit went");
  assert.ok(await object.lookup("agent", "same fork"));
  await object.alarm();
  assert.deepEqual(told, [], "its fork is still named by another entry");
});

test("a workflow that got a fork from a hit holds it until it ends; drop frees an unreachable fork only when nobody holds it; a missing source counts as told", async t => {
  const told: string[] = [];
  let missing = false;
  const { object, state } = cache(t, (workflow, fork) => { if (missing) throw new Error("No workflow"); told.push(`${workflow}/${fork}`); });
  await object.put({ kind: "agent", key: "k", source: "wf1:k:1", workflow: "wf1", value: { fork: { volume: "vol_f" } }, fork: "vol_f" });
  assert.ok(await object.lookup("agent", "k", "wf2"));
  assert.equal(await object.drop("vol_f"), false, "wf2 holds it: its commit must find it");
  assert.equal(await object.holds("vol_f"), true);
  // The entry expires; the fork stays for wf2 until wf2 ends.
  state.clock += RESULT_CACHE_LIMITS.ttlMs;
  await object.alarm();
  assert.deepEqual(told, []);
  await object.unholdAll("wf2");
  assert.deepEqual(told, ["wf1/vol_f"]);
  assert.equal(await object.holds("vol_f"), false);

  await object.put({ kind: "agent", key: "k2", source: "wf3:k2:1", workflow: "wf3", value: 1, fork: "vol_g" });
  assert.equal(await object.drop("vol_g"), true);
  assert.equal(await object.lookup("agent", "k2"), undefined, "its entries went with it");

  missing = true;
  await object.put({ kind: "agent", key: "k3", source: "wf9:k3:1", workflow: "wf9", value: 1, fork: "vol_h" });
  state.clock += RESULT_CACHE_LIMITS.ttlMs;
  await object.alarm();
  assert.equal(state.alarm, null, "a release to a workflow that does not exist is not retried");
});
