import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { startFixture } from './fixture.ts';

test('Worker computer API keeps credentials private, scopes tenants, and persists fake Lambda commands', async t => {
  let starts = 0, execs = 0, terminated = false;
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const value = raw ? JSON.parse(raw) : undefined;
    const pathname = new URL(request.url!, 'http://localhost').pathname;
    response.setHeader('content-type', 'application/json');
    if (pathname.startsWith('/2025-09-09/')) assert.match(request.headers.authorization!, /\/us-west-2\/lambda\/aws4_request/);
    if (pathname === '/2025-09-09/microvms') { starts++; assert.ok(value.clientToken); response.end(JSON.stringify({ microvmId: 'vm-fixture', endpoint: endpoint })); }
    else if (pathname.endsWith('/auth-token')) response.end(JSON.stringify({ authToken: { authorization: 'fixture-proxy' } }));
    else if (pathname === '/health') response.end('{"ok":true}');
    else if (pathname === '/exec') { execs++; assert.equal(value.command, 'echo done'); response.end(JSON.stringify({ exitCode: 0, stdout: 'done', stderr: '', truncated: false })); }
    else if (pathname.endsWith('/vm-fixture')) {
      if (request.method === 'DELETE') terminated = true;
      response.end(JSON.stringify({ state: terminated ? 'TERMINATED' : 'RUNNING' }));
    }
    else { response.statusCode = 404; response.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const fixture = await startFixture({ tenants: [{ id: 'alice', token: 'alice-key' }, { id: 'bob', token: 'bob-key' }], tenant: 'alice', vars: {
    COMPUTER_MANAGED_ENABLED: '1', AWS_ACCESS_KEY_ID: 'fixture-access', AWS_SECRET_ACCESS_KEY: 'fixture-secret', AWS_REGION: 'us-west-2', MICROVM_IMAGE: 'fixture-image', TEST_MICROVM_ENDPOINT: endpoint,
  } });
  t.after(() => fixture.stop());
  const call = async (path: string, body?: unknown, token = fixture.token, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(fixture.url + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); return { status: response.status, text, json: JSON.parse(text) };
  };
  const agent = (await call('/v1/agents', { codeMode: false, fileTools: false })).json.id;
  const connection = { agent, provider: 'lambda', leaseSeconds: 60, dailySeconds: 120 };
  assert.equal((await call('/v1/computers', { ...connection, credentials: {} })).status, 400);
  assert.equal((await call('/v1/computers', connection, 'bob-key')).status, 404);
  const made = await call('/v1/computers', connection);
  assert.equal(made.status, 201, made.text);
  assert.equal((await call('/v1/computers', connection)).status, 409);
  assert.equal((await call(`/v1/agents/${agent}/computer`, undefined, 'bob-key')).status, 404);
  assert.equal((await call(`/v1/agents/${agent}/computer`)).json.session, null);
  const invoke = (operation: string, args: unknown, key: string) => call(`/v1/agents/${agent}/__computer`, { tenant: 'alice', operation, args, key });
  const started = await invoke('computer_start', {}, 'start-once');
  assert.equal(started.status, 200, started.text);
  assert.equal(started.json.state, 'active');
  assert.deepEqual((await invoke('computer_start', {}, 'start-once')).json, started.json);
  assert.equal(starts, 1);
  const result = await invoke('computer_exec', { command: 'echo done' }, 'exec-once');
  assert.equal(result.status, 200, result.text); assert.equal(result.json.stdout, 'done');
  assert.deepEqual((await invoke('computer_exec', { command: 'echo done' }, 'exec-once')).json, result.json);
  assert.equal(execs, 1);
  assert.equal((await invoke('computer_exec', { command: 'changed' }, 'exec-once')).status, 409);
  // Cron/alarms use this same DO-serialized sweep after the fixed lease deadline.
  await fixture.db.query('update computer_leases set expires_at=$2 where connection=$1', [made.json.id, Date.now()-1]);
  const { sweepComputers } = await import('../src/computers/service.ts');
  const repaired = await sweepComputers({ HYPERDRIVE: { connectionString: fixture.databaseUrl }, AGENTS: { getByName: (id: string) => ({ fetch: (request: Request) => fetch(`${fixture.url}/v1/agents/${id}/__computer`, { method: 'POST', headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' }, body: request.body, duplex: 'half' } as RequestInit) }) } } as any);
  assert.deepEqual(repaired, { checked: 1, failed: 0 });
  assert.equal((await call(`/v1/agents/${agent}/computer/stop`, {})).status, 200);
  const status = await call(`/v1/agents/${agent}/computer`);
  assert.equal(status.json.session.state, 'closed');
  assert.doesNotMatch(status.text + made.text, /fixture-secret|fixture-proxy|fixture-access/);
  assert.equal((await call(`/v1/computers/${made.json.id}`, undefined, 'bob-key', 'DELETE')).status, 404);
  assert.equal((await call(`/v1/computers/${made.json.id}`, undefined, fixture.token, 'DELETE')).status, 200);
  assert.equal((await call('/v1/computers')).json.length, 0);
  assert.equal(starts, 1);
});

test('computer attachment inheritance copies settings and credentials but never a session, and deletion detaches it', async t => {
  const { inheritComputer } = await import('../src/computers/service.ts');
  const fixture = await startFixture(); t.after(() => fixture.stop());
  const call = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(fixture.url + path, { method, headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, json: await response.json() as any };
  };
  const env = { HYPERDRIVE: { connectionString: fixture.databaseUrl }, API_TOKEN: fixture.token } as any;
  for (const subagents of [true, false]) {
    const parent = (await call('/v1/agents', { codeMode: false, fileTools: false })).json.id;
    const child = (await call('/v1/agents', { codeMode: false, fileTools: false })).json.id;
    const made = await call('/v1/computers', { agent: parent, provider: 'e2b', credentials: { apiKey: 'fixture-private' }, subagents });
    assert.equal(made.status, 201);
    await inheritComputer(env, 'camelrun-proto-local', parent, child);
    const inherited = await call(`/v1/agents/${child}/computer`);
    assert.equal(inherited.status, subagents ? 200 : 404);
    if (subagents) {
      assert.notEqual(inherited.json.connection.id, made.json.id);
      assert.equal(inherited.json.connection.provider, 'e2b'); assert.equal(inherited.json.connection.subagents, true); assert.equal(inherited.json.session, null);
      assert.doesNotMatch(JSON.stringify(inherited.json), /fixture-private/);
      await call(`/v1/agents/${child}`, undefined, 'DELETE');
      assert.ok(!(await call('/v1/computers')).json.some((c: any) => c.agent === child));
    }
  }
});

test('official E2B SDK creates and deletes only through the loopback fake endpoint', async t => {
  const { remoteDriver } = await import('../src/computers/remote.ts');
  const methods: string[] = [];
  const server = createServer(async (request, response) => {
    methods.push(request.method!);
    assert.equal(request.headers['x-api-key'], 'fixture-e2b');
    response.setHeader('content-type', 'application/json');
    if (request.method === 'POST') response.end(JSON.stringify({ sandboxID: 'e2b-fixture', clientID: 'fixture', templateID: 'base', envdVersion: '0.5.2', envdAccessToken: 'fixture-envd' }));
    else { response.statusCode = 204; response.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const driver = remoteDriver({ TEST_MODE: '1', TEST_COMPUTER_ENDPOINT: endpoint }, 'tenant', 'agent', 'e2b', { apiKey: 'fixture-e2b' });
  const reference = await driver.create('once', 60); assert.equal(reference.id, 'e2b-fixture');
  await driver.close(reference); assert.deepEqual(methods, ['POST', 'DELETE']);
});

test('browser tools need no shell command and provider calls retain the remaining lease', async t => {
  const { ComputerService } = await import('../src/computers/service.ts');
  const fixture = await startFixture(); t.after(() => fixture.stop());
  const env = { HYPERDRIVE: { connectionString: fixture.databaseUrl }, API_TOKEN: fixture.token } as any;
  const calls: { operation: string; args: Record<string, any> }[] = [];
  const service = new ComputerService(env, 'camelrun-proto-local', () => ({
    create: async () => ({ id: 'fixture-session' }),
    call: async (_ref, operation, args) => { calls.push({ operation, args }); return { ok: true }; },
    close: async () => {},
  }));
  const createAgent = async () => {
    const response = await fetch(fixture.url + '/v1/agents', { method: 'POST', headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ codeMode: false, fileTools: false }) });
    assert.equal(response.status, 201); return (await response.json() as any).id as string;
  };
  for (const provider of ['browserbase', 'browser-use'] as const) {
    const agent = await createAgent();
    await service.create({ agent, provider, credentials: { apiKey: 'fixture-browser' }, leaseSeconds: 600 });
    await service.call(agent, 'computer_start', {}, 'start');
    for (const [operation, args] of Object.entries({ browser_navigate: { url: 'https://example.com' }, browser_read: {}, browser_click: { selector: 'button' }, browser_fill: { selector: 'input', text: 'fixture' }, browser_evaluate: { expression: 'document.title' } })) {
      assert.deepEqual(await service.call(agent, operation, args, operation), { ok: true });
      assert.equal(calls.at(-1)?.operation, operation);
      assert.equal(calls.at(-1)?.args.command, undefined);
    }
  }
  const agent = await createAgent();
  await service.create({ agent, provider: 'e2b', credentials: { apiKey: 'fixture-e2b' }, leaseSeconds: 600 });
  await service.call(agent, 'computer_start', {}, 'start');
  await service.call(agent, 'computer_exec', { command: 'true', timeoutSeconds: 5 }, 'exec');
  assert.equal(calls.at(-1)?.args.timeoutSeconds, 5);
  assert.ok(calls.at(-1)!.args.remainingSeconds > 590, 'connect keeps the fixed lease instead of shortening it to the command timeout');
  await assert.rejects(service.call(agent, 'computer_exec', {}, 'invalid'), /Invalid computer command/);
});

test('a Lambda exec checks only its machine, shares first use and idle resume, and refuses explicit stops', async t => {
  const { ComputerService } = await import('../src/computers/service.ts');
  const { shareComputer } = await import('../../../src/core/computer-share.ts');
  const fixture = await startFixture(); t.after(() => fixture.stop());
  const env = { HYPERDRIVE: { connectionString: fixture.databaseUrl }, API_TOKEN: fixture.token, TEST_MODE: '1', COMPUTER_MANAGED_ENABLED: '1' } as any;
  const checked: string[] = [], commands: string[] = [];
  let running = true;
  const service = new ComputerService(env, 'camelrun-proto-local', (_env, _tenant, agent) => ({
    create: async () => ({ id: agent }), close: async () => {},
    running: async ref => { checked.push(ref.id); if (ref.id !== owner) throw new Error('other machine unavailable'); return running; },
    call: async ref => { commands.push(ref.id); running = true; return { exitCode: 0 }; },
  }));
  const create = async () => {
    const response = await fetch(fixture.url + '/v1/agents', { method: 'POST', headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ codeMode: false }) });
    return (await response.json() as any).id as string;
  };
  const owner = await create(), child = await create(), other = await create();
  for (const agent of [owner, other]) await service.create({ agent, provider: 'lambda' });
  await shareComputer(fixture.db as any, 'camelrun-proto-local', owner, child);
  await service.call(child, 'computer_exec', { command: 'true' }, 'shared-running');
  assert.deepEqual(checked, [owner]);
  running = false;
  await service.call(child, 'computer_exec', { command: 'true' }, 'shared-idle-resume');
  assert.equal(commands.length, 2);
  assert.equal((await fixture.db.query('select agent from computer_leases')).rows[0].agent, owner);
  await service.call(owner, 'computer_exec', { command: 'true' }, 'owner-resume');
  assert.equal(commands.length, 3);
  await service.call(owner, 'computer_stop', {}, 'explicit-stop');
  await assert.rejects(service.call(child, 'computer_exec', { command: 'true' }, 'shared-stopped'), (error: any) => error.code === 'COMPUTER_STOPPED');
  await service.call(owner, 'computer_start', {}, 'restart');
  const connection = (await service.status(owner)).connection.id;
  await fixture.db.query('update computer_leases set expires_at=1 where connection=$1', [connection]);
  await assert.rejects(service.call(child, 'computer_exec', { command: 'true' }, 'expired'), /parent's machine is stopped/);
  assert.equal(commands.length, 3);
});
