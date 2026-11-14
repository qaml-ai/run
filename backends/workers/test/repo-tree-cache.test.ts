import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { listFiles, statPaths, versionEntries } from '../src/repos/reads.ts';
import type { RepoContext } from '../src/repos/registry.ts';
import type { Entry } from '../src/repos/repo-policy.ts';
import { camelfsStorage } from '../src/repos/storage.ts';
import { RepoTreeCache } from '../src/repos/tree-cache.ts';
import { fakeCamelfsd } from './fake-camelfsd.ts';

function cacheFor(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const sql = {
    exec(query: string, ...args: (string | number)[]) {
      if (!args.length && query.trimStart().startsWith('CREATE TABLE')) {
        db.exec(query);
        return { toArray: () => [] };
      }
      const statement = db.prepare(query);
      if (statement.columns().length) {
        const rows = statement.all(...args).map(row => ({ ...row }));
        return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
      }
      statement.run(...args);
      return { toArray: () => [] };
    },
  } as unknown as SqlStorage;
  const cache = new RepoTreeCache({
    sql,
    transactionSync<T>(fn: () => T) {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  });
  return { cache, db };
}

const entry = (path: string, blob = 'b'.repeat(40), size = 1, mode: Entry['mode'] = '100644'): Entry => ({ path, blob, size, mode });

async function fixture() {
  const token = 'test-storage-token', fake = fakeCamelfsd(token);
  const storage = camelfsStorage({
    CAMELFS_API_TOKEN: token,
    CAMELFS: { fetch: (url, init) => fake.fetch(new Request(url, init)) },
  });
  const lineage = 'tenant:repo';
  const seed = await storage.putBlob(lineage, new Uint8Array([1]));
  const updated = await storage.putBlob(lineage, new Uint8Array([2, 3]));
  const fields = { author: 'agent:caller', message: 'test', trailers: {} };
  const first = await storage.commit(lineage, { ...fields, parents: [], changes: [
    { path: 'notes/edit', blob: seed.blob }, { path: 'gone', blob: seed.blob }, { path: 'same', blob: seed.blob },
  ] });
  const next = await storage.commit(lineage, { ...fields, parents: [first.commit], changes: [
    { path: 'notes/edit', blob: updated.blob, mode: '100755' },
    { path: 'new', blob: seed.blob },
    { path: 'gone', delete: true },
  ] });
  return { ctx: { storage, lineage } as RepoContext, fake, seed, updated,
    first: { version: first.commit, tree: first.tree }, next: { version: next.commit, tree: next.tree } };
}

test('the first full list fills SQLite, and an own write derives exactly the tier tree', async t => {
  const { cache } = cacheFor(t), { ctx, fake, first, next, seed, updated } = await fixture();
  cache.observe('main', first);
  const initialCalls = fake.calls.length;
  const entries = await versionEntries(ctx, first.tree, cache);
  assert.equal(entries.length, 3);
  assert.deepEqual(fake.calls.slice(initialCalls), [`GET /v1/lineages/tenant%3Arepo/trees/${first.tree}?recursive=1`]);

  const pin = cache.scope();
  pin.pin(first.tree);
  await cache.write('main', async () => ({ previous: first.version, ...next, files: {
    'notes/edit': entry('notes/edit', updated.blob, 2, '100755'), new: entry('new', seed.blob), gone: null,
  } }));
  assert.equal(cache.complete(first.tree), true);
  pin.close();
  assert.equal(cache.complete(first.tree), false);
  const expected = await versionEntries(ctx, next.tree);
  const before = fake.calls.length;
  assert.deepEqual(await versionEntries(ctx, next.tree, cache), expected);
  assert.deepEqual(await listFiles(ctx, next.tree, { path: 'notes', limit: 1 }, cache), { entries: [expected[1]], next: null });
  assert.deepEqual(await statPaths(ctx, next.tree, ['new', 'gone'], cache), { new: expected[0], gone: null });
  assert.deepEqual(fake.calls.slice(before), []);
});

test('a foreign move only changes reachability, and an incomplete tree falls through', async t => {
  const { cache, db } = cacheFor(t), { ctx, fake, first, next } = await fixture();
  cache.observe('main', first);
  await versionEntries(ctx, first.tree, cache);
  cache.notify('main', first.version, next);
  assert.equal(cache.complete(first.tree), false);
  assert.equal(cache.complete(next.tree), false);

  db.prepare('INSERT INTO repo_trees VALUES (?, 0, 0)').run(next.tree);
  db.prepare("INSERT INTO repo_tree_entries VALUES (?, 'gone', 'bogus', '100644', 1)").run(next.tree);
  const before = fake.calls.length;
  assert.equal((await statPaths(ctx, next.tree, ['gone'], cache)).gone, null);
  assert.deepEqual((await listFiles(ctx, next.tree, { limit: 1 }, cache)).entries.map(e => e.path), ['new']);
  assert.equal(fake.calls.length - before, 2);
  assert.equal(cache.complete(next.tree), false);
  await versionEntries(ctx, next.tree, cache);
  assert.equal(cache.complete(next.tree), true);
  cache.observe('main', first);
  assert.equal(cache.complete(next.tree), false);
});

test('four-tree and 200,000-entry limits preserve live trees and skip oversize trees', async t => {
  const { cache, db } = cacheFor(t);
  const pin = cache.scope();
  for (const tree of ['a', 'b', 'c', 'd', 'e']) {
    pin.pin(tree);
    cache.fill(tree, [entry(tree)]);
  }
  assert.equal(cache.complete('e'), false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM repo_trees').get()!.n, 4);
  pin.close();
  assert.equal(db.prepare('SELECT count(*) AS n FROM repo_trees').get()!.n, 0);

  cache.observe('main', { tree: 'large', version: '1' });
  cache.fill('large', Array.from({ length: 200_000 }, (_, i) => entry(String(i))));
  const extra = cache.scope();
  extra.pin('extra');
  cache.fill('extra', [entry('extra')]);
  assert.equal(cache.complete('large'), true);
  assert.equal(cache.complete('extra'), false);
  extra.close();

  const warn = t.mock.method(console, 'warn', () => {});
  const oversized = { tree: 'too-large', version: '2' };
  cache.ownWrite('main', { tree: 'large', version: '1' }, '1', oversized, { new: entry('new') });
  assert.equal(cache.complete('large'), false);
  assert.equal(cache.complete('too-large'), false);
  assert.equal(cache.oversize('too-large'), true);
  const tooMany = Array<Entry>(200_001).fill(entry('any'));
  cache.fill('too-large', tooMany);
  assert.equal(warn.mock.callCount(), 1);
  const fallback = entry('fallback');
  const listTree = t.mock.fn(async () => ({ entries: [fallback] }));
  const ctx = { storage: { listTree } } as unknown as RepoContext;
  assert.deepEqual(await listFiles(ctx, 'too-large', {}, cache), { entries: [fallback], next: null });
  assert.equal(listTree.mock.callCount(), 1);
});
