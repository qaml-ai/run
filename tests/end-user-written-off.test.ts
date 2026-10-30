import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { transaction, type Db } from "../src/db.ts";
import { EndUserCredits, settleUsage, utcDay, type Posted } from "../src/end-user-credits.ts";
import { ModelAttempts } from "../src/model-attempts.ts";
import { attemptAck } from "../src/model-attempt.ts";
import { DEFAULT_PRICING } from "../src/pricing.ts";
import { testDatabase } from "./database.ts";

// What a call costs past what is left for it (its hold, the balance, the daily limit, the bucket's own limit) is written
// off: the tenant bears it, its user is never charged it, and no limit is passed.

const USD = 1_000_000;
const today = () => utcDay(Date.now());

async function credits(settings: Record<string, unknown> = {}, tenant = "t") {
  const { db } = await testDatabase();
  const service = new EndUserCredits(db);
  await service.setSettings(tenant, { enabled: true, ...settings });
  await db.query(`insert into webhook_endpoints (id, tenant, url, events, secret, created_at)
    values ('we_1', $1, 'https://example.test/hook', ARRAY['end_user.balance.low','end_user.credit.exhausted'], '{}', 0)`, [tenant]);
  return { db, service };
}
const balance = async (db: Db, user = "u", tenant = "t") => Number((await db.query("select balance from end_users where tenant = $1 and id = $2", [tenant, user])).rows[0]?.balance ?? 0);
const ledgerSum = async (db: Db, user = "u", tenant = "t") => Number((await db.query("select coalesce(sum(amount), 0) as total from end_user_ledger where tenant = $1 and end_user = $2", [tenant, user])).rows[0].total);
const day = async (db: Db, bucket: string, on = today()) => {
  const row = (await db.query("select allowance_spent, paid_spent, written_off from end_user_days where bucket = $1 and day = $2", [bucket, on])).rows[0];
  return { allowanceSpent: Number(row?.allowance_spent ?? 0), paidSpent: Number(row?.paid_spent ?? 0), writtenOff: Number(row?.written_off ?? 0) };
};
const exhausted = async (db: Db) => (await db.query("select body from webhook_deliveries order by created_at, id")).rows
  .map(row => ({ type: row.body.type, ...row.body.data })).filter(event => event.type === "end_user.credit.exhausted");
/** A call that holds `want` and costs `cost` (raw), settled as a transcription's or images' hold is. */
async function call(service: EndUserCredits, bucket: string, want: number, cost: number, user = "u") {
  const reserved = await service.reserve("t", user, bucket, { id: randomUUID(), want, min: 1 });
  assert.ok(reserved?.hold, `${bucket}: a call holding ${want} starts`);
  const key = `call:${randomUUID()}`;
  await service.settleHold("t", user, bucket, reserved.hold.id, cost, key);
  return { hold: reserved.hold, entry: (await service.ledger("t", user)).entries.find(entry => entry.key === key)! };
}
/** Hide the write-off log lines a test makes on purpose, and return them. */
async function quiet<T>(work: () => Promise<T>): Promise<{ result: T; logged: any[] }> {
  const logged: any[] = [];
  const error = console.error;
  console.error = (line: unknown) => { try { logged.push(JSON.parse(String(line))); } catch { logged.push(line); } };
  try { return { result: await work(), logged }; } finally { console.error = error; }
}

test("a bot at a bucket limit of 0: a call past its allowance never charges a balance of 0; the rest is written off, said once", async () => {
  const { db, service } = await credits({ allowances: { "bot:*": USD }, bucketLimits: { "bot:*": 0 }, markupBps: 2_000 });
  await call(service, "bot:42", 970_000, 970_000);
  // $0.03 of the allowance left: the call holds it, and costs $0.25.
  const { result: { hold, entry }, logged } = await quiet(() => call(service, "bot:42", 30_000, 250_000));
  assert.deepEqual([hold.allowance, hold.paid], [30_000, 0]);
  assert.equal(await balance(db), 0, "the balance stays $0");
  assert.deepEqual([entry.raw, entry.allowance, entry.amount, entry.writtenOff], [250_000, 30_000, 0, 220_000]);
  assert.deepEqual(await day(db, "bot:42"), { allowanceSpent: USD, paidSpent: 0, writtenOff: 220_000 });
  const view = (await service.get("t", "u")).today.buckets.find(bucket => bucket.bucket === "bot:42")!;
  assert.deepEqual([view.allowanceLeft, view.paidSpent, view.writtenOff], [0, 0, 220_000]);
  assert.ok(logged.some(line => line.type === "end_user_written_off" && line.writtenOff === 220_000 && line.reason === "bucket_limit"), JSON.stringify(logged));
  assert.equal((await exhausted(db)).filter(event => event.reason === "bucket_limit" && event.bucket === "bot:42").length, 1, "bucket_limit fires, though a limit of 0 is never crossed");
  // Its next call is refused, for the bucket's limit.
  assert.equal((await service.reserve("t", "u", "bot:42", { id: randomUUID(), want: 10_000, min: 1 }))?.refused?.reason, "bucket_limit");
  assert.equal((await service.refusal("t", "u", "bot:42"))?.reason, "bucket_limit");
  // Spend that holds nothing (a web search) is written off too, and the webhook is not said again that day.
  await quiet(() => service.charge("t", "u", "bot:42", 5_000, "charge:search-1"));
  assert.equal(await balance(db), 0);
  assert.deepEqual(await day(db, "bot:42"), { allowanceSpent: USD, paidSpent: 0, writtenOff: 225_000 });
  assert.equal((await exhausted(db)).filter(event => event.reason === "bucket_limit").length, 1, "once per person, bucket and day");
  const [todays] = (await service.days("t", "u")).days;
  assert.deepEqual([todays.writtenOff, todays.paidCharged, todays.buckets], [225_000, 0, [{ bucket: "bot:42", freeRaw: USD, paidCharged: 0, writtenOff: 225_000 }]], "the per-day totals show it");
  // Their first grant shows in full.
  await service.post("t", "u", { kind: "grant", amount: 10 * USD, key: "pay" });
  assert.equal(await balance(db), 10 * USD);
  assert.equal(await ledgerSum(db), 10 * USD, "the ledger sums to the balance");
});

test("a bucket limit with some room: an overflow charges what is left of it, and writes off the rest", async () => {
  const { db, service } = await credits({ bucketLimits: { "bot:*": 300_000 } });
  await service.post("t", "u", { kind: "grant", amount: 10 * USD, key: "pay" });
  await call(service, "bot:1", 250_000, 250_000);
  const { result: { hold, entry } } = await quiet(() => call(service, "bot:1", USD, 600_000));
  assert.equal(hold.paid, 50_000, "it holds the $0.05 left of the limit");
  assert.deepEqual([entry.amount, entry.writtenOff], [-50_000, 550_000]);
  assert.deepEqual(await day(db, "bot:1"), { allowanceSpent: 0, paidSpent: 300_000, writtenOff: 550_000 });
  assert.equal(await balance(db), 10 * USD - 300_000);
  assert.equal((await exhausted(db)).filter(event => event.reason === "bucket_limit").length, 1);
});

test("the daily limit: paid spend ends at exactly the limit, at the markup, and the rest is written off", async () => {
  const { db, service } = await credits({ dailyLimit: 20 * USD, markupBps: 2_500 });
  await service.post("t", "u", { kind: "grant", amount: 50 * USD, key: "pay" });
  // $19.90 paid today ($15.92 raw at +25%).
  await call(service, "builder", 15_920_000, 15_920_000);
  assert.equal((await service.get("t", "u")).today.paidSpent, 19_900_000);
  // It holds the last $0.10 and costs $0.48 raw ($0.60 charged).
  const { result: { hold, entry } } = await quiet(() => call(service, "builder", USD, 480_000));
  assert.equal(hold.paid, 100_000);
  assert.equal((await service.get("t", "u")).today.paidSpent, 20 * USD, "exactly the limit");
  assert.equal(entry.amount, -100_000);
  assert.equal(entry.writtenOff, 480_000 - 80_000, "what $0.10 pays for at +25% is $0.08 raw; the rest is written off");
  assert.equal(entry.allowance + Math.floor(-entry.amount / 1.25) + entry.writtenOff, entry.raw, "the cost is all accounted for");
  assert.equal(await balance(db), 30 * USD);
  assert.equal((await exhausted(db)).filter(event => event.reason === "daily_limit").length, 1);
  assert.equal((await service.reserve("t", "u", "builder", { id: randomUUID(), want: 1_000, min: 1 }))?.refused?.reason, "daily_limit");
});

test("the balance: an overflow takes it to zero, never below; the next call is refused; zero balance and no allowance charge nothing", async () => {
  const { db, service } = await credits();
  await service.post("t", "u", { kind: "grant", amount: 100_000, key: "pay" });
  const { result: { entry } } = await quiet(() => call(service, "default", 100_000, USD));
  assert.deepEqual([entry.amount, entry.writtenOff, entry.balanceAfter], [-100_000, 900_000, 0]);
  assert.equal(await balance(db), 0);
  assert.equal((await exhausted(db)).filter(event => event.reason === "balance").length, 1, "said once as it reaches zero");
  assert.equal((await service.reserve("t", "u", "default", { id: randomUUID(), want: 1_000, min: 1 }))?.refused?.reason, "balance");
  // At zero, with nothing held: spend that held nothing is all written off.
  await quiet(() => service.charge("t", "u", "default", 7_000, "charge:fetch-1"));
  await quiet(() => transaction(db, sql => settleUsage(sql, { tenant: "t", endUser: "u", bucket: "default", day: today(), raw: 3_000, key: "attempt:z:1" })));
  assert.equal(await balance(db), 0);
  assert.deepEqual(await day(db, "default"), { allowanceSpent: 0, paidSpent: 100_000, writtenOff: 910_000 });
  assert.equal((await exhausted(db)).filter(event => event.reason === "balance").length, 1, "not again until a grant");
  assert.equal(await ledgerSum(db), 0);
});

test("an overflow never takes credit another call in flight holds, however many settle at once", async () => {
  const { db, service } = await credits({ markupBps: 1_000 });
  await service.post("t", "u", { kind: "grant", amount: USD, key: "pay" });
  // One call holds $0.66 ($0.60 at +10%); another that held nothing costs $1: it takes the $0.34 not held, no more.
  const held = await service.reserve("t", "u", "a", { id: randomUUID(), want: 600_000, min: 1 });
  assert.equal(held!.hold!.paid, 660_000);
  await quiet(() => service.charge("t", "u", "b", USD, "charge:big"));
  assert.equal(await balance(db), 660_000, "what the call in flight holds is still there");
  assert.deepEqual(await day(db, "b"), { allowanceSpent: 0, paidSpent: 340_000, writtenOff: USD - Math.floor(340_000 * 10_000 / 11_000) });
  await service.settleHold("t", "u", "a", held!.hold!.id, held!.hold!.raw, "call:held");
  assert.equal(await balance(db), 0, "and it spends it");

  // Ten calls hold $0.10 each and cost three times that, settling at once.
  await service.post("t", "u", { kind: "grant", amount: USD, key: "pay-2" });
  const holds = await Promise.all(Array.from({ length: 10 }, () => service.reserve("t", "u", "c", { id: randomUUID(), want: 90_000, min: 90_000 })));
  assert.equal(holds.filter(result => result?.hold).length, 10);
  await quiet(() => Promise.all(holds.map((result, index) => service.settleHold("t", "u", "c", result!.hold!.id, 270_000, `call:c-${index}`))));
  assert.equal(await balance(db), 0, "never below zero");
  assert.equal(await ledgerSum(db), 0, "the ledger sums to the balance");
  const spent = await day(db, "c");
  assert.equal(spent.paidSpent, USD);
  const entries = (await service.ledger("t", "u", { limit: 200 })).entries.filter(entry => entry.bucket === "c");
  assert.equal(entries.reduce((sum, entry) => sum + entry.writtenOff, 0), spent.writtenOff);
  // Each call's cost is its allowance, what its payment pays for at +10% (rounded down), and its write-off.
  for (const entry of entries) {
    const paidFor = Math.floor(-entry.amount * 10_000 / 11_000);
    assert.ok(entry.writtenOff === 0 ? paidFor >= entry.raw - 1 : paidFor + entry.writtenOff === entry.raw, JSON.stringify(entry));
  }
});

test("corrections: an upward one with no hold is capped as a first settlement is; a downward one reduces the write-off first, then refunds", async () => {
  const { db, service } = await credits({ allowances: { b: 100_000 } });
  await service.post("t", "u", { kind: "grant", amount: 500_000, key: "pay" });
  const settle = (raw: number, revision: number, previous?: Posted) => quiet(() => transaction(db, sql =>
    settleUsage(sql, { tenant: "t", endUser: "u", bucket: "b", day: today(), raw, key: `attempt:c:${revision}`, previous }))).then(result => result.result);
  const first = await settle(400_000, 1);
  assert.deepEqual(first, { raw: 400_000, allowance: 100_000, paid: 300_000, writtenOff: 0 });
  // Raised later (a provider's own figure): capped by the balance as it is now ($0.20 left).
  const raised = await settle(900_000, 2, first);
  assert.deepEqual(raised, { raw: 900_000, allowance: 100_000, paid: 500_000, writtenOff: 300_000 });
  assert.equal(await balance(db), 0);
  // A grant since is never taken for a write-off: a correction up charges only what it adds, within what is left.
  await service.post("t", "u", { kind: "grant", amount: USD, key: "pay-2" });
  const same = await settle(900_000, 3, raised);
  assert.deepEqual(same, raised, "the same cost posts nothing");
  assert.equal((await db.query("select count(*)::int as n from end_user_ledger where idempotency_key = 'attempt:c:3'")).rows[0].n, 0);
  assert.equal(await balance(db), USD);
  // Down by $0.20: the write-off goes down, nothing is refunded.
  const lower = await settle(700_000, 4, raised);
  assert.deepEqual(lower, { raw: 700_000, allowance: 100_000, paid: 500_000, writtenOff: 100_000 });
  assert.equal(await balance(db), USD);
  // Down past the write-off: then the balance is refunded, then the allowance; never more than was paid.
  const less = await settle(300_000, 5, lower);
  assert.deepEqual(less, { raw: 300_000, allowance: 100_000, paid: 200_000, writtenOff: 0 });
  assert.equal(await balance(db), USD + 300_000);
  const none = await settle(0, 6, less);
  assert.deepEqual(none, { raw: 0, allowance: 0, paid: 0, writtenOff: 0 });
  assert.equal(await balance(db), 1_500_000, "everything paid is back, and no more");
  assert.deepEqual(await day(db, "b"), { allowanceSpent: 0, paidSpent: 0, writtenOff: 0 });
  assert.equal(await ledgerSum(db), 1_500_000);
});

test("other spend obeys the same cap: a transcription's hold and a web search at a bucket limit of 0 with no allowance left", async () => {
  const { db, service } = await credits({ allowances: { "bot:*": 50_000 }, bucketLimits: { "bot:*": 0 } });
  await service.post("t", "u", { kind: "grant", amount: 5 * USD, key: "pay" });
  const hold = await service.hold("t", "u", "bot:7", 0.05, "transcription");
  await quiet(() => hold!.settle(0.2));
  await quiet(() => service.charge("t", "u", "bot:7", 30_000, "charge:search"));
  assert.equal(await balance(db), 5 * USD, "a bot at 0 never charges the balance, whatever is there");
  assert.deepEqual(await day(db, "bot:7"), { allowanceSpent: 50_000, paidSpent: 0, writtenOff: 180_000 });
  await assert.rejects(service.hold("t", "u", "bot:7", 0.01, "transcription"), (error: any) => error.status === 402 && error.details.reason === "bucket_limit");
  // Another bucket still spends the balance.
  await service.charge("t", "u", "builder", 30_000, "charge:builder");
  assert.equal(await balance(db), 5 * USD - 30_000);
});

test("a person spends down to nothing: the last call starts on what is left, overdraws nothing, is written off, and the next is refused", async () => {
  const { db, service } = await credits({ markupBps: 2_500 });
  await service.post("t", "u", { kind: "grant", amount: 50_000, key: "pay" });
  const hold = await service.hold("t", "u", "b", 0.2, "images");
  const { logged } = await quiet(() => hold!.settle(0.2));
  assert.equal(await balance(db), 0, "all of it spent, never below zero");
  assert.equal(await ledgerSum(db), 0, "the ledger agrees");
  // $0.05 charged at the markup is $0.04 of cost: the other $0.16 is the tenant's.
  assert.deepEqual(await day(db, "b"), { allowanceSpent: 0, paidSpent: 50_000, writtenOff: 160_000 });
  assert.ok(logged.some(line => line.type === "end_user_written_off" && line.writtenOff === 160_000));
  await assert.rejects(service.hold("t", "u", "b", 0.01, "images"), (error: any) => error.status === 402 && error.details.reason === "balance");
  assert.equal((await service.reserve("t", "u", "b", { id: randomUUID(), want: 1_000, min: 1 }))?.refused?.reason, "balance");
  assert.ok(await service.refusal("t", "u", "b"), "a run is refused before it starts");
});

test("calls at once never overdraw: the first to ask holds what is left, the others are refused", async () => {
  const { db, service } = await credits();
  await service.post("t", "u", { kind: "grant", amount: 40_000, key: "pay" });
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.hold("t", "u", "b", 0.05, "voice_realtime")));
  const held = results.filter(result => result.status === "fulfilled").map(result => (result as PromiseFulfilledResult<any>).value);
  assert.equal(held.length, 1);
  await quiet(() => held[0].settle(0.05));
  assert.equal(await balance(db), 0);
  assert.deepEqual(await day(db, "b"), { allowanceSpent: 0, paidSpent: 40_000, writtenOff: 10_000 });
});

test("the last call stays within the daily limit and the bucket's own: its overshoot is written off, not charged", async () => {
  const { db, service } = await credits({ bucketLimits: { b: 30_000 } });
  await service.post("t", "u", { kind: "grant", amount: 5 * USD, key: "pay" });
  const hold = await service.hold("t", "u", "b", 0.05, "voice_realtime");
  await quiet(() => hold!.settle(0.05));
  assert.deepEqual(await day(db, "b"), { allowanceSpent: 0, paidSpent: 30_000, writtenOff: 20_000 });
  assert.equal(await balance(db), 5 * USD - 30_000);
  await service.setSettings("t", { enabled: true, bucketLimits: {}, dailyLimit: 40_000 });
  const daily = await service.hold("t", "u", "b", 0.05, "voice_realtime");
  await quiet(() => daily!.settle(0.05));
  assert.equal(await balance(db), 5 * USD - 40_000, "the day's limit, not a cent past it");
});

const KEY = "fixture-only";
const keyHash = createHash("sha256").update(KEY).digest("hex");
const MODEL = "anthropic/claude-opus-4.1";
async function attemptsFixture(settings: Record<string, unknown>) {
  const { db } = await testDatabase();
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { payg: { tokenSha256: keyHash, billing: "prepaid" } }, platformKeys: { openrouter: KEY } }) });
  await tenants.reload();
  const service = new EndUserCredits(db);
  await service.setSettings("payg", { enabled: true, ...settings });
  const attempts = new ModelAttempts(db, new Accounts({ tenants, db, pricing: { ...DEFAULT_PRICING, openrouterCreditMultiplier: 1 } }), undefined, 0, undefined, service);
  const begin = (id: string, at = Date.now(), bucket = "builder") => attempts.event("payg", "agent", true, true, { type: "begin", id, provider: "openrouter", model: MODEL, kind: "response", at, keyHash,
    estimate: { inputTokens: 1_000, maxOutputTokens: 4_000, rates: { input: 0, output: 0 } }, endUser: { id: "person", bucket } }).then(attemptAck);
  const finish = (id: string, usd: number) => attempts.event("payg", "agent", true, true, { type: "finish", id, usage: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0, providerCost: usd, providerCreditCost: usd }, chars: 200, completed: true });
  const posted = async (id: string) => {
    const row = (await db.query("select end_user_raw, end_user_allowance, end_user_paid, end_user_written_off, state, revision from model_attempts where id = $1", [id])).rows[0];
    return { raw: Number(row.end_user_raw), allowance: Number(row.end_user_allowance), paid: Number(row.end_user_paid), writtenOff: Number(row.end_user_written_off), state: row.state, revision: row.revision };
  };
  return { db, service, attempts, begin, finish, posted };
}

test("a normal model call with enough balance runs and settles exactly: no write-off, nothing logged", async () => {
  const { db, service, begin, finish, posted } = await attemptsFixture({ markupBps: 2_000 });
  await service.post("payg", "person", { kind: "grant", amount: 10 * USD, key: "pay" });
  const id = randomUUID();
  const { result: ack, logged } = await quiet(async () => {
    const ack = await begin(id);
    await finish(id, 0.01);
    return ack;
  });
  assert.equal(ack.refused, undefined);
  assert.ok(ack.tracked);
  assert.deepEqual(logged.filter(line => line?.type === "end_user_written_off"), []);
  assert.deepEqual(await posted(id), { raw: 10_000, allowance: 0, paid: 12_000, writtenOff: 0, state: "settled", revision: 1 });
  assert.equal(await balance(db, "person", "payg"), 10 * USD - 12_000);
  const [entry] = (await service.ledger("payg", "person", { limit: 1 })).entries;
  assert.deepEqual([entry.raw, entry.amount, entry.writtenOff], [10_000, -12_000, 0]);
  assert.equal((await db.query("select count(*)::int as n from end_user_holds")).rows[0].n, 0);
});

test("a model call that costs more than its hold: capped at settlement, kept on the attempt, and corrected by the difference", async () => {
  const { db, service, attempts, begin, finish, posted } = await attemptsFixture({ allowances: { "bot:*": 100_000 }, bucketLimits: { "bot:*": 0 } });
  const id = randomUUID();
  await quiet(async () => { await begin(id, Date.now(), "bot:1"); await finish(id, 0.4); });
  assert.deepEqual(await posted(id), { raw: 400_000, allowance: 100_000, paid: 0, writtenOff: 300_000, state: "settled", revision: 1 });
  assert.equal(await balance(db, "person", "payg"), 0);
  // Reconciled lower: the write-off goes down, the allowance stays spent; again, nothing moves.
  const usage = (usd: number) => ({ input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0, providerCost: usd, providerCreditCost: usd });
  await db.query("update model_attempts set state = 'estimated' where id = $1", [id]);
  await attempts.settle(id, "payg", "agent", usage(0.25), 0, true, true);
  assert.deepEqual(await posted(id), { raw: 250_000, allowance: 100_000, paid: 0, writtenOff: 150_000, state: "settled", revision: 2 });
  await attempts.settle(id, "payg", "agent", usage(0.25), 0, true, true);
  assert.equal((await posted(id)).revision, 2, "a revision delivered again posts nothing");
  assert.deepEqual(await day(db, "bot:1"), { allowanceSpent: 100_000, paidSpent: 0, writtenOff: 150_000 });
  assert.equal((await service.ledger("payg", "person")).entries.length, 2);
});

test("midnight: a call begun at 23:59:59 is capped by the day it posts to, and so is a correction made later", async () => {
  const { db, service, attempts, begin, finish, posted } = await attemptsFixture({ dailyLimit: USD });
  await service.post("payg", "person", { kind: "grant", amount: 10 * USD, key: "pay" });
  const midnight = Date.parse(`${today()}T00:00:00.000Z`);
  const yesterday = utcDay(midnight - 1);
  // Yesterday's paid spend is $0.90 of its $1 limit; today has none.
  await transaction(db, sql => settleUsage(sql, { tenant: "payg", endUser: "person", bucket: "builder", day: yesterday, raw: 900_000, key: "attempt:y:1" }));
  const id = randomUUID();
  await quiet(async () => { await begin(id, midnight - 1_000); await finish(id, 0.3); });
  assert.deepEqual(await posted(id), { raw: 300_000, allowance: 0, paid: 100_000, writtenOff: 200_000, state: "settled", revision: 1 }, "yesterday's limit, not today's");
  assert.deepEqual(await day(db, "builder", yesterday), { allowanceSpent: 0, paidSpent: USD, writtenOff: 200_000 });
  assert.deepEqual(await day(db, "builder"), { allowanceSpent: 0, paidSpent: 0, writtenOff: 0 });
  // Later, the provider's figure is higher: still yesterday's limit, which is spent.
  await db.query("update model_attempts set state = 'estimated' where id = $1", [id]);
  await quiet(() => attempts.settle(id, "payg", "agent", { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0, providerCost: 0.5, providerCreditCost: 0.5 }, 0, true, true));
  assert.deepEqual(await posted(id), { raw: 500_000, allowance: 0, paid: 100_000, writtenOff: 400_000, state: "settled", revision: 2 });
  assert.equal(await balance(db, "person", "payg"), 9 * USD);
});
