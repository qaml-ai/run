import test from 'node:test';
import assert from 'node:assert/strict';
import { liveStates } from '../src/agent-list.ts';

test('liveStates: in order, width at a time, and an agent whose state fetch throws or errors is null rather than failing the list', async () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({ id: `agent_${index}` }));
  let inFlight = 0, most = 0;
  const fetchState = async (id: string) => {
    inFlight++; most = Math.max(most, inFlight);
    await new Promise(resolve => setTimeout(resolve, 5));
    inFlight--;
    if (id === 'agent_1') throw new Error('Network connection lost.');
    if (id === 'agent_3') return new Response('gone', { status: 500 });
    return Response.json({ running: id === 'agent_4' });
  };
  const seen: [string, unknown][] = [];
  for await (const { entry, state } of liveStates(entries, fetchState, 2)) seen.push([entry.id, state]);
  assert.deepEqual(seen, [['agent_0', { running: false }], ['agent_1', null], ['agent_2', { running: false }], ['agent_3', null], ['agent_4', { running: true }]]);
  assert.equal(most, 2);
});

test('liveStates: a caller that stops early fetches no further chunks', async () => {
  const fetched: string[] = [];
  const entries = Array.from({ length: 6 }, (_, index) => ({ id: `agent_${index}` }));
  for await (const { entry } of liveStates(entries, async id => { fetched.push(id); return Response.json({ running: false }); }, 2)) if (entry.id === 'agent_1') break;
  assert.deepEqual(fetched, ['agent_0', 'agent_1']);
});
