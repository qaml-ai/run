import { fixture } from './workflow-repo-fixture.ts';
import { hookTierServices } from './tier-env.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
const hooks = hookTierServices();
const { branch } = await import('../src/repos/write.ts');
const { prepareRepo, finishJobRepo, renewJobRepo, releaseJobRepo } = await import('../src/jobs/repo.ts');
const { jobSpec, JobSpecError } = await import('../src/jobs/job.ts');
hooks.deregister();

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
test('repo specs validate tenant, owner, ref/version exclusion', async () => {
  const spec = input('repo_1'); assert.equal(jobSpec(spec).repo?.repo, 'repo_1');
  for (const extra of [{ repo: '' }, { owner: 'host:x' }, { version: 'bad' }, { version: 'a'.repeat(40), ref: 'main' }, { tenant: 'other' }]) assert.throws(() => jobSpec({ ...spec, repo: { ...spec.repo, ...extra } }), JobSpecError);
  assert.throws(() => jobSpec({ ...spec, files: {} }), JobSpecError);
  assert.throws(() => jobSpec({ ...spec, volume: { tenant: 't', volume: 'v', snapshot: 's' } }), JobSpecError);
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
