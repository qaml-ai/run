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

test('a slow authority call renews its receipt without holding a SQL transaction', async t => {
  const { db } = await testDatabase();
  t.mock.timers.enable({ apis: ['setInterval'] });
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const work = inboxReceipt(db, 'alice', { requestId: 'slow', answers: [{ id: 'a', version: 1 }] }, async () => {
    entered();
    await blocked;
    return [{ id: 'a', outcome: 'answered', status: 202 }];
  });
  try {
    await started;
    assert.equal((await db.query("select count(*)::int as count from pg_stat_activity where datname=current_database() and state='idle in transaction'")).rows[0].count, 0);
    await db.query("update inbox_answer_receipts set claimed_until=now()-interval '1 second' where request_id='slow'");
    t.mock.timers.tick(30_000);
    let renewed = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      renewed = (await db.query("select claimed_until > now() as renewed from inbox_answer_receipts where request_id='slow'")).rows[0].renewed;
      if (renewed) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(renewed, true);
  } finally { release(); await work; }
});
