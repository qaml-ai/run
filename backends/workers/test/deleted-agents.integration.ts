import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { startFixture } from './fixture.ts';

// A deleted agent is gone for good: what other objects still owe it (a child's ending, a workflow's notices, a cancel)
// is answered once and dropped, never retried for days (the "Agent deleted" storm, 2026-11-12). A restart that wakes
// every object again changes nothing.
const textOf = (body: any) => body.messages.map((message: any) => typeof message.content === 'string' ? message.content : (message.content ?? []).map((part: any) => part.text ?? '').join('\n')).join('\n');
const toolCall = (name: string, args: unknown, id: string) => ({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const free = { prompt_tokens: 1, completion_tokens: 1, cost: 0 };
async function until(check: () => unknown | Promise<unknown>, description: string, timeout = 20_000): Promise<any> {
  const deadline = Date.now() + timeout;
  do { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < deadline);
  throw new Error(`Timed out: ${description}`);
}

test('a deleted owner answers its child\'s ending and its workflow\'s notices once; nothing is retried, before or after a restart', { timeout: 300_000 }, async t => {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const bodies: any[] = [];
  const provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); bodies.push(body);
    const text = textOf(body);
    let delta: any;
    if (text.includes('GONE_HELPER')) { await gate.promise; delta = { role: 'assistant', content: 'child-answer' }; }
    else if (body.messages.at(-1).role === 'tool') delta = { role: 'assistant', content: 'started' };
    // The workflow's one agent answers after 5 s, so the workflow ends after its owner is gone.
    else if (text.includes('WF_CHILD')) { await new Promise(resolve => setTimeout(resolve, 5_000)); delta = { role: 'assistant', content: 'done' }; }
    else if (text.includes('START_WORKFLOW')) delta = toolCall('workflow_start', { script: 'await agent("WF_CHILD"); return 1;', budgetUsd: 1, name: 'gone-owner' }, 'wf-start');
    else delta = toolCall('spawn_agent', { instructions: 'GONE_HELPER', task: 'Wait', name: 'helper' }, 'spawn-gone');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ id: 'f', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }], usage: free })}\n\ndata: [DONE]\n\n`);
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  t.after(() => { provider.closeAllConnections(); return new Promise<void>(resolve => provider.close(() => resolve())); });
  const fixture = await startFixture({ modelURL: `http://127.0.0.1:${(provider.address() as any).port}/v1`, vars: { AGENT_WORKFLOW_TENANTS: '*' } });
  t.after(() => fixture.stop());
  const call = async (path: string, body?: unknown, method?: string) => {
    const response = await fetch(fixture.url + path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as any;
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  const make = async (text: string) => {
    const agent = await call('/v1/agents', { codeMode: false, fileTools: false, builtins: ['agents'], delegate: { instructions: true } });
    const started = await call(`/v1/agents/${agent.id}/prompt`, { text });
    await until(async () => (await call(`/v1/agents/${agent.id}/requests/${started.id}`)).state === 'completed', 'owner turn completed');
    return agent.id as string;
  };
  // One owner whose background child is mid-run; one that started a workflow, which ends after the owner is gone.
  const parent = await make('start');
  await until(() => bodies.some(body => textOf(body).includes('GONE_HELPER')), 'child reached the model');
  const workflowOwner = await make('START_WORKFLOW');
  for (const id of [parent, workflowOwner]) await call(`/v1/agents/${id}`, undefined, 'DELETE');
  gate.resolve();

  const gone = () => (fixture.worker.logs().match(/\{"type":"deleted_agent_rpc"[^}]*\}/g) ?? []).map(line => JSON.parse(line));
  // The workflow ends (5 s), and its notices meet the gone owner: one answer, all dropped.
  await until(() => fixture.worker.logs().includes('"reason":"owner_gone"'), 'the workflow\'s notices dropped', 60_000);
  // Long enough for the old backoff to have retried several times (1, 2, 4, 8, 16 s).
  await new Promise(resolve => setTimeout(resolve, 35_000));
  const before = gone();
  const notices = before.filter(entry => entry.method === 'receiveAgentMessage' && entry.caller === 'workflow');
  assert.equal(notices.length, 1, `one notice reached the gone owner: ${JSON.stringify(before)}`);
  assert.ok(before.filter(entry => entry.method === 'receiveEnding').length <= 1, `the child's ending was answered at most once: ${JSON.stringify(before)}`);
  assert.doesNotMatch(fixture.worker.logs(), /Uncaught Error: Agent (deleted|expired)/);
  // Owing nothing more, the gone owners went quiet: no job and no alarm left to wake them.
  const quiet = (fixture.worker.logs().match(/\{"type":"deleted_agent_quiet"[^}]*\}/g) ?? []).map(line => JSON.parse(line).agent);
  for (const id of [parent, workflowOwner]) assert.ok(quiet.includes(id), `${id} went quiet: ${JSON.stringify(quiet)}`);

  // A restart wakes every object with an alarm: still nothing is sent to the gone owners, and nothing throws.
  await fixture.restart();
  await new Promise(resolve => setTimeout(resolve, 30_000));
  assert.deepEqual(gone().slice(before.length), [], 'nothing calls a gone owner after a restart');
  assert.doesNotMatch(fixture.worker.logs(), /Uncaught Error: Agent (deleted|expired)/);
});
