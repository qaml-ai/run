import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Delegation, type DelegatedChild, type DelegationHost } from '../src/delegation.ts';
import { withSql, submitViaFetch } from './sql-storage.ts';

// The parent Durable Object can be evicted or redeployed after a child's start
// request left and before the parent recorded it as accepted. Pi replays the
// tool call with the same call id: the replay must reach the child as the same
// request (same id, same input) so the child's admission dedupes it, and the
// parent must not mark a child that is running as failed.

type Body = { id: string; method: string; params: Record<string, unknown> };

function world(budget: { usd: number | undefined }) {
  const values = new Map<string, unknown>();
  let transaction = Promise.resolve<unknown>(undefined);
  const storage = {
    get: async (key: string) => structuredClone(values.get(key)),
    put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); },
    delete: async (key: string) => values.delete(key),
    list: async ({ prefix }: { prefix: string }) => new Map([...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)])),
    transaction: (run: (tx: unknown) => unknown) => {
      const pending = transaction.then(() => run(storage));
      transaction = pending.catch(() => {});
      return pending;
    },
  };
  withSql(storage);
  // The children's side: request admission keyed by request id, 409 on a reused id with other input.
  const admitted = new Map<string, string>(), starts: Body[] = [], conflicts: Body[] = [];
  const created = new Set<string>(), tasks: Promise<unknown>[] = [];
  let crashing = false;
  const host = (): DelegationHost => { const made: DelegationHost = {
    storage: storage as unknown as DurableObjectStorage, secret: 'test-only-delegation-secret',
    context: async () => ({ id: 'parent', config: { model: 'test/echo', delegate: { instructions: true, maxDepth: 2, maxParallel: 2 } }, run: { id: 'parent-run' } }),
    remainingBudget: async () => budget.usd,
    // Directory ids are derived from the key, as Directory.upsert does.
    create: async (_config, key) => { created.add(key); return { id: `agent-${key}` }; },
    target: async () => { throw new Error('unexpected target'); },
    fetch: async (id, request) => {
      const url = new URL(request.url);
      if (url.pathname === '/events') {
        const socket = Object.assign(new EventTarget(), { accept() { queueMicrotask(() => socket.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify({ event: 'ready', data: {} }) }))); }, close() {} });
        return { status: 101, webSocket: socket } as unknown as Response;
      }
      if (request.method === 'POST') {
        const body = await request.json() as Body, key = `${id}:${body.id}`, fingerprint = JSON.stringify(body);
        const old = admitted.get(key);
        if (old !== undefined && old !== fingerprint) { conflicts.push(body); return Response.json({ error: 'Request id reused with different input' }, { status: 409 }); }
        if (old === undefined) { admitted.set(key, fingerprint); starts.push(body); }
        // The parent is evicted right after the child admitted its start: nothing after this runs.
        if (crashing) return new Promise<Response>(() => {});
        return Response.json({ state: 'running' });
      }
      // The child's answer, once the parent follows it.
      return Response.json({ state: 'completed', status: 'completed', outcome: { result: { reply: 'helped' } } });
    },
    emit: async () => {}, waitUntil: promise => { tasks.push(promise); },
    submitChild: (...args) => submitViaFetch(made)(...args),
  }; return made; };
  return { host, values, starts, conflicts, created, tasks, crash: (value: boolean) => { crashing = value; } };
}

async function startedOnce(w: ReturnType<typeof world>) {
  for (let i = 0; i < 200 && w.starts.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(w.starts.length, 1, 'the child admitted the first start');
}

for (const [label, background, callId] of [
  ['delegate', false, 'call-1'],
  ['code mode delegate', false, 'codemode-call/c3'],
  ['background spawn', true, 'spawn-call'],
] as const) {
  for (const drift of [false, true]) test(`${label}: a parent restarted between the child's start and its record starts the child once${drift ? ' when its budget moved meanwhile' : ''}`, { timeout: 10_000 }, async () => {
    const budget = { usd: 0.2 as number | undefined };
    const w = world(budget);
    w.crash(true);
    void new Delegation(w.host()).start({ instructions: 'helper', task: 'help' }, callId, new AbortController().signal, background);
    await startedOnce(w);
    const stored = [...w.values.entries()].find(([key]) => key.startsWith('delegation:'))![1] as DelegatedChild;
    assert.equal(stored.accepted, undefined, 'the parent died before recording the start');

    // The restarted parent replays the same tool call. Its budget may have moved meanwhile
    // (its own or a sibling's spending); the child it already started must not see a different request.
    if (drift) budget.usd = 0.12;
    w.tasks.length = 0; // the evicted parent's work went with it
    w.crash(false);
    const replayed = await new Delegation(w.host()).start({ instructions: 'helper', task: 'help' }, callId, new AbortController().signal, background);

    assert.equal(w.starts.length, 1, 'the child started exactly once');
    assert.deepEqual(w.conflicts, [], 'the replay reached the child as the same request');
    assert.equal(w.created.size, 1, 'one child agent');
    assert.equal(replayed.id, stored.id);
    assert.equal(replayed.requestId, stored.requestId);
    assert.equal(replayed.status, 'running');
    assert.equal(replayed.accepted, true);
    assert.equal(replayed.held, stored.held, 'the replay keeps the reservation it made');
    await Promise.all(w.tasks);
  });
}
