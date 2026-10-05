import { test } from "node:test";
import assert from "node:assert/strict";
import { Billing, postLedger } from "../src/billing.ts";
import { Stripe, signWebhook } from "../src/stripe.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";

const SECRET = "whsec_dispute_fixture";
async function fixture() {
  const { db } = await testDatabase();
  await db.query("insert into tenants (id, billing, created_at) values ('alice', 'prepaid', 1)");
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: {} }) });
  const billing = new Billing({ db, tenants, stripe: new Stripe({ secretKey: "sk_test_fixture", webhookSecret: SECRET }) });
  let n = 0;
  const send = (type: string, object: object) => {
    const body = JSON.stringify({ id: `evt_${++n}`, object: "event", type, livemode: false, data: { object } });
    return billing.webhook(body, signWebhook(SECRET, body));
  };
  const account = async () => (await db.query("select balance, purchased from credit_accounts where tenant = 'alice'")).rows[0];
  const blocked = async () => { billing.invalidate(["alice"]); return (await billing.creditLimit("alice"))?.message; };
  return { db, billing, send, account, blocked };
}
// Stripe's event payloads, trimmed to the fields the runtime reads.
const purchase = { object: "checkout.session", created: 1, livemode: false, id: "cs_dispute", mode: "payment", payment_status: "paid", payment_intent: "pi_dispute", customer: "cus_alice", amount_total: 1055, currency: "usd",
  metadata: { purpose: "agent-runtime-credit", tenant: "alice", credit: "10000000" } };
const dispute = (status: string, amount = 1055) => ({ id: "dp_dispute", object: "dispute", amount, charge: "ch_dispute", currency: "usd", payment_intent: "pi_dispute", reason: "fraudulent", status, livemode: false });

test("a dispute debits the purchase's credit and stops runs until it closes; won, the credit comes back", async () => {
  const { db, send, account, blocked } = await fixture();
  await send("checkout.session.completed", purchase);
  assert.deepEqual(await account(), { balance: 10_000_000, purchased: 10_000_000 });
  assert.equal(await blocked(), undefined);
  assert.equal((await send("charge.dispute.created", dispute("needs_response"))).handled, "dispute");
  await send("charge.dispute.created", dispute("needs_response"));
  assert.deepEqual(await account(), { balance: 0, purchased: 0 });
  assert.match(await blocked() ?? "", /disputed/);
  assert.equal((await send("charge.dispute.closed", dispute("won"))).handled, "dispute closed");
  await send("charge.dispute.closed", dispute("won"));
  assert.deepEqual(await account(), { balance: 10_000_000, purchased: 10_000_000 });
  assert.equal(await blocked(), undefined);
  assert.equal(Number((await db.query("select count(*) from credit_ledger")).rows[0].count), 3);
});

test("a lost dispute keeps the debit, so credit already spent leaves the account in debt", async () => {
  const { db, send, account, blocked } = await fixture();
  await send("checkout.session.completed", purchase);
  await postLedger(db, [{ tenant: "alice", kind: "usage", amount: -4_000_000, key: "usage:alice:test" }]);
  await send("charge.dispute.created", dispute("needs_response"));
  assert.deepEqual(await account(), { balance: -4_000_000, purchased: 0 });
  await send("charge.dispute.closed", dispute("lost"));
  assert.deepEqual(await account(), { balance: -4_000_000, purchased: 0 });
  assert.match(await blocked() ?? "", /out of credit/);
});

test("disputes arriving before their purchase, or closed before they open, apply once in the right state", async () => {
  const early = await fixture();
  assert.equal((await early.send("charge.dispute.created", dispute("needs_response"))).handled, "pending dispute");
  await early.send("checkout.session.completed", purchase);
  assert.deepEqual(await early.account(), { balance: 0, purchased: 0 });
  assert.match(await early.blocked() ?? "", /disputed/);

  const reordered = await fixture();
  await reordered.send("checkout.session.completed", purchase);
  await reordered.send("charge.dispute.closed", dispute("won"));
  await reordered.send("charge.dispute.created", dispute("needs_response"));
  assert.deepEqual(await reordered.account(), { balance: 10_000_000, purchased: 10_000_000 });
  assert.equal(await reordered.blocked(), undefined);
});

test("a dispute after a partial refund removes only the credit still left", async () => {
  const { send, account } = await fixture();
  await send("checkout.session.completed", purchase);
  await send("charge.refunded", { id: "ch_dispute", payment_intent: "pi_dispute", amount: 1055, amount_refunded: 500, currency: "usd" });
  await send("charge.dispute.created", dispute("needs_response", 1055));
  assert.deepEqual(await account(), { balance: 0, purchased: 0 });
});
