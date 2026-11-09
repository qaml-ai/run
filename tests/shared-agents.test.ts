import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SharedAgents, requireActiveMember } from '../src/shared-agents.ts';
import { testDatabase } from './database.ts';

const forbidden = (error: unknown) => (error as { status?: number }).status === 403;

test('owner membership cannot be capped, removed or restored, and rejected updates leave it unchanged', async () => {
  const { db } = await testDatabase();
  await db.query("insert into agent_members (id,tenant,agent,person,role,name,added_at) values ('m_owner','owner','agent','owner','owner','Owner',1)");
  const shares = new SharedAgents(db);
  for (const input of [{ dailyCapMicros: 1 }, { dailyCapMicros: 0 }, { dailyCapMicros: null }, { removed: false as const }, 'remove' as const]) {
    await assert.rejects(shares.change('owner', 'agent', 'm_owner', input), (error: unknown) => (error as { status?: number }).status === 400);
  }
  const row = (await db.query("select daily_cap, removed_at, revision from agent_members where id='m_owner'")).rows[0];
  assert.deepEqual(row, { daily_cap: null, removed_at: null, revision: 1 });
});

test('member admission requires a live membership of this tenant and agent', async () => {
  const { db } = await testDatabase();
  await db.query("insert into agent_members (id,tenant,agent,person,role,name,added_at) values ('m_guest','owner','agent','guest','guest','Guest',1)");
  await requireActiveMember(db, 'owner', 'agent', 'member:m_guest');
  await assert.rejects(requireActiveMember(db, 'other', 'agent', 'member:m_guest'), forbidden);
  await assert.rejects(requireActiveMember(db, 'owner', 'other', 'member:m_guest'), forbidden);
  await assert.rejects(requireActiveMember(db, 'owner', 'agent', 'member:missing'), forbidden);
  await db.query("update agent_members set removed_at=2 where id='m_guest'");
  await assert.rejects(requireActiveMember(db, 'owner', 'agent', 'member:m_guest'), forbidden);
  await db.query("delete from agent_members where id='m_guest'");
  await assert.rejects(requireActiveMember(db, 'owner', 'agent', 'member:m_guest'), forbidden);
  await requireActiveMember(db, 'owner', 'agent', 'normal-actor');
  await requireActiveMember(db, 'owner', 'agent');
});
