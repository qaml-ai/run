import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { registerHooks } from 'node:module';
import { fakeCamelfsd } from './fake-camelfsd.ts';
import { camelfsStorage, StorageError } from '../src/repos/storage.ts';
const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers')
      return { url: 'data:text/javascript,export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} } export const waitUntil=p=>p;', shortCircuit: true };
    if (specifier.endsWith('/security-services.ts'))
      return { url: 'data:text/javascript,export const keyServices=async env=>({accounts:{billing:{storageLimit:async()=>env.limit}}});', shortCircuit: true };
    return next(specifier, context);
  } });
const { RepoDO } = await import('../src/repos/repo-do.ts');
const { TenantRepos } = await import('../src/repos/tenant-repos.ts');
const { commitChanges, setRefToVersion, branch, advanceRef } = await import('../src/repos/write.ts');
const { prepareRepo, finishJobRepo, renewJobRepo, releaseJobRepo } = await import('../src/jobs/repo.ts');
const { WorkflowJobs } = await import('../src/workflow-jobs.ts');
const { jobSpec, JobSpecError } = await import('../src/jobs/job.ts');
const { jobDriver } = await import('../src/jobs/driver.ts');
const { mergeRefs } = await import('../src/repos/merge.ts');
const { createRepo, repoContext, deleteRepo } = await import('../src/repos/registry.ts');
hooks.deregister();
const bytes = (s: string) => new TextEncoder().encode(s);
const err = (code: string) => (e: any) => { assert.equal(e.code, code); return true; };
function fixture(t: any) {
  const databases: DatabaseSync[] = [];
  function state() {
    const db = new DatabaseSync(':memory:');
    databases.push(db);
    const sql = { exec(q: string, ...args: any[]) { const stmt = db.prepare(q); const rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []); return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; }, [Symbol.iterator]: () => rows[Symbol.iterator]() }; } };
    return { storage: { sql, transactionSync(fn: any) {
          db.exec('BEGIN');
          try {
            const v = fn();
            db.exec('COMMIT');
            return v;
          }
          catch (e) {
            db.exec('ROLLBACK');
            throw e;
          }
        }, setAlarm: async () => { }, deleteAlarm: async () => { } } };
  }
  t.after(() => databases.forEach(d => d.close()));
  const repos = new Map<string, InstanceType<typeof RepoDO>>(), index = new TenantRepos(state().storage as never);
  const tenant = { registerRepo: (r: any) => index.register(r), repoRow: (id: string) => index.row(id), listRepos: (i: any) => index.list(i), markRepoDeleted: (id: string) => index.deleted(id), repoUsage: (id: string, b: number, f: number) => index.usage(id, b, f), reposUsed: () => index.used() };
  const fake = fakeCamelfsd('test-token');
  const env: any = { CAMELFS: { fetch: (input: any, init: any) => fake.fetch(input instanceof Request ? input : new Request(input, init)) }, CAMELFS_API_TOKEN: 'test-token', TENANTS: { getByName: () => tenant }, REPOS: { getByName: (id: string) => {
        if (!repos.has(id)) repos.set(id, new RepoDO(state() as never, {}));
        return repos.get(id);
      } } };
  const create = async (input = {}) => { const { info } = await createRepo(env, 't', input); return repoContext(env, 't', info.id); };
  const write = (ctx: any, changes: any, extra = {}) => commitChanges(ctx, { ref: 'main', changes, message: 'test', author: 'api:t', who: 'api:t', why: 'test', ...extra });
  return { env, fake, create, write, index };
}

const measure = async (_: string, run: () => Promise<any>) => run();
const input = (repo: string): any => ({ id: 'attempt', command: 'true', timeoutSeconds: 30, payer: { tenant: 't', agent: 'a' }, repo: { tenant: 't', repo, owner: 'workflow:w' }, commit: true });
const output = (commit: string, tree: string): any => ({ ok: true, camelfs: { commit, tree, root: 'a'.repeat(64), warm: true, mountMs: 1, applyMs: 1 } });
test('repo job resolves, branches, leases, advances with root and releases', async t => {
  const f = fixture(t), ctx = await f.create(), spec = input(ctx.repoId), events: string[] = [];
  const saved = await prepareRepo(ctx, spec, 'h', async (name, run) => { events.push(name); return run(); });
  assert.deepEqual(events, ['resolveMs', 'branchMs', 'leaseMs']);
  assert.equal((await ctx.stub.ref('job/attempt'))?.owner, 'workflow:w');
  assert.deepEqual(saved.fence, { holder: 'host:h/attempt', epoch: 1 });
  const c = await ctx.storage.commit(ctx.lineage, { parents: [saved.expect], changes: [], message: 'checkpoint', author: 'job:attempt', trailers: {} });
  const result = output(c.commit, c.tree);
  await finishJobRepo(ctx, spec, saved, result, measure);
  assert.equal(result.camelfs.ref, 'job/attempt'); assert.equal(result.camelfs.version, c.commit);
  assert.equal((await ctx.stub.ref('job/attempt'))?.root, 'a'.repeat(64));
  await releaseJobRepo(f.env, spec.id, saved);
  assert.equal((await ctx.stub.ref('job/attempt'))?.holder, null);
});
test('recovery renews the persisted fence; takeover fails visibly and preserves output', async t => {
  const f = fixture(t), ctx = await f.create(), spec = input(ctx.repoId);
  const saved = await prepareRepo(ctx, spec, 'h', measure);
  await renewJobRepo(f.env, spec.id, saved);
  assert.equal((await ctx.stub.ref('job/attempt'))?.leaseEpoch, saved.fence.epoch);
  await releaseJobRepo(f.env, spec.id, saved);
  await ctx.stub.acquire({ ref: 'job/attempt', holder: 'other', ttlMs: 600000 });
  await assert.rejects(renewJobRepo(f.env, spec.id, saved), /fenced/);
  const c = await ctx.storage.commit(ctx.lineage, { parents: [saved.expect], changes: [], message: 'checkpoint', author: 'job:attempt', trailers: {} });
  const result = { ...output(c.commit, c.tree), exitCode: 9 };
  await finishJobRepo(ctx, spec, saved, result, measure);
  assert.equal(result.exitCode, 9); assert.equal(result.camelfs.checkpointError, `cas: repo:409:fenced:{}`);
  assert.equal((await ctx.stub.ref('job/attempt'))?.version, saved.expect);
});
test('inline workflow files are committed on the precreated job branch and reused', async t => {
  const f = fixture(t), values = new Map(), host: any = { workflow: { id: 'wf_one', tenant: 't' }, payer: () => 'a', storage: { get: async (k: string) => values.get(k), put: async (k: string,v: any) => values.set(k,v) } };
  const jobs: any = new WorkflowJobs(f.env, host);
  const args = { files: { 'hello.txt': 'hello' }, command: 'cat hello.txt', timeoutSeconds: 30, commit: true };
  const { spec } = await jobs.jobSpec('inline', args);
  assert.equal(spec.files, undefined); assert.equal(spec.repo.ref, 'job/inline');
  assert.equal(spec.repo.owner, 'workflow:wf_one');
  const ctx = await repoContext(f.env, 't', spec.repo.repo), head = await ctx.stub.ref('job/inline');
  assert.ok(head); assert.equal((await ctx.stub.stat('job/inline', ['hello.txt'])).entries['hello.txt']?.size, 5);
  const saved = await prepareRepo(ctx, spec, 'h', measure);
  assert.equal(saved.expect, head.version);
  assert.deepEqual((await jobs.jobSpec('inline', args)).spec.repo, spec.repo);
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
  const f = fixture(t), ctx = await f.create(), spec = input(ctx.repoId);
  const saved = await prepareRepo(ctx, spec, 'h', measure);
  const c = await ctx.storage.commit(ctx.lineage, { parents: [saved.expect], changes: [], message: 'checkpoint', author: 'job:attempt', trailers: {} });
  const result = output(c.commit, c.tree);
  await finishJobRepo(ctx, spec, { ...saved, expect: '0'.repeat(40) }, result, measure);
  assert.match(result.camelfs.checkpointError, /^cas: .*stale/);
  assert.ok(result.camelfs.checkpointError.length <= 300);
  assert.equal(result.camelfs.version, undefined);
  assert.equal((await ctx.stub.ref('job/attempt'))?.version, saved.expect);
});

test('inline workflow files surface a missing main instead of creating it', async t => {
  const f = fixture(t), ctx = await f.create({ key: 'workflow:wf_one' });
  const main = await ctx.stub.ref('main'); assert.ok(main);
  await ctx.stub.deleteRef('main', main.version);
  const host: any = { workflow: { id: 'wf_one', tenant: 't' }, payer: () => 'a', storage: { get: async () => undefined, put: async () => assert.fail('failed preparation must not be recorded') } };
  const jobs: any = new WorkflowJobs(f.env, host);
  await assert.rejects(jobs.jobSpec('missing-main', { files: { 'hello.txt': 'hello' }, command: 'true', timeoutSeconds: 30 }), err('no-ref'));
  assert.equal(await ctx.stub.ref('main'), null);
  assert.equal(await ctx.stub.ref('job/missing-main'), null);
});
