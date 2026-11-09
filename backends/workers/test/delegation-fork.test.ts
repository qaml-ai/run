import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Delegation, type ChildComputerFork, type DelegatedChild, type DelegationHost } from '../src/delegation.ts';

// computer: "fork": the parent's snapshot is taken while the child is made (both take seconds on Cloudflare), and a
// fork that cannot be taken still fails the call with nothing kept.

function world(fork: () => Promise<ChildComputerFork>, options: { definition?: Record<string, unknown> } = {}) {
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
  const order: string[] = [], removed: string[] = [], inherited: unknown[] = [], created: Record<string, any>[] = [];
  const host: DelegationHost = {
    storage: storage as unknown as DurableObjectStorage, secret: 'test-only-delegation-secret',
    context: async () => ({ id: 'parent', config: { model: 'test/echo', computer: { hosts: ['example.com'] }, delegate: { instructions: true, agents: [{ name: 'worker', definition: 'worker' }], maxDepth: 2, maxParallel: 2 } }, run: { id: 'parent-run' } }),
    create: async (config, key) => { created.push(config as Record<string, any>); order.push('create'); return { id: `agent-${key}` }; },
    remove: async id => { removed.push(id); },
    target: async () => { if (!options.definition) throw new Error('unexpected target'); return { config: options.definition as never }; },
    forkComputer: async () => { order.push('fork started'); const value = await fork(); order.push('fork taken'); return value; },
    inheritComputer: async (_parent, _child, computer) => { inherited.push(computer); },
    fetch: async (_id, request) => {
      const url = new URL(request.url);
      if (url.pathname === '/events') {
        const socket = Object.assign(new EventTarget(), { accept() { queueMicrotask(() => socket.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify({ event: 'ready', data: {} }) }))); }, close() {} });
        return { status: 101, webSocket: socket } as unknown as Response;
      }
      if (request.method === 'POST') return Response.json({ state: 'running' });
      return new Promise<Response>(() => {});
    },
    emit: async () => {}, waitUntil: () => {},
  };
  return { host, values, order, removed, inherited, created };
}
const snapshot = { native: { snapshot: { id: 'snap', name: 'fork-x', size: 1, image: 'img', createdAt: 1, expiresAt: Date.now() + 86_400_000 }, origin: { parent: 'p', agent: 'parent', batch: 'b', at: 1 } } };

test('a fork is taken while the child is made, and the child starts from it', async () => {
  let take!: (value: ChildComputerFork) => void;
  const w = world(() => new Promise(resolve => { take = resolve; }));
  const started = new Delegation(w.host).start({ instructions: 'helper', task: 'help', computer: 'fork' }, 'spawn-call', new AbortController().signal, true);
  for (let i = 0; i < 200 && !w.order.includes('create'); i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.deepEqual(w.order, ['fork started', 'create'], 'the child is made before the snapshot is done');
  take(snapshot);
  const child = await started;
  assert.equal(child.status, 'running');
  assert.ok(child.id);
  assert.deepEqual(w.inherited, [snapshot]);
});

test('a fork that cannot be taken fails the call, and the child made meanwhile is deleted', async () => {
  const w = world(async () => { throw Object.assign(new Error('nothing to fork'), { status: 409, code: 'NO_SESSION' }); });
  await assert.rejects(new Delegation(w.host).start({ instructions: 'helper', task: 'help', computer: 'fork' }, 'spawn-call', new AbortController().signal, true), /nothing to fork/);
  assert.equal(w.removed.length, 1);
  const [stored] = [...w.values.values()].filter(value => (value as DelegatedChild).key) as DelegatedChild[];
  assert.equal(stored.status, 'failed');
  assert.equal(stored.id, '', 'the record names no child');
  assert.deepEqual(w.inherited, []);
});

// A sub-agent gets no computer unless asked; a definition that declares its own computer keeps it.
const start = (w: ReturnType<typeof world>, args: Record<string, unknown>) => new Delegation(w.host).start({ task: 'help', ...args }, 'spawn-call', new AbortController().signal, true);

test('left out, an instructions child shares its parent computer', async () => {
  const w = world(async () => snapshot);
  await start(w, { instructions: 'helper' });
  assert.equal(w.created.length, 1);
  assert.deepEqual(w.created[0].computer, { hosts: ['example.com'] });
  assert.deepEqual(w.inherited, ['share']);
});

test('left out, a definition without computer settings shares', async () => {
  const w = world(async () => snapshot, { definition: { model: 'test/echo', systemPrompt: 'worker' } });
  await start(w, { agent: 'worker' });
  assert.equal('computer' in w.created[0], false);
  assert.deepEqual(w.inherited, ['share']);
});

test('left out, a definition that declares a computer keeps it', async () => {
  const declared = { hosts: ['declared.example'] };
  const w = world(async () => snapshot, { definition: { model: 'test/echo', systemPrompt: 'worker', computer: declared } });
  await start(w, { agent: 'worker' });
  assert.deepEqual(w.created[0].computer, declared);
  assert.deepEqual(w.inherited, [undefined]);
});

test('an explicit fresh gives an instructions child the parent\'s computer settings; an explicit none removes a definition\'s', async () => {
  const fresh = world(async () => snapshot);
  await start(fresh, { instructions: 'helper', computer: 'fresh' });
  assert.deepEqual(fresh.created[0].computer, { hosts: ['example.com'] });
  assert.deepEqual(fresh.inherited, [undefined]);
  const none = world(async () => snapshot, { definition: { model: 'test/echo', systemPrompt: 'worker', computer: { hosts: ['declared.example'] } } });
  await start(none, { agent: 'worker', computer: 'none' });
  assert.equal('computer' in none.created[0], false);
  assert.deepEqual(none.inherited, ['none']);
});
