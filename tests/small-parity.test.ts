import '../tests/contract/areas/small-parity.contract.test.ts';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase } from './database.ts';

test('definition revisions purge removed and rotated sealed credentials', async () => {
  const { db } = await testDatabase();
  await db.query("insert into tenants(id, created_at) values ('revision-test', 0)");
  const source = (sealed: string) => ({ name: 'tool', url: 'https://example.test/mcp', sealed });
  await db.query('insert into definitions(id, tenant, name, revision, spec, created_at, updated_at) values ($1,$2,$3,1,$4,0,0)', ['revision-test', 'revision-test', 'test', { mcpServers: [source('test-old-ciphertext')], openApi: [{ name: 'api', baseUrl: 'https://example.test/api', sealed: 'test-api-ciphertext' }] }]);
  await db.query("update definitions set revision=revision+1, name='renamed' where id='revision-test'");
  const unchanged = (await db.query("select spec from definition_revisions where id='revision-test' and revision=1")).rows[0].spec;
  assert.equal(unchanged.mcpServers[0].sealed, 'test-old-ciphertext');
  assert.equal(unchanged.openApi[0].sealed, 'test-api-ciphertext');
  await db.query('update definitions set revision=3, spec=$1 where id=$2', [{ mcpServers: [source('test-new-ciphertext')], openApi: [] }, 'revision-test']);
  const prior = (await db.query("select spec from definition_revisions where id='revision-test' and revision=1")).rows[0].spec;
  assert.equal(prior.mcpServers[0].sealed, undefined);
  assert.equal(prior.openApi[0].sealed, undefined);
  const current = (await db.query("select spec from definition_revisions where id='revision-test' and revision=3")).rows[0].spec;
  assert.equal(current.mcpServers[0].sealed, 'test-new-ciphertext');
  await db.query("update definitions set revision=4, spec='{}' where id='revision-test'");
  assert.equal((await db.query("select spec from definition_revisions where id='revision-test' and revision=3")).rows[0].spec.mcpServers[0].sealed, undefined);
});

import { childStatus } from '../src/multi-agent.ts';
test('child status preserves a budget pause for raw and public request records', () => {
  assert.equal(childStatus({ status: 'failed', outcome: { result: { stopped: 'spend_limit' } } }), 'paused');
  assert.equal(childStatus({ status: 'paused' }), 'paused');
  assert.equal(childStatus({ outcome: { result: { stopped: 'input_required' } } }), 'input_required');
  assert.equal(childStatus({ outcome: { result: { code: 'cancelled' } } }), 'aborted');
});
