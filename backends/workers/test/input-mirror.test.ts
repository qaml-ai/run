import assert from 'node:assert/strict';
import test from 'node:test';
import { testDatabase } from './billing-database.ts';
import { webhookEvent } from '../src/webhook-policy.ts';
import { AgentWebhooks, stageWebhook } from '../src/run-webhooks.ts';
import { mirrorId, stageInputMirror, sweepInputMirrors, upsertInputMirrors, type InputMirror } from '../src/input-mirror.ts';
import { transaction } from '../src/postgres.ts';
import type { Env } from '../src/agent-types.ts';

const input = (overrides: Partial<InputMirror> = {}): InputMirror => ({
  id: '1', agent: 'a', tenant: 't', requestId: 'r', toolCallId: 'call', version: 1,
  kind: 'approval', message: 'Proceed?', question: 'Proceed?', detail: {}, state: 'pending',
  responders: { audience: ['person'] }, audience: ['person', 'approver'], subject: 'customer',
  lineage: ['root', 'a'], createdAt: 1, expiresAt: Date.now() + 60_000, ...overrides,
});

test('mirrors use agent-scoped IDs, preserve frozen fields, and reject old or equal versions', async () => {
  const { db } = await testDatabase();
  const first = input();
  await transaction(db, sql => upsertInputMirrors(sql, [first, input({ agent: 'b' })]));
  assert.notEqual(mirrorId('a', '1'), mirrorId('b', '1'));
  const settled = input({ version: 2, state: 'answered', answer: { action: 'accept', by: { via: 'api' }, at: 2 } });
  await transaction(db, sql => upsertInputMirrors(sql, [settled]));
  const updated = (await db.query('select * from agent_inputs where id=$1', [mirrorId('a', '1')])).rows[0];
  assert.equal(updated.priority, 'high');
  assert.equal(updated.priority_rank, 1);
  assert.equal(updated.blocking, true);
  assert.deepEqual(updated.responders, ['person', 'approver']);
  assert.deepEqual(updated.lineage, ['root', 'a']);
  assert.equal(updated.input.workersInputId, '1');
  await transaction(db, sql => upsertInputMirrors(sql, [first, input({ version: 2, subject: 'changed' })]));
  const replay = (await db.query('select * from agent_inputs where id=$1', [updated.id])).rows[0];
  assert.equal(replay.state, 'answered');
  assert.equal(replay.subject, 'customer');
  assert.equal(+replay.updated_at, +updated.updated_at);
  await assert.rejects(transaction(db, async sql => {
    await upsertInputMirrors(sql, [input({ version: 3, state: 'cancelled' })]);
    throw new Error('rollback');
  }));
  assert.equal((await db.query('select version from agent_inputs where id=$1', [updated.id])).rows[0].version, 2);
});

test('durable mirror intents survive lost acknowledgements and keep a newer staged row', async () => {
  const { db, url } = await testDatabase();
  const data = new Map<string, unknown>();
  let lose = true;
  const storage = {
    get: async (key: string) => data.get(key),
    put: async (key: string, value: unknown) => { data.set(key, value); },
    delete: async (key: string) => data.delete(key),
    list: async ({ prefix }: { prefix: string }) => new Map([...data].filter(([key]) => key.startsWith(prefix))),
    transaction: async (run: (tx: unknown) => Promise<void>) => {
      if (lose) throw new Error('lost acknowledgement');
      await run(storage);
    },
  } as unknown as DurableObjectStorage;
  await stageInputMirror(storage, input());
  await stageWebhook(storage, webhookEvent('input.requested', 't', { inputId: '1' }));
  const env = { HYPERDRIVE: { connectionString: url }, API_TOKEN: 'test-only' };
  await db.query('alter table webhook_deliveries rename to unavailable_deliveries');
  await new AgentWebhooks(storage, env).flush();
  assert.equal((await db.query('select count(*) from agent_inputs')).rows[0].count, 0);
  assert.equal(data.size, 2, 'failed webhook enqueue also rolls back the mirror');
  await db.query('alter table unavailable_deliveries rename to webhook_deliveries');
  await new AgentWebhooks(storage, env).flush();
  assert.equal(data.size, 2);
  await stageInputMirror(storage, input({ version: 2, state: 'cancelled' }));
  await stageInputMirror(storage, input());
  lose = false;
  await new AgentWebhooks(storage, env).flush();
  assert.equal([...data.keys()].filter(key => key.includes('pending:')).length, 0);
  assert.equal((await db.query('select state from agent_inputs')).rows[0].state, 'cancelled');
});

test('sweep leases 100 old pending Workers rows and rotates past unchanged rows', async () => {
  const { db, url } = await testDatabase();
  const rows = Array.from({ length: 103 }, (_, n) => input({ id: String(n) }));
  await transaction(db, sql => upsertInputMirrors(sql, rows));
  await db.query("update agent_inputs set updated_at=now()-interval '2 hours'");
  await transaction(db, sql => upsertInputMirrors(sql, [input({ id: 'new' }), input({ id: 'done', state: 'answered' })]));
  const calls: string[] = [];
  const env = { HYPERDRIVE: { connectionString: url }, AGENTS: { getByName: () => ({ fetch: async (request: Request) => {
    assert.equal(new URL(request.url).pathname, '/_input-mirror');
    const body = await request.json() as { tenant: string; ids: string[] };
    assert.equal(body.tenant, 't');
    calls.push(...body.ids);
    return Response.json({ refreshed: true });
  } }) } } as unknown as Env;
  await sweepInputMirrors(env);
  assert.equal(calls.length, 100);
  await sweepInputMirrors(env);
  assert.equal(calls.length, 103);
  assert.equal(new Set(calls).size, 103);
});
