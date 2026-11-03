import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtime, toolCall, OTHER_OPERATOR } from './runtime-server.ts';

for (const provider of ['daytona', 'sprites']) test(`native ${provider} computer API is tenant scoped and tools refresh on an existing agent`, async t => {
  const seen: string[][] = [];
  const r = await runtime(t, (body, index) => {
    seen.push((body.tools ?? []).map((tool: any) => tool.function.name));
    return index === 1 ? toolCall('computer_status', {}, 'status') : { role: 'assistant', content: 'done' };
  });
  const made = await r.call('/v1/agents', { body: { name: 'Computer test', codeMode: false, fileTools: false } });
  assert.equal(made.status, 201, made.text);
  const agent = made.json.id;
  await r.prompt(agent, 'Before connecting');
  assert.ok(!seen[0].includes('computer_status'));
  const input = { agent, provider, credentials: { apiKey: 'test-secret-do-not-return' }, leaseSeconds: 60, dailySeconds: 120 };
  assert.equal((await r.call('/v1/computers', {body:{...input, credentials:{}}})).status, 400);
  assert.equal((await r.call('/v1/computers', {body:{...input, credentials:{...input.credentials, tokenId:'extra'}}})).status, 400);
  assert.equal((await r.call('/v1/computers', { body: input, token: OTHER_OPERATOR })).status, 404);
  const connected = await r.call('/v1/computers', { body: input });
  assert.equal(connected.status, 201, connected.text);
  assert.doesNotMatch(connected.text, /test-secret-do-not-return/);
  assert.equal((await r.call('/v1/computers', { body: input })).status, 409);
  await r.prompt(agent, 'Inspect the computer');
  assert.ok(seen[1].includes('computer_status'));
  assert.ok(seen[1].includes('computer_exec'));
  const result = await r.call(`/v1/agents/${agent}/computer`);
  assert.equal(result.json.session, null);
  assert.equal((await r.call(`/v1/agents/${agent}/computer`, { token: OTHER_OPERATOR })).status, 404);
  assert.equal((await r.call(`/v1/computers/${connected.json.id}`, { method: 'DELETE', token: OTHER_OPERATOR })).status, 404);
  assert.equal((await r.call(`/v1/computers/${connected.json.id}`, { method: 'DELETE' })).status, 200);
  await r.prompt(agent, 'After disconnecting');
  assert.ok(!seen.at(-1)!.includes('computer_status'));
});

test('a computer connected during eager startup is available on the first turn', async t => {
  const r = await runtime(t, (_body,index) => index === 0 ? toolCall('computer_status',{},'first') : { role:'assistant', content:'done' });
  const agent = (await r.call('/v1/agents',{body:{name:'New computer agent',codeMode:false,fileTools:false}})).json.id;
  assert.equal((await r.call('/v1/computers',{body:{agent,provider:'daytona',credentials:{apiKey:'fake'},leaseSeconds:60,dailySeconds:120}})).status,201);
  await r.prompt(agent,'Inspect your computer');
  assert.ok(r.model.bodies[0].tools.some((tool: any) => tool.function.name === 'computer_status'));
  const result = r.model.bodies[1].messages.find((message: any) => message.role === 'tool');
  assert.doesNotMatch(JSON.stringify(result), /unavailable|not available|error/);
});


for (const builtin of ['delegate', 'agents']) for (const subagents of [true, false]) test(`${builtin} child creation inherits computer attachments: ${subagents}`, async t => {
  const r = await runtime(t, body => {
    const system = body.messages.filter((m: any) => m.role === 'system' || m.role === 'developer').map((m: any) => JSON.stringify(m.content)).join(' ');
    if (!system.includes('COMPUTER_PARENT') || body.messages.some((m: any) => m.role === 'tool')) return { role: 'assistant', content: 'done' };
    return toolCall(builtin === 'agents' ? 'spawn_agent' : 'delegate', { agent: 'worker', task: 'child task' }, 'child');
  });
  await r.call('/v1/definitions', { headers: { 'Idempotency-Key': 'worker' }, body: { name: 'Worker', systemPrompt: 'COMPUTER_CHILD' } });
  const parent = (await r.call('/v1/agents', { body: { systemPrompt: 'COMPUTER_PARENT', builtins: [builtin], delegate: { agents: ['worker'] } } })).json.id;
  const attached = await r.call('/v1/computers', { body: { agent: parent, provider: 'e2b', credentials: { apiKey: 'fixture-only' }, subagents } });
  assert.equal(attached.status, 201, attached.text);
  assert.equal(attached.json.subagents, subagents);
  const run = await r.prompt(parent, 'start');
  const child = run.outcome.result.toolCalls.find((c: any) => c.agentId)?.agentId;
  assert.ok(child);
  const status = await r.call(`/v1/agents/${child}/computer`);
  assert.equal(status.status, subagents ? 200 : 404, status.text);
  if (subagents) {
    assert.notEqual(status.json.connection.id, attached.json.id);
    assert.equal(status.json.connection.provider, 'e2b');
    assert.equal(status.json.connection.subagents, true);
    assert.equal(status.json.session, null);
    assert.equal((await r.call(`/v1/agents/${parent}/computer`)).json.session, null);
  }
  await r.call(`/v1/agents/${child}`, { method: 'DELETE' });
  assert.ok(!(await r.call('/v1/computers')).json.some((c: any) => c.agent === child));
});
