import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { transaction, type Db } from "../src/db.ts";
import { EndUserCredits, HOLD_MS, NOTHING_POSTED as NOTHING, settleUsage, utcDay } from "../src/end-user-credits.ts";
import { HOLD_OUTPUT_TOKENS, MIN_OUTPUT_TOKENS, ModelAttempts } from "../src/model-attempts.ts";
import { attemptAck } from "../src/model-attempt.ts";
import { catalogRates, UNPRICED_COST } from "../src/platform-pricing.ts";
import { DEFAULT_PRICING } from "../src/pricing.ts";
import { testDatabase } from "./database.ts";

const USD = 1_000_000;
const today = () => utcDay(Date.now());

async function credits(settings: Record<string, unknown> = {}) {
  const { db } = await testDatabase();
  const service = new EndUserCredits(db);
  await service.setSettings("t", { enabled: true, ...settings });
  return { db, service };
}
const balance = async (db: Db, user = "u") => Number((await db.query("select balance from end_users where tenant = 't' and id = $1", [user])).rows[0]?.balance ?? 0);
const ledgerSum = async (db: Db, user = "u") => Number((await db.query("select coalesce(sum(amount), 0) as total from end_user_ledger where tenant = 't' and end_user = $1", [user])).rows[0].total);
const holds = async (db: Db) => (await db.query("select * from end_user_holds")).rows;

test("a hold takes the bucket's allowance first, then the balance at the markup; settling posts what the call cost", async () => {
  const { db, service } = await credits({ allowances: { "bot:*": USD }, markupBps: 2_500 });
  await service.post("t", "u", { kind: "grant", amount: 2 * USD, key: "pay-1" });

  const first = await service.reserve("t", "u", "bot:1", { id: randomUUID(), want: 1.5 * USD, min: 100 });
  assert.deepEqual(first?.hold && { raw: first.hold.raw, allowance: first.hold.allowance, paid: first.hold.paid }, { raw: 1.5 * USD, allowance: USD, paid: 625_000 }, "0.50 over the allowance costs 0.625 at +25%");
  const during = await service.get("t", "u", ["bot:1"]);
  assert.deepEqual([during.held, during.available, during.today.buckets[0].allowanceLeft], [625_000, 2 * USD - 625_000, 0]);

  // It cost 1.20: the allowance covers 1.00, the balance pays 0.20 marked up.
  await service.settleHold("t", "u", "bot:1", first!.hold!.id, 1.2 * USD, "call-1");
  assert.equal(await balance(db), 2 * USD - 250_000);
  const [usage] = (await service.ledger("t", "u", { limit: 1 })).entries;
  assert.deepEqual([usage.kind, usage.raw, usage.allowance, usage.amount, usage.bucket, usage.metadata.markupBps], ["usage", 1.2 * USD, USD, -250_000, "bot:1", 2_500]);
  assert.equal((await holds(db)).length, 0, "settling releases the hold");
  // The same settlement again posts nothing.
  await service.settleHold("t", "u", "bot:1", first!.hold!.id, 1.2 * USD, "call-1");
  assert.equal(await balance(db), 2 * USD - 250_000);

  // The bucket's allowance is used today; another bot's is its own.
  const second = await service.reserve("t", "u", "bot:1", { id: randomUUID(), want: USD, min: 1 });
  assert.deepEqual([second!.hold!.allowance, second!.hold!.paid], [0, 1_250_000]);
  const other = await service.reserve("t", "u", "bot:2", { id: randomUUID(), want: USD, min: 1 });
  assert.deepEqual([other!.hold!.allowance, other!.hold!.paid], [USD, 0]);
  const day = (await db.query("select bucket, allowance_spent, paid_spent from end_user_days where day = $1 order by bucket", [today()])).rows;
  assert.deepEqual(day.map(row => [row.bucket, Number(row.allowance_spent), Number(row.paid_spent)]), [["bot:1", USD, 250_000]]);
});

test("a call is refused when it cannot hold its minimum: for the balance, or for the daily limit", async () => {
  const { service } = await credits({ allowances: { builder: 500_000 } });
  const broke = await service.reserve("t", "u", "builder", { id: randomUUID(), want: USD, min: 600_000 });
  assert.equal(broke?.refused?.reason, "balance", "the allowance alone is less than the minimum");
  assert.equal(broke!.refused!.message, 'This end user has too little credit left for this call: $0.50 is left of the free $0.50 for "builder" today, and their balance is $0.00');
  assert.ok((await service.reserve("t", "u", "builder", { id: randomUUID(), want: USD, min: 400_000 }))?.hold, "what the allowance has is enough for a smaller minimum");
  const none = await service.refusal("t", "u", "builder");
  assert.equal(none?.message, 'This end user is out of credit: the free $0.50 for "builder" today is used up, and their balance is $0.00', "nothing left: a run is refused before it starts");
  assert.match((await service.refusal("t", "u", "other"))!.message, /"other" has no free allowance/);

  await service.post("t", "u", { kind: "grant", amount: 10 * USD, key: "pay" });
  await service.update("t", "u", { dailyLimit: USD });
  const capped = await service.reserve("t", "u", "builder", { id: randomUUID(), want: 3 * USD, min: 1 });
  assert.equal(capped!.hold!.paid, USD, "the balance has 10 but the day 1");
  const limited = await service.reserve("t", "u", "builder", { id: randomUUID(), want: USD, min: 1 });
  assert.equal(limited?.refused?.reason, "daily_limit");
  assert.match(limited!.refused!.message, /daily credit limit of \$1\.00/);
  assert.equal(await new EndUserCredits(service.db).reserve("off", "u", "builder", { id: randomUUID(), want: USD, min: 1 }), undefined, "a tenant that does not meter its end users holds nothing");
  assert.deepEqual((await service.reserve("t", "nobody", "builder", { id: randomUUID(), want: 0, min: 0 }))?.hold?.raw, 0, "a free call is never refused");
});

test("a bucket's own daily limit caps what it charges the balance, whatever the balance: a bot cannot spend past it", async () => {
  const { service } = await credits({ allowances: { "bot:*": 100_000 }, bucketLimits: { "bot:*": 300_000 } });
  await service.post("t", "u", { kind: "grant", amount: 10 * USD, key: "pay" });
  // The allowance, then up to $0.30 of the balance: $10 there or not.
  const first = await service.reserve("t", "u", "bot:1", { id: randomUUID(), want: USD, min: 1 });
  assert.deepEqual([first!.hold!.allowance, first!.hold!.paid], [100_000, 300_000]);
  const capped = await service.reserve("t", "u", "bot:1", { id: randomUUID(), want: USD, min: 1 });
  assert.equal(capped?.refused?.reason, "bucket_limit");
  assert.match(capped!.refused!.message, /daily limit of \$0\.30 of paid credit for "bot:1"/);
  assert.equal((await service.refusal("t", "u", "bot:1"))?.reason, "bucket_limit", "a run is refused before it starts");
  // Another bot's bucket has its own; a bucket with no key only the balance (and the daily limit).
  assert.equal((await service.reserve("t", "u", "bot:2", { id: randomUUID(), want: USD, min: 1 }))!.hold!.paid, 300_000);
  assert.equal((await service.reserve("t", "u", "builder", { id: randomUUID(), want: USD, min: 1 }))!.hold!.paid, USD);
  // Settled, what it paid counts against its limit as its holds did.
  await service.settleHold("t", "u", "bot:1", first!.hold!.id, 250_000, "call-1");
  assert.equal((await service.get("t", "u")).today.buckets.find(bucket => bucket.bucket === "bot:1")!.paidLimit, 300_000);
  const rest = await service.reserve("t", "u", "bot:1", { id: randomUUID(), want: USD, min: 1 });
  assert.equal(rest!.hold!.paid, 300_000 - 150_000, "$0.15 was paid of its $0.30");
  // A user's own: 0 keeps a bot to its allowance alone, and says so.
  await service.update("t", "u", { bucketLimits: { "bot:3": 0 } });
  const free = await service.reserve("t", "u", "bot:3", { id: randomUUID(), want: USD, min: 1 });
  assert.deepEqual([free!.hold!.allowance, free!.hold!.paid], [100_000, 0]);
  const none = await service.reserve("t", "u", "bot:3", { id: randomUUID(), want: USD, min: 1 });
  assert.equal(none?.refused?.reason, "bucket_limit");
  assert.match(none!.refused!.message, /"bot:3" spends no paid credit/);
  assert.deepEqual((await service.update("t", "u", { bucketLimits: { "bot:3": null } })).overrides.bucketLimits, {});
});

test("changing an allowance mid-day keeps what was spent: only the cap moves", async () => {
  const { db, service } = await credits({ allowances: { builder: 50 * USD } });
  const spent = await service.reserve("t", "u", "builder", { id: randomUUID(), want: 30 * USD, min: 1 });
  await service.settleHold("t", "u", "builder", spent!.hold!.id, 30 * USD, "k1");
  await service.setSettings("t", { allowances: { builder: 40 * USD } });
  const view = (await service.get("t", "u")).today.buckets.find(bucket => bucket.bucket === "builder")!;
  assert.deepEqual([view.allowance, view.allowanceSpent, view.allowanceLeft], [40 * USD, 30 * USD, 10 * USD]);
  const next = await service.reserve("t", "u", "builder", { id: randomUUID(), want: 20 * USD, min: 1 });
  assert.deepEqual([next!.hold!.allowance, next!.hold!.paid], [10 * USD, 0], "10 left of the new 40, and no balance");
  await service.setSettings("t", { allowances: { builder: 60 * USD } });
  assert.equal((await service.get("t", "u")).today.buckets.find(bucket => bucket.bucket === "builder")!.allowanceLeft, 20 * USD, "raised: 60 less the 30 spent and the 10 held");
  assert.equal(Number((await db.query("select allowance_spent from end_user_days where bucket = 'builder'")).rows[0].allowance_spent), 30 * USD);
});

test("parallel calls never hold more than the user has: each sees the others' holds", async () => {
  const { db, service } = await credits();
  await service.post("t", "u", { kind: "grant", amount: USD, key: "pay" });
  const raced = await Promise.all(Array.from({ length: 30 }, () => service.reserve("t", "u", "default", { id: randomUUID(), want: 100_000, min: 100_000 })));
  const granted = raced.filter(result => result?.hold);
  assert.equal(granted.length, 10, "ten calls of $0.10 fit $1.00, whatever order 30 of them arrive in");
  assert.ok(raced.filter(result => result?.refused).every(result => result!.refused!.reason === "balance"));
  // They settle in parallel, some for less than they held.
  await Promise.all(granted.map((result, index) => service.settleHold("t", "u", "default", result!.hold!.id, index % 2 ? 100_000 : 40_000, `call-${index}`)));
  assert.equal(await balance(db), USD - 5 * 100_000 - 5 * 40_000);
  assert.equal(await ledgerSum(db), await balance(db), "the ledger sums to the balance");
});

test("a concurrent workload of holds, extensions and settlements keeps every invariant", async () => {
  const { db, service } = await credits({ allowances: { a: 300_000, b: 100_000 }, markupBps: 1_000, dailyLimit: 2 * USD });
  await service.post("t", "u", { kind: "grant", amount: 3 * USD, key: "pay" });
  let overrun = 0;
  const worker = async (seed: number) => {
    for (let index = 0; index < 20; index++) {
      const bucket = (seed + index) % 3 === 0 ? "b" : "a";
      const want = 10_000 + ((seed * 7919 + index * 104_729) % 150_000);
      const id = randomUUID();
      const reserved = await service.reserve("t", "u", bucket, { id, want, min: Math.floor(want / 2) });
      if (!reserved?.hold) continue;
      let held = reserved.hold.raw;
      if (index % 4 === 0) {
        const more = await service.extend("t", "u", bucket, id, 20_000);
        if (more.hold) held += more.hold.raw;
      }
      // Most calls cost less than they held; one in five a little more (what a hidden reasoning token would do).
      const cost = index % 5 === 0 ? held + 1_000 : Math.floor(held * ((seed + index) % 10) / 10);
      if (cost > held) overrun += 1_000;
      await service.settleHold("t", "u", bucket, id, cost, `call-${seed}-${index}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, (_, seed) => worker(seed)));
  assert.equal((await holds(db)).length, 0);
  const finalBalance = await balance(db);
  assert.equal(await ledgerSum(db), finalBalance, "the ledger sums to the balance");
  const days = (await db.query("select bucket, allowance_spent, paid_spent from end_user_days")).rows;
  const usage = (await db.query("select bucket, sum(allowance)::bigint as allowance, sum(-amount)::bigint as paid from end_user_ledger where kind = 'usage' group by bucket")).rows;
  for (const row of days) {
    const posted = usage.find(entry => entry.bucket === row.bucket)!;
    assert.deepEqual([Number(row.allowance_spent), Number(row.paid_spent)], [Number(posted.allowance), Number(posted.paid)], `bucket ${row.bucket}: the day's counts are the ledger's`);
  }
  const paid = days.reduce((total, row) => total + Number(row.paid_spent), 0);
  // Overruns are the only way past a limit, each by at most its own overrun (marked up).
  const slack = Math.ceil(overrun * 1.1) + 8;
  assert.ok(paid <= 2 * USD + slack, `paid ${paid} within the daily limit and the overruns`);
  assert.ok(finalBalance >= -slack, `balance ${finalBalance} never below the overruns`);
  for (const row of days) assert.ok(Number(row.allowance_spent) <= (row.bucket === "a" ? 300_000 : 100_000) + overrun, `allowance ${row.bucket} within its cap and the overruns`);
});

test("a lowered cost refunds at the rate it was paid at, never more than was paid, whatever the markup is now", async () => {
  const { db, service } = await credits({ markupBps: 2_500 });
  await service.post("t", "u", { kind: "grant", amount: 2 * USD, key: "pay" });
  const posted = await transaction(db, sql => settleUsage(sql, { tenant: "t", endUser: "u", bucket: "b", day: today(), raw: 500_000, key: "attempt:m:1" }));
  assert.deepEqual(posted, { raw: 500_000, allowance: 0, paid: 625_000 });
  // The markup dropped to 0 since: the 100,000 the cost came down by refunds what it was paid at (+25%), not 225,000.
  await service.setSettings("t", { markupBps: 0 });
  const lower = await transaction(db, sql => settleUsage(sql, { tenant: "t", endUser: "u", bucket: "b", day: today(), raw: 400_000, key: "attempt:m:2", previous: posted }));
  assert.deepEqual(lower, { raw: 400_000, allowance: 0, paid: 500_000 });
  // Raised to +100%: down to nothing refunds what was paid, no more.
  await service.setSettings("t", { markupBps: 10_000 });
  const none = await transaction(db, sql => settleUsage(sql, { tenant: "t", endUser: "u", bucket: "b", day: today(), raw: 0, key: "attempt:m:3", previous: lower }));
  assert.deepEqual(none, NOTHING);
  assert.equal(await balance(db), 2 * USD, "every refund together returns exactly what was charged");
  assert.equal(await ledgerSum(db), 2 * USD);
  const [day] = (await db.query("select allowance_spent, paid_spent from end_user_days")).rows;
  assert.deepEqual([Number(day.allowance_spent), Number(day.paid_spent)], [0, 0]);
});

test("a refund returns at most the balance not held by calls in flight; an adjustment still corrects it", async () => {
  const { db, service } = await credits();
  await service.post("t", "u", { kind: "grant", amount: USD, key: "pay" });
  await assert.rejects(service.post("t", "u", { kind: "refund", amount: USD + 1, key: "re-1" }), (error: any) => error.status === 409 && error.code === "INSUFFICIENT_BALANCE");
  await service.reserve("t", "u", "b", { id: randomUUID(), want: 400_000, min: 1 });
  await assert.rejects(service.post("t", "u", { kind: "refund", amount: 600_001, key: "re-2" }), (error: any) => error.status === 409 && error.details.refundable === 600_000);
  assert.equal((await service.post("t", "u", { kind: "refund", amount: 600_000, key: "re-3" })).entry.balanceAfter, 400_000);
  assert.equal(await balance(db), 400_000);
  // A balance already below zero (a call's overspend) is never refunded from; an adjustment moves it either way.
  await transaction(db, sql => settleUsage(sql, { tenant: "t", endUser: "u", bucket: "b", day: today(), raw: 500_000, key: "attempt:o:1" }));
  await assert.rejects(service.post("t", "u", { kind: "refund", amount: 1, key: "re-4" }), (error: any) => error.code === "INSUFFICIENT_BALANCE");
  assert.equal((await service.post("t", "u", { kind: "adjustment", amount: 100_000, key: "adj" })).entry.balanceAfter, 0);
});

test("a corrected cost refunds the balance first, then the allowance; holds of a dead call expire", async () => {
  const { db, service } = await credits({ allowances: { builder: 300_000 } });
  await service.post("t", "u", { kind: "grant", amount: 2 * USD, key: "pay" });
  const posted = await transaction(db, sql => settleUsage(sql, { tenant: "t", endUser: "u", bucket: "builder", day: today(), raw: USD, key: "attempt:x:1" }));
  assert.deepEqual(posted, { raw: USD, allowance: 300_000, paid: 700_000 });
  const corrected = await transaction(db, sql => settleUsage(sql, { tenant: "t", endUser: "u", bucket: "builder", day: today(), raw: 400_000, key: "attempt:x:2", previous: posted }));
  assert.deepEqual(corrected, { raw: 400_000, allowance: 300_000, paid: 100_000 });
  assert.equal(await balance(db), 2 * USD - 100_000);
  const lower = await transaction(db, sql => settleUsage(sql, { tenant: "t", endUser: "u", bucket: "builder", day: today(), raw: 100_000, key: "attempt:x:3", previous: corrected }));
  assert.deepEqual(lower, { raw: 100_000, allowance: 100_000, paid: 0 });
  assert.equal(Number((await db.query("select allowance_spent from end_user_days where bucket = 'builder'")).rows[0].allowance_spent), 100_000);

  // A hold whose call went quiet past HOLD_MS no longer counts, and the next reserve drops it.
  const now = Date.now();
  await service.reserve("t", "u", "builder", { id: randomUUID(), want: 1.5 * USD, min: 1 }, now);
  assert.equal(await balance(db), 2 * USD, "all paid spend refunded");
  assert.equal((await service.get("t", "u", [], now)).available, 2 * USD - 1_300_000, "0.20 of allowance left, 1.30 held of the balance");
  assert.equal((await service.get("t", "u", [], now + HOLD_MS + 1)).available, 2 * USD);
  await service.reserve("t", "u", "builder", { id: randomUUID(), want: 1, min: 1 }, now + HOLD_MS + 1);
  assert.equal((await holds(db)).length, 1);
});

const KEY = "fixture-only";
const keyHash = createHash("sha256").update(KEY).digest("hex");
/** `funding`: dollars paid per dollar of OpenRouter credit; 1 unless a test is about it. */
async function attemptsFixture(funding = 1) {
  const { db } = await testDatabase();
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { payg: { tokenSha256: keyHash, billing: "prepaid" } }, platformKeys: { openrouter: KEY } }) });
  await tenants.reload();
  const service = new EndUserCredits(db);
  await service.setSettings("payg", { enabled: true, markupBps: 2_000 });
  const pricing = { ...DEFAULT_PRICING, openrouterCreditMultiplier: funding };
  return { db, service, attempts: new ModelAttempts(db, new Accounts({ tenants, db, pricing }), undefined, 0, undefined, service) };
}
const MODEL = "anthropic/claude-opus-4.1";

test("a model call holds its estimate, holds more as it streams, is cut at the line, and posts its cost marked up", async () => {
  const { db, service, attempts } = await attemptsFixture();
  const rates = catalogRates("openrouter", MODEL);
  await service.post("payg", "person", { kind: "grant", amount: USD, key: "pay" });
  const id = randomUUID();
  const begin = { type: "begin" as const, id, provider: "openrouter", model: MODEL, kind: "response" as const, at: Date.now(), keyHash,
    estimate: { inputTokens: 10_000, maxOutputTokens: 32_000, rates: { input: 0, output: 0 } }, endUser: { id: "person", bucket: "builder" } };
  const ack = attemptAck(await attempts.event("payg", "agent", true, true, begin));
  // Priced from the catalog (the platform's key, prepaid), never the host's rates.
  const input = Math.ceil(10_000 * rates.input), want = input + Math.ceil(HOLD_OUTPUT_TOKENS * rates.output);
  const held = Number((await holds(db))[0].paid);
  assert.equal(held, Math.min(USD, Math.ceil(want * 1.2)), "the hold is the estimate marked up, within the balance");
  // Its line: where the estimate (2 characters a token) reaches what it holds; it asks for more ahead of it.
  assert.ok(ack.tracked && ack.stopAtChars! > 0 && ack.checkAtChars! < ack.stopAtChars!);
  assert.ok(Math.abs(ack.stopAtChars! - Math.floor((Math.floor(held / 1.2) - input) / rates.output * 2)) <= 2);
  assert.equal((await db.query("select end_user, end_user_bucket from model_attempts where id = $1", [id])).rows[0].end_user, "person");

  // Asking ahead of the line: it holds the rest of the balance, and its line moves out.
  const next = attemptAck(await attempts.event("payg", "agent", true, true, { type: "progress", id, chars: ack.checkAtChars! }));
  assert.equal(next.refused, undefined);
  assert.equal(Number((await holds(db))[0].paid), USD, "it took what was left");
  const line = next.stopAtChars!;
  assert.ok(line > ack.stopAtChars!);
  // Asking again: nothing more, so it stops at that line.
  const cut = attemptAck(await attempts.event("payg", "agent", true, true, { type: "progress", id, chars: next.checkAtChars! }));
  assert.deepEqual([cut.refused?.reason, cut.stopAtChars, cut.checkAtChars], ["balance", line, undefined]);

  // It ends cut short: billed at the estimate of what it streamed, from the balance, marked up.
  await attempts.event("payg", "agent", true, true, { type: "finish", id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, estimatedInputTokens: 10_000 }, chars: line, completed: false });
  const [entry] = (await service.ledger("payg", "person", { limit: 1 })).entries;
  const raw = input + Math.ceil(line / 2) * rates.output;
  assert.ok(Math.abs(entry.raw - raw) <= rates.output * 2, `raw ${entry.raw} ≈ ${raw}`);
  assert.equal(entry.amount, -Math.ceil(entry.raw * 1.2));
  assert.ok(entry.amount >= -USD - Math.ceil(rates.output * 2 * 1.2), "stopped at the line: at most a token or so past the balance");
  assert.equal((await holds(db)).length, 0);
  const posted = (await db.query("select end_user_raw, end_user_paid from model_attempts where id = $1", [id])).rows[0];
  assert.deepEqual([Number(posted.end_user_raw), Number(posted.end_user_paid)], [entry.raw, -entry.amount]);
});

test("a model call its end user cannot pay for is refused before it is made, and leaves no attempt", async () => {
  const { db, attempts } = await attemptsFixture();
  const id = randomUUID();
  const ack = attemptAck(await attempts.event("payg", "agent", true, true, { type: "begin", id, provider: "openrouter", model: MODEL, kind: "response", at: Date.now(), keyHash,
    estimate: { inputTokens: 1_000, maxOutputTokens: 4_000, rates: { input: 15, output: 75 } }, endUser: { id: "nobody", bucket: "builder" } }));
  assert.deepEqual([ack.tracked, ack.refused?.reason, ack.refused?.endUser, ack.refused?.bucket], [false, "balance", "nobody", "builder"]);
  assert.equal((await db.query("select count(*)::int as n from model_attempts")).rows[0].n, 0);
});

test("a begin delivered again holds once, and a request for more that lands after the call settled holds nothing", async () => {
  const { db, service, attempts } = await attemptsFixture();
  await service.post("payg", "person", { kind: "grant", amount: USD, key: "pay" });
  const id = randomUUID();
  const begin = { type: "begin" as const, id, provider: "openrouter", model: MODEL, kind: "response" as const, at: Date.now(), keyHash,
    estimate: { inputTokens: 1_000, maxOutputTokens: 4_000, rates: { input: 15, output: 75 } }, endUser: { id: "person", bucket: "builder" } };
  await attempts.event("payg", "agent", true, true, begin);
  await attempts.event("payg", "agent", true, true, begin);
  assert.equal((await holds(db)).length, 1);
  await attempts.event("payg", "agent", true, true, { type: "finish", id, usage: { input: 100, output: 10, providerCost: 0.01, providerCreditCost: 0 }, chars: 40, completed: true });
  assert.equal((await holds(db)).length, 0);
  // The host's last progress report, answered after the call's end was settled: it does not hold again.
  await service.extend("payg", "person", "builder", id, 100_000);
  assert.equal((await holds(db)).length, 0);
  assert.equal((await service.get("payg", "person")).held, 0);
});

test("a failed call with no output releases its hold; one without an end user is the tenant's alone", async () => {
  const { db, service, attempts } = await attemptsFixture();
  await service.post("payg", "person", { kind: "grant", amount: USD, key: "pay" });
  const id = randomUUID();
  await attempts.event("payg", "agent", true, true, { type: "begin", id, provider: "openrouter", model: MODEL, kind: "response", at: Date.now(), keyHash,
    estimate: { inputTokens: 1_000, maxOutputTokens: MIN_OUTPUT_TOKENS, rates: { input: 15, output: 75 } }, endUser: { id: "person", bucket: "builder" } });
  assert.equal((await holds(db)).length, 1);
  await attempts.event("payg", "agent", true, true, { type: "finish", id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, chars: 0, completed: false });
  assert.equal((await holds(db)).length, 0, "a refused request (no output, no usage) holds nothing more");
  assert.equal((await service.ledger("payg", "person")).entries.filter(entry => entry.kind === "usage").length, 0);

  const plain = randomUUID();
  await attempts.event("payg", "agent", true, true, { type: "begin", id: plain, provider: "openrouter", model: MODEL, kind: "response", at: Date.now(), keyHash });
  await attempts.event("payg", "agent", true, true, { type: "finish", id: plain, usage: { input: 100, output: 10, providerCost: 0.1, providerCreditCost: 0 }, chars: 40, completed: true });
  assert.equal((await db.query("select count(*)::int as n from end_user_ledger where kind = 'usage'")).rows[0].n, 0);
});

test("a model with no price is never free to its end user, nor refused for it: it holds and settles at the catalog's or a mid-range price, and is said", async () => {
  const { db, service, attempts } = await attemptsFixture();
  await service.post("payg", "person", { kind: "grant", amount: USD, key: "pay" });
  const begin = (id: string, provider: string, model: string, endUser = "person") => ({ type: "begin" as const, id, provider, model, kind: "response" as const, at: Date.now(), keyHash,
    estimate: { inputTokens: 1_000, maxOutputTokens: 4_000, rates: { input: 0, output: 0 } }, endUser: { id: endUser, bucket: "b" } });
  // A tenant's own model declared without pricing, on its own key: the host prices it at zero.
  const id = randomUUID();
  const ack = attemptAck(await attempts.event("payg", "agent", false, false, begin(id, "mine", "llama-local")));
  assert.ok(ack.tracked && ack.stopAtChars! > 0, "it holds, at a mid-range price");
  assert.ok(Number((await holds(db))[0].paid) > 0);
  const errors: string[] = [];
  const error = console.error;
  console.error = (line: string) => { errors.push(line); };
  try {
    await attempts.event("payg", "agent", false, false, { type: "finish", id, usage: { input: 1_000, output: 100, cacheRead: 2_000, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, chars: 200, completed: true });
  } finally { console.error = error; }
  const [entry] = (await service.ledger("payg", "person", { limit: 1 })).entries;
  // $3 in, $15 out, $0.30 cache reads, a million tokens.
  assert.equal(entry.raw, 1_000 * UNPRICED_COST.input + 100 * UNPRICED_COST.output + 2_000 * UNPRICED_COST.cacheRead);
  assert.equal(entry.amount, -Math.ceil(entry.raw * 1.2));
  assert.ok(errors.some(line => JSON.parse(line).type === "end_user_unpriced_model"), errors.join("\n"));
  // Someone on a small free allowance still runs one: its hold is sized as a mid-range model's, not the dearest.
  for (const user of ["small", "small-2"]) await service.update("payg", user, { allowances: { b: 30_000 } });
  const small = attemptAck(await attempts.event("payg", "agent", false, false, begin(randomUUID(), "mine", "llama-local", "small")));
  assert.equal(small.refused, undefined);
  // So on the platform's key, a model the catalog lacks (billed at the provider's dearest when it settles).
  const unlisted = attemptAck(await attempts.event("payg", "agent", true, true, begin(randomUUID(), "openrouter", "newlab/brand-new-model", "small-2")));
  assert.equal(unlisted.refused, undefined);
  // Nobody with nothing to pay with runs one.
  const refused = attemptAck(await attempts.event("payg", "agent", false, false, begin(randomUUID(), "mine", "llama-local", "nobody")));
  assert.equal(refused.refused?.reason, "balance");
  // A tenant endpoint's call (no cost to the tenant) is priced as the catalog prices the model it names.
  const routed = randomUUID();
  attemptAck(await attempts.event("payg", "agent", false, false, begin(routed, "acme", `openrouter/${MODEL}`)));
  await attempts.event("payg", "agent", false, false, { type: "finish", id: routed, usage: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, chars: 200, completed: true });
  const rates = catalogRates("openrouter", MODEL);
  assert.equal((await service.ledger("payg", "person", { limit: 1 })).entries[0].raw, Math.round(1_000 * rates.input + 100 * rates.output));
  // A model the catalog prices at zero is free, as is a call the provider says cost nothing.
  const free = randomUUID();
  const freeAck = attemptAck(await attempts.event("payg", "agent", false, false, begin(free, "openrouter", "google/gemma-4-26b-a4b-it:free", "nobody")));
  assert.equal(freeAck.refused, undefined);
  await attempts.event("payg", "agent", false, false, { type: "finish", id: free, usage: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, chars: 200, completed: true });
  const reported = randomUUID();
  attemptAck(await attempts.event("payg", "agent", false, false, begin(reported, "mine", "llama-local")));
  await attempts.event("payg", "agent", false, false, { type: "finish", id: reported, usage: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0, providerCost: 0, cost: { total: 0 } }, chars: 200, completed: true });
  assert.equal((await service.ledger("payg", "nobody")).entries.length, 0);
  assert.equal((await service.ledger("payg", "person")).entries.filter(entry => entry.kind === "usage").length, 2);
});

test("what a call costs its end user is what it costs the tenant: usage.recorded's cost (cache reads and writes, reasoning, the provider's own) and funding it", async () => {
  const { db, service, attempts } = await attemptsFixture(1.055);
  await db.query("insert into webhook_endpoints (id, tenant, url, events, secret, created_at) values ('we', 'payg', 'https://hooks.example.test', '{usage.recorded}', '{}', 0)");
  await service.post("payg", "person", { kind: "grant", amount: 10 * USD, key: "pay" });
  const call = async (usage: Record<string, unknown>) => {
    const id = randomUUID();
    attemptAck(await attempts.event("payg", "agent", true, true, { type: "begin", id, provider: "openrouter", model: MODEL, kind: "response", at: Date.now(), keyHash,
      estimate: { inputTokens: 1_000, maxOutputTokens: 4_000, rates: { input: 0, output: 0 } }, endUser: { id: "person", bucket: "b" } }));
    await attempts.event("payg", "agent", true, true, { type: "finish", id, usage, chars: 100, completed: true });
    const recorded = (await db.query("select body from webhook_deliveries where body->'data'->>'attemptId' = $1", [id])).rows[0].body.data;
    const entry = (await service.ledger("payg", "person")).entries.find(entry => entry.metadata.attempt === id)!;
    const charged = -Number((await db.query("select amount from credit_ledger where idempotency_key = $1", [`model-attempt:${id}:1`])).rows[0].amount);
    return { recorded, entry, charged };
  };
  // Priced from the catalog: cache reads and writes at their own rates, reasoning as the output it is billed as.
  const priced = await call({ input: 1_000, output: 2_000, reasoning: 1_500, cacheRead: 50_000, cacheWrite: 10_000 });
  const rates = catalogRates("openrouter", MODEL);
  assert.ok(priced.recorded.cost.usd > (1_000 * rates.input + 2_000 * rates.output) / USD, "cache tokens are priced");
  // The tenant pays the platform the provider's price and the cost of funding its credits: the end user's raw cost is that.
  assert.equal(priced.entry.raw, priced.charged);
  assert.ok(priced.charged > Math.round(priced.recorded.cost.usd * USD), "funding is on top of the provider's price");
  assert.ok(Math.abs(priced.charged - priced.recorded.cost.usd * USD * 1.055) <= 2);
  // What the provider says it charged comes first.
  const reported = await call({ input: 1_000, output: 2_000, cacheRead: 0, cacheWrite: 0, providerCost: 0.123456 });
  assert.deepEqual([reported.recorded.cost.usd, reported.entry.raw], [0.123456, reported.charged]);
  assert.equal(reported.entry.amount, -Math.ceil(reported.charged * 1.2), "the markup is over that");
});
