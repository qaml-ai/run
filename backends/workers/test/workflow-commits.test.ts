import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import type { StartedEffect, EffectOutcome } from "../src/workflow-runner.ts";
import { harness } from "./workflow-harness.ts";
import { fixture } from "./workflow-repo-fixture.ts";

// The workflow modules reach Durable Objects; a stand-in base class lets them load in Node.
const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {} export const waitUntil = p => p;", shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { WorkflowCommits, WORKFLOW_COMMIT_PREFIX } = await import("../src/workflow-commits.ts");
const { byKind, WorkflowObject } = await import("../src/workflow-object.ts");
const { BranchJanitor } = await import("../src/workflow-forks.ts");
hooks.deregister();

test("removed effects fault on first call and issue no effects", { timeout: 60_000 }, async () => {
  const message = "job() and push() were removed; run commands with the bash tool in a child agent.";
  for (const name of ["job", "push"]) {
    const h = harness();
    h.init({ code: `try { await ${name}({}); } catch {} return "ignored";` });
    await h.wake();
    assert.equal(h.runner.get().status, "failed");
    assert.deepEqual(h.runner.get().fault, { code: "script_error", message });
    assert.deepEqual(h.world.queue, []);
  }
});

test("byKind sends agents to the children, commits to the merge executor, polls by kind, and recovers both", async () => {
  const calls: string[] = [];
  const executor = (name: string) => ({
    start: async (effect: StartedEffect) => { calls.push(`${name} start ${effect.kind}`); },
    cancel: async (effect: StartedEffect) => { calls.push(`${name} cancel ${effect.kind}`); },
    recover: async () => { calls.push(`${name} recover`); },
    abort: async () => { calls.push(`${name} abort`); },
  });
  const children = executor("children"), commits = { ...executor("commits"), poll: async (effect: StartedEffect) => { calls.push(`commits poll ${effect.kind}`); return undefined; } };
  const both = byKind({ agent: children, commit: commits });
  const effect = (kind: string) => ({ key: kind, attempt: 1, kind, args: {} });
  for (const kind of ["agent", "commit"]) await both.start(effect(kind));
  await both.cancel!(effect("agent"));
  await both.poll!(effect("commit"));
  await both.recover!();
  await both.abort!();
  assert.deepEqual(calls, ["children start agent", "commits start commit", "children cancel agent", "commits poll commit", "children recover", "commits recover", "children abort", "commits abort"]);
});

function commits(env: ConstructorParameters<typeof WorkflowCommits>[0]) {
  const rows = new Map<string, unknown>();
  const storage = {
    put: async (key: string, value: unknown) => { rows.set(key, value); },
    delete: async (key: string) => { rows.delete(key); },
    get: async (key: string) => rows.get(key),
    list: async ({ prefix }: { prefix: string }) => new Map([...rows].filter(([key]) => key.startsWith(prefix))),
  };
  const landed: [string, number, EffectOutcome][] = [], pending: Promise<void>[] = [];
  const executor = new WorkflowCommits(env, {
    tenant: () => "t", storage: storage as never,
    land: async (key, attempt, outcome) => { landed.push([key, attempt, outcome]); },
    waitUntil: promise => { pending.push(promise); },
  });
  return { executor, landed, rows, settled: async () => { while (pending.length) await pending.shift(); } };
}
const effect = (key: string, args: Record<string, unknown>): StartedEffect => ({ key, attempt: 1, kind: "commit", args });

test("a workflow's forks are deleted once it ends; a failed delete is tried again later, never while a commit is landing", async () => {
  const rows = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => rows.get(key),
    put: async (key: string, value: unknown) => { rows.set(key, value); },
    delete: async (key: string) => rows.delete(key),
    list: async ({ prefix }: { prefix: string }) => new Map([...rows].filter(([key]) => key.startsWith(prefix))),
  };
  let now = 1_000_000;
  const deleted: string[] = [], failing = new Set<string>();
  const janitor = () => new BranchJanitor({ storage: storage as never, now: () => now, deleteOwned: async id => {
    if (failing.has(id)) throw new Error("storage unavailable");
    deleted.push(id); return { held: [] };
  } });
  let forks = janitor();
  await storage.put("workflow-repo:" + "vol_a", true);
  await storage.put("workflow-repo:" + "vol_b", true);
  await storage.put("workflow-repo:" + "vol_c", true);
  // A commit still landing (its pending row) keeps every fork: it is tried again later.
  rows.set(WORKFLOW_COMMIT_PREFIX + "land", { kind: "commit", key: "land", attempt: 1 });
  assert.equal(await forks.ended(), now + 60_000);
  assert.deepEqual(deleted, []);
  rows.delete(WORKFLOW_COMMIT_PREFIX + "land");
  // One delete fails: the others go, and the retry backs off.
  failing.add("vol_b");
  assert.equal(await forks.ended(), now + 120_000);
  assert.deepEqual(deleted, ["vol_a", "vol_c"]);
  assert.equal(await forks.retryAt(), now + 120_000);
  // A crash, then the alarm: a new instance over the same storage finishes it, and the retry is cleared.
  failing.clear();
  now += 120_000;
  forks = janitor();
  assert.equal(await forks.ended(), undefined);
  assert.deepEqual(deleted, ["vol_a", "vol_c", "vol_b"]);
  assert.equal(await forks.retryAt(), undefined);
  assert.equal([...rows.keys()].filter(key => key.startsWith("workflow-repo")).length, 0);
  // Nothing left: ending again does nothing.
  assert.equal(await forks.ended(), undefined);
  assert.equal(deleted.length, 3);
});

test("a commit with a lost landing keeps the sweep armed", { timeout: 60_000 }, async () => {
  const h = harness();
  h.init({ code: `return await commit({repo:"repo_1",ref:"fork/one",base:{ref:"main",version:"v"}}, { key: "k" });` });
  await h.wake();
  assert.deepEqual(h.world.queue.map(effect => effect.kind), ["commit"]);
  h.world.queue.splice(0);
  (h.world as unknown as { answer: (effect: StartedEffect) => EffectOutcome }).answer = () => ({ ok: true, value: { landed: true } });
  assert.notEqual(h.alarmAt, null);
  for (let guard = 0; guard < 5 && h.runner.get().status !== "completed"; guard++) {
    h.clock = Math.max(h.clock, h.alarmAt!);
    await h.runner.alarm();
  }
  assert.equal(h.runner.get().status, "completed");
  assert.deepEqual(h.runner.get().result, { landed: true });
});

test('commit merges cleanly, reports conflicts, rejects snapshots and retries storage failures', async t => {
  const f = await fixture(t), ctx = await f.create();
  const { childBranch, repoAt } = await import('../src/workflow-branches.ts');
  const mem = { get:async()=>undefined,put:async()=>{} };
  const fork = await childBranch(f.env,'t',mem as never,{workflow:'wf_1',key:'a',attempt:1},repoAt(ctx.repoId));
  await f.write(ctx,{a:{bytes:new TextEncoder().encode('one')}},{ref:fork.ref});
  const j = commits(f.env);
  await j.executor.start(effect('merge',{fork})); await j.settled();
  assert.equal((j.landed[0][2] as any).value.committed,true);
  await j.executor.start(effect('again',{fork})); await j.settled();
  assert.equal((j.landed[1][2] as any).value.changed,false);
  await j.executor.start(effect('snapshot',{fork,snapshot:'old'})); await j.settled();
  assert.match((j.landed[2][2] as any).error,/no snapshot/);
  const bare = {...fork,base:{version:fork.base.version}};
  await j.executor.start(effect('bare',{fork:bare})); await j.settled();
  assert.match((j.landed[3][2] as any).error,/no branch to merge into; start the agent from a ref/);
  const conflicting = await childBranch(f.env,'t',mem as never,{workflow:'wf_1',key:'conflict',attempt:1},repoAt(ctx.repoId));
  await f.write(ctx,{a:{bytes:new TextEncoder().encode('ours')}});
  await f.write(ctx,{a:{bytes:new TextEncoder().encode('theirs')}},{ref:conflicting.ref});
  await j.executor.start(effect('conflict',{fork:conflicting})); await j.settled();
  const conflict = (j.landed[4][2] as any).value;
  assert.equal(conflict.committed,false);
  assert.equal(conflict.conflicts[0].path,'a');
  assert.equal(conflict.conflicts[0].reason,'both_modified');
  const url = f.env.CAMELFS_URL;
  f.env.CAMELFS_URL = "invalid URL";
  await j.executor.start(effect('retry',{fork:conflicting})); await j.settled();
  assert.equal(j.landed.length,5,'storage failures do not land');
  assert.ok([...j.rows.values()].some((row:any)=>row.key==='retry'&&row.kind==='commit'));
  f.env.CAMELFS_URL = url;
  await j.executor.recover(); await j.settled();
  assert.equal((j.landed[5][2] as any).value.committed,false);
  assert.equal(j.rows.size,0);

});

test('result cache keys on trees and recreates branches; a missing version is a logged miss', async t => {
  const f = await fixture(t), ctx = await f.create(), old = await ctx.repo.resolve('main');
  const rows = new Map<string, unknown>(), keys: string[] = [];
  let cached: any;
  const cache = { lookup: async (_kind: string,key: string) => { keys.push(key); return cached; } };
  const storage = {get:async(k:string)=>rows.get(k),put:async(k:string,v:unknown)=>{rows.set(k,v);}};
  const self = {ctx:{storage},results:()=>({tenant:'t',cache}),settings:()=>({})};
  const results = (WorkflowObject.prototype as any).resultCache.call(self,f.env,'wf_new');
  const args = JSON.stringify({prompt:'edit',repo:ctx.repoId,model:'test/model'});
  await results.lookup('agent',args,{key:'a',attempt:1});
  await f.write(ctx,{temporary:{bytes:new TextEncoder().encode('temporary')}});
  await f.write(ctx,{temporary:null});
  assert.notEqual((await ctx.repo.resolve('main')).version,old.version);
  await results.lookup('agent',args,{key:'a',attempt:1});
  assert.equal(keys[0],keys[1],'new versions with equal trees share keys');
  cached = {value:{text:'cached'},source:'old:k:1',fork:{repo:ctx.repoId,version:old.version}};
  const hit = await results.lookup('agent',args,{key:'a',attempt:1});
  assert.equal((await ctx.repo.resolve(hit.hit.value.fork.ref)).version,old.version);
  assert.equal(rows.get(`workflow-repo:${ctx.repoId}`),true);
  cached = {...cached,fork:{repo:ctx.repoId,version:'f'.repeat(40)}};
  const lines: string[] = [], error = console.error;
  console.error = line => lines.push(line);
  try {
    const miss = await results.lookup('agent',args,{key:'missing',attempt:1});
    assert.equal(miss.hit,undefined);
    assert.equal(JSON.parse(lines[0]).type,'workflow_cache_fork_missing');
  } finally { console.error = error; }
});
