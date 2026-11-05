import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { startFixture } from './fixture.ts';

const textOf = (body: any) => body.messages.map((message: any) => typeof message.content === 'string' ? message.content : (message.content ?? []).map((part: any) => part.text ?? '').join('\n')).join('\n');
const lastUser = (body: any) => textOf({ messages: body.messages.filter((message: any) => message.role === 'user').slice(-1) });
const toolCall = (name: string, args: unknown, id: string) => ({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const free = { prompt_tokens: 1, completion_tokens: 1, cost: 0 };
async function until(check: () => unknown | Promise<unknown>, description: string, timeout = 15_000): Promise<any> {
  const deadline = Date.now() + timeout;
  do { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 25)); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`);
}
async function setup(t: any, respond: (body: any) => object) {
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
  const fixture = await startFixture({ modelURL: model.url });
  t.after(() => fixture.stop());
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(fixture.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as any;
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  return { fixture, model, call };
}

test('workerd resumes background child after eviction and delivers one trusted notification', { timeout: 90_000 }, async t => {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const { fixture, model, call } = await setup(t, body => {
    if (textOf(body).includes('BACKGROUND_HELPER')) return { role: 'assistant', content: 'child-answer', wait: gate.promise };
    if (lastUser(body).includes('<agent_notification')) return { role: 'assistant', content: 'observed child-answer' };
    if (body.messages.at(-1).role === 'tool') return { role: 'assistant', content: 'started' };
    return toolCall('spawn_agent', { instructions: 'BACKGROUND_HELPER', task: 'Complete your task', name: 'helper' }, 'spawn-first');
  });
  const agent = await call('/v1/agents', { codeMode: false, fileTools: false, builtins: ['agents'], delegate: { instructions: true } });
  const started = await call(`/v1/agents/${agent.id}/prompt`, { text: 'start' });
  await until(async () => (await call(`/v1/agents/${agent.id}/requests/${started.id}`)).state === 'completed', 'parent completed');
  await until(() => model.bodies.some(body => textOf(body).includes('BACKGROUND_HELPER')), 'child reached model');
  const linked = await fixture.db.query("select header->>'parentAgentId' as parent, header->>'parentRunId' as run from agents where header->'config'->>'type' = 'subagent'");
  assert.deepEqual(linked.rows, [{ parent: agent.id, run: started.id }]);
  await fixture.worker.stop(true);
  await fixture.worker.start();
  await call(`/v1/agents/${agent.id}/history`);
  gate.resolve();
  const history = await until(async () => {
    const history = await call(`/v1/agents/${agent.id}/history`);
    return history.messages.some((message: any) => message.role === 'assistant' && JSON.stringify(message.content).includes('observed child-answer')) && history;
  }, 'recovered child notification reached parent', 30_000);
  assert.equal(history.messages.filter((message: any) => message.source?.kind === 'agent').length, 1);
  assert.ok(model.bodies.some(body => lastUser(body).includes('<agent_notification name="helper" status="completed">')));
});

test('workerd cancels a delegated child when its parent run is aborted', { timeout: 90_000 }, async t => {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const { fixture, model, call } = await setup(t, body => textOf(body).includes('CANCEL_HELPER')
    ? { role: 'assistant', content: 'should-not-finish', wait: gate.promise }
    : toolCall('delegate', { instructions: 'CANCEL_HELPER', task: 'Wait for work' }, 'delegate-first'));
  const agent = await call('/v1/agents', { codeMode: false, fileTools: false, builtins: ['delegate'], delegate: { instructions: true } });
  const started = await call(`/v1/agents/${agent.id}/prompt`, { text: 'start' });
  await until(() => model.bodies.some(body => textOf(body).includes('CANCEL_HELPER')), 'child reached model');
  const rows = await fixture.db.query("select id from agents where header->'config'->>'type' = 'subagent'");
  assert.equal(rows.rows.length, 1);
  const child = rows.rows[0].id;
  const childRequest = `delegate_${createHash('sha256').update(`${started.id}:delegate-first`).digest('hex').slice(0, 48)}`;
  await call(`/v1/agents/${agent.id}/requests`, { id: 'cancel-parent', method: 'abort', params: {} });
  const ended = await until(async () => { const record = await call(`/v1/agents/${child}/requests/${childRequest}`); return record.state === 'completed' && record; }, 'child aborted', 20_000);
  assert.ok(['aborted', 'cancelled'].includes(ended.outcome?.result?.code), JSON.stringify(ended));
  const parent = await call(`/v1/agents/${agent.id}/requests/${started.id}`);
  assert.equal(parent.state, 'completed');
  assert.ok(['aborted', 'cancelled'].includes(parent.outcome?.result?.code), JSON.stringify(parent));
  const removed = await fetch(`${fixture.url}/v1/agents/${agent.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${fixture.token}` } });
  assert.equal(removed.status, 200, await removed.text());
  const missing = await fetch(`${fixture.url}/v1/agents/${child}`, { headers: { authorization: `Bearer ${fixture.token}` } });
  assert.equal(missing.status, 404);
});

test('workerd child reports progress and messages its signed parent without ending its task', { timeout: 90_000 }, async t => {
  const { call, model } = await setup(t, body => {
    if (textOf(body).includes('MESSAGING_HELPER')) {
      const calls = body.messages.filter((message: any) => message.role === 'tool').length;
      if (!calls) return toolCall('report_progress', { text: 'Read the source' }, 'progress-first');
      if (calls === 1) return toolCall('send_message', { to: 'parent', text: 'question-from-child' }, 'message-first');
      return { role: 'assistant', content: 'helper-completed' };
    }
    if (lastUser(body).includes('<agent_message')) return { role: 'assistant', content: 'ack-message' };
    if (lastUser(body).includes('<agent_notification')) return { role: 'assistant', content: 'ack-completed' };
    if (body.messages.at(-1).role === 'tool') return { role: 'assistant', content: 'parent-started' };
    return toolCall('spawn_agent', { instructions: 'MESSAGING_HELPER', task: 'Work and keep me informed', name: 'helper' }, 'spawn-message');
  });
  const agent = await call('/v1/agents', { codeMode: false, fileTools: false, builtins: ['agents'], delegate: { instructions: true } });
  await call(`/v1/agents/${agent.id}/prompt`, { text: 'start' });
  const history = await until(async () => {
    const history = await call(`/v1/agents/${agent.id}/history`);
    return history.messages.some((message: any) => message.role === 'assistant' && JSON.stringify(message.content).includes('ack-completed')) && history;
  }, 'parent received child message and ending', 30_000);
  const messages = history.messages.filter((message: any) => message.source?.kind === 'agent');
  assert.equal(messages.length, 2);
  assert.ok(messages.some((message: any) => message.metadata.kind === 'message' && message.content === 'question-from-child'));
  assert.ok(model.bodies.some(body => lastUser(body).includes('<agent_message name="helper">')));
  const child = model.bodies.find(body => textOf(body).includes('MESSAGING_HELPER'));
  assert.ok(child.tools.some((tool: any) => tool.function.name === 'report_progress'));
  assert.ok(child.tools.some((tool: any) => tool.function.name === 'send_message'));
});
