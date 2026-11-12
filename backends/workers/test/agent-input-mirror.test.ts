import assert from 'node:assert/strict';
import test from 'node:test';
import { readInputMirrors, repairInputMirrors, restageInputMirrors } from '../src/agent-input-mirror.ts';
import type { AgentRuntime } from '../src/agent-runtime.ts';
import type { HumanInput } from '../src/human.ts';

test('recovery leaves an ownerless Pi input unbound and does not report it missing', async () => {
  const doc = { requests: { input: { question: 'Which region?', requestId: '', createdAt: 1, state: 'pending' } as HumanInput } };
  const data = new Map<string, unknown>();
  let commits = 0;
  const storage = {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => { data.set(key, value); },
    transaction: async (work: (tx: unknown) => Promise<void>) => work(storage),
  };
  const runtime = {
    config: async () => ({ id: 'agent', tenantId: 'tenant', expiresAt: null, config: { humanInput: { approvers: ['boss'] } } }),
    ctx: { storage },
    harness: { pi: async () => ({ snapshot: async () => doc, commit: async (work: (tx: unknown) => Promise<unknown>) => {
      commits++;
      return work({ doc: async () => doc });
    } }) },
    delegation: { lineage: async () => undefined },
  } as unknown as AgentRuntime;
  assert.deepEqual(await restageInputMirrors(runtime, ['input', 'absent']), ['absent']);
  assert.equal(commits, 0);
  assert.equal(doc.requests.input.policyBound, undefined);
  assert.equal(doc.requests.input.requestId, '');
  assert.equal(data.size, 0, 'an input with no known owner is not mirrored');

  // Once onHuman records the owner, recovery can bind the original actor, not an empty run.
  data.set('input-owner:input', 'original-run');
  data.set('request:original-run', { id: 'original-run', params: { actor: 'alice' } });
  const [row] = await readInputMirrors(runtime);
  assert.equal(commits, 1);
  assert.equal(row.requestId, 'original-run');
  assert.deepEqual(row.audience, ['alice', 'boss']);
  assert.equal(doc.requests.input.requestId, 'original-run');
  assert.equal(doc.requests.input.policyBound, true);
  assert.deepEqual(await restageInputMirrors(runtime, ['input']), []);
  assert.equal(commits, 1, 'the owner and audience are frozen only once');
  assert.equal((data.get('input-mirror-pending:input') as typeof row).requestId, 'original-run');
});

test("startup's restage flushes after its rows commit: an idle agent's re-staged inputs reach Postgres", async () => {
  const doc = { requests: { input: { question: 'Which region?', requestId: 'run', createdAt: 1, state: 'pending', policyBound: true } as HumanInput } };
  const data = new Map<string, unknown>(), order: string[] = [];
  const storage = {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => { data.set(key, value); },
    transaction: async (work: (tx: unknown) => Promise<void>) => { await new Promise(resolve => setTimeout(resolve, 5)); await work(storage); order.push('restaged'); },
  };
  const runtime = {
    config: async () => ({ id: 'agent', tenantId: 'tenant', expiresAt: null, config: {} }),
    ctx: { storage },
    harness: { pi: async () => ({ snapshot: async () => doc }) },
    delegation: { lineage: async () => undefined },
    webhooks: { flush: async () => { order.push(`flushed ${[...data.keys()].filter(key => key.startsWith('input-mirror-pending:')).length}`); } },
  } as unknown as AgentRuntime;
  await repairInputMirrors(runtime);
  assert.deepEqual(order, ['restaged', 'flushed 1']);
});
