// Ported from tests/end-user-lots.test.ts. Included assertions and test bodies are unchanged.
// Only service imports and the isolated Postgres fixture differ; see money-policy-port.json for excluded ECS fixtures.
import { test } from "node:test";

import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";

import type { Db } from "../src/postgres.ts";

import { EndUserCredits, utcDay } from "../src/end-user-credits.ts";

import { testDatabase } from "./billing-database.ts";

const USD = 1_000_000;

const DAY = 86_400_000;

async function fixture() {
  const { db } = await testDatabase();
  const credits = new EndUserCredits(db);
  await credits.setSettings("t", { enabled: true, allowances: { "*": 0 } });
  return { db, credits };
}

const spend = async (credits: EndUserCredits, bucket: string, raw: number, now = Date.now()) => {
  const id = randomUUID();
  const reserved = await credits.reserve("t", "u", bucket, { id, want: raw, min: 1 }, now);
  assert.ok(reserved?.hold, JSON.stringify(reserved));
  await credits.settleHold("t", "u", bucket, id, raw, `call:${id}`, {}, now);
};

const lots = async (credits: EndUserCredits, now = Date.now()) => (await credits.get("t", "u", [], now)).lots.map(lot => [lot.key, lot.remaining, lot.expiresAt]);

async function holds(db: Db) {
  const { rows: [row] } = await db.query(`select u.balance, coalesce(sum(l.remaining), 0)::bigint as lots from end_users u
    left join end_user_lots l on l.tenant = u.tenant and l.end_user = u.id and l.remaining > 0 where u.tenant = 't' and u.id = 'u' group by u.balance`);
  assert.ok(Number(row.lots) <= Math.max(0, Number(row.balance)), `lots ${row.lots} past the balance ${row.balance}`);
  assert.ok(Number(row.lots) >= 0);
}

test("a month's credit is a lot every bucket spends first, splitting into the credit that never expires", async () => {
  const { db, credits } = await fixture();
  const end = Date.now() + 30 * DAY;
  await credits.post("t", "u", { kind: "grant", amount: 5 * USD, key: "pack-1", description: "500 credits" });
  await credits.post("t", "u", { kind: "grant", amount: 3 * USD, key: "plan:1", expiresAt: end, description: "camelBot Plus" });
  assert.deepEqual(await lots(credits), [["plan:1", 3 * USD, end], [null, 5 * USD, null]]);
  // Any bucket: builder, then a bot, each from the month first.
  await spend(credits, "builder", 2 * USD);
  await spend(credits, "bot:1", 2 * USD);
  assert.deepEqual(await lots(credits), [[null, 4 * USD, null]], "the month spent first, the rest from the pack");
  assert.equal((await credits.get("t", "u")).balance, 4 * USD);
  await holds(db);
  for (const bad of [{ expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 401 * DAY }, { expiresAt: "soon" }]) {
    await assert.rejects(credits.post("t", "u", { kind: "grant", amount: USD, key: `bad:${JSON.stringify(bad)}`, ...bad }), (error: any) => error.status === 400, JSON.stringify(bad));
  }
  await assert.rejects(credits.post("t", "u", { kind: "spend", amount: USD, key: "x", expiresAt: end }), (error: any) => error.status === 400, "only a grant expires");
  await assert.rejects(credits.post("t", "u", { kind: "grant", amount: USD, key: "y", lot: "plan:1" }), (error: any) => error.status === 400, "only a debit names a lot");
});

test("at its time a lot's unspent part expires: an expiry entry, the balance down, the day's expired, a webhook", async () => {
  const { db, credits } = await fixture();
  await db.query(`insert into webhook_endpoints (id, tenant, url, events, secret, created_at) values ('we_1', 't', 'https://example.test/hook', ARRAY['end_user.credit.expired'], '{}', 0)`);
  const now = Date.now(), end = now + DAY;
  await credits.post("t", "u", { kind: "grant", amount: USD, key: "pack-1" });
  await credits.post("t", "u", { kind: "grant", amount: 3 * USD, key: "plan:1", expiresAt: end });
  await spend(credits, "bot:1", USD, now);
  // Not yet: nothing expires.
  assert.equal((await credits.get("t", "u", [], end - 1)).balance, 3 * USD);
  // Its time: the $2 left of it goes, the pack stays; once.
  const after = await credits.get("t", "u", [], end + 1);
  assert.deepEqual([after.balance, after.lots.map(lot => [lot.key, lot.remaining])], [USD, [[null, USD]]]);
  assert.equal((await credits.get("t", "u", [], end + 2)).balance, USD);
  const [expiry] = (await credits.ledger("t", "u", { kinds: ["expiry"] })).entries;
  assert.deepEqual([expiry.kind, expiry.amount, expiry.metadata.lot, expiry.balanceAfter], ["expiry", -2 * USD, "plan:1", USD]);
  const days = (await credits.days("t", "u", { to: utcDay(end + 2 * DAY) })).days;
  assert.equal(days.reduce((total, day) => total + day.expired, 0), 2 * USD);
  const { rows } = await db.query("select body from webhook_deliveries where body->>'type' = 'end_user.credit.expired'");
  assert.deepEqual(rows.map(row => [row.body.data.amount, row.body.data.metadata.lot, row.body.data.balance]), [[-2 * USD, "plan:1", USD]]);
  await holds(db);
});

test("a hold open at expiry settles against the lot it reserved; what it leaves expires at the next lock", async () => {
  const { db, credits } = await fixture();
  const now = Date.now(), end = now + 60_000;
  await credits.post("t", "u", { kind: "grant", amount: 2 * USD, key: "pack-1" });
  await credits.post("t", "u", { kind: "grant", amount: USD, key: "plan:1", expiresAt: end });
  // A call holds $0.80 before the month ends: from the month's lot.
  const id = randomUUID();
  const reserved = await credits.reserve("t", "u", "bot:1", { id, want: 800_000, min: 1 }, now);
  assert.equal(reserved?.hold?.paid, 800_000);
  // The month ends while it runs: only the $0.20 nobody holds expires.
  assert.equal((await credits.get("t", "u", [], end + 1)).balance, 2_800_000);
  // A call after its end can't take what is left of it: only the pack's $2 is there for it.
  const late = await credits.reserve("t", "u", "bot:2", { id: randomUUID(), want: 5 * USD, min: 1 }, end + 2);
  assert.equal(late?.hold?.paid, 2 * USD);
  await credits.release(late!.hold!.id);
  // The call settles at $0.50, from the month's lot; the $0.30 it held and didn't spend expires at the next lock.
  await credits.settleHold("t", "u", "bot:1", id, 500_000, `call:${id}`, {}, end + 3);
  const after = await credits.get("t", "u", [], end + 4);
  assert.deepEqual([after.balance, after.lots.map(lot => [lot.key, lot.remaining])], [2 * USD, [[null, 2 * USD]]], "the pack untouched");
  const expired = (await credits.ledger("t", "u", { kinds: ["expiry"] })).entries.map(entry => entry.amount).sort((a, b) => a - b);
  assert.deepEqual(expired, [-300_000, -200_000]);
  await holds(db);
});

test("refunds: a pack's takes credit that never expires first; one naming the month's grant takes its lot", async () => {
  const { db, credits } = await fixture();
  const end = Date.now() + 30 * DAY;
  await credits.post("t", "u", { kind: "grant", amount: 5 * USD, key: "pack-1" });
  await credits.post("t", "u", { kind: "grant", amount: 3 * USD, key: "plan:1", expiresAt: end });
  await credits.post("t", "u", { kind: "refund", amount: 2 * USD, key: "re-pack" });
  assert.deepEqual(await lots(credits), [["plan:1", 3 * USD, end], [null, 3 * USD, null]]);
  await credits.post("t", "u", { kind: "refund", amount: 3 * USD, key: "re-plan", lot: "plan:1" });
  assert.deepEqual(await lots(credits), [[null, 3 * USD, null]]);
  // A spend and a negative adjustment take the soonest expiring lot first, as usage does.
  await credits.post("t", "u", { kind: "grant", amount: USD, key: "plan:2", expiresAt: end });
  await credits.post("t", "u", { kind: "spend", amount: 1_500_000, key: "footer" });
  assert.deepEqual(await lots(credits), [[null, 2_500_000, null]]);
  await holds(db);
});

test("a debt is repaid before a month's credit counts; usage never takes lots past the balance", async () => {
  const { db, credits } = await fixture();
  const end = Date.now() + 30 * DAY;
  // Refund debt (a purchase refunded after it was spent): the balance below zero.
  await credits.post("t", "u", { kind: "adjustment", amount: -USD, key: "debt" });
  await credits.post("t", "u", { kind: "grant", amount: 3 * USD, key: "plan:1", expiresAt: end });
  assert.deepEqual(await lots(credits), [["plan:1", 2 * USD, end]], "$1 of the month repaid the debt");
  // Concurrent calls from many bots: every lot stays within the balance, and the month goes first.
  await credits.post("t", "u", { kind: "grant", amount: USD, key: "pack-1" });
  await Promise.all(Array.from({ length: 12 }, (_, i) => spend(credits, `bot:${i}`, 200_000)));
  assert.equal((await credits.get("t", "u")).balance, 600_000);
  assert.deepEqual(await lots(credits), [[null, 600_000, null]]);
  await holds(db);
});

test("credit granted before lots can be marked to expire, once per key; a sweep expires lots of people who do nothing", async () => {
  const { db, credits } = await fixture();
  const now = Date.now(), end = now + DAY;
  await credits.post("t", "u", { kind: "grant", amount: 5 * USD, key: "pack-1" });
  await credits.post("t", "u", { kind: "grant", amount: 2 * USD, key: "plan:old" });
  const marked = await credits.markLot("t", "u", { key: "plan:old", amount: 2 * USD, expiresAt: end });
  assert.deepEqual([marked.replayed, marked.lot.remaining], [false, 2 * USD]);
  assert.equal((await credits.markLot("t", "u", { key: "plan:old", amount: 2 * USD, expiresAt: end })).replayed, true);
  await assert.rejects(credits.markLot("t", "u", { key: "plan:old", amount: USD, expiresAt: end }), (error: any) => error.status === 409);
  await assert.rejects(credits.markLot("t", "u", { key: "too-much", amount: 6 * USD, expiresAt: end }), (error: any) => error.status === 409 && error.details?.available === 5 * USD);
  assert.equal((await credits.get("t", "u")).balance, 7 * USD, "marking moves no balance");
  assert.equal((await credits.ledger("t", "u")).entries.length, 2, "and posts nothing");
  // Nobody touches the account: a node's sweep expires it.
  assert.equal(await credits.expireDue(100, end - 1), 0);
  assert.equal(await credits.expireDue(100, end + 1), 1);
  assert.equal(Number((await db.query("select balance from end_users where tenant = 't' and id = 'u'")).rows[0].balance), 5 * USD);
  assert.equal(await credits.expireDue(100, end + 2), 0);
  await holds(db);
  // A marked lot reads, and is refunded by name, by the key it was marked with.
  await credits.post("t", "u", { kind: "grant", amount: USD, key: "plan:2" });
  await credits.markLot("t", "u", { key: "plan:2", amount: USD, expiresAt: end + DAY });
  assert.deepEqual((await credits.get("t", "u", [], end + 3)).lots.map(lot => lot.key), ["plan:2", null]);
  await credits.post("t", "u", { kind: "refund", amount: 400_000, key: "re-2", lot: "plan:2" });
  assert.deepEqual((await credits.get("t", "u", [], end + 4)).lots.map(lot => [lot.key, lot.remaining]), [["plan:2", 600_000], [null, 5 * USD]]);
});
