import assert from 'node:assert/strict';
import test from 'node:test';
import { ConfigurationQueue } from '../src/configuration-queue.ts';

function memoryStorage() {
  const data = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => structuredClone(data.get(key)),
    put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
    list: async ({ prefix }: { prefix: string }) => new Map([...data].filter(([key]) => key.startsWith(prefix))),
    transaction: async (run: (tx: unknown) => unknown) => run(storage),
  };
  return storage as unknown as DurableObjectStorage;
}

test('configuration request IDs distinguish patches from replacements across restart', async () => {
  for (const replacement of [false, true]) {
    const storage = memoryStorage();
    const host = {
      busy: async () => true,
      released: async () => {},
      apply: async () => {},
      failed: async () => {},
      background: (_work: Promise<void>) => {},
      wake: async () => {},
    };
    const input = { id: 'same-configuration', method: 'configure', params: { systemPrompt: 'same' } };
    const queue = new ConfigurationQueue(storage, host);
    const first = await queue.enqueue(input, replacement);
    await queue.settled();

    const restarted = new ConfigurationQueue(storage, host);
    assert.deepEqual(await restarted.enqueue(input, replacement), first, 'the same mode replays its durable request');
    await restarted.settled();
    await assert.rejects(restarted.enqueue(input, !replacement), (error: unknown) => {
      assert.equal((error as { status?: number }).status, 409);
      return true;
    }, 'a patch and a replacement have different effects even with the same fields');
  }
});

test('overlapping queue kicks use one ordered drain and recover the same queue after restart', async () => {
  const storage = memoryStorage();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const applied: string[] = [];
  let active = 0;
  let maximum = 0;
  const host = {
    busy: async () => false,
    released: async () => {},
    apply: async (record: { id: string }) => {
      maximum = Math.max(maximum, ++active);
      if (record.id === 'first') await blocked;
      applied.push(record.id);
      const saved = await storage.get<{ state: string }>(`request:${record.id}`);
      await storage.put(`request:${record.id}`, { ...saved, state: 'completed' });
      active--;
    },
    failed: async (_record: unknown, error: unknown) => { throw error; },
    background: (_work: Promise<void>) => {},
    wake: async () => {},
  };
  const queue = new ConfigurationQueue(storage, host);
  await queue.enqueue({ id: 'first', method: 'configure', params: {} });
  await queue.enqueue({ id: 'second', method: 'configure', params: {} });
  for (let i = 0; i < 10; i++) queue.kick();
  release();
  await queue.settled();
  assert.deepEqual(applied, ['first', 'second']);
  assert.equal(maximum, 1);
  const restarted = new ConfigurationQueue(storage, host);
  restarted.kick();
  await restarted.settled();
  assert.deepEqual(applied, ['first', 'second']);
  assert.equal(await restarted.completedOrder(), 2);
});
