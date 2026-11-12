import test from 'node:test';
import assert from 'node:assert/strict';
import { alarmAt, runAlarm, ALARM_FAILURE_FLOOR_MS } from '../src/workflow-alarm.ts';

test('the one alarm is the earliest time any concern needs, or none', () => {
  assert.equal(alarmAt(null, undefined, undefined), undefined);
  assert.equal(alarmAt(5_000, 2_000, undefined), 2_000);
  assert.equal(alarmAt(null, 9_000, 3_000), 3_000);
  assert.equal(alarmAt(1_000), 1_000);
});

test('a concern that throws is logged; the ones after it still run, and the alarm is armed again', async () => {
  const ran: string[] = [], logged: string[] = [], armed: number[] = [];
  const result = await runAlarm({
    concerns: [
      ['runner', () => { ran.push('runner'); throw new Error('runner broke'); }],
      ['forks', async () => { ran.push('forks'); throw new Error('forks broke'); }],
      ['notices', async () => { ran.push('notices'); }],
    ],
    next: async () => 1_500, arm: async at => { armed.push(at); }, log: concern => logged.push(concern), now: () => 1_000,
  });
  assert.deepEqual(ran, ['runner', 'forks', 'notices'], 'the notices still flush after the runner and forks threw');
  assert.deepEqual(logged, ['runner', 'forks']);
  assert.deepEqual(result.failed, ['runner', 'forks']);
  assert.deepEqual(armed, [1_000 + ALARM_FAILURE_FLOOR_MS], 'after a failure, not sooner than the floor');
});

test('without a failure the alarm is armed for exactly when it is needed; with nothing needed it is not armed', async () => {
  const armed: number[] = [];
  await runAlarm({ concerns: [['notices', () => {}]], next: async () => 1_200, arm: async at => { armed.push(at); }, log: () => {}, now: () => 1_000 });
  assert.deepEqual(armed, [1_200]);
  await runAlarm({ concerns: [['notices', () => {}]], next: async () => undefined, arm: async at => { armed.push(at); }, log: () => {}, now: () => 1_000 });
  assert.deepEqual(armed, [1_200]);
});

test('when even the next time cannot be read, the alarm comes back after the floor', async () => {
  const armed: number[] = [], logged: string[] = [];
  await runAlarm({ concerns: [], next: async () => { throw new Error('storage'); }, arm: async at => { armed.push(at); }, log: concern => logged.push(concern), now: () => 1_000 });
  assert.deepEqual(armed, [1_000 + ALARM_FAILURE_FLOOR_MS]);
  assert.deepEqual(logged, ['next']);
});
