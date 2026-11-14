import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startFixture } from './fixture.ts';

const textOf = (body: any) => body.messages.map((message: any) => typeof message.content === 'string' ? message.content : (message.content ?? []).map((part: any) => part.text ?? '').join('\n')).join('\n');
const toolCall = (name: string, args: unknown, id: string) => ({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const free = { prompt_tokens: 1, completion_tokens: 1, cost: 0 };
async function until(check: () => unknown | Promise<unknown>, description: string, timeout = 15_000): Promise<any> {
  const deadline = Date.now() + timeout;
  do { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 25)); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`);
}
async function setup(t: any, respond: (body: any) => object, options: Parameters<typeof startFixture>[0] = {}) {
  const bodies: any[] = [];
  const provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    const { wait, ...delta } = respond(body) as any;
    if (wait) await wait;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }], usage: free })}\n\ndata: [DONE]\n\n`);
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(() => { provider.closeAllConnections(); return new Promise<void>(resolve => provider.close(() => resolve())); });
  const model = { url: `http://127.0.0.1:${(provider.address() as any).port}/v1`, bodies };
  const fixture = await startFixture({ ...options, modelURL: model.url });
  t.after(() => fixture.stop());
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(fixture.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as any;
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  return { fixture, model, call };
}

test('a delegated child clears its negative attachment hint before waking with the inherited connection', { timeout: 90_000 }, async t => {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const { fixture, model, call } = await setup(t, body => {
    if (textOf(body).includes('HINT_HELPER')) return { role: 'assistant', content: 'child done', wait: gate.promise };
    if (body.messages.at(-1).role === 'tool') return { role: 'assistant', content: 'parent done' };
    return toolCall('delegate', { instructions: 'HINT_HELPER', task: 'Do the work', computer: 'fresh' }, 'delegate-hint');
  }, {
    entrypoint: fileURLToPath(new URL('./computer-hint-entry.ts', import.meta.url)),
    vars: { PILOT_DB_PROFILE: '1', TEST_HOOKS: '1' },
  });
  const { id: parent } = await call('/v1/agents', { codeMode: false, fileTools: false, builtins: ['delegate'], delegate: { instructions: true } });
  const connection = await call('/v1/computers', { agent: parent, provider: 'e2b', credentials: { apiKey: 'fixture-only' } });
  await call(`/v1/agents/${parent}/prompt`, { text: 'start' });
  await until(() => model.bodies.some(body => textOf(body).includes('HINT_HELPER')), 'child reached model');
  const { rows } = await fixture.db.query("select agent,id from computer_connections where agent<>$1", [parent]);
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].id, connection.id);
  const state = await call(`/experimental/agents/${rows[0].agent}/__test/computer-hint`);
  assert.equal(state.afterConfiguration, false);
  assert.equal(state.afterInheritance.hint, null);
  const queries = state.afterInheritance.profile.phases.other.statements;
  assert.ok(queries['select:agents+computer_connections']?.queries > 0, 'wake swept the inherited connection');
  assert.ok(queries['select:computer_connections+computer_leases']?.queries > 0, 'wake checked the next lease deadline');
  gate.resolve();
});
