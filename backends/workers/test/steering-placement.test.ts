import test from 'node:test';
import assert from 'node:assert/strict';
import { steeringJoined } from '../src/steering-placement.ts';

const old = { id: 1, status: 'placed' };
const steer = { id: 2, status: 'placed' };

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
