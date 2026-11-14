import assert from 'node:assert/strict';
import test from 'node:test';
import { runPilotLoad } from '../scripts/pilot-load.mjs';

test('pilot load enqueues cleanup once, polls durable progress and verifies credential revocation', async () => {
  const original = globalThis.fetch;
  let cleanups = 0;
  let polls = 0;
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
      cleanups++;
      body = { state: 'deleting' };
    } else if (path === '/v1/tenants/pilot-load-test-0/deletion') {
      assert.equal(init.method, 'GET');
      polls++;
      body = { state: 'deleted' };
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
    assert.equal(cleanups, 1);
    assert.equal(polls, 1);
    assert.ok(calls.every(call => call.method !== 'DELETE'), 'cleanup intent is enqueued once instead of running in an HTTP background task');
    assert.ok(!JSON.stringify(report).includes('synthetic-pilot-key'));
  } finally { globalThis.fetch = original; }
});

const loadOptions = {
  operatorBaseUrl: 'https://camelrun-pilot-bootstrap-test.example.workers.dev',
  operatorToken: 'synthetic-operator-key', tenantIds: ['pilot-load-test-0'],
  fakeBaseUrl: 'https://camelrun-pilot-fakemodel.example.workers.dev',
  stages: [20, 21], stopStageOnErrorRate: true,
};

test('pilot early stop cancels active and late admissions without inventing workload failures', async () => {
  const original = globalThis.fetch;
  const prompts = [], aborts = [], polls = [];
  let agents = 0, cleanups = 0, profileReads = 0;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/v1/tenants') return Response.json({ token: { token: 'synthetic-pilot-key' } });
    if (path === '/v1/agents') return Response.json({ id: `agent-${agents++}` });
    if (path === '/pilot/database-profile') { profileReads++; return Response.json({ epoch: 'test', phases: {}, operations: {} }); }
    const agent = Number(/\/agents\/agent-(\d+)\//.exec(path)?.[1]);
    if (path.endsWith('/prompt')) {
      prompts.push(agent);
      if (agent === 2) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(init.signal.aborted, false, 'stop must not hide a late admission');
      return Response.json({ id: 'request' });
    }
    if (path.includes('/requests/')) {
      polls.push(agent);
      if (agent < 2) return Response.json({ code: 'UNAVAILABLE' }, { status: 503 });
      // Exercise abort while response.json() is pending, not just fetch().
      return { headers: new Headers(), ok: true, json: () => new Promise((resolve, reject) => {
        if (init.signal.aborted) reject(init.signal.reason);
        else init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      }) };
    }
    if (path.endsWith('/abort')) {
      aborts.push(agent);
      return Response.json({}, { status: agent === 3 ? 503 : 200 });
    }
    if (path === '/pilot/cleanup') { cleanups++; return Response.json({ state: 'deleted' }); }
    if (path === '/v1/me') return Response.json({ code: 'UNAUTHORIZED' }, { status: 401 });
    return Response.json({ pending_attempts: 0, holds: 0, held_micros: 0 });
  };
  try {
    const report = await runPilotLoad(loadOptions);
    assert.equal(report.stages.length, 1, 'no later ramp starts');
    const stage = report.stages[0];
    assert.equal(prompts.length, 20, 'the concurrent burst is unchanged');
    assert.equal(stage.failed, 2, 'exactly 5% does not stop; the next error does');
    assert.equal(stage.stop.failed, 2);
    assert.equal(stage.cancelled, 18, 'stop-caused body aborts are not workload failures');
    assert.equal(stage.accepted, 20, 'late admissions remain observable');
    assert.ok(!polls.includes(2), 'a late admission is aborted without starting a wait');
    assert.equal(aborts.filter(id => id === 2).length, 1);
    assert.equal(new Set(aborts).size, 20);
    assert.equal(stage.stop.abortFailed, 1);
    assert.equal(stage.stop.financialDrainComplete, true);
    assert.equal(stage.turnsPerSecond, null);
    assert.equal(stage.turnLatency, null);
    assert.equal(stage.censored, true);
    assert.equal(stage.databaseProfile.skipped, true);
    assert.equal(profileReads, 20, 'heavy final profiling is skipped after a stop');
    assert.equal(cleanups, 1, 'abort failure cannot skip durable cleanup');
    assert.deepEqual(report.cleanup.failures, []);
  } finally { globalThis.fetch = original; }
});

test('exactly five percent errors does not censor a stage or stop its next ramp', async () => {
  const original = globalThis.fetch;
  let agents = 0, aborts = 0;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/v1/tenants') return Response.json({ token: { token: 'synthetic-pilot-key' } });
    if (path === '/v1/agents') return Response.json({ id: `agent-${agents++}` });
    if (path === '/pilot/database-profile') return Response.json({ epoch: 'test', phases: {}, operations: {} });
    if (path.endsWith('/prompt')) return Response.json({ id: JSON.parse(init.body).requestId });
    if (path.endsWith('/requests/load-20-0')) return Response.json({ code: 'UNAVAILABLE' }, { status: 503 });
    if (path.includes('/requests/')) return Response.json({ state: 'completed', outcome: { result: { reply: 'ok' } } });
    if (path.endsWith('/abort')) aborts++;
    if (path === '/pilot/cleanup') return Response.json({ state: 'deleted' });
    if (path === '/v1/me') return Response.json({ code: 'UNAUTHORIZED' }, { status: 401 });
    return Response.json({});
  };
  try {
    const report = await runPilotLoad({ ...loadOptions, originSampleMs: 5000 });
    assert.equal(report.stages.length, 2);
    assert.equal(report.stages[0].failed, 1);
    assert.equal(report.stages[0].errorRate, .05);
    assert.equal(report.stages[0].censored, undefined);
    assert.equal(report.stages[1].completed, 21);
    assert.equal(aborts, 0);
    assert.ok(report.stages.every(stage => typeof stage.turnsPerSecond === 'number'));
    assert.equal(report.originSampling.queriesPerSample, 2);
    assert.ok(report.stages.every(stage => stage.originSamples[0].phase === 'before' && stage.originSamples.at(-1).phase === 'after'));
  } finally { globalThis.fetch = original; }
});
