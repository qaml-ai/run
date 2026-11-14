import { fixture } from './workflow-repo-fixture.ts';
import { hookTierServices } from './tier-env.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
const hooks = hookTierServices();
const { statPaths } = await import('../src/repos/reads.ts');
const { commitChanges, setRefToVersion, branch } = await import('../src/repos/write.ts');
const { prepareRepo, finishJobRepo, renewJobRepo, releaseJobRepo } = await import('../src/jobs/repo.ts');
const { WorkflowJobs } = await import('../src/workflow-jobs.ts');
const { jobSpec, JobSpecError } = await import('../src/jobs/job.ts');
const { jobDriver } = await import('../src/jobs/driver.ts');
const { mergeRefs } = await import('../src/repos/merge.ts');
const { createRepo, repoContext, deleteRepo } = await import('../src/repos/registry.ts');
hooks.deregister();
const bytes = (s: string) => new TextEncoder().encode(s);
const err = (code: string) => (e: any) => { assert.equal(e.code, code); return true; };

const measure = async (_: string, run: () => Promise<any>) => run();
const input = (repo: string): any => ({ id: 'attempt', command: 'true', timeoutSeconds: 30, payer: { tenant: 't', agent: 'a' }, repo: { tenant: 't', repo, owner: 'workflow:w' }, commit: true });
const output = (commit: string, tree: string): any => ({ ok: true, camelfs: { commit, tree, root: 'a'.repeat(64), warm: true, mountMs: 1, applyMs: 1 } });
// TEMPORARY(K5)
test.skip('repo job resolves, branches, leases, advances with root and releases', async t => {
  const f = await fixture(t), ctx = await f.create(), spec = input(ctx.repoId), events: string[] = [];
  const saved = await prepareRepo();
  assert.deepEqual(events, ['resolveMs', 'branchMs', 'leaseMs']);
  assert.equal((await ctx.repo.ref('job/attempt'))?.owner, 'workflow:w');
  assert.deepEqual(saved.fence, { holder: 'host:h/attempt', epoch: 1 });
  const mount = { lineage: saved.lineage, tree: saved.tree, parent: saved.expect };
  const c = await f.fake.checkpoint(mount, spec.id);
  const result = output(c.commit, c.tree);
  await finishJobRepo(ctx, spec, saved, result, measure);
  assert.equal(result.camelfs.ref, 'job/attempt');
  // Host authority: the ref moves to the host's own checkpoint commit, never a re-made one.
  assert.equal(result.camelfs.version, c.commit);
  assert.equal(result.camelfs.commit, c.commit);
  assert.equal((await ctx.repo.ref('job/attempt'))?.version, c.commit);
  assert.equal((await ctx.repo.ref('job/attempt'))?.root, 'a'.repeat(64));
  await releaseJobRepo(f.env, spec.id, saved);
  assert.equal((await ctx.repo.ref('job/attempt'))?.holder, null);
});
// TEMPORARY(K5)
test.skip('recovery renews the persisted fence; takeover fails visibly and preserves output', async t => {
  const f = await fixture(t), ctx = await f.create(), spec = input(ctx.repoId);
  const saved = await prepareRepo();
  await renewJobRepo(f.env, spec.id, saved);
  assert.equal((await ctx.repo.ref('job/attempt'))?.leaseEpoch, saved.fence.epoch);
  await releaseJobRepo(f.env, spec.id, saved);
  await ctx.repo.acquire({ ref: 'job/attempt', holder: 'other', ttlMs: 600000 });
  await assert.rejects(renewJobRepo(f.env, spec.id, saved), /fenced/);
  const c = await ctx.storage.commit(ctx.lineage, { parents: [saved.expect], changes: [], message: 'checkpoint', author: 'job:attempt', trailers: {} });
  const result = { ...output(c.commit, c.tree), exitCode: 9 };
  await finishJobRepo(ctx, spec, saved, result, measure);
  assert.equal(result.exitCode, 9); assert.equal(result.camelfs.checkpointError, `cas: repo:409:fenced:{}`);
  assert.equal((await ctx.repo.ref('job/attempt'))?.version, saved.expect);
});
test('workflow repo at records cleanup before dispatch and shares target validation', async t => {
  const f = await fixture(t), ctx = await f.create(), values = new Map();
  const host: any = { workflow: { id: 'wf_one', tenant: 't' }, payer: () => 'a', storage: { put: async (k: string,v: unknown) => values.set(k,v) } };
  const jobs: any = new WorkflowJobs(f.env, host);
  const {spec} = await jobs.jobSpec('repo-at', { at: {repo:ctx.repoId,ref:'main'}, command:'true',timeoutSeconds:30 });
  assert.deepEqual(spec.repo,{tenant:'t',repo:ctx.repoId,ref:'main',owner:'workflow:wf_one'});
  assert.equal(values.get(`workflow-repo:${ctx.repoId}`),true);
  await assert.rejects(jobs.jobSpec('invalid',{at:{repo:ctx.repoId,ref:'main',version:'a'.repeat(40)},command:'true',timeoutSeconds:30}), /not both/);
});
test('repo specs validate tenant, owner, ref/version exclusion, and containers refuse repos', async () => {
  const spec = input('repo_1'); assert.equal(jobSpec(spec).repo?.repo, 'repo_1');
  for (const extra of [{ repo: '' }, { owner: 'host:x' }, { version: 'bad' }, { version: 'a'.repeat(40), ref: 'main' }, { tenant: 'other' }]) assert.throws(() => jobSpec({ ...spec, repo: { ...spec.repo, ...extra } }), JobSpecError);
  assert.throws(() => jobSpec({ ...spec, files: {} }), JobSpecError);
  assert.throws(() => jobSpec({ ...spec, volume: { tenant: 't', volume: 'v', snapshot: 's' } }), JobSpecError);
  const found = jobDriver({ COMPUTER_CONTAINERS: {} } as never); assert.ok(found.ok);
  await assert.rejects(found.driver.run(spec), /repo needs camelFS/);
});

test('a stale mounted version becomes a bounded checkpoint error', async t => {
  const f = await fixture(t), ctx = await f.create(), spec = input(ctx.repoId);
  const main = await ctx.repo.resolve('main');
  await branch(ctx, { name: 'job/attempt', from: 'main' });
  const saved = { ...main, expect: main.version, lineage: ctx.lineage, repo: spec.repo, fence: { holder: 'host:h/attempt', epoch: 1 } };
  const c = await ctx.storage.commit(ctx.lineage, { parents: [saved.expect], changes: [], message: 'checkpoint', author: 'job:attempt', trailers: {} });
  const result = output(c.commit, c.tree);
  await finishJobRepo(ctx, spec, { ...saved, expect: '0'.repeat(40) }, result, measure);
  assert.match(result.camelfs.checkpointError, /^cas: .*stale/);
  assert.ok(result.camelfs.checkpointError.length <= 300);
  assert.equal(result.camelfs.version, undefined);
  assert.equal((await ctx.repo.ref('job/attempt'))?.version, saved.expect);
});
test('inline workflow files are committed on the precreated job branch and reused', async t => {
  const f = await fixture(t), values = new Map(), host: any = { workflow: { id: 'wf_one', tenant: 't' }, payer: () => 'a', storage: { get: async (k: string) => values.get(k), put: async (k: string,v: any) => values.set(k,v) } };
  const jobs: any = new WorkflowJobs(f.env, host);
  const args = { files: { 'hello.txt': 'hello' }, command: 'cat hello.txt', timeoutSeconds: 30, commit: true };
  const { spec } = await jobs.jobSpec('inline', args);
  assert.equal(spec.files, undefined); assert.equal(spec.repo.ref, 'job/inline');
  assert.equal(spec.repo.owner, 'workflow:wf_one');
  const ctx = await repoContext(f.env, 't', spec.repo.repo), head = await ctx.repo.ref('job/inline');
  assert.ok(head); assert.equal((await statPaths(ctx, head.tree, ['hello.txt']))['hello.txt']?.size, 5);
  await assert.rejects(prepareRepo(), err('needs_k5'));
  assert.deepEqual((await jobs.jobSpec('inline', args)).spec.repo, spec.repo);
});

test('an inline job branch surfaces a missing base ref', async t => {
  const f = await fixture(t), ctx = await f.create({ key: 'workflow:wf_one' });
  const main = await ctx.repo.ref('main'); assert.ok(main);
  await ctx.repo.deleteRef('main', main.version);
  await assert.rejects(branch(ctx, { name: 'job/missing-main', from: 'main' }), err('ref_not_found'));
  assert.equal(await ctx.repo.ref('main'), null);
  assert.equal(await ctx.repo.ref('job/missing-main'), null);
});
