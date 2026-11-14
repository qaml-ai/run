import { fixture } from './workflow-repo-fixture.ts';
import { hookTierServices } from './tier-env.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
const hooks = hookTierServices();
const { StorageError } = await import('../src/repos/storage.ts');
const { repoHistory } = await import('../src/repos/history.ts');
const { statPaths, versionEntries } = await import('../src/repos/reads.ts');
const { commitChanges, setRefToVersion, branch } = await import('../src/repos/write.ts');
const { mergeRefs } = await import('../src/repos/merge.ts');
const { agentRepo, createRepo, repoContext, deleteRepo } = await import('../src/repos/registry.ts');
const { handleRepoRequest } = await import('../src/repos/routes.ts');
hooks.deregister();
const bytes = (s: string) => new TextEncoder().encode(s);
const err = (code: string) => (e: any) => { assert.equal(e.code, code); return true; };
test('first and delta commits use daemon ids, blob authorization, path expectations and quota', async (t) => {
  const { create, write, fake, env } = await fixture(t), ctx = await create();
  const a = await write(ctx, { a: { bytes: bytes('hello') } });
  assert.equal((await ctx.storage.getCommit(ctx.lineage, a.version)).tree, a.tree);
  const b = await write(ctx, { b: { bytes: bytes('world') }, a: { mode: '100755' } });
  assert.deepEqual((await ctx.repo.commit(b.version!))!.parents, [a.version]);
  assert.equal((await ctx.repo.commit(b.version!))!.trailers['Camel-Op'], 'api');
  await assert.rejects(write(ctx, { a: { bytes: bytes('no') } }, { pathExpect: { a: 'none' } }), err('stale'));
  await assert.rejects(write(ctx, { a: { blob: 'a'.repeat(40) } }), err('unknown_blob'));
  env.limit = 0;
  await assert.rejects(write(ctx, { c: { bytes: bytes('quota') } }), err('storage_limit'));
});
test('fork shares lineage; cross-lineage copies PUT bytes; keyed lifecycle and tenant index', async (t) => {
  const { create, write, env, fake, index } = await fixture(t), src = await create({ key: 'src' } as any), a = await write(src, { a: { bytes: bytes('source') } });
  const fork = await create({ from: { repo: src.repoId } } as any);
  assert.equal(fork.lineage, src.lineage);
  const puts = () => fake.calls.filter(c => c.startsWith('PUT ') && c.endsWith('/blobs')).length;
  const before = puts();
  await write(fork, { copy: { from: { repo: src.repoId, path: 'a' } } });
  assert.equal(puts(), before);
  const dest = await create();
  await write(dest, { copy: { from: { repo: src.repoId, path: 'a', version: a.version } } });
  assert.equal(puts(), before + 1);
  assert.equal((await createRepo(env, 't', { key: 'src' })).existing, true);
  assert.equal(index.list().repos.length, 3);
  await deleteRepo(env, 't', src.repoId);
  await assert.rejects(createRepo(env, 't', { key: 'src' }), err('deleted_key'));
  assert.equal(index.list().repos.length, 2);
});
test('openBlob streams response, preserves ranges and maps fake authorization errors', async (t) => {
  const { create, write } = await fixture(t), ctx = await create(), v = await write(ctx, { a: { bytes: bytes('abcdef') } }), e = v.files.a!;
  const r = await ctx.storage.openBlob(ctx.lineage, e.blob, v.tree!, 'a', 'bytes=1-3');
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 1-3/6');
  assert.equal(await r.text(), 'bcd');
  await assert.rejects(ctx.storage.openBlob(ctx.lineage, e.blob, v.tree!, 'missing'), e => e instanceof StorageError && e.status === 404);
});
test('restore creates a commit and branches can start at an old version', async (t) => {
  const { create, write } = await fixture(t), ctx = await create(), a = await write(ctx, { a: { bytes: bytes('one') } });
  const b = await write(ctx, { a: { bytes: bytes('two') } });
  await branch(ctx, { name: 'old', from: { version: a.version! } });
  assert.equal((await ctx.repo.ref('old'))!.version, a.version);
  const r = await setRefToVersion(ctx, { ref: 'main', version: a.version!, newCommit: true, author: 'api:t' });
  assert.notEqual(r.version, a.version);
  assert.deepEqual((await ctx.repo.commit(r.version))?.parents, [b.version]);
  assert.equal((await ctx.repo.commit(r.version))?.trailers['Camel-Op'], 'restore');
  assert.equal((await statPaths(ctx, (await ctx.repo.ref('main'))!.tree, ['a'])).a!.blob, a.files.a!.blob);

});
test('merge clean, conflicts, ff, squash and already merged', async (t) => {
  const { create, write } = await fixture(t), ctx = await create();
  await write(ctx, { a: { bytes: bytes('base\n') } });
  await branch(ctx, { name: 'topic', from: 'main' });
  await write(ctx, { b: { bytes: bytes('topic') } }, { ref: 'topic' });
  const theirs = await write(ctx, { b: { bytes: bytes('topic tip') } }, { ref: 'topic' });
  const ff = await mergeRefs(ctx, { into: 'main', from: 'topic', mode: 'ff' });
  assert.equal(ff.version, theirs.version);
  assert.equal((await mergeRefs(ctx, { into: 'main', from: 'topic' })).changed, false);
  const ours = await write(ctx, { c: { bytes: bytes('ours') } });
  const topic = await write(ctx, { d: { bytes: bytes('theirs') } }, { ref: 'topic' });
  await assert.rejects(mergeRefs(ctx, { into: 'main', from: 'topic', mode: 'ff' }), err('not_fast_forward'));
  const merged = await mergeRefs(ctx, { into: 'main', from: 'topic' });
  assert.deepEqual((await ctx.repo.commit(merged.version!))!.parents, [ours.version, topic.version]);
  assert.equal((await ctx.repo.commit(merged.version!))!.trailers['Camel-Op'], 'merge');
  await write(ctx, { a: { bytes: bytes('ours\n') } });
  await write(ctx, { a: { bytes: bytes('theirs\n') } }, { ref: 'topic' });
  await assert.rejects(mergeRefs(ctx, { into: 'main', from: 'topic' }), err('conflict'));
  await assert.rejects(mergeRefs(ctx, { into: 'main', from: 'topic', mode: 'ff' }), err('not_fast_forward'));
  const clean = await create();
  await write(clean, { a: { bytes: bytes('base') } });
  await branch(clean, { name: 'topic', from: 'main' });
  await write(clean, { b: { bytes: bytes('topic') } }, { ref: 'topic' });
  const squashed = await mergeRefs(clean, { into: 'main', from: 'topic', mode: 'squash' });
  assert.equal((await clean.repo.commit(squashed.version!))!.parents.length, 1);
});
test('the tier retries a keyed write without reuploading a large blob', async t => {
  let beforeMove: (() => Promise<void>) | undefined;
  const { create, write, fake } = await fixture(t, { beforeWriteMove: async () => {
    const run = beforeMove;
    beforeMove = undefined;
    await run?.();
  } });
  const ctx = await create();
  beforeMove = async () => { await write(ctx, { other: { bytes: bytes('winner') } }); };
  const result = await write(ctx, { large: { bytes: new Uint8Array(8 * 1024 * 1024 + 1) } }, { idempotencyKey: 'large' });
  const head = (await ctx.repo.ref('main'))!;
  assert.equal(head.version, result.version);
  const entries = await statPaths(ctx, head.tree, ['other', 'large']);
  assert.equal(entries.other?.size, 6);
  assert.equal(entries.large?.size, 8 * 1024 * 1024 + 1);
  assert.equal(fake.calls.filter(c => c.endsWith('/blobs') && c.startsWith('PUT ')).length, 1);
});
test('tenant index pages equal timestamps, retains tombstones, and sums only live usage', async (t) => {
  const { index } = await fixture(t);
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
test('explicit expect rejects a stale write', async (t) => {
  const { create, write } = await fixture(t), ctx = await create(), first = await write(ctx, { a: { bytes: bytes('first') } });
  await write(ctx, { a: { bytes: bytes('second') } });
  await assert.rejects(write(ctx, { a: { bytes: bytes('stale') } }, { expect: first.version }), err('stale'));
});

test('quota does not charge mode changes or blobs already owned by another head twice', async t => {
  const { create, write, env, index } = await fixture(t), ctx = await create();
  await write(ctx, { a: { bytes: bytes('base') } });
  await branch(ctx, { name: 'topic', from: 'main' });
  const topic = await write(ctx, { b: { bytes: bytes('topic') } }, { ref: 'topic' });
  env.limit = index.used();
  await write(ctx, { a: { mode: '100755' } });
  await write(ctx, { copied: { from: { repo: ctx.repoId, ref: 'topic', path: 'b' } } });
  const merged = await mergeRefs(ctx, { into: 'main', from: 'topic' });
  assert.equal(merged.changed, true);
  assert.equal((await statPaths(ctx, (await ctx.repo.ref('main'))!.tree, ['b'])).b!.blob, topic.files.b!.blob);
});
test('every repo is born with main: an empty first commit by its creator; a second create makes no commit', async (t) => {
  const { env, fake } = await fixture(t);
  const { info } = await agentRepo(env, 't', 'ag1');
  const main = info.refs.find((r: { name: string }) => r.name === 'main')!;
  assert.equal(main.tree, '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  const ctx = await repoContext(env, 't', info.id);
  const first = (await ctx.repo.commit(main.version))!;
  assert.deepEqual([first.author, first.parents, first.message], ['agent:ag1', [], 'create']);
  assert.equal((await ctx.storage.getCommit(ctx.lineage, main.version)).trailers['Camel-Op'], 'api');
  const commits = () => fake.calls.filter(c => c.startsWith('POST ') && c.endsWith('/commits')).length;
  const before = commits();
  const again = await agentRepo(env, 't', 'ag1');
  assert.equal(again.existing, true);
  assert.equal(again.info.refs.find((r: { name: string }) => r.name === 'main')!.version, main.version);
  assert.equal(commits(), before);
  // The first write CASes against main's version like every other.
  const w = await commitChanges(ctx, { ref: 'main', op: 'api', changes: { a: { bytes: new TextEncoder().encode('x') } }, message: 'w', author: 'agent:ag1' });
  assert.equal(w.previous, main.version);
});

test('PUT refs rejects backwards and sideways moves without changing the ref, tree or history', async t => {
  const { create, write, env } = await fixture(t), ctx = await create();
  const base = await write(ctx, { a: { bytes: bytes('base') } });
  await branch(ctx, { name: 'topic', from: 'main' });
  const main = await write(ctx, { a: { bytes: bytes('main') } });
  const topic = await write(ctx, { a: { bytes: bytes('topic') } }, { ref: 'topic' });
  const state = async () => {
    const head = (await ctx.repo.ref('main'))!;
    return [head, await versionEntries(ctx, head.tree), await repoHistory(ctx, { ref: 'main' })];
  };
  const before = await state();
  for (const version of [base.version, topic.version, main.version]) {
    const request = new Request(`https://example.test/v1/repos/${ctx.repoId}/refs/main`, {
      method: 'PUT', body: JSON.stringify({ version, expect: main.version }),
    });
    const response = await handleRepoRequest(request, env, { tenantId: 't' });
    if (version === main.version) {
      assert.equal(response?.status, 200);
      assert.equal((await response!.json() as { changed: boolean }).changed, false);
    } else {
      assert.equal(response?.status, 409);
      assert.deepEqual(await response!.json(), { error: 'not_fast_forward', code: 'not_fast_forward', current: main.version });
    }
    assert.deepEqual(await state(), before);
  }
});

test('stat reads the resolved tree on both sides of the 64-path cutoff', async t => {
  const { create, write, fake } = await fixture(t), ctx = await create();
  await write(ctx, { 'dir/file': { bytes: bytes('before') } });
  const before = (await ctx.repo.ref('main'))!;
  await write(ctx, { 'dir/file': { bytes: bytes('after') } });
  const names = ['dir/file', 'dir', ...Array.from({ length: 63 }, (_, i) => `missing-${i}`)];
  for (const count of [64, 65]) {
    const offset = fake.calls.length;
    const entries = await statPaths(ctx, before.tree, names.slice(0, count));
    assert.equal(entries['dir/file']?.size, 6);
    assert.equal(entries.dir, null);
    assert.equal(entries['missing-0'], null);
    const reads = fake.calls.slice(offset);
    assert.equal(reads.length, count === 64 ? 64 : 1);
    assert.ok(reads.every(call => call.includes(`/trees/${before.tree}`)));
    assert.equal(reads.every(call => call.includes('/entry?')), count === 64);
  }
});
