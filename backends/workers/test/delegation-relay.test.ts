import test from 'node:test';
import assert from 'node:assert/strict';
import { Delegation, type DelegatedChild, type DelegationHost } from '../src/delegation.ts';

test('child pushes preserve event order, reject unknown runs and settle once without a relay', async () => {
  const child = { id: 'child', key: 'child', requestId: 'child-run', parentRequestId: 'parent-run', toolCallId: 'call', name: 'helper', status: 'running' } as DelegatedChild;
  const values = new Map<string, unknown>([['delegation:child', child], ['delegation-run:child:child-run', 'child']]);
  const storage = {
    async get(key: string) { return structuredClone(values.get(key)); },
    async put(key: string, value: unknown) { values.set(key, structuredClone(value)); },
    async list({ prefix }: { prefix: string }) { return new Map([...values].filter(([key]) => key.startsWith(prefix))); },
    async transaction(work: (tx: unknown) => unknown) { return work(storage); },
  };
  const forwarded: any[] = [];
  const delegation = new Delegation({ storage, async emit(event: unknown) { forwarded.push(event); }, async fetch() { assert.fail('push must not open a relay'); }, waitUntil() {} } as unknown as DelegationHost);
  const frame = (type: string) => ({ agentId: child.id, requestId: child.requestId, event: { type: 'event', event: { type } } });
  assert.deepEqual(await delegation.receive({ ...frame('ignored'), requestId: 'unknown' }), { accepted: false });
  await delegation.receive(frame('message_start'));
  await delegation.receive(frame('message_end'));
  const completion = { agentId: child.id, requestId: child.requestId, event: { type: 'response' }, record: { state: 'completed', status: 'completed', outcome: { result: { usage: { costUsd: 0.15 } } } } };
  await delegation.receive(completion);
  await delegation.receive(completion);
  assert.deepEqual(forwarded.map(frame => frame.event.type), ['subagent_event', 'subagent_event', 'subagent_end']);
  assert.deepEqual(forwarded.slice(0, 2).map(frame => frame.event.event.type), ['message_start', 'message_end']);
  assert.equal(await delegation.cost(child.parentRequestId), 0.15);
  assert.equal(delegation.measurements.relayStreams, 0);
  assert.equal(delegation.measurements.pushedCompletions, 1);
  assert.equal(delegation.measurements.recoveredCompletions, 0);
});


test('recovery and a late completion push count and settle the child exactly once', async () => {
  const child = { id: 'child', key: 'child', requestId: 'child-run', parentRequestId: 'parent-run', toolCallId: 'call', name: 'helper', status: 'running', accepted: true } as DelegatedChild;
  const values = new Map<string, unknown>([['delegation:child', child], ['delegation-run:child:child-run', 'child']]);
  const record = { state: 'completed', status: 'completed', outcome: { result: { usage: { costUsd: 0.15 } } } };
  const storage = {
    async get(key: string) { return structuredClone(values.get(key)); },
    async put(key: string, value: unknown) { values.set(key, structuredClone(value)); },
    async list({ prefix }: { prefix: string }) { return new Map([...values].filter(([key]) => key.startsWith(prefix))); },
    async transaction(work: (tx: unknown) => unknown) { return work(storage); },
  };
  const forwarded: any[] = [];
  const delegation = new Delegation({ storage, async emit(event: unknown) { forwarded.push(event); }, async fetch() { return Response.json(record); }, waitUntil() {} } as unknown as DelegationHost);
  // Deterministically reproduce the load test's race: the bounded sweep wins before the push arrives.
  (delegation as any).following.add(child.key);
  await (delegation as any).sweep();
  const completion = { agentId: child.id, requestId: child.requestId, event: { type: 'response' }, record };
  await delegation.receive(completion);
  await delegation.receive(completion);
  assert.equal(delegation.measurements.recoveredCompletions, 1);
  assert.equal(delegation.measurements.pushedCompletions, 0);
  assert.equal(forwarded.filter(frame => frame.event.type === 'subagent_end').length, 1);
  assert.equal(await delegation.cost(child.parentRequestId), 0.15);
});
