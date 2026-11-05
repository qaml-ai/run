import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleEvent, visibleReplay } from '../src/event-visibility.ts';
import { SUBAGENT_EVENTS } from '../src/multi-agent-policy.ts';

test('child and workflow events require an explicit subscription', () => {
  for (const type of SUBAGENT_EVENTS) {
    const frame = { type: 'event', requestId: 'parent', event: { type } };
    assert.equal(visibleEvent(frame, false), false, type);
    assert.equal(visibleEvent(frame, true), true, type);
  }
  for (const frame of [{ type: 'event', event: { type: 'message_end' } }, { type: 'response' }, { type: 'snapshot' }])
    assert.equal(visibleEvent(frame, false), true);
});

test('a poll advances past hidden child events after its last visible event', () => {
  const visible = { id: 7, data: { type: 'response', id: 'parent' } };
  const hidden = { id: 8, data: { type: 'event', event: { type: 'subagent_end' } } };
  const result = visibleReplay({ cursor: 6, events: [visible, hidden] }, false);
  assert.equal(result.cursor, 8);
  assert.deepEqual(result.events, [visible]);
  assert.deepEqual(visibleReplay({ cursor: result.cursor, events: [] }, false), { cursor: 8, events: [] });
});
