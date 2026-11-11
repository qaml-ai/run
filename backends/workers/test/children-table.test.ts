import test from 'node:test';
import assert from 'node:assert/strict';
import { ChildRows } from '../src/children-table.ts';
import type { DelegatedChild } from '../src/delegation.ts';
import { withSql } from './sql-storage.ts';

function storage() {
  const values = new Map<string, unknown>();
  let lists = 0;
  const store = {
    async get(key: string) { return structuredClone(values.get(key)); },
    async put(key: string, value: unknown) { values.set(key, structuredClone(value)); },
    async list({ prefix }: { prefix: string }) { lists++; return new Map([...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)])); },
    async transaction<T>(work: (tx: unknown) => Promise<T>) { return work(store); },
  };
  withSql(store);
  return { storage: store as unknown as DurableObjectStorage, values, lists: () => lists };
}

const child = (key: string, extra: Partial<DelegatedChild> = {}): DelegatedChild => ({
  id: `client_${key}`, key, requestId: `spawn_${key}`, parentRequestId: 'run-1', toolCallId: `call_${key}`, name: key, depth: 1,
  createdAt: 1, status: 'running', made: true, background: true, ...extra,
});

test('rows written before the table (KV only) are imported once, then read by index without listing', async () => {
  const s = storage();
  s.values.set('delegation:a', child('a'));
  s.values.set('delegation:b', child('b', { status: 'completed', endedAt: 2, parentRequestId: 'run-2', createdAt: 2 }));
  // Not children: other delegation keys share the word but not the prefix.
  s.values.set('delegation-run:client_a:spawn_a', 'a');
  s.values.set('delegation-payload:a', { task: 'help' });
  const rows = new ChildRows(s.storage);
  assert.deepEqual((await rows.running()).map(row => row.key), ['a']);
  assert.deepEqual((await rows.ofRun('run-2')).map(row => row.key), ['b']);
  assert.equal((await rows.byRun('client_b', 'spawn_b'))?.key, 'b');
  assert.deepEqual((await rows.byRequest('spawn_a')).map(row => row.key), ['a']);
  assert.deepEqual((await rows.ended()).map(row => row.key), ['b']);
  assert.equal(s.lists(), 1, 'the KV rows are listed once per instance, at load');
});

test('every write keeps the KV row older code reads, and stores the owner columns', async () => {
  const s = storage(), rows = new ChildRows(s.storage);
  const written = child('c', { owner: { kind: 'agent', id: 'parent' }, rootOwner: { kind: 'agent', id: 'root' }, chain: ['root', 'parent'], maxDepth: 2 });
  await rows.put(written);
  assert.deepEqual(s.values.get('delegation:c'), written);
  const [stored] = s.storage.sql.exec<Record<string, unknown>>('SELECT owner_kind, owner_id, call_id, root_owner, chain, depth, max_depth FROM children WHERE key = ?', 'c').toArray();
  assert.deepEqual({ ...stored }, { owner_kind: 'agent', owner_id: 'parent', call_id: 'call_c', root_owner: '{"kind":"agent","id":"root"}', chain: '["root","parent"]', depth: 1, max_depth: 2 });
  // A row older code wrote has no owner: it is the agent's own (owner_id empty until the owner rewrites it).
  s.values.set('delegation:legacy', child('legacy'));
  await new ChildRows(s.storage).load();
  assert.deepEqual({ ...s.storage.sql.exec('SELECT owner_kind, owner_id FROM children WHERE key = ?', 'legacy').toArray()[0] }, { owner_kind: 'agent', owner_id: '' });
});

test('a row older code changed (a rollback, then forward again) is taken from KV at the next load', async () => {
  const s = storage(), rows = new ChildRows(s.storage);
  await rows.put(child('d'));
  // The object ran the previous version for a while: it ended the child in KV only.
  s.values.set('delegation:d', child('d', { status: 'completed', endedAt: 5 }));
  assert.equal((await rows.get('d'))?.status, 'running', 'this instance read its table already');
  const next = new ChildRows(s.storage);
  assert.equal((await next.get('d'))?.status, 'completed');
  assert.deepEqual((await next.running()).map(row => row.key), []);
});

test('a first load inside a transaction that throws is rolled back with it, and the next load imports again', async () => {
  const s = storage();
  s.values.set('delegation:a', child('a'));
  const rows = new ChildRows(s.storage);
  await assert.rejects(s.storage.transaction(async () => { await rows.load(); throw new Error('crash'); }));
  // The table and its import went with the transaction: the memo is not trusted.
  assert.deepEqual((await rows.running()).map(row => row.key), ['a']);
});
