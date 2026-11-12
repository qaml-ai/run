import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowNotices, noticeEvent } from '../src/workflow-notices.ts';

function sql() {
  const db = new DatabaseSync(':memory:');
  return { exec(query: string, ...args: any[]) { const rows = db.prepare(query).all(...args) as any[]; return Object.assign(rows[Symbol.iterator](), { toArray: () => rows, one: () => rows[0] }); } } as unknown as SqlStorage;
}

test('the owner hears endings, stops and finished phases, never a step that changed nothing', () => {
  assert.equal(noticeEvent(undefined, { status: 'completed' }), undefined, 'the first look only records');
  assert.equal(noticeEvent({ status: 'running' }, { status: 'completed' }), 'completed');
  assert.equal(noticeEvent({ status: 'running' }, { status: 'failed' }), 'failed');
  assert.equal(noticeEvent({ status: 'running' }, { status: 'budget_exhausted' }), 'budget_exhausted');
  assert.equal(noticeEvent({ status: 'running' }, { status: 'paused', pauseReason: 'payer_exhausted' }), 'payer_exhausted');
  assert.equal(noticeEvent({ status: 'running' }, { status: 'paused', pauseReason: 'capacity_refused' }), 'capacity_refused');
  assert.equal(noticeEvent({ status: 'running', phase: 'review' }, { status: 'running', phase: 'judge' }), 'phase');
  assert.equal(noticeEvent({ status: 'running', phase: 'review' }, { status: 'waiting', phase: 'review' }), undefined);
  assert.equal(noticeEvent({ status: 'running' }, { status: 'running', phase: 'review' }), undefined, 'a first phase is not a finished one');
  assert.equal(noticeEvent({ status: 'budget_exhausted' }, { status: 'running' }), undefined, 'a resume is the owner\'s own doing');
});

test('notices are staged in order and delivered once each; a failed delivery keeps the rest behind it and retries', async () => {
  const sent: any[] = [], later: (() => Promise<void>)[] = [];
  let fail = 1;
  const notices = new WorkflowNotices({
    sql: sql(), workflowId: 'wf_x', owner: () => ({ kind: 'agent', id: 'owner' }), name: () => 'port', bucket: () => 'b',
    send: async (owner, request, notice) => { if (fail-- > 0) throw new Error('owner evicted'); sent.push({ owner, request, notice }); },
    later: (_ms, task) => { later.push(task); },
  });
  notices.check({ status: 'running', phase: 'review' });
  notices.check({ status: 'running', phase: 'judge', counts: { done: 3 } });
  notices.check({ status: 'completed', phase: 'judge', result: { ok: true } });
  assert.equal(notices.pending(), 2);
  await notices.flush();
  assert.equal(sent.length, 0);
  assert.equal(later.length, 1, 'a retry is scheduled');
  await later[0]!();
  assert.deepEqual(sent.map(entry => [entry.request.id, entry.notice.metadata.event, JSON.parse(entry.request.params.text).status]), [['wf_x_n1', 'phase', 'running'], ['wf_x_n2', 'completed', 'completed']]);
  assert.deepEqual(JSON.parse(sent[1].request.params.text).result, { ok: true });
  assert.deepEqual(sent[0].notice, { source: { kind: 'agent', agentId: 'wf_x', name: 'port' }, root: 'owner', costUsd: 0, metadata: { kind: 'workflow', workflowId: 'wf_x', status: 'running', event: 'phase' } });
  assert.equal(sent[0].request.params.bucket, 'b');
  assert.equal(notices.pending(), 0);
});

test('a workflow with no agent owner (started through the API) notifies no one', async () => {
  const notices = new WorkflowNotices({ sql: sql(), workflowId: 'wf_y', owner: () => undefined, name: () => undefined, bucket: () => undefined, send: async () => assert.fail('no owner'), later: () => {} });
  notices.check({ status: 'running' });
  notices.check({ status: 'completed' });
  assert.equal(notices.pending(), 0);
});
