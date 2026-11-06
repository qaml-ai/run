import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { agentSpend, modelSpendLimit, runSpend, setAgentSpendLimit } from '../src/agent-spend.ts';
import { testDatabase } from './billing-database.ts';

async function setup() {
  const { db } = await testDatabase();
  await db.query("insert into agents(id,tenant,header,revision,name,type,model) values('agent','tenant','{}',1,'','agent','test')");
  const record = async (cost: number, at: number, requestId: string, kind = 'response', tenant = 'tenant') => {
    const id = randomUUID();
    await db.query(`insert into model_attempts(id,tenant,agent,provider,model,kind,platform,catalog_priced,prepaid,key_hash,context,started_at,updated_at,next_check_at,totals,state)
      values($1,$2,'agent','test','test',$3,true,true,true,$4,$5,$6,$6,$6,$7,'settled')`,
      [id, tenant, kind, 'a'.repeat(64), JSON.stringify({ requestId }), at, JSON.stringify({ cost, platformCost: cost * 2 })]);
    return id;
  };
  return { db, record };
}

test('agent budget resets from set_at, includes compaction and raw cost, and excludes other tenants', async () => {
  const { db, record } = await setup();
  await record(0.7, 10, 'old');
  await setAgentSpendLimit(db, 'agent', 0.2, 20);
  assert.deepEqual(await agentSpend(db, 'tenant', 'agent'), { usd: 0.2, spent: 0, setAt: 20 });
  await record(0.15, 21, 'run');
  await record(0.15, 22, 'run', 'compaction');
  await record(10, 22, 'run', 'response', 'other');
  assert.deepEqual(await agentSpend(db, 'tenant', 'agent'), { usd: 0.2, spent: 0.3, setAt: 20 });
  const stop = await modelSpendLimit(db, { tenant: 'tenant', agent: 'agent' });
  assert.equal(stop?.status, 402);
  assert.equal(stop?.code, 'SPEND_LIMIT');
  assert.equal(stop?.stopLimit, 'agent');
  assert.match(stop!.message, /\$0\.2 \(\$0\.3 spent since it was set\)/);
  // Supplying the same value explicitly also starts counting from zero.
  await setAgentSpendLimit(db, 'agent', 0.2, 30);
  assert.deepEqual(await agentSpend(db, 'tenant', 'agent'), { usd: 0.2, spent: 0, setAt: 30 });
  assert.equal(await modelSpendLimit(db, { tenant: 'tenant', agent: 'agent' }), undefined);
  assert.equal(await agentSpend(db, 'other', 'agent'), null);
  await setAgentSpendLimit(db, 'agent', null);
  assert.equal(await agentSpend(db, 'tenant', 'agent'), null);
});

test('run budget is isolated by request; agent budget has priority and corrected attempts count once', async () => {
  const { db, record } = await setup();
  await setAgentSpendLimit(db, 'agent', 1, 0);
  const first = await record(0.15, 1, 'first');
  await record(0.15, 2, 'first', 'compaction');
  await record(0.15, 3, 'second');
  assert.equal(await runSpend(db, 'tenant', 'agent', 'first'), 0.3);
  assert.equal(await modelSpendLimit(db, { tenant: 'tenant', agent: 'agent', requestId: 'second', spendLimit: 0.2 }), undefined);
  const stop = await modelSpendLimit(db, { tenant: 'tenant', agent: 'agent', requestId: 'first', spendLimit: 0.2 });
  assert.equal(stop?.stopLimit, 'run');
  assert.equal(stop?.message, 'This run has reached its spend limit of $0.2 ($0.3 spent)');
  await db.query("update model_attempts set totals=$2,revision=revision+1 where id=$1", [first, JSON.stringify({ cost: 0.05 })]);
  assert.equal(await runSpend(db, 'tenant', 'agent', 'first'), 0.2);
  assert.equal((await modelSpendLimit(db, { tenant: 'tenant', agent: 'agent', requestId: 'first', spendLimit: 0.2 }))?.stopLimit, 'run');
  await setAgentSpendLimit(db, 'agent', 0, 0);
  assert.equal((await modelSpendLimit(db, { tenant: 'tenant', agent: 'agent', requestId: 'first', spendLimit: 0 }))?.stopLimit, 'agent');
});

test('superseded model attempts remain recorded without consuming an agent or run budget', async () => {
  const { db, record } = await setup();
  await setAgentSpendLimit(db, 'agent', 1, 0);
  const blocked = await record(10, 1, 'fallback');
  await db.query("update model_attempts set context=context || '{\"superseded\":\"content_filter\"}'::jsonb where id=$1", [blocked]);
  await record(0.1, 2, 'fallback');
  assert.equal((await agentSpend(db, 'tenant', 'agent'))?.spent, 0.1);
  assert.equal(await runSpend(db, 'tenant', 'agent', 'fallback'), 0.1);
  assert.equal(Number((await db.query("select totals->>'cost' as cost from model_attempts where id=$1", [blocked])).rows[0].cost), 10);
});
