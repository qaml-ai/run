import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WorkflowNotices, noticeEvent, workflowNext, shortFault } from '../src/workflow-notices.ts';

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

test('a first send the isolate dies in the middle of is still retried: the alarm was armed before it went out', async () => {
  const db = new DatabaseSync(':memory:');
  let now = 1_000;
  const armed: number[] = [], sent: string[] = [];
  const make = (send: () => Promise<void>) => new WorkflowNotices({ sql: sql(db), workflowId: 'wf_c', owner: () => ({ kind: 'agent', id: 'owner' }), name: () => undefined, bucket: () => undefined,
    send: async (_owner, request) => { await send(); sent.push(request.id); }, arm: async at => { armed.push(at); }, now: () => now, random: () => 0 });
  const before = make(() => new Promise<void>(() => {}));
  before.check({ status: 'running' });
  before.check({ status: 'completed', result: 1 });
  // As the object's told() does: guard, then the background send, which never returns (the isolate dies under it).
  await before.guard();
  void before.flush();
  assert.deepEqual(armed, [2_000], 'armed for the first retry before the send');
  now = 2_000;
  const after = make(async () => {});
  await after.flush();
  assert.deepEqual(sent, ['wf_c_n1'], 'the alarm, in a new instance, delivers it');
  assert.equal(after.pending(), 0);
  armed.length = 0;
  await after.guard();
  assert.deepEqual(armed, [], 'nothing pending: guard arms nothing');
});

test('a row from before created_at gets its week from when it is first seen, not never', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE workflow_notices (seq INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)");
  db.exec("INSERT INTO workflow_notices (event, body, status) VALUES ('completed', '{}', 'completed')");
  let now = 5_000_000;
  const notices = new WorkflowNotices({ sql: sql(db), workflowId: 'wf_l', owner: () => ({ kind: 'agent', id: 'o' }), name: () => undefined, bucket: () => undefined,
    send: async () => { throw new Error('down'); }, arm: async () => {}, now: () => now, random: () => 0 });
  assert.equal((db.prepare('SELECT created_at FROM workflow_notices').get() as { created_at: number }).created_at, 5_000_000);
  now += 7 * 86_400_000 - 1;
  await notices.flush();
  assert.equal(notices.pending(), 1, 'kept within its week');
  now += 2 + 300_000 * 2;
  await notices.flush();
  assert.equal(notices.pending(), 0, 'dropped after it');
});

test('an owner that is gone (deleted, expired) drops every waiting notice after one answer: nothing is retried', async () => {
  let calls = 0;
  const armed: number[] = [];
  const notices = new WorkflowNotices({
    sql: sql(), workflowId: 'wf_gone', owner: () => ({ kind: 'agent', id: 'owner' }), name: () => undefined, bucket: () => undefined,
    send: async () => { calls++; return { gone: true }; }, arm: async at => { armed.push(at); }, now: () => 1_000, random: () => 0,
  });
  notices.check({ status: 'running', phase: 'a' });
  notices.check({ status: 'running', phase: 'b' });
  notices.check({ status: 'completed', phase: 'b' });
  assert.equal(notices.pending(), 2);
  await notices.flush();
  assert.equal(calls, 1, 'one send learns the owner is gone');
  assert.equal(notices.pending(), 0);
  assert.equal(notices.retryAt(), undefined);
  assert.deepEqual(armed, [], 'no retry is armed');
});

test("a fault's notice carries its code and message, and every stop says what it waits for, so a fault never reads as a pause", async () => {
  const sent: any[] = [];
  const notices = new WorkflowNotices({
    sql: sql(), workflowId: 'wf_f', owner: () => ({ kind: 'agent', id: 'owner' }), name: () => 'port', bucket: () => undefined,
    send: async (_owner, request) => { sent.push(JSON.parse(request.params.text)); }, arm: async () => {}, now: () => 1_000, random: () => 0,
  });
  notices.check({ status: 'running' });
  notices.check({ status: 'paused', pauseReason: 'key_required', fault: { code: 'key_required', message: 'commit() inside parallel() needs a key' } });
  notices.check({ status: 'running' });
  notices.check({ status: 'paused', pauseReason: 'confirm_rerun' });
  await notices.flush();
  assert.deepEqual(sent[0].fault, { code: 'key_required', message: 'commit() inside parallel() needs a key' });
  assert.match(sent[0].next, /^The script failed \(key_required\): fix it with workflow_edit/);
  assert.equal(sent[1].fault, undefined);
  assert.match(sent[1].next, /confirm with workflow_resume, or workflow_edit with confirm: true/);
  assert.equal(workflowNext({ status: 'running' }), undefined);
  // The runtime's own faults are resumed, not edited; a payer stop names jobs too; a long message is cut.
  assert.match(workflowNext({ status: 'paused', pauseReason: 'vm_crash', fault: { code: 'vm_crash', message: 'x' } })!, /workflow_resume runs the step again/);
  assert.match(workflowNext({ status: 'paused', pauseReason: 'journal_version', fault: { code: 'journal_version', message: 'x' } })!, /once that version is deployed/);
  assert.match(workflowNext({ status: 'paused', pauseReason: 'payer_exhausted' })!, /A sub-agent or job/);
  assert.equal(shortFault({ code: 'vm_crash', message: 'e'.repeat(2000) }).message.length, 500 + '… (cut)'.length);
  assert.match(workflowNext({ status: 'budget_exhausted' })!, /workflow_budget/);
});
