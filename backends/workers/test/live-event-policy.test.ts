import assert from 'node:assert/strict';
import { test } from 'node:test';
import { follow, replay, turnSnapshot, TURN_SNAPSHOT_BYTES } from '../src/live-event-policy.ts';

test('event replay rejects missing history unless the caller requests a snapshot', () => {
  const session = { cursor: 100, events: [{ id: 100, data: { type: 'event' } }] };
  assert.throws(() => replay(session, '1'), /REPLAY_GAP/);
  assert.deepEqual(replay(session, '1', true), { cursor: 100, snapshot: { type: 'snapshot', cursor: 100, requestId: null, turn: null }, events: [] });
  assert.deepEqual(replay(session, '99').events, session.events);
  assert.throws(() => replay(session, 'NaN'), /Invalid event cursor/);
});

test('a running turn folds finished messages and bounds retained snapshot bytes', () => {
  const session = { cursor: 7, events: [], turn: { requestId: 'run', count: 0, bytes: 0, messages: [] as any[] }, partial: { role: 'assistant', content: 'still streaming' } };
  follow(session, { type: 'event', requestId: 'run', event: { type: 'turn_opened', index: 5 } } as any, '', false);
  follow(session, { type: 'event', requestId: 'run', event: { type: 'message_end', message: { role: 'user', content: 'hello' } } } as any, 'hello', false);
  assert.equal(turnSnapshot({ options: {} }, session).turn?.start, 5);
  assert.equal(turnSnapshot({ options: {} }, session).turn?.count, 1);
  follow(session, { type: 'event', requestId: 'run', event: { type: 'message_end', message: {} } } as any, 'x'.repeat(TURN_SNAPSHOT_BYTES), false);
  const snapshot = turnSnapshot({ options: {} }, session);
  assert.equal(snapshot.turn?.count, 2);
  assert.equal(snapshot.turn?.truncated, true);
  assert.deepEqual(snapshot.turn?.messages, []);
  assert.deepEqual(snapshot.turn?.partial, session.partial);
});
