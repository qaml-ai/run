import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime, AgentError, type WorkflowSummary } from '../clients/typescript.ts';
import { Agents } from '../clients/agents.ts';

type Seen = { method: string; path: string; query: Record<string, string>; body: unknown; idempotencyKey: string | null };

/** A runtime whose fetch records every request and answers from `answer`. */
function fakeRuntime(answer: (seen: Seen, count: number) => unknown) {
  const requests: Seen[] = [];
  const runtime = new AgentRuntime({ url: 'https://runtime.example', apiKey: 'test-key', fetch: async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('Authorization'), 'Bearer test-key');
    const seen: Seen = { method: init?.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), body: init?.body ? JSON.parse(String(init.body)) : undefined, idempotencyKey: headers.get('Idempotency-Key') };
    requests.push(seen);
    const value = answer(seen, requests.length);
    return value instanceof Response ? value : Response.json(value, { status: seen.method === 'POST' && seen.path === '/v1/workflows' ? 201 : 200 });
  } });
  return { runtime, requests };
}

const summary = (status: WorkflowSummary['status'], extra: Partial<WorkflowSummary> = {}): WorkflowSummary => ({
  id: 'wf_abc', status, step: 2, budget: { usd: 20 }, concurrency: 8,
  spent: { usd: 1.5, calls: 3, inputTokens: 100, cachedInputTokens: 0, outputTokens: 50 }, counts: { done: 3 }, createdAt: 1, updatedAt: 2, ...extra,
});

test('start posts the script, budget and the rest, with the Idempotency-Key header when given', async () => {
  const { runtime, requests } = fakeRuntime(() => summary('running'));
  const script = 'const out = await parallel(args.files.map(file => () => agent(`Port ${file}`, { key: `port:${file}` }))); return out;';
  const started = await runtime.workflows.start({ script, args: { files: ['a.ts'] }, budget: { usd: 20 }, concurrency: 4, classes: { worker: 'strong' }, name: 'port' }, { idempotencyKey: 'port-1' });
  assert.equal(started.id, 'wf_abc');
  assert.deepEqual(requests, [{ method: 'POST', path: '/v1/workflows', query: {}, idempotencyKey: 'port-1',
    body: { script, args: { files: ['a.ts'] }, budget: { usd: 20 }, concurrency: 4, classes: { worker: 'strong' }, name: 'port' } }]);

  await runtime.workflows.start({ script, budget: { usd: null } });
  assert.equal(requests[1]!.idempotencyKey, null);
  assert.deepEqual(requests[1]!.body, { script, budget: { usd: null } });
});

test('reads: get, items with its filters, events after a cursor', async () => {
  const { runtime, requests } = fakeRuntime(seen => seen.path.endsWith('/items') ? { items: [], next: 7 } : seen.path.endsWith('/events') ? { events: [] } : summary('running', { step: 4 }));
  assert.equal((await runtime.workflows.get('wf_abc')).step, 4);
  assert.deepEqual(await runtime.workflows.items('wf_abc', { after: 3, limit: 50, status: 'failed', kind: 'agent' }), { items: [], next: 7 });
  await runtime.workflows.items('wf_abc');
  assert.deepEqual(await runtime.workflows.events('wf_abc', { after: 12 }), { events: [] });
  assert.deepEqual(requests.map(seen => [seen.method, seen.path, seen.query]), [
    ['GET', '/v1/workflows/wf_abc', {}],
    ['GET', '/v1/workflows/wf_abc/items', { after: '3', limit: '50', status: 'failed', kind: 'agent' }],
    ['GET', '/v1/workflows/wf_abc/items', {}],
    ['GET', '/v1/workflows/wf_abc/events', { after: '12' }],
  ]);
  assert.ok(requests.every(seen => seen.body === undefined && seen.idempotencyKey === null));
});

test('pause, resume, abort and budget post their bodies (no edit: a workflow is changed by starting a new one)', async () => {
  const { runtime, requests } = fakeRuntime(() => summary('paused', { pauseReason: 'user' }));
  assert.equal((runtime.workflows as unknown as { edit?: unknown }).edit, undefined);
  assert.equal((await runtime.workflows.pause('wf_abc', { children: 'abort' })).pauseReason, 'user');
  await runtime.workflows.pause('wf_abc');
  await runtime.workflows.resume('wf_abc');
  await runtime.workflows.abort('wf_abc');
  await runtime.workflows.budget('wf_abc', 40);
  await runtime.workflows.budget('wf_abc', null);
  assert.deepEqual(requests.map(seen => [seen.method, seen.path, seen.body]), [
    ['POST', '/v1/workflows/wf_abc/pause', { children: 'abort' }],
    ['POST', '/v1/workflows/wf_abc/pause', {}],
    ['POST', '/v1/workflows/wf_abc/resume', {}],
    ['POST', '/v1/workflows/wf_abc/abort', {}],
    ['POST', '/v1/workflows/wf_abc/budget', { usd: 40 }],
    ['POST', '/v1/workflows/wf_abc/budget', { usd: null }],
  ]);
});

test('wait polls until the workflow settles, and gives up after timeoutMs with the latest summary', async () => {
  const { runtime, requests } = fakeRuntime((_, count) => summary(count < 3 ? 'running' : 'completed', count < 3 ? {} : { result: { ported: 12 } }));
  const done = await runtime.workflows.wait('wf_abc', { pollMs: 1 });
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.result, { ported: 12 });
  assert.equal(requests.length, 3);
  assert.ok(requests.every(seen => seen.method === 'GET' && seen.path === '/v1/workflows/wf_abc'));

  for (const status of ['paused', 'budget_exhausted', 'failed', 'aborted'] as const) {
    const settled = fakeRuntime(() => summary(status));
    assert.equal((await settled.runtime.workflows.wait('wf_abc', { pollMs: 1 })).status, status);
    assert.equal(settled.requests.length, 1);
  }

  const stuck = fakeRuntime(() => summary('running'));
  // pollMs is at least 100 ms; it gives up when the next poll would pass the deadline, so 250 ms is two or three polls.
  await assert.rejects(stuck.runtime.workflows.wait('wf_abc', { pollMs: 100, timeoutMs: 250 }), (error: AgentError & { workflow?: WorkflowSummary }) => {
    assert.ok(error instanceof AgentError);
    assert.match(error.message, /still running after 250 ms/);
    assert.equal(error.workflow?.status, 'running');
    return true;
  });
  assert.ok(stuck.requests.length >= 2 && stuck.requests.length <= 3, `polled ${stuck.requests.length} times`);
});

test('the runtime refuses malformed workflow ids before sending, and surfaces WORKFLOWS_OFF', async () => {
  const { runtime, requests } = fakeRuntime(() => Response.json({ error: 'Workflows are not enabled for this account yet. Ask us to turn them on.', code: 'WORKFLOWS_OFF' }, { status: 403 }));
  assert.throws(() => runtime.workflows.get('not-a-workflow'), /Invalid workflow id/);
  assert.equal(requests.length, 0);
  await assert.rejects(runtime.workflows.get('wf_abc'), (error: AgentError & { code?: string }) => error.status === 403 && error.code === 'WORKFLOWS_OFF');
});

test('Agents exposes the same workflows client, and upsert sends the workflows setting', async () => {
  const agents = new Agents({ url: 'https://runtime.example', apiKey: 'test-key' });
  assert.equal(agents.workflows, agents.runtime.workflows);
  let body: Record<string, unknown> | undefined;
  const runtime = new AgentRuntime({ url: 'https://runtime.example', apiKey: 'test-key', fetch: async (_, init) => { body = JSON.parse(String(init?.body)); return Response.json({ id: 'client_1', token: 't' }); } });
  await runtime.upsertAgent('lead', { delegate: { agents: ['worker'] }, workflows: { maxBudgetUsd: 25 } });
  assert.deepEqual(body?.workflows, { maxBudgetUsd: 25 });
  assert.deepEqual(body?.builtins, ['delegate']);
  await runtime.upsertAgent('lead', { delegate: { agents: ['worker'] }, workflows: false });
  assert.equal(body?.workflows, false);
});
