import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import { EndUserCredits } from '../src/end-user-credits.ts';
import { testDatabase } from './database.ts';
import { OPERATOR, OTHER_OPERATOR, runtime } from './runtime-server.ts';

async function fixture() {
  const { db } = await testDatabase();
  const credits = new EndUserCredits(db);
  await credits.setSettings('t', { enabled: true, allowances: { '*': 0 } });
  return { db, credits };
}

test('transfers preserve expiry and leave holds with their source; replay moves neither side twice', async () => {
  const { credits } = await fixture();
  const expiry = Date.now() + 60_000;
  await credits.post('t', 'alice', { kind: 'grant', amount: 500, key: 'plan', expiresAt: expiry });
  await credits.post('t', 'alice', { kind: 'grant', amount: 500, key: 'pack' });
  const heldId = randomUUID();
  await credits.reserve('t', 'alice', 'builder', { id: heldId, want: 200, min: 200 });
  const result = await credits.transfer('t', 'alice', { to: 'team:one', amount: 600, key: 'one' });
  assert.equal(result.debit.amount, -600);
  assert.equal(result.credits.reduce((n, e) => n + e.amount, 0), 600);
  const target = await credits.get('t', 'team:one');
  assert.deepEqual(target.lots.map(l => [l.remaining, l.expiresAt]), [[300, expiry], [300, null]]);
  assert.equal((await credits.get('t', 'alice')).held, 200);
  assert.equal((await credits.transfer('t', 'alice', { to: 'team:one', amount: 600, key: 'one' })).replayed, true);
  assert.equal((await credits.get('t', 'team:one')).balance, 600);
  await assert.rejects(credits.transfer('t', 'alice', { to: 'team:two', amount: 600, key: 'one' }), { code: 'IDEMPOTENCY_CONFLICT' });
  await credits.settleHold('t', 'alice', 'builder', heldId, 200, 'usage:held', {});
  assert.equal((await credits.get('t', 'alice')).balance, 200);
  assert.equal((await credits.get('t', 'team:one', [], expiry + 1)).balance, 300);
});

test('concurrent transfers cannot overspend and ledger entries conserve credits', async () => {
  const { db, credits } = await fixture();
  await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 30 }), { minLength: 2, maxLength: 15 }), async amounts => {
    const id = randomUUID();
    const from = `person:${id}`, to = `team:${id}`;
    await credits.post('t', from, { kind: 'grant', amount: 100, key: `seed:${id}` });
    const results = await Promise.allSettled(amounts.map((amount, i) => credits.transfer('t', from, { to, amount, key: `${id}:${i}` })));
    const moved = results.reduce((n, result, i) => n + (result.status === 'fulfilled' ? amounts[i]! : 0), 0);
    const [a, b] = await Promise.all([credits.get('t', from), credits.get('t', to)]);
    assert.equal(a.balance + b.balance, 100);
    assert.equal(b.balance, moved);
    assert.ok(a.balance >= 0);
    const sum = await db.query("select sum(amount)::bigint as amount from end_user_ledger where tenant='t' and reference like $1", [`entry:transfer:${id}:%`]);
    assert.equal(Number(sum.rows[0].amount), 0);
    for (const result of results) if (result.status === 'rejected') assert.equal(result.reason.code, 'INSUFFICIENT_BALANCE');
  }), { numRuns: 30 });
});

test('opposite-direction concurrent transfers take account locks in the same order', async () => {
  const { credits } = await fixture();
  for (const id of ['a', 'b']) await credits.post('t', id, { kind: 'grant', amount: 100, key: `seed:${id}` });
  await Promise.all(Array.from({ length: 12 }, (_, i) => credits.transfer('t', i % 2 ? 'a' : 'b', { to: i % 2 ? 'b' : 'a', amount: 1, key: `opposite:${i}` })));
  assert.equal((await credits.get('t', 'a')).balance, 100);
  assert.equal((await credits.get('t', 'b')).balance, 100);
});

test('a live hold keeps expired credit at its source until settlement', async t => {
  const { db, credits } = await fixture();
  const now = Date.now(), expiry = now + 1_000;
  await credits.post('t', 'held-source', { kind: 'grant', amount: 1_000, key: 'expiring', expiresAt: expiry });
  const hold = randomUUID();
  const reserved = await credits.reserve('t', 'held-source', 'builder', { id: hold, want: 500, min: 500 }, now);
  assert.ok(reserved && !reserved.refused);
  t.mock.method(Date, 'now', () => expiry + 1);

  const expired = await credits.get('t', 'held-source');
  assert.equal(expired.balance, 500);
  assert.equal(expired.held, 500);
  await assert.rejects(credits.transfer('t', 'held-source', { to: 'held-target', amount: 1, key: 'held-transfer' }), { code: 'INSUFFICIENT_BALANCE' });
  assert.equal((await credits.get('t', 'held-target')).balance, 0);
  assert.equal((await db.query("select remaining from end_user_lots where tenant='t' and end_user='held-source'")).rows[0].remaining, 500);

  // Newly purchased credit can move without exporting the earlier call's expired lot.
  await credits.post('t', 'held-source', { kind: 'grant', amount: 200, key: 'fresh-credit' });
  await credits.transfer('t', 'held-source', { to: 'held-target', amount: 200, key: 'fresh-transfer' });
  assert.deepEqual((await credits.get('t', 'held-target')).lots.map(lot => [lot.remaining, lot.expiresAt]), [[200, null]]);
  assert.equal((await credits.get('t', 'held-source')).held, 500);
  await credits.settleHold('t', 'held-source', 'builder', hold, 500, 'usage:expiry-held', {});
  assert.equal((await credits.get('t', 'held-source')).balance, 0);
  assert.equal((await credits.get('t', 'held-source')).held, 0);
  assert.equal((await credits.get('t', 'held-target')).balance, 200);
});

test('incoming expiring transfers repay destination debt before creating a spendable lot', async () => {
  const { credits } = await fixture();
  const expiry = Date.now() + 60_000;
  await credits.post('t', 'debt-target', { kind: 'adjustment', amount: -400, key: 'old-debt' });
  await credits.post('t', 'debt-source', { kind: 'grant', amount: 500, key: 'debt-plan', expiresAt: expiry });
  const first = await credits.transfer('t', 'debt-source', { to: 'debt-target', amount: 300, key: 'repay-first' });
  assert.equal(first.debit.amount, -300);
  assert.equal(first.credits[0].amount, 300);
  assert.equal((await credits.get('t', 'debt-target')).balance, -100);
  assert.deepEqual((await credits.get('t', 'debt-target')).lots, []);
  await credits.transfer('t', 'debt-source', { to: 'debt-target', amount: 200, key: 'repay-rest' });
  assert.deepEqual((await credits.get('t', 'debt-target')).lots.map(lot => [lot.remaining, lot.expiresAt]), [[100, expiry]]);
  assert.equal((await credits.get('t', 'debt-source')).balance, 0);
  assert.equal((await credits.get('t', 'debt-target', [], expiry + 1)).balance, 0);
});

test('concurrent reuse of a key across disjoint sources commits exactly one complete transfer', async () => {
  const { db, credits } = await fixture();
  for (const source of ['key-source-a', 'key-source-b']) await credits.post('t', source, { kind: 'grant', amount: 100, key: `seed:${source}` });
  const requests = [
    { from: 'key-source-a', to: 'key-target-a', amount: 30 },
    { from: 'key-source-b', to: 'key-target-b', amount: 50 },
  ];
  const results = await Promise.allSettled(requests.map(({ from, ...input }) => credits.transfer('t', from, { ...input, key: 'cross-source' })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const winner = results.findIndex(result => result.status === 'fulfilled');
  const loser = 1 - winner;
  assert.equal((results[loser] as PromiseRejectedResult).reason.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await credits.get('t', requests[winner].from)).balance, 100 - requests[winner].amount);
  assert.equal((await credits.get('t', requests[winner].to)).balance, requests[winner].amount);
  assert.equal((await credits.get('t', requests[loser].from)).balance, 100);
  assert.equal((await credits.get('t', requests[loser].to)).balance, 0);
  const entries = (await db.query("select amount from end_user_ledger where tenant='t' and reference='entry:transfer:cross-source'")).rows;
  assert.equal(entries.length, 2);
  assert.equal(entries.reduce((sum, entry) => sum + Number(entry.amount), 0), 0);
  const { from, ...input } = requests[winner];
  assert.equal((await credits.transfer('t', from, { ...input, key: 'cross-source' })).replayed, true);
  assert.equal((await credits.get('t', from)).balance, 100 - input.amount);
});


test('the transfer API scopes both accounts to the authenticated tenant', async t => {
  const r = await runtime(t, () => ({ content: 'ok' }));
  const seeded = await r.call('/v1/end-users/alice/entries', { method: 'POST', token: OPERATOR, body: { kind: 'grant', amount: 100, key: 'seed' } });
  assert.equal(seeded.status, 201);
  const moved = await r.call('/v1/end-users/alice/transfers', { method: 'POST', body: { to: 'team:one', amount: 40, key: 'transfer' } });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.debit.amount, -40);
  assert.equal(moved.json.credits[0].amount, 40);
  assert.equal((await r.call('/v1/end-users/alice/transfers', { method: 'POST', body: { to: 'team:one', amount: 40, key: 'transfer' } })).json.replayed, true);
  assert.equal((await r.call('/v1/end-users/team%3Aone', { token: OTHER_OPERATOR })).json.balance, 0);
  assert.equal((await r.call('/v1/end-users/alice/transfers', { method: 'POST', token: OTHER_OPERATOR, body: { to: 'team:one', amount: 1, key: 'steal' } })).status, 409);
});
