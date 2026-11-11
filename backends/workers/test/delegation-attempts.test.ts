import test from 'node:test';
import assert from 'node:assert/strict';
import { Delegation, callIdentity, type DelegationHost } from '../src/delegation.ts';
import { attemptedCall } from '../../../shared/owner.ts';
import { withSql, submitViaFetch, childAlarms } from './sql-storage.ts';

// Attempted call ids: a call's child is keyed by its run and `callId:attempt`. The same attempt finds the same child
// (a replay, a resumed turn); a new attempt of a call whose child ended makes a new child instead of returning it.

function fixture() {
  const values = new Map<string, unknown>();
  const storage = {
    async get(key: string) { return structuredClone(values.get(key)); },
    async put(key: string, value: unknown) { values.set(key, structuredClone(value)); },
    async delete(key: string) { return values.delete(key); },
    async list({ prefix }: { prefix: string }) { return new Map([...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)])); },
    async transaction(work: (tx: unknown) => unknown) { return work(storage); },
  };
  withSql(storage);
  const submitted: any[] = [];
  let made = 0;
  const host: DelegationHost = {
    storage: storage as unknown as DurableObjectStorage,
    context: async () => ({ id: 'parent', config: { model: 'test/echo', delegate: { instructions: true, maxParallel: 4 } }, run: { id: 'parent-run' } }),
    create: async () => ({ id: `child-${++made}` }), target: async () => { throw new Error('unexpected target'); },
    fetch: async (_id, request) => {
      if (request.method === 'POST') { submitted.push(await request.json()); return Response.json({ state: 'running' }); }
      return Response.json({ state: 'completed', status: 'completed', outcome: { result: { reply: `answer ${made}` } } });
    },
    submitChild: undefined as never,
    emit: async () => {}, waitUntil: () => {},
  };
  host.submitChild = submitViaFetch(host);
  const delegation = new Delegation(host);
  return { delegation, submitted, stop: childAlarms(host, delegation), storage };
}

test('attempt 1 keeps the identity a call had before attempts existed', async () => {
  assert.equal(attemptedCall('call'), 'call');
  assert.equal(attemptedCall('call', 1), 'call');
  assert.equal(attemptedCall('call', 3), 'call:3');
  assert.throws(() => attemptedCall('call', 0));
  // A child made by older code (digest of run:callId) is the same row as attempt 1's.
  const { digest } = await import('../src/api-contract.ts');
  assert.equal(await callIdentity('run', 'call'), await digest('run:call'));
  assert.notEqual(await callIdentity('run', 'call', 2), await callIdentity('run', 'call'));
});

test('the same attempt finds its child again; a new attempt of an ended call makes a new child', async t => {
  const f = fixture();
  t.after(f.stop);
  const signal = new AbortController().signal;
  const first = await f.delegation.start({ instructions: 'helper', task: 'help' }, 'call', signal);
  const ended = await f.delegation.wait(first);
  assert.equal(ended.status, 'completed');
  // Made again (a replay): the stored child, not a second start.
  assert.equal((await f.delegation.start({ instructions: 'helper', task: 'help' }, 'call', signal)).key, first.key);
  assert.equal(f.submitted.length, 1);
  const second = await f.delegation.start({ instructions: 'helper', task: 'help' }, 'call', signal, false, undefined, undefined, 2);
  assert.notEqual(second.key, first.key);
  assert.notEqual(second.id, first.id);
  assert.equal(second.attempt, 2);
  assert.equal(f.submitted.length, 2);
  assert.notEqual(f.submitted[1].id, f.submitted[0].id, 'the new attempt is a new request of a new child');
  const rows = f.storage.sql.exec<{ call_id: string; attempt: number }>('SELECT call_id, attempt FROM children ORDER BY attempt').toArray();
  assert.deepEqual(rows.map(row => [row.call_id, row.attempt]), [['call', 1], ['call', 2]]);
  await f.delegation.wait(second);
});

test('a children table an earlier version made gains the attempt column, its rows first attempts', async () => {
  const f = fixture();
  f.storage.sql.exec(`CREATE TABLE children (key TEXT PRIMARY KEY, owner_kind TEXT NOT NULL DEFAULT 'agent', owner_id TEXT NOT NULL DEFAULT '', call_id TEXT NOT NULL DEFAULT '',
    child_id TEXT NOT NULL DEFAULT '', request_id TEXT NOT NULL, parent_request_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, background INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT '', root_owner TEXT, chain TEXT, depth INTEGER, max_depth INTEGER, started INTEGER NOT NULL, ended INTEGER, cost REAL, state TEXT NOT NULL)`);
  f.storage.sql.exec(`INSERT INTO children (key, call_id, request_id, status, started, state) VALUES ('old', 'call', 'r', 'completed', 1, '{"key":"old","status":"completed"}')`);
  assert.equal((await f.delegation.rows.get('old'))?.status, 'completed');
  assert.deepEqual(f.storage.sql.exec('SELECT attempt FROM children WHERE key = ?', 'old').toArray().map(row => row.attempt), [1]);
  await f.stop();
});
