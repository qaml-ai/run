import test from 'node:test';
import assert from 'node:assert/strict';
import { listAgents, liveStates } from '../src/agent-list.ts';
import type { ControlEnv, Directory, DirectoryEntry } from '../src/control.ts';
import { testDatabase } from './billing-database.ts';

test('unfiltered lists retain directory agents without a Postgres row; metadata filters require an indexed match', async () => {
  const { db, url } = await testDatabase();
  const entries = ['indexed', 'directory-only'].map(id => ({
    id, key: id, config: { name: id, type: 'agent', metadata: { type: 'project' } }, expiresAt: null,
  })) as DirectoryEntry[];
  await db.query("insert into agents(id,tenant,header,revision,name,type,model) values($1,'alice',$2,1,$1,'agent','test')",
    ['indexed', JSON.stringify({ config: entries[0].config })]);
  const env = { HYPERDRIVE: { connectionString: url }, AGENTS: { getByName: () => ({
    fetch: async () => Response.json({ running: false, connected: false }),
  }) } } as unknown as ControlEnv;
  const directory = { list: async () => entries } as unknown as Directory;
  const summary = (entry: DirectoryEntry) => ({ ...entry, ...entry.config });
  const list = async (query = '') => {
    const response = await listAgents(new Request(`https://runtime.test/v1/agents${query}`), env, 'alice', directory, summary);
    assert.equal(response.status, 200);
    return await response.json() as Record<string, unknown>[];
  };
  const all = await list();
  assert.deepEqual(all.map(agent => agent.id), ['indexed', 'directory-only']);
  assert.deepEqual(all[1].metadata, { type: 'project' });
  assert.equal(all[1].lastActiveAt, null);
  assert.equal(all[1].lastError, null);
  assert.equal(all[1].workspaceId, null);
  assert.deepEqual((await list('?metadata.type=project')).map(agent => agent.id), ['indexed']);
  assert.deepEqual(await list('?metadata.type=missing'), []);
});

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
