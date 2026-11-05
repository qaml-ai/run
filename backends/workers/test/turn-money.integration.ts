import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFixture } from './fixture.ts';
import { EndUserCredits } from '../src/end-user-credits.ts';
import { database } from '../src/postgres.ts';

test('every model call records subject and workspace usage; a poor subject cannot dispatch', async t => {
  const f = await startFixture();
  t.after(() => f.stop());
  const credits = new EndUserCredits(database({ HYPERDRIVE: { connectionString: f.databaseUrl } }));
  await credits.setSettings('camelrun-proto-local', { enabled: true, markupBps: 2500 });
  await credits.post('camelrun-proto-local', 'customer', { kind: 'grant', amount: 1_000_000, key: 'customer-grant' });
  const call = async (path: string, body?: object) => {
    const response = await fetch(f.url + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
    return response.json() as Promise<any>;
  };
  const workspace = await call('/v1/workspaces', { name: 'Customer workspace' });
  const agent = await call('/v1/agents', { model: 'test/echo', subject: 'customer', bucket: 'support', workspaceId: workspace.id });
  const sent = await call(`/v1/agents/${agent.id}/requests`, { id: 'customer-turn', method: 'prompt', params: { text: 'hello customer' } });
  assert.equal(sent.id, 'customer-turn');
  let result: any;
  for (let i = 0; i < 100; i++) {
    result = await call(`/v1/agents/${agent.id}/requests/customer-turn?wait=1`);
    if (result.state === 'completed') break;
  }
  assert.equal(result.state, 'completed');
  const attempts = (await f.db.query('select context,end_user,end_user_bucket,totals,state from model_attempts where agent=$1', [agent.id])).rows;
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].end_user, 'customer');
  assert.equal(attempts[0].end_user_bucket, 'support');
  assert.equal(attempts[0].context.requestId, 'customer-turn');
  assert.equal(attempts[0].state, 'settled');
  assert.equal(Number((await f.db.query('select responses from workspace_usage where workspace=$1', [workspace.id])).rows[0].responses), 1);
  const after = await credits.get('camelrun-proto-local', 'customer', ['support']);
  assert.ok(after.balance < 1_000_000 && after.balance >= 0);
  assert.equal(Number((await f.db.query('select count(*) n from end_user_holds')).rows[0].n), 0);

  const broke = await call('/v1/agents', { model: 'test/echo', subject: 'empty-customer', bucket: 'support' });
  await call(`/v1/agents/${broke.id}/requests`, { id: 'poor-turn', method: 'prompt', params: { text: 'must not call provider' } });
  for (let i = 0; i < 100; i++) {
    result = await call(`/v1/agents/${broke.id}/requests/poor-turn?wait=1`);
    if (result.state === 'completed') break;
  }
  assert.equal(Number((await f.db.query('select count(*) n from model_attempts where agent=$1', [broke.id])).rows[0].n), 0);
  assert.equal((await credits.get('camelrun-proto-local', 'empty-customer')).balance, 0);
});
