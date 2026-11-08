import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inboxDetail, decisionDetail, expiryAnswer, Inputs, resolution } from '../src/inputs.ts';
import { testDatabase } from './database.ts';

const question = { question: 'Region?', options: [{ label: 'EU' }, { label: 'US' }], recommended: 'EU', reason: 'Nearest' };
test('recommendations are checked and expire only after per-item opt-in; approvals never accept automatically', () => {
  const detail = inboxDetail({ questions: [question] });
  assert.deepEqual(detail.recommendation, { answer: { answers: { 'Region?': 'EU' } }, reason: 'Nearest' });
  assert.equal(expiryAnswer({ kind: 'question', detail }).action, 'cancel');
  const opted = { ...detail, applyRecommendationOnExpiry: true };
  assert.deepEqual(expiryAnswer({ kind: 'question', detail: opted }, 1), { action: 'accept', content: { answers: { 'Region?': 'EU' } }, by: { system: 'expired' }, at: 1 });
  assert.equal(expiryAnswer({ kind: 'approval', detail: opted }).action, 'cancel');
  assert.throws(() => inboxDetail({ questions: [question], applyRecommendationOnExpiry: true }, 'approval'));
  assert.throws(() => inboxDetail({ questions: [question], links: ['http://example.com'] }));
  assert.throws(() => inboxDetail({ questions: [question], attachments: Array(33).fill({ path: '/workspace/a' }) }));
  assert.throws(() => inboxDetail({ questions: [{ ...question, recommended: 'nowhere' }] }));
});

test('key replacement is serialized, replay does not withdraw newer work, and answer batches have durable delivery intent', async () => {
  const { db } = await testDatabase();
  const store = new Inputs({ db });
  const detail = decisionDetail({ title: 'Region?', body: 'Pick a region', options: question.options });
  const base = { agent: 'a1', tenant: 'test', requestId: 'r1', toolCallId: 'call1', tool: 'request_decision', argumentsHash: 'hash', responders: {}, expiresAt: Date.now() + 60000, blocking: false, itemKey: 'region' };
  const make = (call: string) => store.create({ ...base, toolCallId: call }, [{ kind: 'question', message: 'Region?', detail }]);
  const [first] = await make('call1');
  const [second] = await make('call2');
  assert.equal((await store.get(first.id))?.state, 'withdrawn');
  assert.equal((await make('call1'))[0].id, first.id);
  assert.equal((await store.get(second.id))?.state, 'pending');
  assert.equal((await store.forRequest('a1', 'r1')).length, 0, 'decisions never join a suspension');
  const [third] = await store.create({ ...base, itemKey: 'other', toolCallId: 'call3' }, [{ kind: 'question', message: 'Region?', detail }]);
  const answer = { action: 'accept' as const, content: { answers: { 'Region?': 'EU' } }, by: { actor: 'person' }, at: Date.now() };
  await store.settleAll([second, third].map(input => ({ id: input.id, answer })));
  const deliveries = await store.deliveries('a1');
  assert.equal(deliveries.size, 1);
  assert.deepEqual([...deliveries.values()][0].map(input => input.id).sort(), [second.id, third.id].sort());
  await store.delivered([...deliveries.keys()][0]);
  assert.equal((await store.deliveries('a1')).size, 0);
});
