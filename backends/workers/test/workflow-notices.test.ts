import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowNotices, noticeEvent } from '../src/workflow-notices.ts';

function sql(db = new DatabaseSync(':memory:')) {
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

test('notices are staged in order and delivered once each; a failed delivery keeps the rest behind it and is retried by the alarm', async () => {
  const sent: any[] = [], armed: number[] = [];
  let fail = 1, now = 1_000;
  const notices = new WorkflowNotices({
    sql: sql(), workflowId: 'wf_x', owner: () => ({ kind: 'agent', id: 'owner' }), name: () => 'port', bucket: () => 'b',
    send: async (owner, request, notice) => { if (fail-- > 0) throw new Error('owner evicted'); sent.push({ owner, request, notice }); },
    arm: async at => { armed.push(at); }, now: () => now, random: () => 0,
  });
  notices.check({ status: 'running', phase: 'review' });
  notices.check({ status: 'running', phase: 'judge', counts: { done: 3 } });
  notices.check({ status: 'completed', phase: 'judge', result: { ok: true } });
  assert.equal(notices.pending(), 2);
  await notices.flush();
  assert.equal(sent.length, 0);
  assert.deepEqual(armed, [2_000], 'the alarm is armed for the retry, in the future');
  assert.equal(notices.retryAt(), 2_000);
  await notices.flush();
  assert.equal(sent.length, 0, 'not due yet: nothing is sent early');
  now = 2_000;
  await notices.flush();
  assert.deepEqual(sent.map(entry => [entry.request.id, entry.notice.metadata.event, JSON.parse(entry.request.params.text).status]), [['wf_x_n1', 'phase', 'running'], ['wf_x_n2', 'completed', 'completed']]);
  assert.deepEqual(JSON.parse(sent[1].request.params.text).result, { ok: true });
  assert.deepEqual(sent[0].notice, { source: { kind: 'agent', agentId: 'wf_x', name: 'port' }, root: 'owner', costUsd: 0, metadata: { kind: 'workflow', workflowId: 'wf_x', status: 'running', event: 'phase' } });
  assert.equal(sent[0].request.params.bucket, 'b');
  assert.equal(notices.pending(), 0);
  assert.equal(notices.retryAt(), undefined);
});

test('a completed notice whose send failed is delivered by the alarm after the object was evicted', async () => {
  const db = new DatabaseSync(':memory:');
  let now = 1_000;
  const armed: number[] = [], sent: string[] = [];
  const make = (send: () => Promise<void>) => new WorkflowNotices({ sql: sql(db), workflowId: 'wf_z', owner: () => ({ kind: 'agent', id: 'owner' }), name: () => undefined, bucket: () => undefined,
    send: async (_owner, request) => { await send(); sent.push(request.id); }, arm: async at => { armed.push(at); }, now: () => now, random: () => 0 });
  const before = make(async () => { throw new Error('the owner was evicted mid-call'); });
  before.check({ status: 'running' });
  before.check({ status: 'completed', result: 42 });
  await before.flush();
  assert.deepEqual(armed, [2_000], 'the alarm holds the retry: the completed workflow arms nothing else');
  // The object is evicted (its memory gone); its alarm fires later in a new instance, which delivers.
  now = 2_500;
  const after = make(async () => {});
  assert.equal(after.retryAt(), 2_501, 'already due: the alarm is for at once, never in the past');
  await after.flush();
  assert.deepEqual(sent, ['wf_z_n1']);
  assert.equal(after.pending(), 0);
});

test('backoff grows to five minutes, and a notice its owner never takes is dropped after a week', async () => {
  let now = 1_000_000;
  const armed: number[] = [];
  const notices = new WorkflowNotices({ sql: sql(), workflowId: 'wf_w', owner: () => ({ kind: 'agent', id: 'o' }), name: () => undefined, bucket: () => undefined,
    send: async () => { throw new Error('down'); }, arm: async at => { armed.push(at); }, now: () => now, random: () => 0 });
  notices.check({ status: 'running' });
  notices.check({ status: 'failed', error: 'x' });
  for (let i = 0; i < 7; i++) { await notices.flush(); now = notices.retryAt()!; }
  const gaps = armed.map((at, index) => at - (index ? armed[index - 1]! : 1_000_000));
  assert.deepEqual(gaps, [1_000, 4_000, 16_000, 64_000, 256_000, 300_000, 300_000]);
  now += 8 * 86_400_000;
  await notices.flush();
  assert.equal(notices.pending(), 0);
});

test('a workflow with no agent owner (started through the API) notifies no one', async () => {
  const notices = new WorkflowNotices({ sql: sql(), workflowId: 'wf_y', owner: () => undefined, name: () => undefined, bucket: () => undefined, send: async () => assert.fail('no owner'), arm: async () => {} });
  notices.check({ status: 'running' });
  notices.check({ status: 'completed' });
  assert.equal(notices.pending(), 0);
});
