// Ported from tests/end-user-debits.test.ts. Included assertions and test bodies are unchanged.
// Only service imports and the isolated Postgres fixture differ; see money-policy-port.json for excluded ECS fixtures.
import { test } from "node:test";

import assert from "node:assert/strict";

import { createHash, randomUUID } from "node:crypto";

import { Accounts } from "../src/accounts.ts";

import { Tenants } from "../src/tenants.ts";

import { transaction, type Db } from "../src/postgres.ts";

import { EndUserCredits, NOTHING_POSTED as NOTHING, settleUsage, utcDay } from "../src/end-user-credits.ts";

import { ModelAttempts } from "../src/model-attempts.ts";

import { attemptAck } from "../src/model-attempt.ts";

import { catalogRates } from "../src/platform-pricing.ts";

import { DEFAULT_PRICING } from "../../../src/pricing.ts";

import { testDatabase } from "./billing-database.ts";

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

test("a lowered cost refunds at the rate it was paid at, never more than was paid, whatever the markup is now", async () => {
  const { db, service } = await credits({ markupBps: 2_500 });
  await service.post("t", "u", { kind: "grant", amount: 2 * USD, key: "pay" });
  const posted = await transaction(db, sql => settleUsage(sql, { tenant: "t", endUser: "u", bucket: "b", day: today(), raw: 500_000, key: "attempt:m:1" }));
  assert.deepEqual(posted, { raw: 500_000, allowance: 0, paid: 625_000, writtenOff: 0 });
  // The markup dropped to 0 since: the 100,000 the cost came down by refunds what it was paid at (+25%), not 225,000.
  await service.setSettings("t", { markupBps: 0 });
  const lower = await transaction(db, sql => settleUsage(sql, { tenant: "t", endUser: "u", bucket: "b", day: today(), raw: 400_000, key: "attempt:m:2", previous: posted }));
  assert.deepEqual(lower, { raw: 400_000, allowance: 0, paid: 500_000, writtenOff: 0 });
  // Raised to +100%: down to nothing refunds what was paid, no more.
  await service.setSettings("t", { markupBps: 10_000 });
  const none = await transaction(db, sql => settleUsage(sql, { tenant: "t", endUser: "u", bucket: "b", day: today(), raw: 0, key: "attempt:m:3", previous: lower }));
  assert.deepEqual(none, NOTHING);
  assert.equal(await balance(db), 2 * USD, "every refund together returns exactly what was charged");
  assert.equal(await ledgerSum(db), 2 * USD);
  const [day] = (await db.query("select allowance_spent, paid_spent from end_user_days")).rows;
  assert.deepEqual([Number(day.allowance_spent), Number(day.paid_spent)], [0, 0]);
});

test("a corrected cost refunds the balance first, then the allowance", async () => {
  const { db, service } = await credits({ allowances: { builder: 300_000 } });
  await service.post("t", "u", { kind: "grant", amount: 2 * USD, key: "pay" });
  const posted = await transaction(db, sql => settleUsage(sql, { tenant: "t", endUser: "u", bucket: "builder", day: today(), raw: USD, key: "attempt:x:1" }));
  assert.deepEqual(posted, { raw: USD, allowance: 300_000, paid: 700_000, writtenOff: 0 });
  const corrected = await transaction(db, sql => settleUsage(sql, { tenant: "t", endUser: "u", bucket: "builder", day: today(), raw: 400_000, key: "attempt:x:2", previous: posted }));
  assert.deepEqual(corrected, { raw: 400_000, allowance: 300_000, paid: 100_000, writtenOff: 0 });
  assert.equal(await balance(db), 2 * USD - 100_000);
  const lower = await transaction(db, sql => settleUsage(sql, { tenant: "t", endUser: "u", bucket: "builder", day: today(), raw: 100_000, key: "attempt:x:3", previous: corrected }));
  assert.deepEqual(lower, { raw: 100_000, allowance: 100_000, paid: 0, writtenOff: 0 });
  assert.equal(Number((await db.query("select allowance_spent from end_user_days where bucket = 'builder'")).rows[0].allowance_spent), 100_000);

});

const KEY = "fixture-only";

const keyHash = createHash("sha256").update(KEY).digest("hex");

async function attemptsFixture(funding = 1) {
  const { db } = await testDatabase();
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { payg: { tokenSha256: keyHash, billing: "prepaid" } }, platformKeys: { openrouter: KEY } }) });
  await tenants.reload();
  // Fund the tenant so it can make calls on the platform's key.
  await db.query("insert into credit_accounts (tenant, balance, purchased) values ('payg', 1000000000, 1000000000) on conflict (tenant) do nothing");
  const service = new EndUserCredits(db);
  await service.setSettings("payg", { enabled: true, markupBps: 2_000 });
  const pricing = { ...DEFAULT_PRICING, openrouterCreditMultiplier: funding };
  return { db, service, attempts: new ModelAttempts(db, new Accounts({ tenants, db, pricing }), undefined, 0, undefined, service) };
}

const MODEL = "anthropic/claude-opus-4.1";

test("a model call its end user cannot pay for is refused before it is made, and leaves no attempt", async () => {
  const { db, attempts } = await attemptsFixture();
  const id = randomUUID();
  const ack = attemptAck(await attempts.event("payg", "agent", true, true, { type: "begin", id, provider: "openrouter", model: MODEL, kind: "response", at: Date.now(), keyHash,
    estimate: { inputTokens: 1_000, maxOutputTokens: 4_000, rates: { input: 15, output: 75 } }, endUser: { id: "nobody", bucket: "builder" } }));
  assert.deepEqual([ack.tracked, ack.refused?.reason, ack.refused?.endUser, ack.refused?.bucket], [false, "balance", "nobody", "builder"]);
  assert.equal((await db.query("select count(*)::int as n from model_attempts")).rows[0].n, 0);
});

test("ChatGPT subscription attempts charge no end-user credit, including through an endpoint", async t => {
  const { db, service, attempts } = await attemptsFixture();
  await service.setSettings("payg", { enabled: true, allowances: { b: USD }, markupBps: 2_000 });
  await service.post("payg", "person", { kind: "grant", amount: USD, key: "pay" });
  const errors = t.mock.method(console, "error", () => {});
  for (const provider of ["openai-codex", "gateway/openai-codex"]) {
    for (const kind of ["response", "compaction"] as const) {
      for (const usage of [
        { input: 1_000, output: 100, cost: { total: 0 } },
        { input: 1_000, output: 100, cost: { total: 0.1 }, providerCost: 0.1 },
        {}, // Missing usage must not turn a subscription call into a paid estimate.
      ]) {
        const id = randomUUID();
        const ack = attemptAck(await attempts.event("payg", "agent", false, false, { type: "begin", id, provider, model: "gpt-6-luna", kind, at: Date.now(), keyHash,
          estimate: { inputTokens: 1_000, maxOutputTokens: 4_000, rates: { input: 0, output: 0 } }, endUser: { id: "person", bucket: "b" } }));
        assert.deepEqual(ack, { tracked: true });
        assert.deepEqual(attemptAck(await attempts.event("payg", "agent", false, false, { type: "progress", id, chars: 20_000 })), { tracked: true });
        await attempts.event("payg", "agent", false, false, { type: "finish", id, usage, chars: 20_000, completed: true });
        await attempts.event("payg", "agent", false, false, { type: "finish", id, usage, chars: 20_000, completed: true });
        const row = (await db.query("select end_user_raw, end_user_allowance, end_user_paid, charge, state from model_attempts where id=$1", [id])).rows[0];
        assert.deepEqual([Number(row.end_user_raw), Number(row.end_user_allowance), Number(row.end_user_paid), Number(row.charge), row.state], [0, 0, 0, 0, "settled"]);
      }
    }
  }
  const person = await service.get("payg", "person", ["b"]);
  assert.equal(person.balance, USD);
  assert.equal(person.held, 0);
  assert.equal(person.today.buckets[0].allowanceSpent, 0);
  assert.equal(person.today.buckets[0].paidSpent, 0);
  assert.equal((await service.ledger("payg", "person")).entries.filter(entry => entry.kind === "usage").length, 0);
  assert.equal(errors.mock.calls.length, 0, "subscription calls never raise the fallback alarm");
  // A person with neither allowance nor balance is never refused at begin.
  await service.update("payg", "empty", { allowances: { b: 0 } });
  assert.deepEqual(attemptAck(await attempts.event("payg", "agent", false, false, { type: "begin", id: randomUUID(), provider: "gateway/openai-codex", model: "gpt-6-luna", kind: "response", at: Date.now(), keyHash, endUser: { id: "empty", bucket: "b" } })), { tracked: true });
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

test("one paid model call can go negative and the next is refused", async () => {
  const { service, attempts } = await attemptsFixture();
  await service.post("payg", "u", { kind: "grant", amount: 1, key: "grant" });
  const begin = (id: string) => attempts.event("payg", "agent", true, true, { type: "begin", id, provider: "openrouter", model: MODEL, kind: "response", at: Date.now(), keyHash, endUser: { id: "u", bucket: "b" } });
  const id = randomUUID();
  assert.deepEqual(attemptAck(await begin(id)), { tracked: true });
  await attempts.event("payg", "agent", true, true, { type: "finish", id, usage: { providerCost: 0.01 }, chars: 100, completed: true });
  const user = await service.get("payg", "u", ["b"]);
  assert.deepEqual([user.balance, user.available, user.held, user.today.buckets[0].writtenOff], [-11_999, -11_999, 0, 0]);
  assert.equal(attemptAck(await begin(randomUUID())).refused?.reason, "balance");
});

test("a debit crosses the daily limit in full and is idempotent across concurrent delivery", async () => {
  const { service } = await credits({ dailyLimit: 1 });
  await service.post("t", "u", { kind: "grant", amount: USD, key: "grant" });
  assert.equal(await service.refusal("t", "u", "b"), undefined);
  await Promise.all([1, 2].map(() => service.debit("t", "u", "b", 0.02, "debit")));
  const person = await service.get("t", "u", ["b"]);
  assert.deepEqual([person.balance, person.today.paidSpent, person.today.buckets[0].writtenOff], [980_000, 20_000, 0]);
  assert.equal((await service.refusal("t", "u", "b"))?.reason, "daily_limit");
  assert.equal((await service.ledger("t", "u", { kinds: ["usage"] })).entries.length, 1);
});

test("a correction reverses historical write-off before refunding balance", async () => {
  const { db, service } = await credits();
  const day = today();
  await service.post("t", "u", { kind: "grant", amount: 10, key: "grant" });
  await service.debit("t", "u", "b", 0.000010, "old");
  await db.query("update end_user_days set written_off=20");
  await db.query("update end_user_ledger set written_off=20, raw=30 where idempotency_key='old'");
  const correct = (raw: number, key: string, previous: typeof NOTHING) => transaction(db, sql => settleUsage(sql, { tenant: "t", endUser: "u", bucket: "b", day, raw, key, previous }));
  const first = await correct(15, "correct-1", { raw: 30, allowance: 0, paid: 10, writtenOff: 20 });
  assert.deepEqual(first, { raw: 15, allowance: 0, paid: 10, writtenOff: 5 });
  const second = await correct(5, "correct-2", first);
  assert.deepEqual(second, { raw: 5, allowance: 0, paid: 5, writtenOff: 0 });
  assert.equal(await balance(db), 5);
});
