import assert from 'node:assert/strict';
import test from 'node:test';
import { startFixture } from './fixture.ts';

test('public account and agent tokens cannot invoke internal computer maintenance', async t => {
  const fixture = await startFixture({ vars: { TEST_MODE: '0' } });
  t.after(() => fixture.stop());
  const created = await fetch(`${fixture.url}/v1/agents`, {
    method: 'POST', headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'test/echo', codeMode: false, fileTools: false }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const agent = await created.json() as { id: string; token: string };
  for (const token of [fixture.token, agent.token]) {
    for (const operation of ['confirm-cleanup', 'remove', 'refresh', 'sweep']) {
      const response = await fetch(`${fixture.url}/v1/agents/${agent.id}/__computer`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ tenant: 'camelrun-proto-local', operation }),
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: 'Not found', code: 'NOT_FOUND' });
    }
  }
});
