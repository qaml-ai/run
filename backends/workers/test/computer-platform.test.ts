import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionInput } from '../src/computers/service.ts';
import { microvmApi, microvmDriver, testEndpoint, boundedResponse } from '../src/computers/microvm.ts';
import { remoteDriver } from '../src/computers/remote.ts';
import { observe, microvmCost } from '../src/computers/microvm-policy.ts';
import { PROVIDERS, type Provider } from '../src/computers/policy.ts';

const fakeEnv = { AWS_ACCESS_KEY_ID: 'test-access', AWS_SECRET_ACCESS_KEY: 'test-secret', AWS_SESSION_TOKEN: 'test-session', AWS_REGION: 'us-west-2', MICROVM_IMAGE: 'fixture-image', TEST_MODE: '1', TEST_MICROVM_ENDPOINT: 'http://127.0.0.1:9999' };
test('computer connection credentials, provider limits and managed admission match the API contract', () => {
  for (const provider of ['daytona','sprites','e2b','boat']) {
    const value = connectionInput({ agent: 'agent', provider, credentials: { apiKey: 'fixture-only' } }, false);
    assert.equal(value.leaseSeconds, 900); assert.equal(value.dailySeconds, 3600);
    assert.throws(() => connectionInput({ agent: 'agent', provider, credentials: {} }, false));
    assert.throws(() => connectionInput({ agent: 'agent', provider, credentials: { apiKey: 'fixture-only', tokenId: 'extra' } }, false));
  }
  assert.throws(() => connectionInput({ agent: 'agent', provider: 'lambda' }, false), /not available/);
  assert.throws(() => connectionInput({ agent: 'agent', provider: 'lambda', credentials: { apiKey: 'no' } }, true));
  for (const url of ['http://example.com', 'https://localhost', 'https://127.0.0.1', 'https://example.com/path', 'https://user@example.com']) assert.throws(() => connectionInput({ agent: 'agent', provider: 'tunnel', credentials: { apiKey: 'fixture', url } }, false));
  assert.equal(connectionInput({ agent: 'agent', provider: 'lambda', subagents: false }, true).subagents, false);
  assert.throws(() => connectionInput({ agent: 'agent', provider: 'sprites', credentials: { apiKey: 'fixture' }, leaseSeconds: 901 }, false));
});
test('Workers rejects the dropped Modal provider before contacting a provider gateway', () => {
  assert.equal(PROVIDERS.includes('modal' as Provider), false);
  assert.throws(() => connectionInput({ agent: 'agent', provider: 'modal', credentials: { tokenId: 'id', tokenSecret: 'fixture' } }, false), /Invalid computer connection/);
  let contacted = false;
  const env = { COMPUTER_PROVIDER_GATEWAY: { async fetch() { contacted = true; return Response.json({}); } } };
  assert.throws(() => remoteDriver(env, 'tenant', 'agent', 'modal' as Provider, { tokenId: 'id', tokenSecret: 'fixture' }), /Unsupported computer provider/);
  assert.equal(contacted, false);
});
test('Lambda API signs every operation for lambda, bounds replies, and rejects unsafe fake endpoints', async () => {
  const requests: Request[] = [];
  const api = microvmApi(fakeEnv, async request => { requests.push(request); return Response.json({ ok: true }); });
  await api('RunMicrovm', { clientToken: 'once', imageIdentifier: 'image' });
  await api('GetMicrovm', { microvmIdentifier: 'vm/a', maxItems: 1 });
  await api('SuspendMicrovm', { microvmIdentifier: 'vm/a' });
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(new URL(request.url).origin, fakeEnv.TEST_MICROVM_ENDPOINT);
    assert.match(request.headers.get('authorization')!, /^AWS4-HMAC-SHA256 Credential=test-access\/\d{8}\/us-west-2\/lambda\/aws4_request/);
    assert.equal(request.headers.get('x-amz-security-token'), 'test-session');
    assert.match(request.headers.get('authorization')!, /SignedHeaders=.*host/);
  }
  assert.equal(new URL(requests[1].url).pathname, '/2025-09-09/microvms/vm%2Fa');
  assert.equal(new URL(requests[1].url).search, '?maxItems=1');
  await assert.rejects(api('Unknown', {}), /Unknown/);
  assert.throws(() => testEndpoint('https://lambda.us-west-2.amazonaws.com', { TEST_MODE: '1' }));
  assert.throws(() => testEndpoint('http://127.0.0.1:1', {}));
  await assert.rejects(boundedResponse(new Response('x'.repeat(100)), 10), /exceeds limit/);
});
test('managed Lambda fake endpoint executes lifecycle and stable command receipt without using AWS', async () => {
  const seen: { path: string; method: string; body: any }[] = [];
  const driver = microvmDriver(fakeEnv, 'tenant', async request => {
    const path = new URL(request.url).pathname, body = request.method === 'POST' ? await request.json() : undefined;
    seen.push({ path, method: request.method, body });
    if (path === '/2025-09-09/microvms' && request.method === 'POST') return Response.json({ microvmId: 'vm-1', endpoint: fakeEnv.TEST_MICROVM_ENDPOINT });
    if (path.endsWith('/auth-token')) return Response.json({ authToken: { authorization: 'fixture-proxy-token' } });
    if (path === '/health') return Response.json({ ok: true });
    if (path === '/exec') return Response.json({ exitCode: 0, stdout: 'ok', stderr: '', truncated: false });
    if (path.endsWith('/vm-1')) return Response.json({ state: 'TERMINATED' });
    throw new Error(`Unexpected fake request ${path}`);
  });
  let allocated;
  const ref = await driver.create('stable-connection', 7200, async r => { allocated = r; });
  assert.deepEqual(ref, allocated);
  assert.equal(seen[0].body.clientToken, 'stable-connection');
  assert.equal(seen[0].body.idlePolicy.autoResumeEnabled, true);
  assert.deepEqual(await driver.call(ref, 'computer_exec', { requestKey: 'stable-exec', command: 'echo ok', timeoutSeconds: 60 }), { exitCode: 0, stdout: 'ok', stderr: '', truncated: false });
  const exec = seen.find(r => r.path === '/exec')!;
  assert.match(exec.body.requestKey, /^[a-f0-9]{64}$/);
  await driver.close(ref);
  assert.ok(seen.some(r => r.method === 'DELETE'));
});
test('native Sprites and Tunnel adapters bound output and use the source provider protocols', async () => {
  for (const provider of ['sprites','tunnel'] as const) {
    const seen: Request[] = [];
    const driver = remoteDriver({ TEST_MODE: '1', TEST_COMPUTER_ENDPOINT: 'http://127.0.0.1:9999' }, 'tenant', 'agent', provider, { apiKey: 'fixture', url: 'https://machine.example.com' }, async request => {
      seen.push(request);
      const path = new URL(request.url).pathname;
      if (path.endsWith('/exec')) return provider === 'sprites' ? new Response('\x01'+JSON.stringify({ code: 0, stdout: 'done', stderr: '' })+'\x03\x00') : Response.json({ exit_code: 0, stdout: 'done', stderr: '' });
      if (path.endsWith('/claim')) return Response.json({ id: 'claimed' });
      if (path.endsWith('/sprites')) return Response.json({ name: 'session' });
      return Response.json({});
    });
    const ref = await driver.create('session', 60);
    assert.equal((await driver.call(ref, 'computer_exec', { command: 'echo done', timeoutSeconds: 60, requestKey: 'key' }) as any).stdout, 'done');
    await driver.close(ref);
    assert.ok(seen.every(r => new URL(r.url).origin === 'http://127.0.0.1:9999'));
    assert.ok(seen.every(r => r.headers.get('authorization') === 'Bearer fixture'));
  }
});
test('MicroVM state accounting reuses active and suspended intervals from the Node runtime', () => {
  const startedAt = '2026-11-05T00:00:00Z', start = Date.parse(startedAt);
  const suspended = observe(undefined, { state: 'SUSPENDED', startedAt }, start + 10000);
  const resumed = observe(suspended, { state: 'RUNNING', startedAt }, start + 30000);
  assert.equal(resumed.seconds, 10); assert.equal(resumed.suspendedSeconds, 20);
  assert.equal(resumed.suspends, 1); assert.equal(resumed.resumes, 1); assert.ok(microvmCost(resumed) > 0);
});

test('Daytona REST transport waits for readiness and confirms deletion', async () => {
  const seen: string[] = [];
  let deleted = false;
  const driver = remoteDriver({ TEST_MODE: '1', TEST_COMPUTER_ENDPOINT: 'http://127.0.0.1:9999' }, 'tenant', 'agent', 'daytona', { apiKey: 'fixture' }, async request => {
    const path = new URL(request.url).pathname;
    seen.push(`${request.method} ${path}`);
    if (request.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }); }
    if (deleted) return new Response(null, { status: 404 });
    if (path.endsWith('/process/execute')) return Response.json({ exitCode: 0, result: 'ready' });
    return Response.json({ id: 'daytona-fixture', state: 'started' });
  });
  const ref = await driver.create('session', 60);
  assert.equal((await driver.call(ref, 'computer_exec', { command: 'echo ready', timeoutSeconds: 60 }) as any).stdout, 'ready');
  await driver.close(ref);
  assert.ok(seen.includes('GET /api/sandbox/daytona-fixture'));
});
