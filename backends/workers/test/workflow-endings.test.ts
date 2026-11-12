import test from 'node:test';
import assert from 'node:assert/strict';
import { Delegation, type DelegationHost } from '../src/delegation.ts';
import { WorkflowEndings, endingRecord, ENDING_RESULT_CHARS, type EndingSummary } from '../src/workflow-endings.ts';
import { workflowNext } from '../src/workflow-tools.ts';
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

test('a workflow child outlives its owner\'s stop and deletion; a cancel of its row aborts the workflow, not an agent', async () => {
  const o = owner();
  await o.delegation.registerWorkflow({ id: 'wf_1', name: 'review', callId: 'c' });
  await o.delegation.cancel('parent-run');
  await o.delegation.cancel();
  await o.delegation.destroy();
  assert.deepEqual(o.aborted, [], 'a stop or a deletion leaves the workflow running');
  assert.equal((await o.delegation.children())[0]!.cancelRequested, undefined);
  // A row marked for cancel (an earlier build's) is cancelled through WORKFLOWS on recovery.
  const [row] = await o.delegation.children();
  await o.delegation.rows.put({ ...row!, cancelRequested: true });
  await o.delegation.recover();
  assert.deepEqual(o.aborted, ['wf_1']);
  // A refused start: its row ends quietly, owing no notification.
  await o.delegation.registerWorkflow({ id: 'wf_bad', name: 'bad', callId: 'c2' });
  await o.delegation.forgetWorkflow('wf_bad');
  const bad = (await o.delegation.children()).find(child => child.id === 'wf_bad')!;
  assert.deepEqual([bad.status, bad.notified], ['failed', true]);
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
