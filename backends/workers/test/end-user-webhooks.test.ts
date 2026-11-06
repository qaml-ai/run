// Ported from tests/end-user-webhooks.test.ts. Included assertions and test bodies are unchanged.
// Only imports and the isolated Postgres fixture differ; see webhook-policy-port.json for ECS exclusions.
import { test } from "node:test";

import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";

import type { Db } from "../src/postgres.ts";

import { EndUserCredits } from "../src/end-user-credits.ts";

import { signedHeaders } from "../src/webhook-policy.ts";

import { testDatabase } from "./billing-database.ts";

const USD = 1_000_000;

async function fixture(settings: Record<string, unknown>) {
  const { db } = await testDatabase();
  const credits = new EndUserCredits(db);
  await credits.setSettings("t", { enabled: true, ...settings });
  await db.query(`insert into webhook_endpoints (id, tenant, url, events, secret, created_at)
    values ('we_1', 't', 'https://example.test/hook', ARRAY['end_user.balance.low','end_user.credit.exhausted'], '{}', 0)`);
  return { db, credits };
}

const events = async (db: Db) => (await db.query("select body from webhook_deliveries order by created_at, id")).rows.map(row => ({ type: row.body.type, ...row.body.data }));

const spend = async (credits: EndUserCredits, bucket: string, raw: number) => {
  const reserved = await credits.reserve("t", "u", bucket, { id: randomUUID(), want: raw, min: 1 });
  if (reserved?.hold) await credits.settleHold("t", "u", bucket, reserved.hold.id, raw, `call:${randomUUID()}`);
  return reserved;
};

test("balance.low fires as the balance falls below the threshold, once until a grant lifts it back", async () => {
  const { db, credits } = await fixture({ lowBalance: 2 * USD });
  await credits.post("t", "u", { kind: "grant", amount: 3 * USD, key: "pay-1" });
  await spend(credits, "default", 500_000);
  assert.deepEqual(await events(db), [], "still above the threshold");
  await spend(credits, "default", 600_000);
  await spend(credits, "default", 100_000);
  assert.deepEqual((await events(db)).map(event => [event.type, event.endUser, event.balance, event.threshold]), [["end_user.balance.low", "u", 1_900_000, 2 * USD]], "once, as it crosses");
  await credits.post("t", "u", { kind: "grant", amount: 5 * USD, key: "pay-2" });
  await spend(credits, "default", 5_000_000);
  assert.equal((await events(db)).filter(event => event.type === "end_user.balance.low").length, 2, "re-armed by the grant");
});

test("a refund to zero is silent: no balance.low, no credit.exhausted (nothing to top up), until a grant re-arms them", async () => {
  const { db, credits } = await fixture({ lowBalance: 2 * USD });
  await credits.post("t", "u", { kind: "grant", amount: 50 * USD, key: "pay-1" });
  await spend(credits, "default", 45 * USD);
  const before = (await events(db)).length;
  // Buy $50, spend $45, refund what is left: the balance is 0, never -$45, and nobody is told they ran out.
  await assert.rejects(credits.post("t", "u", { kind: "refund", amount: 50 * USD, key: "re-1" }), (error: any) => error.code === "INSUFFICIENT_BALANCE");
  assert.equal((await credits.post("t", "u", { kind: "refund", amount: 5 * USD, key: "re-2" })).entry.balanceAfter, 0);
  assert.equal((await events(db)).length, before);
  // A call refused now is not "ran out" either: the flags were set by the refund.
  await spend(credits, "default", USD);
  assert.equal((await events(db)).filter(event => event.type === "end_user.credit.exhausted" && event.reason === "balance").length, 0);
  await credits.post("t", "u", { kind: "grant", amount: 3 * USD, key: "pay-2" });
  await spend(credits, "default", 3 * USD);
  // Both in one transaction, in the same millisecond: in either order.
  assert.deepEqual((await events(db)).slice(before).map(event => [event.type, event.reason ?? null]).sort(), [["end_user.balance.low", null], ["end_user.credit.exhausted", "balance"]], "re-armed by the grant");
});

test("a spend is a debit: it fires balance.low and credit.exhausted as usage does, and end_user.credit.spent with its words", async () => {
  const { db, credits } = await fixture({ lowBalance: 2 * USD });
  await db.query("update webhook_endpoints set events = events || ARRAY['end_user.credit.spent'] where id = 'we_1'");
  await credits.post("t", "u", { kind: "grant", amount: 3 * USD, key: "pay-1" });
  await credits.post("t", "u", { kind: "spend", amount: 2 * USD, key: "item-1", description: "A month without the footer" });
  await credits.post("t", "u", { kind: "spend", amount: USD, key: "item-2" });
  // Each with the spend that moved the balance (in its transaction: their order within it is not kept).
  assert.deepEqual((await events(db)).map(event => [event.type, event.balance, event.cause?.kind ?? event.kind, event.description ?? null]).sort(), [
    ["end_user.balance.low", USD, "spend", null],
    ["end_user.credit.exhausted", 0, "spend", null],
    ["end_user.credit.spent", 0, "spend", null],
    ["end_user.credit.spent", USD, "spend", "A month without the footer"],
  ]);
});

test("credit.exhausted says why: a bucket's allowance used up (once a day), the balance at zero (once until credited), the daily limit (once a day)", async () => {
  const { db, credits } = await fixture({ allowances: { "bot:*": 100_000 } });
  await credits.post("t", "u", { kind: "grant", amount: 300_000, key: "pay" });
  await spend(credits, "bot:1", 60_000);
  await spend(credits, "bot:1", 60_000);
  await spend(credits, "bot:1", 60_000);
  const allowance = (await events(db)).filter(event => event.reason === "allowance");
  assert.deepEqual(allowance.map(event => [event.bucket, event.allowance]), [["bot:1", 100_000]], "the bucket's allowance ran out once, though spending went on from the balance");

  await spend(credits, "bot:1", 300_000);
  const refusedAfter = await credits.reserve("t", "u", "bot:1", { id: randomUUID(), want: 10_000, min: 10_000 });
  assert.equal(refusedAfter?.refused?.reason, "balance");
  const balance = (await events(db)).filter(event => event.reason === "balance");
  assert.equal(balance.length, 1, "once, though a call was refused after");
  assert.ok(balance[0].balance <= 0);

  await credits.post("t", "u", { kind: "grant", amount: USD, key: "pay-2" });
  await credits.update("t", "u", { dailyLimit: 500_000 });
  await spend(credits, "other", 300_000);
  assert.equal((await events(db)).filter(event => event.reason === "daily_limit").length, 1, "the day's paid spend reached the limit");
  assert.equal((await credits.reserve("t", "u", "other", { id: randomUUID(), want: 10_000, min: 10_000 }))?.refused?.reason, "daily_limit");
  assert.equal((await events(db)).filter(event => event.reason === "daily_limit").length, 1, "and the refusal after does not say it again");
  await spend(credits, "default", 1);
  await credits.post("t", "u", { kind: "adjustment", amount: -2 * USD, key: "take" });
  assert.equal((await events(db)).filter(event => event.reason === "balance").length, 2, "re-armed by the grant, fired by the adjustment taking it to zero");
});
