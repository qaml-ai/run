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
        if (!repos.has(id))
          repos.set(id, new RepoDO(state() as never, {}));
        return repos.get(id);
      } } };
  const create = async (input = {}) => { const { info } = await createRepo(env, 't', input); return repoContext(env, 't', info.id); };
  const write = (ctx: any, changes: any, extra = {}) => commitChanges(ctx, { ref: 'main', changes, message: 'test', author: 'api:t', who: 'api:t', why: 'test', ...extra });
  return { env, fake, create, write, index };
}
test('first and delta commits use daemon ids, blob authorization, path expectations, no-op and quota', async (t) => {
  const { create, write, fake, env } = fixture(t), ctx = await create();
  const a = await write(ctx, { a: { bytes: bytes('hello') } });
  assert.ok(fake.commits.has(a.version!));
  const b = await write(ctx, { b: { bytes: bytes('world') }, a: { mode: '100755' } });
  assert.equal((await ctx.stub.commit(b.version!))!.parents[0], a.version);
  assert.equal((await write(ctx, { a: { mode: '100755' } })).changed, false);
  await assert.rejects(write(ctx, { a: { bytes: bytes('no') } }, { pathExpect: { a: 'none' } }), err('stale-path'));
  await assert.rejects(write(ctx, { a: { blob: 'a'.repeat(40) } }), err('unknown-blob'));
  env.limit = 0;
  await assert.rejects(write(ctx, { c: { bytes: bytes('quota') } }), err('storage-limit'));
});
test('fork shares lineage; cross-lineage copies PUT bytes; keyed lifecycle and tenant index', async (t) => {
  const { create, write, env, fake, index } = fixture(t), src = await create({ key: 'src' } as any), a = await write(src, { a: { bytes: bytes('source') } });
  const fork = await create({ from: { repo: src.repoId } } as any);
  assert.equal(fork.lineage, src.lineage);
  const puts = () => fake.calls.filter(c => c.startsWith('PUT ')).length;
  const before = puts();
  await write(fork, { copy: { from: { repo: src.repoId, path: 'a' } } });
  assert.equal(puts(), before);
  const dest = await create();
  await write(dest, { copy: { from: { repo: src.repoId, path: 'a', version: a.version } } });
  assert.equal(puts(), before + 1);
  assert.equal((await createRepo(env, 't', { key: 'src' })).existing, true);
  assert.equal(index.list().repos.length, 3);
  await deleteRepo(env, 't', src.repoId);
  await assert.rejects(createRepo(env, 't', { key: 'src' }), err('deleted-key'));
  assert.equal(index.list().repos.length, 2);
});
test('openBlob streams response, preserves ranges and maps fake authorization errors', async (t) => {
  const { create, write } = fixture(t), ctx = await create(), v = await write(ctx, { a: { bytes: bytes('abcdef') } }), e = v.files.a!;
  const r = await ctx.storage.openBlob(ctx.lineage, e.blob, v.tree!, 'a', 'bytes=1-3');
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 1-3/6');
  assert.equal(await r.text(), 'bcd');
  await assert.rejects(ctx.storage.openBlob(ctx.lineage, e.blob, v.tree!, 'missing'), e => e instanceof StorageError && e.status === 404);
});
test('restore creates a commit; branch fallback loads old trees; advanceRef uses daemon metadata and diff', async (t) => {
  const { create, write } = fixture(t), ctx = await create(), a = await write(ctx, { a: { bytes: bytes('one') } });
  await write(ctx, { a: { bytes: bytes('two') } });
  await branch(ctx, { name: 'old', from: { version: a.version! }, who: 'api:t' });
  assert.equal((await ctx.stub.ref('old'))!.version, a.version);
  const r = await setRefToVersion(ctx, { ref: 'main', version: a.version!, newCommit: true, author: 'api:t', who: 'api:t', why: 'restore' });
  assert.notEqual(r.version, a.version);
  assert.equal((await ctx.stub.stat('main', ['a'])).entries.a!.blob, a.files.a!.blob);
  const blob = await ctx.storage.putBlob(ctx.lineage, bytes('checkpoint'));
  const commit = await ctx.storage.commit(ctx.lineage, { parents: [r.version], changes: [{ path: 'cp', blob: blob.blob, mode: '100644' }], author: 'api:t', message: 'checkpoint', trailers: {} });
  const advanced = await advanceRef(ctx, { ref: 'main', expect: r.version, commit: commit.commit, who: 'api:t', why: 'checkpoint' });
  assert.equal(advanced.files.cp!.size, 10);
  assert.equal((await ctx.storage.diff(ctx.lineage, a.tree!, commit.tree)).changes.length, 1);
});
test('merge clean, conflicts, ff, squash and already merged', async (t) => {
  const { create, write } = fixture(t), ctx = await create();
  await write(ctx, { a: { bytes: bytes('base\n') } });
  await branch(ctx, { name: 'topic', from: 'main', who: 'api:t' });
  const theirs = await write(ctx, { b: { bytes: bytes('topic') } }, { ref: 'topic' });
  const ff = await mergeRefs(ctx, { into: 'main', from: 'topic', mode: 'ff' });
  assert.equal(ff.version, theirs.version);
  assert.equal((await mergeRefs(ctx, { into: 'main', from: 'topic' })).changed, false);
  await write(ctx, { c: { bytes: bytes('ours') } });
  await assert.rejects(mergeRefs(ctx, { into: 'main', from: 'topic', mode: 'ff' }), err('not-fast-forward'));
  await write(ctx, { d: { bytes: bytes('theirs') } }, { ref: 'topic' });
  const merged = await mergeRefs(ctx, { into: 'main', from: 'topic' });
  assert.equal((await ctx.stub.commit(merged.version!))!.parents.length, 2);
  await write(ctx, { a: { bytes: bytes('ours\n') } });
  await write(ctx, { a: { bytes: bytes('theirs\n') } }, { ref: 'topic' });
  await assert.rejects(mergeRefs(ctx, { into: 'main', from: 'topic' }), err('conflicts'));
  await assert.rejects(mergeRefs(ctx, { into: 'main', from: 'topic', mode: 'ff' }), err('not-fast-forward'));
  const clean = await create();
  await write(clean, { a: { bytes: bytes('base') } });
  await branch(clean, { name: 'topic', from: 'main', who: 'api:t' });
  await write(clean, { b: { bytes: bytes('topic') } }, { ref: 'topic' });
  const squashed = await mergeRefs(clean, { into: 'main', from: 'topic', mode: 'squash' });
  assert.equal((await clean.stub.commit(squashed.version!))!.parents.length, 1);
});
test('commitChanges retries a concurrent move without uploading blobs again', async (t) => {
  const { create, write, fake } = fixture(t), ctx = await create();
  await write(ctx, { a: { bytes: bytes('base') } });
  const original = ctx.stub.cas.bind(ctx.stub);
  let raced = false;
  (ctx.stub as any).cas = async (input: any) => {
    assert.notEqual(input.expect, undefined);
    if (!raced) {
      raced = true;
      await write(ctx, { other: { bytes: bytes('winner') } });
    }
    return original(input);
  };
  const result = await write(ctx, { a: { bytes: bytes('retry') } });
  assert.equal(result.changed, true);
  assert.ok((await ctx.stub.stat('main', ['other'])).entries.other);
  assert.equal(fake.calls.filter(c => c.startsWith('PUT ')).length, 3);
});
for (const operation of ['setRefToVersion', 'branch', 'advanceRef', 'mergeRefs'])
  test(`${operation} detects a concurrent ref move`, async (t) => {
    const { create, write } = fixture(t), ctx = await create(), a = await write(ctx, { a: { bytes: bytes('base') } });
    await branch(ctx, { name: 'topic', from: 'main', who: 'api:t' });
    await write(ctx, { a: { bytes: bytes('new') } });
    const theirs = await write(ctx, { b: { bytes: bytes('topic') } }, { ref: 'topic' });
    const current = (await ctx.stub.ref('main'))!.version;
    const original = ctx.stub.cas.bind(ctx.stub);
    let raced = false;
    (ctx.stub as any).cas = async (input: any) => {
      assert.notEqual(input.expect, undefined);
      if (!raced) {
        raced = true;
        if (operation === 'branch')
          await original({ ref: 'old', expect: null, commit: (await ctx.stub.commit(theirs.version!))!, entries: [], who: 'api:t', why: 'race' });
        else
          await write(ctx, { winner: { bytes: bytes('winner') } });
      }
      return original(input);
    };
    let promise;
    if (operation === 'setRefToVersion')
      promise = setRefToVersion(ctx, { ref: 'main', version: a.version!, expect: current, newCommit: false, author: 'api:t', who: 'api:t', why: 'test' });
    else if (operation === 'branch')
      promise = branch(ctx, { name: 'old', from: { version: a.version! }, who: 'api:t' });
    else if (operation === 'mergeRefs')
      promise = mergeRefs(ctx, { into: 'main', from: 'topic' });
    else {
      const c = await ctx.storage.commit(ctx.lineage, { parents: [current], changes: [], author: 'api:t', message: 'cp', trailers: {} });
      promise = advanceRef(ctx, { ref: 'main', expect: current, commit: c.commit, who: 'api:t', why: 'test' });
    }
    await assert.rejects(promise, err('stale'));
  });
test('tenant index pages equal timestamps, retains tombstones, and sums only live usage', async (t) => {
  const { index } = fixture(t);
  const row = (id: string) => ({ id, name: id, key: id, lineage: `t:${id}`, createdAt: 1, deletedAt: null, bytes: 0, files: 0 });
  index.register(row('b'));
  index.register(row('a'));
  index.register(row('c'));
  assert.deepEqual(index.list({ limit: 2 }).repos.map(r => r.id), ['a', 'b']);
  assert.equal(index.list({ limit: 2 }).next, 'b');
  assert.deepEqual(index.list({ after: 'b' }).repos.map(r => r.id), ['c']);
  index.usage('a', 10, 1);
  index.usage('b', 20, 2);
  assert.equal(index.used(), 30);
  index.deleted('a');
  assert.equal(index.used(), 20);
  assert.ok(index.register(row('a')).row.deletedAt);
});
test('explicit expect prevents commit retry; restore without expect retries the observed head', async (t) => {
  const { create, write } = fixture(t), ctx = await create(), first = await write(ctx, { a: { bytes: bytes('first') } });
  const second = await write(ctx, { a: { bytes: bytes('second') } });
  await assert.rejects(write(ctx, { a: { bytes: bytes('stale') } }, { expect: first.version }), err('stale'));
  const original = ctx.stub.cas.bind(ctx.stub);
  let raced = false;
  (ctx.stub as any).cas = async (input: any) => { assert.notEqual(input.expect, undefined); if (!raced) {
    raced = true;
    await write(ctx, { winner: { bytes: bytes('winner') } });
  } return original(input); };
  const restored = await setRefToVersion(ctx, { ref: 'main', version: first.version!, newCommit: true, author: 'api:t', who: 'api:t', why: 'restore' });
  assert.notEqual(restored.previous, second.version);
  assert.deepEqual((await ctx.stub.commit(restored.version))!.parents, [restored.previous]);
});

test('quota does not charge mode changes or blobs already owned by another head twice', async t => {
  const { create, write, env, index } = fixture(t), ctx = await create();
  await write(ctx, { a: { bytes: bytes('base') } });
  await branch(ctx, { name: 'topic', from: 'main', who: 'api:t' });
  const topic = await write(ctx, { b: { bytes: bytes('topic') } }, { ref: 'topic' });
  env.limit = index.used();
  await write(ctx, { a: { mode: '100755' } });
  await write(ctx, { copied: { from: { repo: ctx.repoId, ref: 'topic', path: 'b' } } });
  const merged = await mergeRefs(ctx, { into: 'main', from: 'topic' });
  assert.equal(merged.changed, true);
  assert.equal((await ctx.stub.stat('main', ['b'])).entries.b!.blob, topic.files.b!.blob);
});
