// Ported from tests/model-credit.test.ts. Included assertions and test bodies are unchanged.
// Only service imports and the isolated Postgres fixture differ; see money-policy-port.json for excluded ECS fixtures.
import { test } from "node:test";

import assert from "node:assert/strict";

import { createHash, randomUUID } from "node:crypto";

import { Accounts } from "../src/accounts.ts";

import { Tenants } from "../src/tenants.ts";

import { EndUserCredits } from "../src/end-user-credits.ts";

import { attemptAck, type AttemptEstimate } from "../src/model-attempt.ts";

import { ModelAttempts } from "../src/model-attempts.ts";

import { testDatabase } from "./billing-database.ts";

const KEY = "fixture-only", keyHash = createHash("sha256").update(KEY).digest("hex");

const USD = 1_000_000;

const PRO = "openai/gpt-5.5-pro";

const MILLION_IN = { inputTokens: 1_000_000, maxOutputTokens: 128_000, rates: { input: 0, output: 0 } };

const SMALL = { inputTokens: 1_000, maxOutputTokens: 128_000, rates: { input: 0, output: 0 } };

async function setup(balance: number, purchased = balance) {
  const { db } = await testDatabase();
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { payg: { tokenSha256: keyHash, billing: "prepaid" }, internal: { tokenSha256: "a".repeat(64) }, unbilled: { tokenSha256: "b".repeat(64), billing: "none" } }, platformKeys: { openrouter: KEY } }) });
  await tenants.reload();
  const account = new Accounts({ tenants, db });
  await db.query("insert into credit_accounts (tenant, balance, purchased) values ('payg', $1, $2)", [balance, purchased]);
  const attempts = new ModelAttempts(db, account);
  const begin = async (model: string, estimate: AttemptEstimate, id = randomUUID()) => ({ id, ack: await attempts.event("payg", "agent", true, true, { type: "begin", id, provider: "openrouter", model, kind: "response", at: Date.now(), keyHash, estimate }) });
  return { db, attempts, begin, account };
}

test("a failed attempt without usage evidence costs nothing, including after reconciliation", async () => {
  const { db, attempts, begin } = await setup(10 * USD);
  const balance = async () => Number((await db.query("select balance from credit_accounts where tenant = 'payg'")).rows[0].balance);
  const failed = await begin("particle-ai/particle-1", SMALL);
  await attempts.event("payg", "agent", true, true, { type: "finish", id: failed.id, usage: { input: 0, output: 0 }, chars: 0, completed: false });
  assert.equal(await balance(), 10 * USD);

  const answered = await begin("deepseek/deepseek-v4.1-flash-1017", SMALL);
  await attempts.event("payg", "agent", true, true, { type: "finish", id: answered.id, usage: { input: 100, output: 10, providerCost: 0.01, providerCreditCost: 0 }, chars: 40, completed: true });
  const charged = 10 * USD - await balance();
  assert.ok(charged > 0, "the answer is charged");

  await db.query("update model_attempts set updated_at = 0, next_check_at = 0 where id = $1", [failed.id]);
  await attempts.reconcile();
  assert.equal(10 * USD - await balance(), charged, "reconciling the failed attempt charges nothing");
  assert.equal(Number((await db.query("select charge from model_attempts where id = $1", [failed.id])).rows[0].charge), 0);
});

test("a failed platform call releases the end-user hold and costs neither payer", async () => {
  const { db } = await testDatabase();
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { payg: { tokenSha256: keyHash, billing: "prepaid" } }, platformKeys: { openrouter: KEY } }) });
  await tenants.reload();
  await db.query("insert into credit_accounts (tenant, balance, purchased) values ('payg', $1, $1)", [10 * USD]);
  const service = new EndUserCredits(db);
  await service.setSettings("payg", { enabled: true });
  await service.post("payg", "person", { kind: "grant", amount: 5 * USD, key: "pay" });
  const attempts = new ModelAttempts(db, new Accounts({ tenants, db }), undefined, 0, undefined, service);
  const event = (body: object) => attempts.event("payg", "agent", true, true, body as never);
  const begin = (id: string, model: string) => event({ type: "begin", id, provider: "openrouter", model, kind: "response", at: Date.now(), keyHash, estimate: SMALL, endUser: { id: "person", bucket: "b" } });
  const endUserHeld = async () => Number((await db.query("select coalesce(sum(paid + allowance), 0)::bigint as n from end_user_holds")).rows[0].n);
  const balance = async () => Number((await db.query("select balance from credit_accounts where tenant = 'payg'")).rows[0].balance);
  const person = async () => Number((await db.query("select balance from end_users where tenant = 'payg' and id = 'person'")).rows[0].balance);

  const failed = randomUUID(), answered = randomUUID();
  await begin(failed, "particle-ai/particle-1");
  assert.ok(await endUserHeld() > 0);
  await event({ type: "finish", id: failed, usage: { input: 0, output: 0 }, chars: 0, completed: false });

  assert.equal(await endUserHeld(), 0);
  await begin(answered, "deepseek/deepseek-v4.1-flash-1017");
  await event({ type: "finish", id: answered, usage: { input: 100, output: 10, providerCost: 0.01, providerCreditCost: 0 }, chars: 40, completed: true });
  const tenantPaid = 10 * USD - await balance(), personPaid = 5 * USD - await person();
  assert.ok(tenantPaid >= 10_000 && personPaid >= 10_000, `the answer is charged to both: ${tenantPaid}, ${personPaid}`);

  await db.query("update model_attempts set updated_at = 0, next_check_at = 0 where id = $1", [failed]);
  await attempts.reconcile();
  assert.deepEqual([10 * USD - await balance(), 5 * USD - await person()], [tenantPaid, personPaid], "reconciling the failed attempt charges neither");
  const row = (await db.query("select charge, end_user_raw from model_attempts where id = $1", [failed])).rows[0];
  assert.deepEqual([Number(row.charge), Number(row.end_user_raw)], [0, 0]);
});

test("a tenants-file tenant with no billing, or none, starts without a credit account: as camel-bots and chiridion-prod are", async () => {
  const { db, attempts } = await setup(0);
  for (const tenant of ["internal", "unbilled"]) {
    const id = randomUUID();
    const answer = await attempts.event(tenant, "agent", true, true, { type: "begin", id, provider: "openrouter", model: PRO, kind: "response", at: Date.now(), keyHash, estimate: MILLION_IN } as never);
    assert.equal(answer, true, tenant);
    assert.equal((await db.query("select 1 from credit_accounts where tenant = $1", [tenant])).rowCount, 0, `${tenant} has no credit account`);
    await attempts.event(tenant, "agent", true, true, { type: "finish", id, usage: { input: 10, output: 1, providerCost: 0.01, providerCreditCost: 0 }, chars: 4, completed: true });
  }
});

const charge = (attempts: ModelAttempts, id: string, agent = "agent") =>
  attempts.event("payg", agent, true, true, { type: "finish", id, usage: { input: 100, output: 10, providerCost: 0.1, providerCreditCost: 0 }, chars: 40, completed: true });

const balanceOf = async (db: ModelAttempts["db"]) =>
  Number((await db.query("select balance from credit_accounts where tenant='payg'")).rows[0].balance);

test("a tenant with one micro-dollar can start without an output cap, settles in full, and cannot start again", async () => {
  const { db, attempts, begin } = await setup(1);
  const { id, ack } = await begin(PRO, MILLION_IN);
  assert.equal(ack, true, "no tenant affordability fields");
  assert.deepEqual(await attempts.event("payg", "agent", true, true, { type: "progress", id, chars: 100_000 }), { tracked: true });
  await charge(attempts, id);
  assert.equal(await balanceOf(db), 1 - 100_000);
  const next = await begin(PRO, SMALL);
  assert.equal(attemptAck(next.ack).refused?.reason, "balance");
  assert.equal((await db.query("select id from model_attempts where id=$1", [next.id])).rowCount, 0);
  assert.equal((await begin(PRO, MILLION_IN, id)).ack, true, "a committed begin can be redelivered");
});

test("free credit refuses the next call when hourly spend reaches the allowance with balance left", async () => {
  const { account, db, attempts, begin } = await setup(5 * USD, 0);
  const started = await begin(PRO, MILLION_IN);
  assert.equal(started.ack, true);
  await db.query("insert into credit_spend_minutes(tenant,minute,amount) values ('payg',$1,$2)",
    [Math.floor(Date.now() / 60_000), account.billing.pricing.free.hourlySpend - 100_000]);
  await charge(attempts, started.id);
  assert.equal(await balanceOf(db), 5 * USD - 100_000);
  assert.equal(await account.billing.spendable("payg", db), 0);
  assert.equal(attemptAck((await begin(PRO, SMALL)).ack).refused?.reason, "balance");
  await db.query("update credit_spend_minutes set amount=amount+1 where tenant='payg'");
  assert.equal(attemptAck((await begin(PRO, SMALL)).ack).refused?.reason, "balance");
});

test("concurrent agents can all admit against the same tiny positive balance and all debit in full", async () => {
  const { db, attempts } = await setup(1);
  const calls = Array.from({ length: 8 }, (_, n) => ({ id: randomUUID(), agent: `agent-${n}` }));
  const decisions = await Promise.all(calls.map(({ id, agent }) => attempts.event("payg", agent, true, true,
    { type: "begin", id, provider: "openrouter", model: PRO, kind: "response", at: Date.now(), keyHash, estimate: MILLION_IN })));
  assert.deepEqual(decisions, calls.map(() => true));
  await Promise.all(calls.map(({ id, agent }) => charge(attempts, id, agent)));
  assert.equal(await balanceOf(db), 1 - calls.length * 100_000);
  const usage = (await db.query("select count(*) n, sum(amount) total from credit_ledger where tenant='payg' and kind='usage'")).rows[0];
  assert.equal(Number(usage.n), calls.length);
  assert.equal(Number(usage.total), -calls.length * 100_000);
});

test("an open payment dispute blocks admission with a positive purchased balance", async () => {
  const { db, begin } = await setup(5 * USD);
  await db.query("insert into billing_disputes(id,payment_intent,tenant,amount,status,created_at,updated_at) values('fixture-dispute','fixture-intent','payg',100,'needs_response',$1,$1)", [Date.now()]);
  assert.equal(attemptAck((await begin(PRO, SMALL)).ack).refused?.reason, "balance");
  await db.query("update billing_disputes set closed=true where id='fixture-dispute'");
  assert.equal((await begin(PRO, SMALL)).ack, true);
});
