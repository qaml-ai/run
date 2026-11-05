import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveToolInputs, withInputNote } from '../src/mcp-inputs.ts';
import { toolResult } from '../src/attached-tools.ts';
import type { HumanInput } from '../src/human.ts';

const approved: HumanInput = { question: 'Allow wipe?', kind: 'approval', createdAt: 1000, state: 'answered', answer: '{"approved":true}', answerDetail: { action: 'accept', by: { via: 'api', actor: 'ops-1' }, at: 4000 } };
test('approval retry contains durable proof and the source response note', () => {
  const resolved = resolveToolInputs([{ id: 'approval-1', input: approved }]);
  assert.ok('reply' in resolved);
  assert.deepEqual(resolved.reply.approval, { input: 'approval-1', by: { via: 'api', actor: 'ops-1' }, at: 4000 });
  assert.deepEqual(withInputNote({ content: [{ type: 'text', text: 'deleted' }] }, resolved.reply).content, [{ type: 'text', text: 'deleted' }, { type: 'text', text: '(Approved by ops-1 after 3s.)' }]);
});
test('declining approval returns the source explanation without retrying', () => {
  const resolved = resolveToolInputs([{ id: 'approval-1', input: { ...approved, state: 'declined', answerDetail: { action: 'decline', content: { reason: 'keep it' }, by: { via: 'api' }, at: 4000 } } }]);
  assert.ok('result' in resolved);
  assert.equal(resolved.result.isError, true);
  assert.match(String((resolved.result.content?.[0] as any).text), /The user declined this call: keep it\. It did not run/);
});
test('multiple elicitation replies preserve keyed form content and opaque state', () => {
  const input: HumanInput = { ...approved, kind: 'form', answerDetail: { action: 'accept', content: { name: 'new' }, by: { via: 'api' }, at: 4000 } };
  const resolved = resolveToolInputs([{ id: 'form-1', input, key: 'name' }, { id: 'url-1', input: { ...input, kind: 'url' }, key: 'login' }], 'opaque-state');
  assert.ok('reply' in resolved);
  assert.deepEqual(resolved.reply.inputResponses, { name: { action: 'accept', content: { name: 'new' } }, login: { action: 'accept' } });
  assert.equal(resolved.reply.requestState, 'opaque-state');
});

test('approval proof carries sender ids while its note retains the display name', () => {
  const resolved = resolveToolInputs([{ id: 'approval-2', input: { ...approved, answerDetail: { action: 'accept', by: { via: 'agent', from: { id: 'agent-1', name: 'Operator' }, actor: 'ops' }, at: 4000 } } }]);
  assert.ok('reply' in resolved);
  assert.deepEqual(resolved.reply.approval?.by, { via: 'agent', from: 'agent-1', actor: 'ops' });
  assert.match(resolved.reply.note!, /Operator/);
});

test('an approval annotation does not remove a host script tool result', () => {
  const result = toolResult(withInputNote({ content: [{ type: 'text', text: 'saved' }] }, { note: '(Approved by Operator.)' }));
  assert.equal(result.structuredOutput, 'saved');
  assert.deepEqual(result.output, [{ type: 'text', text: 'saved' }, { type: 'text', text: '(Approved by Operator.)' }]);
});
