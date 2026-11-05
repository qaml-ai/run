import test from 'node:test';
import assert from 'node:assert/strict';
import { waitsForProgress } from '../src/delegation-progress.ts';

const worker = { id: 'child-1', name: 'worker' };
const calls = (...parts: object[]) => [{ role: 'assistant', content: parts }];
const wait = (args: object) => ({ type: 'toolCall', name: 'wait_agent', arguments: args });

test('a sibling wait defers the selected child progress to its own result', () => {
  assert.equal(waitsForProgress(calls(wait({})), worker), true);
  assert.equal(waitsForProgress(calls(wait({ agents: ['worker'] })), worker), true);
  assert.equal(waitsForProgress(calls(wait({ agents: ['child-1'] })), worker), true);
});

test('other children still report beside a selective sibling wait', () => {
  assert.equal(waitsForProgress(calls(wait({ agents: ['other'] })), worker), false);
  assert.equal(waitsForProgress(calls(wait({ agents: [] })), worker), false);
});

test('a result without a sibling wait keeps normal progress delivery', () => {
  assert.equal(waitsForProgress(calls({ type: 'toolCall', name: 'send_message', arguments: { to: 'worker' } }), worker), false);
  assert.equal(waitsForProgress([{ role: 'toolResult', content: [wait({})] }], worker), false);
});
