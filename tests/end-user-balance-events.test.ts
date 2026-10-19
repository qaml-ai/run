import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { transaction, type Db } from "../src/db.ts";
import { EndUserCredits, settleUsage, utcDay, type Posted } from "../src/end-user-credits.ts";
import { testDatabase } from "./database.ts";
import { runtime } from "./runtime-server.ts";

// Balance events an auto top-up (or receipts, or a mirror of balances) can be built on (#276): per-person thresholds,
// written-down re-arm rules, a `cause` on each, events for the tenant's own entries, and an allowance warning.

const USD = 1_000_000;
const EVENTS = ["end_user.balance.low", "end_user.credit.exhausted", "end_user.credit.granted", "end_user.credit.refunded", "end_user.credit.adjusted", "end_user.allowance.low"];
async function fixture(settings: Record<string, unknown>) {
  const { db } = await testDatabase();
  const credits = new EndUserCredits(db);
  await credits.setSettings("t", { enabled: true, ...settings });
  await db.query(`insert into webhook_endpoints (id, tenant, url, events, secret, created_at) values ('we_1', 't', 'https://example.test/hook', $1, '{}', 0)`, [EVENTS]);
  return { db, credits };
}
const events = async (db: Db, type?: string) => (await db.query("select body from webhook_deliveries order by created_at, xmin::text::bigint, ctid")).rows
  .map(row => ({ type: row.body.type, ...row.body.data })).filter(event => !type || event.type === type);
const spend = async (credits: EndUserCredits, raw: number, user = "u", bucket = "default") => {
  const reserved = await credits.reserve("t", user, bucket, { id: randomUUID(), want: raw, min: 1 });
  if (reserved?.hold) await credits.settleHold("t", user, bucket, reserved.hold.id, raw, `call:${randomUUID()}`, { requestId: "req_1" });
  return reserved;
};

test("below $10, add $5: balance.low fires on the crossing, and again on the first debit after a top-up that left it under", async () => {
  const { db, credits } = await fixture({ lowBalance: 10 * USD });
  await credits.post("t", "u", { kind: "grant", amount: 10_400_000, key: "pay-1" });
  await spend(credits, 9_400_000);
  const [first] = await events(db, "end_user.balance.low");
  assert.deepEqual([first.balance, first.threshold, first.previousBalance, first.cause.kind, first.cause.requestId, first.cause.bucket], [USD, 10 * USD, 10_400_000, "usage", "req_1", "default"]);
  assert.ok(Number.isInteger(first.cause.entryId));
  await spend(credits, 100_000);
  assert.equal((await events(db, "end_user.balance.low")).length, 1, "still under, not topped up: once");

  // The tenant tops up $5: $5.90, still under $10. The next debit says so again.
  await credits.post("t", "u", { kind: "grant", amount: 5 * USD, key: "topup-1" });
  assert.equal((await events(db, "end_user.balance.low")).length, 1, "a grant itself fires nothing");
  await spend(credits, 100_000);
  const low = await events(db, "end_user.balance.low");
  assert.equal(low.length, 2);
  assert.deepEqual([low[1].balance, low[1].cause.kind], [5_800_000, "usage"]);
  assert.ok(low[1].cause.entryId > low[0].cause.entryId, "entry ids order a person's events");
  await spend(credits, 100_000);
  assert.equal((await events(db, "end_user.balance.low")).length, 2, "once per top-up");
});

test("a person's own lowBalance overrides the tenant's, is shown under overrides, and a threshold set above the balance fires once", async () => {
  const { db, credits } = await fixture({ lowBalance: 2 * USD });
  await credits.post("t", "u", { kind: "grant", amount: 5 * USD, key: "pay-1" });
  await credits.post("t", "v", { kind: "grant", amount: 5 * USD, key: "pay-2" });
  const raised = await credits.update("t", "u", { lowBalance: 10 * USD });
  assert.deepEqual([raised.lowBalance, raised.overrides.lowBalance], [10 * USD, 10 * USD]);
  const [changed] = await events(db, "end_user.balance.low");
  assert.deepEqual([changed.endUser, changed.balance, changed.threshold, changed.cause], ["u", 5 * USD, 10 * USD, { kind: "threshold_changed", bucket: null }]);
  await credits.update("t", "u", { lowBalance: 10 * USD });
  assert.equal((await events(db, "end_user.balance.low")).length, 1, "the same value again: nothing");
  await spend(credits, 100_000);
  assert.equal((await events(db, "end_user.balance.low")).length, 1, "told already, not topped up since");

  // Cleared: the tenant's $2 applies again, and $4.90 is above it.
  const cleared = await credits.update("t", "u", { lowBalance: null });
  assert.deepEqual([cleared.lowBalance, cleared.overrides.lowBalance], [2 * USD, null]);
  await spend(credits, 3 * USD);
  const low = await events(db, "end_user.balance.low");
  assert.deepEqual(low.slice(1).map(event => [event.endUser, event.threshold, event.cause.kind]), [["u", 2 * USD, "usage"]]);

  // The tenant's raised to $6: v ($5) is told once; u (own threshold cleared, already told under $2) is not again.
  await credits.setSettings("t", { lowBalance: 6 * USD }, { merge: true });
  await credits.setSettings("t", { lowBalance: 6 * USD }, { merge: true });
  const after = (await events(db, "end_user.balance.low")).slice(2);
  assert.deepEqual(after.map(event => [event.endUser, event.threshold, event.cause.kind]), [["v", 6 * USD, "threshold_changed"]]);
  // A person with their own threshold is not swept by the tenant's.
  await credits.update("t", "v", { lowBalance: USD });
  await credits.setSettings("t", { lowBalance: 8 * USD }, { merge: true });
  assert.deepEqual((await events(db, "end_user.balance.low")).slice(3).map(event => event.endUser), []);
});

test("cause says what moved the balance: a negative adjustment, a corrected cost, a refused call; a refund stays silent", async () => {
  const { db, credits } = await fixture({ lowBalance: 2 * USD });
  await credits.post("t", "u", { kind: "grant", amount: 3 * USD, key: "pay-1" });
  // A dispute on credit already spent: the tenant takes it back with an adjustment.
  const { entry } = await credits.post("t", "u", { kind: "adjustment", amount: -4 * USD, key: "dp_123" });
  const [low] = await events(db, "end_user.balance.low");
  const [out] = await events(db, "end_user.credit.exhausted");
  assert.deepEqual([low.cause.kind, low.cause.entryKey, low.cause.entryId], ["adjustment", "dp_123", entry.id]);
  assert.deepEqual([out.reason, out.cause.kind, out.cause.entryKey], ["balance", "adjustment", "dp_123"]);

  // A refused call: credit.exhausted with no entry behind it, once the flag is re-armed by a grant that left it at zero.
  await credits.post("t", "u", { kind: "grant", amount: USD, key: "pay-2" });
  assert.equal((await spend(credits, USD / 2))?.refused?.reason, "balance");
  const refused = (await events(db, "end_user.credit.exhausted")).at(-1);
  assert.deepEqual([refused.cause, refused.balance], [{ kind: "refusal", bucket: "default" }, 0]);

  // A model call's cost, posted at an estimate and corrected later, with its run's request.
  await credits.post("t", "w", { kind: "grant", amount: 3 * USD, key: "pay-3" });
  const post = (raw: number, revision: number, previous?: Posted) => transaction(db, sql => settleUsage(sql, {
    tenant: "t", endUser: "w", bucket: "builder", day: utcDay(Date.now()), raw, key: `attempt:a1:${revision}`, previous, metadata: { requestId: "req_9" },
  }));
  const estimated = await post(500_000, 1);
  await post(1_500_000, 2, estimated);
  const corrected = (await events(db, "end_user.balance.low")).filter(event => event.endUser === "w");
  assert.deepEqual(corrected.map(event => [event.balance, event.cause.kind, event.cause.requestId, event.cause.bucket]), [[1_500_000, "usage_correction", "req_9", "builder"]]);

  // A refund that crosses both: silent (the guide: never top up on it).
  await credits.post("t", "x", { kind: "grant", amount: 3 * USD, key: "pay-4" });
  await credits.post("t", "x", { kind: "refund", amount: 3 * USD, key: "re-1" });
  assert.equal((await events(db)).filter(event => event.endUser === "x" && (event.type === "end_user.balance.low" || event.type === "end_user.credit.exhausted")).length, 0);
});

test("a person never credited (free allowances only) is never told their balance is low", async () => {
  const { db, credits } = await fixture({ allowances: { "bot:*": 100_000 }, lowBalance: 2 * USD });
  await spend(credits, 100_000, "free", "bot:1");
  // A charge past the allowance (a web search): written off, nothing debited.
  await credits.charge("t", "free", "bot:1", 5_000, "charge:1");
  assert.equal((await credits.get("t", "free")).balance, 0);
  await credits.setSettings("t", { lowBalance: 3 * USD }, { merge: true });
  assert.deepEqual(await events(db, "end_user.balance.low"), []);
  // Credited once, they are: the tenant's next threshold change tells them.
  await credits.post("t", "free", { kind: "grant", amount: USD, key: "pay-1" });
  await credits.setSettings("t", { lowBalance: 4 * USD }, { merge: true });
  assert.deepEqual((await events(db, "end_user.balance.low")).map(event => [event.endUser, event.cause.kind]), [["free", "threshold_changed"]]);
});

test("each grant, refund and adjustment sends its event once; a replayed key sends nothing", async () => {
  const { db, credits } = await fixture({});
  const grant = await credits.post("t", "u", { kind: "grant", amount: 5 * USD, key: "pi_1", reference: "Pack", metadata: { pack: "small" } });
  await credits.post("t", "u", { kind: "grant", amount: 5 * USD, key: "pi_1", reference: "Pack", metadata: { pack: "small" } });
  await Promise.all(Array.from({ length: 5 }, () => credits.post("t", "u", { kind: "refund", amount: USD, key: "re_1" })));
  await credits.post("t", "u", { kind: "adjustment", amount: -250_000, key: "adj_1" });
  const posted = (await events(db)).filter(event => event.type.startsWith("end_user.credit.") && event.type !== "end_user.credit.exhausted");
  assert.deepEqual(posted.map(event => [event.type, event.kind, event.amount, event.key, event.balance, event.previousBalance]), [
    ["end_user.credit.granted", "grant", 5 * USD, "pi_1", 5 * USD, 0],
    ["end_user.credit.refunded", "refund", -USD, "re_1", 4 * USD, 5 * USD],
    ["end_user.credit.adjusted", "adjustment", -250_000, "adj_1", 3_750_000, 4 * USD],
  ]);
  assert.deepEqual([posted[0].entryId, posted[0].reference, posted[0].metadata, posted[0].endUser], [grant.entry.id, "Pack", { pack: "small" }, "u"]);
});

test("allowance.low fires once per person, bucket and day past allowanceWarningPercent; off without it", async () => {
  const { db, credits } = await fixture({ allowances: { "bot:*": USD } });
  await spend(credits, 900_000, "u", "bot:1");
  assert.equal((await events(db, "end_user.allowance.low")).length, 0, "off by default");
  await credits.setSettings("t", { allowanceWarningPercent: 80 }, { merge: true });
  assert.equal((await credits.settings("t")).allowanceWarningPercent, 80);
  await spend(credits, 700_000, "v", "bot:1");
  await spend(credits, 100_000, "v", "bot:1");
  await spend(credits, 50_000, "v", "bot:1");
  await spend(credits, 100_000, "v", "bot:2");
  const warned = await events(db, "end_user.allowance.low");
  assert.deepEqual(warned.map(event => [event.endUser, event.bucket, event.allowance, event.allowanceSpent, event.percent, event.day]), [["v", "bot:1", USD, 800_000, 80, utcDay(Date.now())]]);
  for (const bad of [0, 101, 50.5, "80"]) await assert.rejects(credits.setSettings("t", { allowanceWarningPercent: bad }), (error: any) => error.status === 400, String(bad));
  assert.equal((await credits.setSettings("t", { allowanceWarningPercent: null })).allowanceWarningPercent, null);
});

test("the API: a person's lowBalance, and the end users under their threshold", async t => {
  const r = await runtime(t, () => ({ content: "ok" }));
  await r.call("/v1/end-user-settings", { method: "PUT", body: { enabled: true, lowBalance: 2 * USD, allowanceWarningPercent: 90 } });
  for (const [id, amount] of [["a", USD], ["b", 3 * USD], ["c", 5 * USD]] as const) await r.call(`/v1/end-users/${id}/entries`, { body: { kind: "grant", amount, key: `pay-${id}` } });
  const patched = await r.call("/v1/end-users/c", { method: "PATCH", body: { lowBalance: 10 * USD } });
  assert.deepEqual([patched.status, patched.json.lowBalance, patched.json.overrides.lowBalance], [200, 10 * USD, 10 * USD], patched.text);
  const below = await r.call("/v1/end-users?belowLowBalance=true");
  assert.deepEqual(below.json.endUsers.map((user: any) => user.id), ["a", "c"]);
  assert.equal((await r.call("/v1/end-users")).json.endUsers.length, 3);
  assert.equal((await r.call("/v1/end-users?belowLowBalance=yes")).status, 400);
  assert.equal((await r.call("/v1/end-users/c", { method: "PATCH", body: { lowBalance: -1 } })).status, 400);
  assert.equal((await r.call("/v1/end-user-settings")).json.allowanceWarningPercent, 90);
});
