import test from 'node:test';
import assert from 'node:assert/strict';
import { Delegation, type DelegatedChild, type DelegationHost } from '../src/delegation.ts';

function fixture() {
  const values = new Map<string, unknown>();
  const payloadAccess: { key: string; noCache: boolean }[] = [];
  const storage = {
    async get(key: string, options?: { noCache?: boolean }) {
      if (key.startsWith('delegation-payload:')) payloadAccess.push({ key, noCache: options?.noCache === true });
      return structuredClone(values.get(key));
    },
    async put(key: string, value: unknown, options?: { noCache?: boolean }) {
      if (key.startsWith('delegation-payload:')) payloadAccess.push({ key, noCache: options?.noCache === true });
      values.set(key, structuredClone(value));
    },
    async list({ prefix }: { prefix: string }) { return new Map([...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)])); },
    async transaction<T>(work: (tx: unknown) => Promise<T>) { return work(storage); },
  } as unknown as DurableObjectStorage;
  const tasks: Promise<unknown>[] = [];
  const host = { storage, emit: async () => {}, waitUntil: (promise: Promise<unknown>) => { tasks.push(promise); } } as unknown as DelegationHost;
  const delegation = new Delegation(host);
  const child: DelegatedChild = { id: 'child', key: 'child', requestId: 'request', parentRequestId: 'parent', toolCallId: 'call', task: 'task'.repeat(8_000), name: 'helper', depth: 1, made: true, createdAt: 1, status: 'running', accepted: true };
  return { storage, values, payloadAccess, host, delegation, child, tasks };
}

test('completion spills payloads, keeps status small and recovers the exact result on demand', async () => {
  const f = fixture();
  await f.storage.put('delegation:child', f.child);
  await f.storage.put('delegation-run:child:request', 'child');
  const result = { reply: 'answer'.repeat(8_000), output: { value: 'output'.repeat(2_000) }, usage: { costUsd: 0.25 } };
  const event = { agentId: 'child', requestId: 'request', event: { type: 'response' }, record: { state: 'completed', status: 'completed', outcome: { result } } };
  await f.delegation.receive(event);
  await f.delegation.receive(event);
  const stored = await f.storage.get<DelegatedChild>('delegation:child');
  assert.equal(stored?.task, undefined);
  assert.equal(stored?.outcome, undefined);
  assert.ok(JSON.stringify(await f.delegation.children()).length < 1024);
  assert.ok(stored!.payloadBytes! > 80_000);
  assert.equal(await f.delegation.cost('parent'), 0.25);
  const recovered = new Delegation(f.host);
  const answer = await recovered.wait(stored!);
  assert.equal(answer.task, f.child.task);
  assert.deepEqual(answer.outcome?.result, result);
  assert.ok(f.payloadAccess.length > 0);
  assert.ok(f.payloadAccess.every(access => access.noCache));
  await Promise.all(f.tasks);
});

test('recovery upgrades old inline rows and notifications still carry their complete result', async () => {
  const f = fixture();
  const child = { ...f.child, background: true, status: 'completed', outcome: { result: { reply: 'long answer'.repeat(4_000) } } };
  await f.storage.put('delegation:child', child);
  let notice: DelegatedChild | undefined;
  f.host.notify = async value => { notice = value; };
  await f.delegation.recover();
  await Promise.all(f.tasks);
  assert.equal(notice?.task, child.task);
  assert.equal(notice?.outcome?.result?.reply, child.outcome.result.reply);
  const stored = await f.storage.get<DelegatedChild>('delegation:child');
  assert.equal(stored?.task, undefined);
  assert.equal(stored?.outcome, undefined);
  assert.equal(stored?.notified, true);
  assert.ok(f.payloadAccess.every(access => access.noCache));
});

test('a batched notification hydrates a spilled sibling that has no outbox entry yet', async () => {
  const { DelegationNotifications } = await import('../src/delegation-notifications.ts');
  const f = fixture();
  const sibling = { ...f.child, background: true, status: 'completed', task: undefined, spent: 0.25 };
  await f.storage.put('delegation:child', sibling);
  await f.storage.put('delegation-payload:child', { task: 'sibling task', outcome: { result: { reply: 'spilled sibling answer' } } });
  const sent: any[] = [];
  const notices = new DelegationNotifications({ storage: f.storage, submit: async (...args) => { sent.push(args); }, admitWake: async () => ({ allowed: true, hour: 0 }), retry: async () => {} });
  await notices.deliver({ ...sibling, id: 'other', key: 'other', requestId: 'other', task: 'other task', outcome: { result: { reply: 'other answer' } } });
  assert.equal(sent.length, 1);
  assert.match(sent[0][0].params.text, /spilled sibling answer/);
  assert.match(sent[0][0].params.text, /sibling task/);
});
