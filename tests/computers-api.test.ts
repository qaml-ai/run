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
