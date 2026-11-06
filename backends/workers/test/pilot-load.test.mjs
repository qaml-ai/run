import assert from 'node:assert/strict';
import test from 'node:test';
import { runPilotLoad } from '../scripts/pilot-load.mjs';

test('pilot load awaits foreground cleanup, retries a live lease and verifies credential revocation', async () => {
  const original = globalThis.fetch;
  let cleanups = 0;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method });
    let body = {};
    let status = 200;
    if (path === '/v1/tenants') body = { token: { token: 'synthetic-pilot-key' } };
    else if (path === '/v1/agents') body = { id: 'agent' };
    else if (path === '/v1/agents/agent/prompt') body = { id: 'request' };
    else if (path === '/v1/agents/agent/requests/request') body = { state: 'completed', outcome: { result: { reply: 'ok' } } };
    else if (path === '/pilot/cleanup') {
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), { tenant: 'pilot-load-test-0' });
      body = { state: ++cleanups === 1 ? 'deleting' : 'deleted' };
    } else if (path === '/v1/me') { status = 401; body = { code: 'UNAUTHORIZED' }; }
    return Response.json(body, { status });
  };
  try {
    const report = await runPilotLoad({
      operatorBaseUrl: 'https://camelrun-pilot-bootstrap-test.example.workers.dev',
      operatorToken: 'synthetic-operator-key', tenantIds: ['pilot-load-test-0'],
      fakeBaseUrl: 'https://camelrun-pilot-fakemodel.example.workers.dev', stages: [1],
    });
    assert.equal(report.stages[0].completed, 1);
    assert.equal(report.cleanup.deletedTenants, 1);
    assert.equal(report.cleanup.revokedCredentials, 1);
    assert.deepEqual(report.cleanup.failures, []);
    assert.equal(cleanups, 2);
    assert.ok(calls.every(call => call.method !== 'DELETE' && !call.path.endsWith('/deletion')), 'cleanup never depends on a background waitUntil request');
    assert.ok(!JSON.stringify(report).includes('synthetic-pilot-key'));
  } finally { globalThis.fetch = original; }
});
