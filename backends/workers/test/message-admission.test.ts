import assert from 'node:assert/strict';
import test from 'node:test';
import { InboxDoc, LiveDoc, type Conversation } from '@earendil-works/pi-durable';
import { admitAgentMessage, type MessageAdmission } from '../src/message-admission.ts';

function fixture() {
  const submissions = new Map<string, any>([['running', { id: 1, status: 'placed', entry: 10 }]]);
  const entries = new Map<number, any>([[10, { data: {} }]]);
  const live = { run: { inputs: [1] } }, inbox = { items: [] as any[] }, sent: any[] = [];
  const tx = {
    async submissionByRequest(_conversation: unknown, requestId: string) { return submissions.get(requestId); },
    async entry(id: number) { return entries.get(id); },
    async doc(token: unknown) { assert.ok(token === LiveDoc || token === InboxDoc); return token === LiveDoc ? live : inbox; },
    async appendEntry() { throw new Error('No held steers in this fixture'); },
  };
  const root = {
    id: 1,
    async commit(work: (tx: any) => unknown) { return work(tx); },
    async submit(_tx: unknown, input: any) {
      sent.push(input);
      submissions.set(input.requestId, { id: 2, status: 'queued' });
      inbox.items.push({ id: 2, entry: input.entry });
      return 2;
    },
  } as unknown as Conversation;
  const input: MessageAdmission = { requestId: 'message', content: 'hello', entry: { kind: 'camel.prompt', data: { requestId: 'message' } },
    candidate: { owner: 'running', nativeRequest: 'running' }, held: [] };
  return { root, input, submissions, entries, live, inbox, sent };
}

test('an ended candidate leaves no runnable input before the caller takes a wake', async () => {
  const f = fixture();
  f.submissions.set('running', { id: 1, status: 'done', entry: 10, answer: 11 });
  assert.deepEqual(await admitAgentMessage(f.root, f.input, 'join'), { submitted: false });
  assert.equal(f.sent.length, 0);
  assert.deepEqual(await admitAgentMessage(f.root, f.input, 'own'), { submitted: true, owner: null });
  assert.equal(f.sent[0].whenBusy, 'followUp');
  assert.equal(f.sent[0].entry.data.logicalOwner, null);
});

test('a queued replay retains its own-turn decision over a stale candidate', async () => {
  const f = fixture();
  await admitAgentMessage(f.root, f.input, 'own');
  assert.deepEqual(await admitAgentMessage(f.root, { ...f.input, legacyOwner: 'running' }, 'join'), { submitted: true, owner: null });
  assert.equal(f.sent.length, 1);
});

test('a placed replay retains the committed owner without checking a newer candidate', async () => {
  const f = fixture();
  f.submissions.set('message', { id: 2, status: 'placed', entry: 12 });
  f.entries.set(12, { data: { logicalOwner: 'original' } });
  assert.deepEqual(await admitAgentMessage(f.root, f.input, 'join'), { submitted: true, owner: 'original' });
  assert.equal(f.sent.length, 0);
});

test('a just-placed candidate uses its native logical owner before projection catches up', async () => {
  const f = fixture();
  f.entries.set(10, { data: { logicalOwner: 'original' } });
  assert.deepEqual(await admitAgentMessage(f.root, f.input, 'join'), { submitted: true, owner: 'original' });
  assert.equal(f.sent[0].whenBusy, 'steer');
  assert.equal(f.sent[0].entry.data.logicalOwner, 'original');
});
