import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleEvent } from '../src/event-visibility.ts';
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
