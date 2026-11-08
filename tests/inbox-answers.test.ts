import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerInboxGroup, inboxAnswers } from '../shared/inbox-answers.ts';

test('inbox separates conflicts and forbidden items before submitting one agent batch', async () => {
  const rows: Record<string, any> = {
    fresh: { state: 'pending', version: 1, expiresAt: Date.now() + 10000 },
    another: { state: 'pending', version: 1, expiresAt: Date.now() + 10000 },
    done: { state: 'answered', version: 2, answer: { by: { actor: 'alice' } } },
    expired: { state: 'pending', version: 1, expiresAt: 0 },
    withdrawn: { state: 'withdrawn', version: 2 },
    forbidden: { state: 'pending', version: 1 },
    moved: { state: 'pending', version: 3 },
  };
  const writes: unknown[] = [];
  const answers = Object.keys(rows).map(id => ({ id, version: 1, action: 'accept' }));
  const result = await answerInboxGroup(answers, async id => rows[id], (input) => {
    if (input === rows.forbidden) throw Object.assign(new Error('Not a responder'), { status: 403 });
  }, async batch => { writes.push(batch); return { status: 202 }; });
  assert.deepEqual(result.map(r => r.outcome), ['answered', 'answered', 'conflict', 'conflict', 'conflict', 'forbidden', 'conflict']);
  assert.equal(writes.length, 1);
  assert.deepEqual((writes[0] as any[]).map(a => a.id), ['fresh', 'another']);
  assert.throws(() => inboxAnswers({ requestId: 'x', answers: [{ id: 'a', version: 0 }] }));
});

test('recommendations are taken from the authority and guarded by the observed version', async () => {
  const input = { version: 2, state: 'pending', expiresAt: Date.now() + 10000, detail: { recommendation: { answer: { choice: 'current' } } } };
  const written: any[] = [];
  const write = async (batch: any[]) => { written.push(...batch); return { status: 202 }; };
  const stale = await answerInboxGroup([{ id: 'a', version: 1, accept: 'recommended' }], async () => input, () => {}, write);
  assert.equal(stale[0].outcome, 'conflict');
  assert.equal(written.length, 0);
  await answerInboxGroup([{ id: 'a', version: 2, accept: 'recommended' }], async () => input, () => {}, write);
  assert.deepEqual(written[0].body.content, { choice: 'current' });
});
