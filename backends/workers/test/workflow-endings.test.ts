import test from 'node:test';
import assert from 'node:assert/strict';
import { Delegation, type DelegationHost } from '../src/delegation.ts';
import { WorkflowEndings, endingRecord, ENDING_RESULT_CHARS, type EndingSummary } from '../src/workflow-endings.ts';
import { workflowNext, workflowTools } from '../src/workflow-tools.ts';
import { openRequest } from '../src/agent-types.ts';
import type { ChildEnding } from '../src/ending-outbox.ts';
import { withSql } from './sql-storage.ts';

// A workflow's endings are a child's (docs/design/workflow-simplification.md, cut 3): workflow_start writes the owner's
// row, the workflow object stages each ending (and each budget or payer stop) in its own outbox with its status, and
// the owner takes it once, as any child's. Exactly once: redelivery, a crash between stage and deliver, a gone owner.

function memory() {
  const values = new Map<string, unknown>();
  const storage = {
    async get(key: string) { return structuredClone(values.get(key)); },
    async put(key: string, value: unknown) { values.set(key, structuredClone(value)); },
    async delete(key: string) { return values.delete(key); },
    async list({ prefix, limit }: { prefix: string; limit?: number }) { return new Map([...values].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).slice(0, limit ?? Infinity).map(([key, value]) => [key, structuredClone(value)])); },
    async transaction(work: (tx: unknown) => unknown) { return work(storage); },
    transactionSync<T>(work: () => T) { return work(); },
  };
  withSql(storage);
  return storage as unknown as DurableObjectStorage;
}

/** The owner agent: its delegation over its own storage, a running turn `parent-run`. */
function owner(options: { abort?: (id: string) => Promise<boolean> } = {}) {
  const events: any[] = [], tasks: Promise<unknown>[] = [], notified: string[] = [], aborted: string[] = [];
  const host = {
    storage: memory(),
    context: async () => ({ id: 'owner', config: {}, run: { id: 'parent-run' } }),
    async emit(event: unknown) { events.push(event); },
    async fetch() { assert.fail('a workflow child is never fetched as an agent'); },
    async cancelRequest() { assert.fail('a workflow child is never cancelled as an agent'); },
    async remove() { assert.fail('a workflow is never removed as a made agent'); },
    async notify(child: { requestId: string }) { notified.push(child.requestId); },
    abortWorkflow: options.abort ?? (async (id: string) => { aborted.push(id); return true; }),
    waitUntil(promise: Promise<unknown>) { tasks.push(promise); },
  } as unknown as DelegationHost;
  const delegation = new Delegation(host);
  return { delegation, events, notified, aborted, settle: () => Promise.all(tasks.splice(0)) };
}

/** The workflow object's side, over `storage` (a second instance over the same storage is the object after a crash). */
function workflow(deliver: (ending: ChildEnding) => Promise<{ accepted: boolean }>, storage = memory()) {
  const armed: number[] = [];
  const endings = new WorkflowEndings({
    storage, workflowId: 'wf_1', owner: () => ({ kind: 'agent', id: 'owner' }), name: () => 'review',
    receiveEnding: async (_owner, ending) => deliver(ending), arm: async at => { armed.push(at); },
  });
  return { storage, endings, armed };
}

const summary = (status: string, extra: Partial<EndingSummary> = {}): EndingSummary => ({ status, counts: { done: 2 }, spent: { usd: 0.4 }, budget: { usd: 1 }, ...extra });

test('the ending record: its exact line, its facts, its result cut at 16,000 characters; nothing for a run, a pause or a capacity wait', () => {
  const done = endingRecord('wf_1', 'review', summary('completed', { result: { ok: true } }))!;
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.outcome?.result, { reply: 'Workflow review completed.', output: { workflowId: 'wf_1', status: 'completed', result: { ok: true }, counts: { done: 2 }, spentUsd: 0.4, budgetUsd: 1 }, usage: { costUsd: 0 } });
  const failed = endingRecord('wf_1', 'review', summary('failed', { fault: { code: 'script_error', message: 'x is not defined' } }))!;
  assert.equal(failed.outcome?.result?.reply, 'Workflow review failed (script_error): x is not defined');
  assert.equal(failed.outcome?.error, 'x is not defined');
  assert.equal(endingRecord('wf_1', 'review', summary('failed', { error: 'boom' }))!.outcome?.result?.reply, 'Workflow review failed (error): boom');
  assert.equal(endingRecord('wf_1', 'review', summary('aborted'))!.outcome?.result?.reply, 'Workflow review was aborted.');
  const budget = endingRecord('wf_1', 'review', summary('budget_exhausted'))!;
  assert.deepEqual([budget.status, budget.outcome?.result?.stopped], ['stopped', 'budget_exhausted']);
  const payer = endingRecord('wf_1', 'review', summary('paused', { pauseReason: 'payer_exhausted' }))!;
  assert.deepEqual([payer.status, payer.outcome?.result?.stopped], ['stopped', 'payer_exhausted']);
  for (const quiet of [summary('running'), summary('waiting'), summary('paused', { pauseReason: 'user' }), summary('paused', { pauseReason: 'capacity_refused' })])
    assert.equal(endingRecord('wf_1', 'review', quiet), undefined, JSON.stringify(quiet));
  const big = endingRecord('wf_1', 'review', summary('completed', { result: 'x'.repeat(40_000) }))!;
  assert.ok(String((big.outcome?.result?.output as { result: string }).result).startsWith('x'.repeat(ENDING_RESULT_CHARS) + '… (cut at 16000'));
  assert.equal(workflowNext({ status: 'budget_exhausted' }), 'Its budget is spent: raise it with workflow_budget.');
  assert.equal(workflowNext({ status: 'failed', fault: { code: 'script_error', message: 'x' } }), 'To change it, abort it and start a new workflow: finished results are reused.');
  assert.equal(workflowNext({ status: 'completed' }), undefined);
});

test('a workflow_start registers a background child; its ending is taken once however often it comes, charging nothing', async () => {
  const o = owner();
  const row = await o.delegation.registerWorkflow({ id: 'wf_1', name: 'review', callId: 'call-start' });
  assert.deepEqual([row.requestId, row.status, row.background, row.workflow, row.made, row.attempt, row.depth], ['wf_1_a000001', 'running', true, true, true, 1, 1]);
  // Registered again (the call replayed): the same row.
  assert.equal((await o.delegation.registerWorkflow({ id: 'wf_1', name: 'review', callId: 'call-start' })).createdAt, row.createdAt);
  const w = workflow(ending => o.delegation.receiveEnding(ending));
  w.endings.statusWritten(summary('completed', { result: 42 }));
  // Written again (the status transaction replayed): one row in the outbox.
  w.endings.statusWritten(summary('completed', { result: 42 }));
  assert.equal(w.endings.pending(), 1);
  await w.endings.outbox.flush();
  assert.equal(w.endings.pending(), 0);
  await o.settle();
  const [taken] = await o.delegation.children();
  assert.deepEqual([taken!.status, taken!.spent], ['completed', 0]);
  assert.equal(await o.delegation.cost('parent-run'), 0, 'its children billed what it spent');
  // Redelivered (the object evicted before it removed its row): accepted, nothing more.
  assert.deepEqual(await o.delegation.receiveEnding({ agentId: 'wf_1', requestId: 'wf_1_a000001', record: endingRecord('wf_1', 'review', summary('completed'))! }), { accepted: true });
  await o.settle();
  assert.equal(o.events.filter(event => event.event?.type === 'subagent_end').length, 1);
  assert.deepEqual(o.notified, ['wf_1_a000001']);
});

test('a crash between staging and delivering: the next instance of the object delivers it, once', async () => {
  const o = owner();
  await o.delegation.registerWorkflow({ id: 'wf_1', name: 'review', callId: 'c' });
  const first = workflow(async () => assert.fail('the isolate died before it sent'));
  first.endings.statusWritten(summary('aborted'));
  const next = workflow(ending => o.delegation.receiveEnding(ending), first.storage);
  assert.equal(next.endings.pending(), 1);
  await next.endings.outbox.flush();
  await o.settle();
  assert.deepEqual(o.notified, ['wf_1_a000001']);
  assert.equal((await o.delegation.children())[0]!.status, 'aborted');
});

test('a budget stop ends the row\'s attempt; a raise opens the next; its ending lands on that one', async () => {
  const o = owner();
  await o.delegation.registerWorkflow({ id: 'wf_1', name: 'review', callId: 'c' });
  const w = workflow(ending => o.delegation.receiveEnding(ending));
  w.endings.statusWritten(summary('budget_exhausted'));
  assert.equal(w.endings.attempt(), 2, 'what it does next is the next attempt');
  await w.endings.outbox.flush();
  await o.settle();
  assert.equal((await o.delegation.children())[0]!.status, 'paused');
  // workflow_budget raised it: the row lists as running again, as its second attempt.
  await o.delegation.reopenWorkflow('wf_1');
  await o.delegation.reopenWorkflow('wf_1');
  const rows = await o.delegation.children();
  assert.deepEqual(rows.map(row => [row.requestId, row.status]).sort(), [['wf_1_a000001', 'paused'], ['wf_1_a000002', 'running']]);
  w.endings.statusWritten(summary('completed'));
  await w.endings.outbox.flush();
  await o.settle();
  assert.deepEqual((await o.delegation.children()).map(row => [row.requestId, row.status]).sort(), [['wf_1_a000001', 'paused'], ['wf_1_a000002', 'completed']]);
  assert.deepEqual(o.notified, ['wf_1_a000001', 'wf_1_a000002']);
});

test('a payer stop that resumes by itself: the next attempt\'s ending opens its row, even if it comes first', async () => {
  const o = owner();
  await o.delegation.registerWorkflow({ id: 'wf_1', name: 'review', callId: 'c' });
  const held: ChildEnding[] = [];
  const w = workflow(async ending => { held.push(ending); return { accepted: true }; });
  w.endings.statusWritten(summary('paused', { pauseReason: 'payer_exhausted' }));
  w.endings.statusWritten(summary('completed'));
  await w.endings.outbox.flush();
  assert.deepEqual(held.map(ending => ending.requestId), ['wf_1_a000001', 'wf_1_a000002'], 'sent in attempt order');
  // Arriving out of order (the first's delivery failed and was retried later): each lands on its own attempt.
  assert.deepEqual(await o.delegation.receiveEnding(held[1]!), { accepted: true });
  assert.deepEqual(await o.delegation.receiveEnding(held[0]!), { accepted: true });
  await o.settle();
  assert.deepEqual((await o.delegation.children()).map(row => [row.requestId, row.status]).sort(), [['wf_1_a000001', 'paused'], ['wf_1_a000002', 'completed']]);
  // An attempt the owner never had and is older than its latest is unknown.
  assert.deepEqual(await o.delegation.receiveEnding({ ...held[0]!, agentId: 'wf_other' }), { accepted: false });
});

test('a workflow child outlives its owner\'s stop and deletion', async () => {
  const o = owner();
  await o.delegation.registerWorkflow({ id: 'wf_1', name: 'review', callId: 'c' });
  await o.delegation.cancel('parent-run');
  await o.delegation.cancel();
  await o.delegation.destroy();
  assert.deepEqual(o.aborted, [], 'a stop or a deletion leaves the workflow running');
  const [row] = await o.delegation.children();
  assert.deepEqual([row!.status, row!.cancelRequested], ['running', undefined]);
});

test('workflow_start: a start that fails past the row ends it when the workflow does not exist, and keeps it when it may', async () => {
  // WORKFLOWS: `made` ids exist; create answers 503 (a sandbox that cannot check scripts) or throws (a transport error).
  const made = new Set<string>();
  let failure: 'refused' | 'transport' | 'made-then-lost' = 'refused';
  const env = { WORKFLOWS: { getByName: (id: string) => ({
    get: async () => made.has(id) ? { tenant: 't', status: 'running' } : { refused: { error: 'Unknown workflow', status: 404 } },
    view: async () => ({ tenant: 't', status: 'running', owner: { kind: 'agent', id: 'owner' } }),
    create: async () => {
      if (failure === 'refused') return { refused: { error: 'The sandbox Worker cannot check workflow scripts yet', status: 503 } };
      if (failure === 'made-then-lost') made.add(id);
      throw new Error('network connection lost');
    },
  }) } };
  const o = owner();
  const tools = workflowTools({ env: env as never, tenant: 't', agentId: 'owner', remaining: async () => Infinity,
    children: { register: (workflow, api) => o.delegation.registerWorkflow(workflow, api as never), reopen: id => o.delegation.reopenWorkflow(id), forget: id => o.delegation.forgetWorkflow(id) } });
  const start = tools.find(tool => tool.name === 'workflow_start') as any;
  const call = (callId: string) => start.execute({ script: 'return 1;', budgetUsd: 1, name: callId }, { callId }, {});
  await assert.rejects(call('refused'), /cannot check workflow scripts/);
  failure = 'transport';
  await assert.rejects(call('transport'), /network connection lost/);
  failure = 'made-then-lost';
  await assert.rejects(call('lost'), /network connection lost/);
  const rows = Object.fromEntries((await o.delegation.children()).map(row => [row.name, row.status]));
  assert.deepEqual(rows, { refused: 'failed', transport: 'failed', lost: 'running' }, 'only a workflow known not to exist ends its row');
});

test('a skipped attempt: a stop retried after a later attempt\'s ending landed still lands on its own row', async () => {
  const o = owner();
  await o.delegation.registerWorkflow({ id: 'wf_1', name: 'review', callId: 'c' });
  const held: ChildEnding[] = [];
  const w = workflow(async ending => { held.push(ending); return { accepted: true }; });
  w.endings.statusWritten(summary('budget_exhausted'));
  w.endings.statusWritten(summary('paused', { pauseReason: 'payer_exhausted' }));
  w.endings.statusWritten(summary('completed'));
  await w.endings.outbox.flush();
  // a1 lands; a2 fails for now; a3 lands; a2 is retried and lands on a row of its own.
  for (const index of [0, 2, 1]) assert.deepEqual(await o.delegation.receiveEnding(held[index]!), { accepted: true });
  await o.settle();
  assert.deepEqual((await o.delegation.children()).map(row => [row.requestId, row.status]).sort(), [['wf_1_a000001', 'paused'], ['wf_1_a000002', 'paused'], ['wf_1_a000003', 'completed']]);
});

test('runtime notices staged while the owner is busy take no request slot', () => {
  assert.equal(openRequest({ state: 'running' }), true);
  assert.equal(openRequest({ state: 'running', noticeQueued: true }), false);
  assert.equal(openRequest({ state: 'completed' }), false);
});

test('an ending the owner has no row for is refused and dropped, never retried; a gone owner\'s answer drops it too; no owner stages nothing', async () => {
  const o = owner();
  const w = workflow(ending => o.delegation.receiveEnding(ending));
  w.endings.statusWritten(summary('completed'));
  await w.endings.outbox.flush();
  assert.equal(w.endings.pending(), 0);
  const gone = workflow(async () => ({ accepted: true }));
  gone.endings.statusWritten(summary('failed', { error: 'x' }));
  await gone.endings.outbox.flush();
  assert.equal(gone.endings.pending(), 0);
  const ownerless = new WorkflowEndings({ storage: memory(), workflowId: 'wf_2', owner: () => undefined, name: () => undefined, receiveEnding: async () => assert.fail('no owner'), arm: async () => {} });
  ownerless.statusWritten(summary('completed'));
  assert.equal(ownerless.pending(), 0);
});

test('interrupt_agent on a workflow aborts it; on a row whose workflow was never made (its start failed past the row) it ends the row', async () => {
  const exists = new Set(['wf_live']), aborted: string[] = [];
  const o = owner({ abort: async id => { if (!exists.has(id)) return false; aborted.push(id); return true; } });
  await o.delegation.registerWorkflow({ id: 'wf_live', name: 'live', callId: 'c1' });
  await o.delegation.registerWorkflow({ id: 'wf_gone', name: 'gone', callId: 'c2' });
  const interrupt = o.delegation.tools({ instructions: true }, ['agents']).find(tool => tool.name === 'interrupt_agent') as any;
  assert.ok(interrupt, 'interrupt_agent is a tool');
  for (const agent of ['live', 'gone']) await interrupt.execute({ agent }, { callId: `i-${agent}`, taskId: 't', getTask: async () => undefined }, {});
  assert.deepEqual(aborted, ['wf_live']);
  const rows = Object.fromEntries((await o.delegation.children()).map(row => [row.id, [row.status, row.notified]]));
  assert.deepEqual(rows, { wf_live: ['running', undefined], wf_gone: ['failed', true] });
});

test('after attempts land out of order, list_agents and wait_agent show the workflow\'s highest attempt', async () => {
  const o = owner();
  await o.delegation.registerWorkflow({ id: 'wf_1', name: 'review', callId: 'c' });
  const held: ChildEnding[] = [];
  const w = workflow(async ending => { held.push(ending); return { accepted: true }; });
  w.endings.statusWritten(summary('budget_exhausted'));
  w.endings.statusWritten(summary('paused', { pauseReason: 'payer_exhausted' }));
  w.endings.statusWritten(summary('completed'));
  await w.endings.outbox.flush();
  for (const index of [0, 2, 1]) await o.delegation.receiveEnding(held[index]!);
  await o.settle();
  const tools = o.delegation.tools({ instructions: true }, ['agents']);
  const api = { callId: 'l', taskId: 't', getTask: async () => undefined };
  const listed = (await (tools.find(tool => tool.name === 'list_agents') as any).execute({}, api, {})).structuredOutput.agents;
  assert.deepEqual(listed.map((agent: any) => [agent.agentId, agent.status]), [['wf_1', 'completed']]);
  const waited = (await (tools.find(tool => tool.name === 'wait_agent') as any).execute({ agents: ['review'] }, { ...api, callId: 'w' }, {})).structuredOutput.agents;
  assert.deepEqual(waited.map((agent: any) => [agent.agentId, agent.status]), [['wf_1', 'completed']]);
});

test('a payer stop retries by itself: the owner hears it once, not at every refused retry, and again after another stop', () => {
  const w = workflow(async () => ({ accepted: true }));
  const payer = summary('paused', { pauseReason: 'payer_exhausted' });
  w.endings.statusWritten(payer);
  w.endings.statusWritten(payer);
  w.endings.statusWritten(payer);
  assert.deepEqual([w.endings.pending(), w.endings.attempt()], [1, 2], 'one stop told; its retries refused again tell nothing');
  w.endings.statusWritten(summary('budget_exhausted'));
  w.endings.statusWritten(payer);
  assert.deepEqual([w.endings.pending(), w.endings.attempt()], [3, 4], 'a budget stop, then the payer again: both told');
  w.endings.statusWritten(summary('failed', { fault: { code: 'payer_gave_up', message: 'no credit for 7 days' } }));
  const keys = w.storage.sql.exec("SELECT key FROM child_outbox ORDER BY key").toArray().map((row: any) => row.key);
  assert.deepEqual(keys, ['wf_1_a000001:z', 'wf_1_a000002:z', 'wf_1_a000003:z', 'wf_1_a000004:z']);
});
