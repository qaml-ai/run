import { test } from "node:test";
import assert from "node:assert/strict";
import { Billing } from "../src/billing.ts";
import { Stripe, signWebhook } from "../src/stripe.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";

const SECRET = "whsec_refund_fixture";
async function fixture() {
  const { db } = await testDatabase();
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: {} }) });
  const billing = new Billing({ db, tenants, stripe: new Stripe({ secretKey: "sk_test_fixture", webhookSecret: SECRET }) });
  const send = (type: string, object: object) => {
    const body = JSON.stringify({ id: `evt_${type}`, type, data: { object } });
    return billing.webhook(body, signWebhook(SECRET, body));
  };
  const account = async () => (await db.query("select balance,purchased from credit_accounts where tenant='alice'")).rows[0];
  return { db, billing, send, account };
}
const purchase = { id: "cs_refund", payment_status: "paid", payment_intent: "pi_refund", customer: "cus_alice", amount_total: 1055, currency: "usd",
  metadata: { purpose: "agent-runtime-credit", tenant: "alice", credit: "10000000" } };
const refund = (amount = 1055) => ({ id: "ch_refund", payment_intent: "pi_refund", amount: 1055, amount_refunded: amount, currency: "usd" });

test("a full refund arriving first is retained and atomically offsets later purchase fulfillment", async () => {
  const { db, send, account } = await fixture();
  assert.equal((await send("charge.refunded", refund())).handled, "pending refund");
  assert.equal(await account(), undefined);
  await send("checkout.session.completed", purchase);
  await send("checkout.session.async_payment_succeeded", purchase);
  await send("charge.refunded", refund());
  assert.deepEqual(await account(), { balance: 0, purchased: 0 });
  assert.equal((await db.query("select count(*) from credit_ledger")).rows[0].count, 2);
  assert.equal((await db.query("select count(*) from billing_events")).rows[0].count, 0, "no artificial recovery/depletion between the two ledger entries");
});

test("partial refunds reconcile monotonically across reordering, retries and restart", async () => {
  const { db, billing, send, account } = await fixture();
  await send("charge.refunded", refund(500));
  await send("charge.refunded", refund(264));
  const restarted = new Billing({ db, tenants: billing.tenants, stripe: new Stripe({ secretKey: "sk_test_fixture", webhookSecret: SECRET }) });
  const body = JSON.stringify({ id: "evt_purchase", type: "checkout.session.completed", data: { object: purchase } });
  await restarted.webhook(body, signWebhook(SECRET, body));
  const remaining = 10_000_000 - Math.round(10_000_000 * 500 / 1055);
  assert.deepEqual(await account(), { balance: remaining, purchased: remaining });
  await send("charge.refunded", refund(1055));
  await send("charge.refunded", refund(500));
  assert.deepEqual(await account(), { balance: 0, purchased: 0 });
  assert.equal((await db.query("select count(*) from credit_ledger")).rows[0].count, 3);
});

test("concurrent purchase and refund delivery cannot lose or apply credit twice", async () => {
  const { db, send, account } = await fixture();
  await Promise.all(Array.from({ length: 16 }, (_, i) => i % 2 ? send("charge.refunded", refund()) : send("checkout.session.completed", purchase)));
  assert.deepEqual(await account(), { balance: 0, purchased: 0 });
  assert.equal((await db.query("select count(*) from credit_ledger")).rows[0].count, 2);
  await assert.rejects(send("checkout.session.completed", { ...purchase, id: "cs_other" }), /another purchase/);
});

test("conflicting and invalid refunds cannot mutate the stored payment or its balance", async () => {
  const { db, send, account } = await fixture();
  await send("checkout.session.completed", purchase);
  for (const amount of [-1, 1056, 1.5]) await assert.rejects(send("charge.refunded", refund(amount)), /Invalid cumulative/);
  await assert.rejects(send("charge.refunded", { ...refund(), currency: "eur" }), /currency/);
  assert.equal((await db.query("select count(*) from billing_stripe_refunds")).rows[0].count, 0, "failed reconciliation rolls back incoming state");
  await send("charge.refunded", refund(264));
  await assert.rejects(send("charge.refunded", { ...refund(), payment_intent: "pi_other" }), /conflicts/);
  assert.equal((await db.query("select payment_intent from billing_stripe_refunds")).rows[0].payment_intent, "pi_refund");
  assert.equal((await account()).balance, 10_000_000 - Math.round(10_000_000 * 264 / 1055));
  assert.equal((await send("charge.refunded", { ...refund(), id: "ch_other_product", metadata: { purpose: "another-product" } })).handled, "ignored");
});

test("a reconciliation failure rolls back both fulfillment and pending refunds for a safe retry", async () => {
  const { db, send, account } = await fixture();
  await send("charge.refunded", refund());
  await db.query("alter table credit_ledger add constraint reject_test_refund check (kind <> 'refund')");
  await assert.rejects(send("checkout.session.completed", purchase), /reject_test_refund/);
  assert.equal(await account(), undefined);
  assert.equal((await db.query("select count(*) from credit_ledger")).rows[0].count, 0);
  await db.query("alter table credit_ledger drop constraint reject_test_refund");
  await send("checkout.session.completed", purchase);
  assert.deepEqual(await account(), { balance: 0, purchased: 0 });
});
