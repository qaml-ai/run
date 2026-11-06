import test from 'node:test';
import assert from 'node:assert/strict';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { DecisionRuntime } from '../src/decision-runtime.ts';
import { DecisionFailed, type DecisionItem } from '../src/decision-policy.ts';
import { HttpError } from '../src/errors.ts';

const input = { tool: 'shop__read', description: 'Read an item', args: { id: 'a' }, intent: 'Show item a' };
const api = { taskId: 42, callId: 'call_a' } as ToolExecutionApi;
const answers = (exfiltration = 0) => ({ ordinary: { type: 'noul', noul: 0.95 }, irreversible: { type: 'noul', noul: 0.01 }, exfiltration: { type: 'noul', noul: exfiltration } });

test('judged tools use fixed source questions, scoped keys, and await a distinct usage receipt', async () => {
  const seen: DecisionItem[] = [], records: any[] = [];
  let admitted = 0;
  const runtime = new DecisionRuntime({
    context: async () => ({ tenant: 'tenant', agent: 'agent', requestId: 'request', keyScope: 'scope', budget: 1 }),
    key: async (tenant, scope) => { assert.equal(tenant, 'tenant'); assert.equal(scope, 'scope'); return { apiKey: 'fake', platform: false }; },
    provider: { id: 'openrouter', dataPolicy: true, async decide(item) { seen.push(item); assert.equal(admitted, 1); return { answers: answers(), inputTokens: 400, outputTokens: 8, costUsd: 0.00002 }; } },
    admit: async () => { admitted++; },
    record: async (context, usage) => { await Promise.resolve(); records.push({ context, usage }); },
  });
  assert.equal((await runtime.judge(input, new AbortController().signal, api)).decision, 'allow');
  assert.deepEqual(Object.keys(seen[0].questions).sort(), ['exfiltration', 'irreversible', 'ordinary']);
  assert.deepEqual(JSON.parse(String(seen[0].state)), { request: input.intent, tool: input.tool, description: input.description, arguments: JSON.stringify(input.args) });
  assert.equal(records[0].context.callId, 'judge:42');
  assert.equal(records[0].context.requestId, 'request');
  assert.equal(records[0].usage.usage.cost.total, 0.00002);
});

test('judged risk denies and provider failure falls back to asking', async () => {
  let failed = false;
  const runtime = new DecisionRuntime({ context: async () => ({ tenant: 'tenant' }), key: async () => ({ apiKey: 'fake', platform: false }), provider: { id: 'openrouter', async decide() { if (failed) throw new DecisionFailed(401, 'unavailable'); return { answers: answers(0.9), inputTokens: 1, outputTokens: 1 }; } } });
  assert.equal((await runtime.judge(input, new AbortController().signal, api)).decision, 'deny');
  failed = true;
  assert.equal((await runtime.judge(input, new AbortController().signal, api)).decision, 'ask');
});

test('budget refusal and unjudgeable inputs send no provider calls', async () => {
  let sent = 0, admitted = 0;
  const runtime = new DecisionRuntime({ context: async () => ({ tenant: 'tenant' }), key: async () => ({ apiKey: 'fake', platform: false }), admit: async () => { admitted++; throw new HttpError(402, 'No budget'); }, provider: { id: 'openrouter', async decide() { sent++; return { answers: answers(), inputTokens: 1, outputTokens: 1 }; } } });
  assert.equal((await runtime.judge(input, new AbortController().signal, api)).reason, 'budget');
  assert.equal((await runtime.judge({ ...input, args: { huge: 'x'.repeat(8001) } }, new AbortController().signal, api)).reason, 'unjudgeable');
  assert.equal(admitted, 1);
  assert.equal(sent, 0);
});
