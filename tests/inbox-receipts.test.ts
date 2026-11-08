import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inboxReceipt, sweepInboxReceipts } from '../shared/inbox-answers.ts';
import { testDatabase } from './database.ts';

test('receipts serialize identical callers, refuse changed payloads, expire and prune', async () => {
  const { db } = await testDatabase();
  const body = { requestId: 'review', answers: [{ id: 'a', version: 1, action: 'accept' }] };
  let runs = 0;
  const run = async () => {
    runs++;
    await new Promise(resolve => setTimeout(resolve, 100));
    return [{ id: 'a', outcome: 'answered' as const, status: 202 }];
  };
  const [one, two] = await Promise.all([inboxReceipt(db, 'alice', body, run), inboxReceipt(db, 'alice', body, run)]);
  assert.deepEqual(one, two);
  assert.equal(runs, 1);
  const equivalent = { requestId: 'review', answers: [{ action: 'accept', version: 1, id: 'a' }] };
  assert.deepEqual(await inboxReceipt(db, 'alice', equivalent, run), one);
  const different = { requestId: 'review', answers: [{ id: 'a', version: 2, action: 'cancel' }] };
  await assert.rejects(inboxReceipt(db, 'alice', different, run), { status: 409 });
  await db.query("update inbox_answer_receipts set created_at=now()-interval '8 days'");
  await inboxReceipt(db, 'alice', different, run);
  assert.equal(runs, 2, 'expired receipt is ignored even before the sweep');
  await db.query("update inbox_answer_receipts set created_at=now()-interval '8 days'");
  await sweepInboxReceipts(db);
  assert.equal((await db.query('select count(*)::int as count from inbox_answer_receipts')).rows[0].count, 0);
});
