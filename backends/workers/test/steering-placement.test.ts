import test from 'node:test';
import assert from 'node:assert/strict';
import { steeringCanJoin, steeringJoined } from '../src/steering-placement.ts';

const old = { id: 1, status: 'placed' };
const steer = { id: 2, status: 'placed' };

test('only a native input still placed can accept a logical steer', () => {
  assert.equal(steeringCanJoin(old), true);
  assert.equal(steeringCanJoin({ status: 'done', answer: 8 }), false);
  assert.equal(steeringCanJoin({ status: 'unanswered' }), false);
  assert.equal(steeringCanJoin({ status: 'queued' }), false);
  assert.equal(steeringCanJoin(undefined), false);
});

test('steering placed after tools belongs to the running turn', () => {
  assert.equal(steeringJoined(steer, old, [old, steer]), true);
});

test('steering placed after a final response starts its own turn', () => {
  assert.equal(steeringJoined(steer, { ...old, status: 'done', answer: 8 }, [steer]), false);
});

test('a live logical turn keeps an accepted steer across native final answers', () => {
  assert.equal(steeringJoined({ ...steer, status: 'done', answer: 9 }, { ...old, status: 'done', answer: 8 }, [], true), true);
});

test('a delayed observer uses the actual answers to recover run ownership', () => {
  assert.equal(steeringJoined({ ...steer, status: 'done', answer: 9 }, { ...old, status: 'done', answer: 8 }, []), false);
  assert.equal(steeringJoined({ ...steer, status: 'done', answer: 8 }, { ...old, status: 'done', answer: 8 }, []), true);
});

test('a queued input is not classified until Pi places it', () => {
  assert.equal(steeringJoined({ ...steer, status: 'queued' }, old, [old]), undefined);
});
