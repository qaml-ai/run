import assert from 'node:assert/strict';
import test from 'node:test';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { resumedHumanTools } from '../src/human.ts';
import { MessageProjection } from '../src/message-projection.ts';

test('resumed input calls retain original arguments and are started once per tool', async () => {
  const pi = {
    getTask: async (task: number) => ({ input: task === 2 ? { kind: 'nested', parent: 1 } : { kind: 'model', assistant: 10, callId: 'approval' } }),
    commit: async (read: (tx: unknown) => unknown) => read({ entry: async () => ({ model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'approval', name: 'shop__delete', arguments: { id: 'a' } }] }] }) }),
  } as unknown as Parameters<typeof resumedHumanTools>[0];
  assert.deepEqual(await resumedHumanTools(pi, ['1:approval', '2:form'], context), [{ type: 'tool_execution_start', toolCallId: 'approval', toolName: 'shop__delete', args: { id: 'a' } }]);
});

test('a tool completion reaches the stream before its result message ends', () => {
  const events = new MessageProjection().events({ role: 'toolResult', toolCallId: 'approval', toolName: 'shop__delete', timestamp: 1, content: [{ type: 'text', text: 'deleted' }] }, true) as { type: string }[];
  assert.deepEqual(events.map(event => event.type), ['message_start', 'tool_execution_end', 'message_end']);
});
