import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './workflow-repo-fixture.ts';
const { childBranch, repoAt } = await import('../src/workflow-branches.ts');
import { BranchJanitor } from '../src/workflow-forks.ts';
const { mergeRefs } = await import('../src/repos/merge.ts');
const memory = () => {
  const rows = new Map<string, any>();
  return { rows, get: async (k: string) => rows.get(k), put: async (k: string, v: unknown) => { rows.set(k,v); }, delete: async (k: string) => rows.delete(k), list: async ({prefix}: {prefix: string}) => new Map([...rows].filter(([k]) => k.startsWith(prefix))) };
};
test('agent repo branches once per effect, resumes edits, and merges idempotently', async t => {
  const f = fixture(t), ctx = await f.create(), storage = memory();
  const at = repoAt(ctx.repoId), effect = {workflow:'wf',key:'edit',attempt:1};
  const fork = await childBranch(f.env,'t',storage as never,effect,at);
  assert.match(fork.ref,/^fork\/[0-9a-f]{16}-1$/);
  assert.equal(storage.rows.get(`workflow-repo:${ctx.repoId}`),true);
  assert.equal((await ctx.stub.ref(fork.ref))!.owner,'workflow:wf');
  const edited = await f.write(ctx,{a:{bytes:new TextEncoder().encode('one')}},{ref:fork.ref});
  await f.write(ctx,{b:{bytes:new TextEncoder().encode('main moved')}});
  assert.deepEqual(await childBranch(f.env,'t',storage as never,effect,at),fork);
  assert.equal((await ctx.stub.resolve(fork.ref)).version,edited.version);
  assert.equal((await mergeRefs(ctx,{into:'main',from:fork.ref})).changed,true);
  assert.equal((await mergeRefs(ctx,{into:'main',from:fork.ref})).changed,false);
});
test('branches from cached versions, and missing versions throw without a branch', async t => {
  const f = fixture(t), ctx = await f.create(), storage = memory();
  const old = await ctx.stub.resolve('main');
  await f.write(ctx,{a:{bytes:new TextEncoder().encode('new')}});
  const fork = await childBranch(f.env,'t',storage as never,{workflow:'wf',key:'cached',attempt:1},repoAt(ctx.repoId),old.version);
  assert.equal((await ctx.stub.resolve(fork.ref)).version,old.version);
  await assert.rejects(childBranch(f.env,'t',storage as never,{workflow:'wf',key:'missing',attempt:1},repoAt(ctx.repoId),'f'.repeat(40)), /no_ref/);
  assert.throws(()=>repoAt({repo:ctx.repoId,ref:'main',version:old.version}),/not both/);
});
test('end retains held refs and retries with backoff, then deletes only workflow refs', async t => {
  const f = fixture(t), ctx = await f.create(), storage = memory();
  const fork = await childBranch(f.env,'t',storage as never,{workflow:'wf',key:'edit',attempt:1},repoAt(ctx.repoId));
  const lease = await ctx.stub.acquire({ref:fork.ref,holder:'host',ttlMs:60000});
  const janitor = new BranchJanitor({storage:storage as never,now:()=>1000,deleteOwned:()=>ctx.stub.deleteOwned('workflow:wf')});
  assert.equal(await janitor.ended(),61000);
  assert.equal(await janitor.ended(),121000);
  await ctx.stub.release({ref:fork.ref,holder:'host',epoch:lease.epoch});
  assert.equal(await janitor.ended(),undefined);
  assert.equal(await ctx.stub.ref(fork.ref),null);
  assert.ok(await ctx.stub.ref('main'));
});
test('two workflows with the same effect key on one repo get their own branches', async t => {
  const f = fixture(t), ctx = await f.create();
  const one = await childBranch(f.env,'t',memory() as never,{workflow:'wf_one',key:'edit',attempt:1},repoAt(ctx.repoId));
  const two = await childBranch(f.env,'t',memory() as never,{workflow:'wf_two',key:'edit',attempt:1},repoAt(ctx.repoId));
  assert.notEqual(one.ref,two.ref);
  assert.equal((await ctx.stub.ref(one.ref))!.owner,'workflow:wf_one');
  assert.equal((await ctx.stub.ref(two.ref))!.owner,'workflow:wf_two');
});
