import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { InboxDoc } from '@earendil-works/pi-durable';

// Successful queue releases do not call the Workers-only admission service.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './control.ts' && context.parentURL === new URL('../src/batch-queue.ts', import.meta.url).href) {
    return { url: 'data:text/javascript,export function releaseTurn() { throw new Error("unexpected cancellation"); }', shortCircuit: true };
  }
  return next(specifier, context);
} });
const { BatchQueue } = await import('../src/batch-queue.ts');

function fixture() {
  let items: { mode: string }[] = [], run: object | undefined = {};
  const sent: unknown[] = [], values = new Map<string, any>();
  const storage = {
    get: async (key: string) => values.get(key),
    list: async ({ prefix }: { prefix: string }) => new Map([...values].filter(([key]) => key.startsWith(prefix))),
    delete: async (key: string) => values.delete(key),
    put: async (key: string, value: unknown) => { values.set(key, value); },
    transaction: async (fn: (tx: any) => Promise<unknown>) => fn(storage),
  };
  const pi = { root: async () => ({ id: 'root' }), snapshot: async (doc: unknown) => doc === InboxDoc ? { items } : { run } };
  const runtime = { ctx: { storage }, harness: { pi: async () => pi, submit: async (...args: unknown[]) => { sent.push(args); } },
    config: async () => ({ config: { queue: { mode: 'batch' } } }), track: () => {} };
  return { queue: new BatchQueue(runtime as any), sent, values, inbox: (next: typeof items) => { items = next; }, idle: () => { run = undefined; } };
}

test('queued steers prevent unrelated follow-ups entering Pi on batching and ordinary agents', async () => {
  const f = fixture();
  f.inbox([{ mode: 'steer' }]);
  for (const config of [{}, { queue: { mode: 'batch' } }]) {
    assert.equal(await f.queue.holds({ config } as any, { params: { text: 'other payer', endUser: 'other' } }, false), 'hold');
  }
});

test('a rejected steer is held until idle and released as its own turn', async () => {
  const f = fixture(), params = { text: 'other payer', endUser: 'other', whileRunning: 'steer' };
  assert.equal(await f.queue.holds({ config: {} } as any, { params }, false), 'hold');
  f.values.set('batch-hold:1', { id: 'other', key: 'batch-hold:1', startedAt: 0, content: 'other payer', submission: { whenBusy: 'followUp' }, params });
  await (f.queue as any).release();
  assert.equal(f.sent.length, 0);
  f.idle();
  await (f.queue as any).release();
  assert.equal(f.sent.length, 1);
  assert.equal(f.values.has('batch-hold:1'), false);
});
