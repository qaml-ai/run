import test from 'node:test';
import assert from 'node:assert/strict';
import { Delegation, type DelegatedChild, type DelegationHost } from '../src/delegation.ts';

function fixture() {
  const values = new Map<string, unknown>();
  const storage = {
    async get(key: string) { return structuredClone(values.get(key)); },
    async put(key: string, value: unknown) { values.set(key, structuredClone(value)); },
    async list({ prefix }: { prefix: string }) { return new Map([...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)])); },
    async transaction<T>(work: (tx: unknown) => Promise<T>) { return work(storage); },
  } as unknown as DurableObjectStorage;
  const delegation = new Delegation({ storage } as DelegationHost);
  const child: DelegatedChild = { id: 'child', key: 'child', requestId: 'spawn_child', parentRequestId: 'spawn', toolCallId: 'call', task: 'help', name: 'helper', depth: 1, background: true, made: true, createdAt: 1, status: 'completed', spent: 0.15 };
  return { storage, delegation, child };
}

test('a background child is charged only when its notice lands, once, to that notice turn', async () => {
  const { storage, delegation, child } = fixture();
  await storage.put('delegation:child', child);
  assert.equal(await delegation.costSince(0), 0);
  await delegation.landNotice('child_spawn_child', 0.15);
  await delegation.landNotice('child_spawn_child', 0.15);
  assert.equal(await delegation.cost('spawn'), 0);
  assert.equal(await delegation.cost('child_spawn_child'), 0.15);
  assert.equal(await delegation.costSince(0), 0.15);
});

test('recovered settlement keeps prior charges and can settle a deliberately reopened child', async () => {
  const { storage, delegation, child } = fixture();
  await storage.transaction(tx => delegation.settleInTransaction(tx, { ...child, background: false }, 'parent'));
  const saved = (await storage.get<DelegatedChild>('delegation:child'))!;
  await storage.transaction(tx => delegation.settleInTransaction(tx, saved, 'parent'));
  assert.equal(await delegation.cost('parent'), 0.15);
  await storage.transaction(tx => delegation.settleInTransaction(tx, { ...saved, charged: undefined }, 'parent'));
  assert.equal(await delegation.cost('parent'), 0.30);
});
