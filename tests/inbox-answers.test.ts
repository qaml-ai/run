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
  assert.deepEqual((writes[0] as any[]).map(a => a.body.version), [1, 1]);
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

test('authority read failures are unavailable; forbidden results reveal no state or responder', async () => {
  const results = await answerInboxGroup(['down', 'forbidden', 'ok'].map(id => ({ id, version: 1, action: 'accept' })), async id => {
    if (id === 'down') throw new Error('private infrastructure error');
    return { id, version: 1, state: 'pending', expiresAt: Date.now() + 10000, answer: { by: { actor: 'secret' } } };
  }, input => { if (input.id === 'forbidden') throw Object.assign(new Error('Not allowed'), { status: 403 }); }, async () => ({ status: 202 }));
  assert.deepEqual(results[0], { id: 'down', outcome: 'unavailable', status: 503, retryable: true });
  assert.equal(results[1].outcome, 'forbidden');
  assert.equal('state' in results[1], false);
  assert.equal('by' in results[1], false);
  assert.equal(results[2].outcome, 'answered');
});

test('one failed write is not bisected, and pending version races become conflicts', async () => {
  let version = 1, writes = 0;
  const entries = ['a', 'b'].map(id => ({ id, version: 1, action: 'accept' }));
  const results = await answerInboxGroup(entries, async () => ({ version, state: 'pending', expiresAt: Date.now() + 10000 }), () => {}, async () => {
    writes++;
    version++;
    throw Object.assign(new Error('CAS failed'), { status: 409 });
  });
  assert.equal(writes, 1);
  assert.deepEqual(results.map(r => r.outcome), ['conflict', 'conflict']);
});

test('write outages are retryable and settled matching answers are same without a write', async () => {
  let writes = 0;
  const rows: any = { same: { version: 2, state: 'answered', answer: { action: 'accept', content: { a: 1, b: 2 }, by: { actor: 'a' } } }, pending: { version: 1, state: 'pending', expiresAt: Date.now() + 10000 } };
  const results = await answerInboxGroup(['same', 'pending'].map(id => ({ id, version: 1, action: 'accept', content: { b: 2, a: 1 } })), async id => rows[id], () => {}, async () => { writes++; throw new Error('Unavailable'); });
  assert.equal(writes, 1);
  assert.equal(results[0].outcome, 'same');
  assert.deepEqual(results[1], { id: 'pending', outcome: 'unavailable', status: 503, retryable: true });
});
