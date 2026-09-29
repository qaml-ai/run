import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "../src/accounts.ts";
import { BillingAlerts } from "../src/billing-alerts.ts";
import { BillingMailer } from "../src/billing-mailer.ts";
import { createHash } from "node:crypto";
import { Billing } from "../src/billing.ts";
import { AutoTopup } from "../src/auto-topup.ts";
import { Stripe, signWebhook } from "../src/stripe.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";
import { listen, runtime, OPERATOR } from "./runtime-server.ts";
import { billingEmail } from "../src/billing-emails.ts";

const SECRET = "whsec_auto_fixture";
async function fixture(t: TestContext) {
  const { db } = await testDatabase();
  let now = Date.UTC(2026,8,29), seq = 0;
  let outcome: "success" | "decline" | "action" | "processing" = "success";
  let card: any = { id: "pm_4242", type: "card", customer: "cus_alice", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } };
  let lost: string | undefined;
  let tamper = false;
  const invoices = new Map<string, any>(), payments = new Map<string, any>(), keys = new Map<string, any>();
  const calls: { path: string; method: string; params: URLSearchParams; key?: string }[] = [];
  const url = await listen(t, async (req,res) => {
    let body = ""; for await (const part of req) body += part;
    const path = new URL(req.url!, "http://local").pathname, params = new URLSearchParams(body), key = req.headers["idempotency-key"] as string;
    calls.push({ path, method: req.method!, params, key });
    let value: any;
    if (key && keys.has(key)) { const prior = keys.get(key); assert.equal(body, prior.body); value = prior.value; }
    else if (req.method === "GET" && path === "/v1/customers/cus_alice") value = { id: "cus_alice", livemode: false, invoice_settings: { default_payment_method: card } };
    else if (req.method === "GET" && path === "/v1/invoice_payments") {
      const id = new URL(req.url!, "http://local").searchParams.get("invoice")!;
      const pi = payments.get(id);
      value = { has_more: false, data: pi ? [{ invoice: id, status: pi.status === "succeeded" ? "paid" : "open", amount_paid: pi.amount_received, payment: { type: "payment_intent", payment_intent: pi } }] : [] };
    } else if (req.method === "GET" && path.startsWith("/v1/invoices/")) value = invoices.get(path.split("/")[3]);
    else if (req.method === "POST" && path === "/v1/invoices") {
      const id = `in_${++seq}`;
      assert.equal(params.get("pending_invoice_items_behavior"), "exclude");
      assert.equal(params.get("auto_advance"), "false");
      value = { id, customer: params.get("customer"), livemode: false, metadata: { purpose: params.get("metadata[purpose]"), attempt: params.get("metadata[attempt]") }, currency: "usd", status: "draft", auto_advance: false, starting_balance: 0, total: 0, amount_due: 0, amount_paid: 0, hosted_invoice_url: `https://invoice.stripe.test/${id}` };
      invoices.set(id, value);
    } else if (req.method === "POST" && path === "/v1/invoiceitems") {
      const invoice = invoices.get(params.get("invoice")!)!;
      assert.equal(invoice.status, "draft"); assert.equal(params.get("discountable"), "false");
      const amount = Number(params.get("amount")); invoice.total += amount; invoice.amount_due += amount;
      if (tamper) { tamper = false; invoice.total += 100; }
      value = { id: `ii_${++seq}`, invoice: invoice.id, amount };
    } else if (path.endsWith("/void")) {
      value = invoices.get(path.split("/")[3]); value.status = "void";
      const pi = payments.get(value.id); if (pi) pi.status = "canceled";
    } else if (path.endsWith("/finalize")) {
      value = invoices.get(path.split("/")[3]); value.status = "open";
      payments.set(value.id, { id: `pi_${value.id}`, customer: value.customer, livemode: false, currency: "usd", amount: value.total, amount_received: 0, status: "requires_payment_method" });
    } else if (path.endsWith("/pay")) {
      value = invoices.get(path.split("/")[3]); const pi = payments.get(value.id)!;
      assert.equal(params.get("off_session"), "true");
      pi.payment_method = card;
      pi.status = outcome === "success" ? "succeeded" : outcome === "decline" ? "requires_payment_method" : outcome === "action" ? "requires_action" : "processing";
      if (outcome === "success") { value.status = "paid"; value.amount_paid = value.total; pi.amount_received = pi.amount; }
    }
    if (key && value) keys.set(key, { body, value });
    if ((lost === path || (lost === "pay" && path.endsWith("/pay"))) && req.method === "POST") { lost = undefined; res.destroy(); return; }
    res.writeHead(value ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify(value ?? { error: { code: "resource_missing" } }));
  });
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { alice: { tokenSha256: "a".repeat(64), billing: "prepaid" } } }) }); await tenants.reload();
  const stripe = new Stripe({ secretKey: "sk_test_auto", webhookSecret: SECRET, apiUrl: url });
  const billing = new Billing({ db, tenants, stripe, publicUrl: "https://agents.example.test" });
  const auto = new AutoTopup(billing, stripe, () => now);
  await db.query("insert into billing_stripe_customers (tenant,livemode,request_id,customer,created_at) values ('alice',false,gen_random_uuid(),'cus_alice',$1)", [now]);
  const quote = (terms = { threshold: 5e6, amount: 20e6, monthlyLimit: 200e6 }) => auto.quote("alice", terms);
  const enable = async (terms?: { threshold: number; amount: number; monthlyLimit: number }) => { const q = await quote(terms); return auto.enable("alice", q.id, q.version, true); };
  const advance = (ms = 31_000) => { now += ms; };
  const pump = async (n = 7) => { for (let i=0;i<n;i++) await auto.pump(); };
  const balance = async () => (await billing.account("alice")).balance;
  return { db, billing, stripe, auto, url, quote, enable, advance, pump, balance, calls, invoices, payments,
    setOutcome: (next: typeof outcome) => { outcome = next; }, setCard: (next: typeof card) => { card = next; },
    tamper: () => { tamper = true; }, lose: (path: string) => { lost = path; }, restart: () => new AutoTopup(billing, stripe, () => now),
    approve: () => { for (const [id, pi] of payments) { pi.status = "succeeded"; pi.amount_received = pi.amount; const invoice = invoices.get(id); invoice.status = "paid"; invoice.amount_paid = invoice.total; } } };
}

test("auto top-up is off by default; quotes require current explicit consent and survive a card-setup round trip", async t => {
  const f = await fixture(t);
  assert.equal((await f.auto.get("alice")).state, "off"); await f.pump(); assert.equal(f.invoices.size, 0);
  f.setCard(null); const without = await f.quote(); assert.equal(without.card, null);
  await assert.rejects(f.auto.enable("alice", without.id, without.version, true), /changed/);
  await assert.rejects(f.auto.enable("alice", without.id, without.version, false), /authorization/);
  f.setCard({ id: "pm_new", type: "card", customer: "cus_alice", card: { brand: "visa", last4: "5555", exp_month: 1, exp_year: 2031 } });
  const reviewed = await f.auto.preview("alice", without.id); assert.equal(reviewed.card?.last4, "5555"); assert.notEqual(reviewed.version, without.version);
  await f.billing.post([{ tenant: "alice", kind: "grant", amount: 10e6, key: "grant" }]);
  await assert.rejects(f.auto.enable("alice", reviewed.id, reviewed.version, true), /changed/);
  const fresh = await f.auto.preview("alice", without.id); assert.equal(fresh.immediate, false);
  await f.auto.enable("alice", fresh.id, fresh.version, true); assert.equal((await f.auto.get("alice")).state, "on");
  await f.auto.disable("alice"); await f.auto.enable("alice", fresh.id, fresh.version, true);
  assert.equal((await f.auto.get("alice")).enabled, false, "replaying an old acceptance cannot undo a later disable");
});

test("an immediate top-up reserves the all-in amount and posts credit only after verified Stripe payment", async t => {
  const f = await fixture(t), state = await f.enable();
  assert.equal(state.held, 21.1e6); assert.equal(state.state, "processing"); assert.equal(await f.balance(), 0);
  await f.pump();
  assert.equal(await f.balance(), 20e6); assert.equal(f.invoices.size, 1);
  const done = await f.auto.get("alice"); assert.equal(done.usedThisPeriod, 21.1e6); assert.equal(done.held, 0);
  const ledger = (await f.billing.ledger("alice")).entries[0]; assert.equal(ledger.metadata.autoTopup, true); assert.match(String(ledger.metadata.invoiceUrl), /^https:/);
  assert.equal((await f.db.query("select count(*) from billing_events where type='billing.topup.receipt'")).rows[0].count, 1);
  await f.pump(); assert.equal(await f.balance(), 20e6);
});

test("concurrent workers share one reservation and invoice; a lost create response resumes with its original key", async t => {
  const f = await fixture(t); await f.enable(); f.lose("/v1/invoices"); await f.auto.pump(); f.advance();
  const other = f.restart();
  for (let i=0;i<8;i++) await Promise.all([f.auto.pump(), other.pump()]);
  assert.equal(await f.balance(), 20e6); assert.equal(f.invoices.size, 1);
  assert.equal((await f.db.query("select count(*) from billing_auto_attempts")).rows[0].count, 1);
  const creates = f.calls.filter(c => c.path === "/v1/invoices"); assert.equal(new Set(creates.map(c => c.key)).size, 1);
});

test("monthly cap includes fees: nine $21.10 top-ups fit $200, refunds do not reopen the cap", async t => {
  const f = await fixture(t); await f.enable();
  for (let i=0;i<9;i++) {
    await f.pump(); assert.equal(await f.balance(), 20e6);
    await f.billing.post([{ tenant: "alice", kind: "usage", amount: -20e6, key: `usage:${i}` }]);
    f.advance();
  }
  await f.pump(); const state = await f.auto.get("alice");
  assert.equal(state.state, "limit_reached"); assert.equal(state.usedThisPeriod, 189.9e6); assert.equal(f.invoices.size, 9);
  const pi = [...f.payments.values()][0];
  const body = JSON.stringify({ id: "evt_refund", type: "charge.refunded", livemode: false, data: { object: { id: "ch_refund", payment_intent: pi.id, amount: 2110, amount_refunded: 2110, currency: "usd", metadata: { purpose: "agent-runtime-auto-topup" } } } });
  await f.billing.webhook(body, signWebhook(SECRET, body)); f.advance(); await f.pump();
  assert.equal((await f.auto.get("alice")).usedThisPeriod, 189.9e6); assert.equal(f.invoices.size, 9);
  assert.equal((await f.db.query("select count(*) from billing_events where type='billing.topup.limit'")).rows[0].count, 1);
});

test("declines keep the reservation across months; explicit retry pays the same invoice with the new default card", async t => {
  const f = await fixture(t); f.setOutcome("decline"); await f.enable(); await f.pump();
  let state = await f.auto.get("alice"); assert.equal(state.state, "paused_declined"); const id = state.attempt!.id;
  f.advance(5*86_400_000); await f.pump(); assert.equal(f.invoices.size, 1); assert.equal((await f.auto.get("alice")).held, 21.1e6);
  assert.equal(f.calls.filter(c => c.path.endsWith("/pay")).length, 1);
  f.setOutcome("success"); f.setCard({ id: "pm_new", type: "card", customer: "cus_alice", card: { brand: "visa", last4: "5555", exp_month: 1, exp_year: 2031 } });
  await f.auto.retry("alice", id); await f.pump(3);
  assert.equal(await f.balance(), 20e6); assert.equal(f.invoices.size, 1);
  assert.equal(f.calls.filter(c => c.path.endsWith("/pay")).at(-1)!.params.get("payment_method"), "pm_new");
});

test("bank confirmation remains on the original invoice; invoice.paid without a successful payment cannot grant credit", async t => {
  const f = await fixture(t); f.setOutcome("action"); await f.enable(); await f.pump();
  assert.equal((await f.auto.get("alice")).state, "action_required"); assert.equal(await f.balance(), 0);
  f.approve(); await f.auto.wake([...f.invoices.keys()][0]); await f.pump(1); assert.equal(await f.balance(), 20e6);
  const g = await fixture(t); g.setOutcome("action"); await g.enable(); await g.pump();
  const invoice = [...g.invoices.values()][0]; invoice.status = "paid"; invoice.amount_paid = invoice.total;
  await g.auto.wake([...g.invoices.keys()][0]); await g.pump(1); assert.equal(await g.balance(), 0); assert.equal((await g.auto.get("alice")).state, "reconcile");
});

test("disable cancels unsubmitted reservations but an already submitted invoice can finish", async t => {
  const f = await fixture(t); await f.enable(); await f.auto.disable("alice"); await f.pump();
  assert.equal(f.invoices.size, 0); assert.equal((await f.auto.get("alice")).held, 0);
  await f.enable(); await f.pump(1); await f.auto.disable("alice"); await f.pump(6);
  assert.equal(await f.balance(), 20e6); assert.equal((await f.auto.get("alice")).enabled, false); assert.equal(f.invoices.size, 1);
});

test("a removed card pauses before payment and resumes the same invoice when a default card is restored", async t => {
  const f = await fixture(t); await f.enable(); f.setCard(null); await f.pump();
  assert.equal((await f.auto.get("alice")).state, "paused_no_card"); assert.equal(f.calls.filter(c => c.path.endsWith("/pay")).length, 0);
  f.setCard({ id: "pm_back", type: "card", customer: "cus_alice", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } }); await f.auto.refresh("alice"); await f.pump(3);
  assert.equal(await f.balance(), 20e6); assert.equal(f.invoices.size, 1);
});

test("ambiguous old invoice creates retain the hold; invoice totals are checked before charging", async t => {
  const f = await fixture(t); await f.enable(); f.lose("/v1/invoices"); await f.pump(1); f.advance(24*3_600_000); await f.pump(1);
  assert.equal((await f.auto.get("alice")).state, "reconcile"); assert.equal((await f.auto.get("alice")).held, 21.1e6); assert.equal(f.invoices.size, 1);
  const g = await fixture(t); await g.enable(); g.tamper(); await g.pump(1);
  assert.equal((await g.auto.get("alice")).state, "reconcile"); assert.equal(g.calls.filter(c => c.path.endsWith("/pay")).length, 0);
});

test("payment emails include exact charges, the invoice link, and escaped text", () => {
  const mail = billingEmail({ kind: "receipts", tenant: "<alice>", email: "billing@example.test", origin: "https://agents.example.test", balance: 20e6,
    payment: { notice: "receipt", amount: 20e6, fee: 1.1e6, total: 21.1e6, used: 21.1e6, monthlyLimit: 200e6, invoiceUrl: "https://invoice.stripe.test/in_1", card: { brand: "visa", last4: "4242" } } });
  assert.match(mail.subject, /20.00/); assert.match(mail.text, /Charged: \$21.10/); assert.match(mail.html, /&lt;alice&gt;/); assert.match(mail.text, /View invoice: https:/);
  for (const notice of ["declined", "action_required", "no_card", "limit", "reconcile"]) assert.ok(billingEmail({ kind: "problems", tenant: "alice", email: "b@example.test", origin: "https://agents.example.test", payment: { notice, total: 21.1e6 } }).text);
});


test("an old ambiguous pay is reconciled from its successful invoice without charging again", async t => {
  const f = await fixture(t); await f.enable(); f.lose("pay"); await f.pump(1);
  assert.equal(await f.balance(), 0); f.advance(24*3_600_000); await f.pump(1);
  assert.equal(await f.balance(), 20e6); assert.equal(f.calls.filter(c => c.path.endsWith("/pay")).length, 1);
});

test("failed ledger writes roll back the paid marker and retry fulfillment without another payment", async t => {
  const f = await fixture(t); await f.enable();
  await f.db.query("create function reject_auto_credit() returns trigger language plpgsql as $$ begin raise exception 'fixture rejection'; end $$");
  await f.db.query("create trigger reject_auto_credit before insert on credit_ledger for each row execute function reject_auto_credit()");
  await f.pump(1); assert.equal((await f.auto.get("alice")).held, 21.1e6); assert.equal(await f.balance(), 0);
  await f.db.query("drop trigger reject_auto_credit on credit_ledger"); f.advance(); await f.pump(1);
  assert.equal(await f.balance(), 20e6); assert.equal(f.calls.filter(c => c.path.endsWith("/pay")).length, 1);
});

test("the mail worker sends payment receipts and drops a resolved no-card warning", async t => {
  const f = await fixture(t);
  const accounts = new Accounts({ db: f.db, tenants: f.billing.tenants, secretsKey: "ab".repeat(32) });
  const alerts = new BillingAlerts(f.db, accounts);
  await f.db.query("insert into billing_recipients (id,tenant,email,status,receipts,confirmation_hash,confirmation_expires,created_at) values (gen_random_uuid(),'alice','finance@example.test','verified',true,'fixture',0,0)");
  const sent: string[] = [];
  const mailer = new BillingMailer({ db: f.db, alerts, origin: "https://agents.example.test", from: "billing@example.test", configurationSet: "fixture", topics: [], send: async mail => { sent.push(mail.subject); return "ses_fixture"; } });
  await f.enable(); f.setCard(null); await f.pump(5);
  assert.equal((await f.auto.get("alice")).state, "paused_no_card");
  f.setCard({ id: "pm_back", type: "card", customer: "cus_alice", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } }); await f.auto.refresh("alice"); await f.pump(3);
  await mailer.pump(); await mailer.stop();
  assert.deepEqual(sent, ["Auto top-up added $20.00 to camelRun"]);
});


test("auto top-up REST requires the exact quote version and explicit consent", async t => {
  const f = await fixture(t);
  const r = await runtime(t, () => ({ role: "assistant", content: "Hi" }), { STRIPE_SECRET_KEY: "sk_test_auto", STRIPE_WEBHOOK_SECRET: SECRET, AGENT_STRIPE_API_URL: f.url },
    { tenants: { alice: { billing: "prepaid", apiKeys: {}, tokenSha256: createHash("sha256").update(OPERATOR).digest("hex") } } });
  await r.db.query("insert into billing_stripe_customers (tenant,livemode,request_id,customer,created_at) values ('alice',false,gen_random_uuid(),'cus_alice',0)");
  assert.equal((await r.call("/v1/billing/auto-topup", { token: null })).status, 401);
  assert.equal((await r.call("/v1/billing/auto-topup")).json.state, "off");
  const quote = await r.call("/v1/billing/auto-topup/quote", { body: { thresholdUsd: 5, amountUsd: 20, monthlyLimitUsd: 200 } });
  assert.equal(quote.status, 201, JSON.stringify(quote.json)); assert.equal(quote.json.total, 21.1e6); assert.equal(quote.json.immediate, true);
  const body = { quoteId: quote.json.id, version: quote.json.version };
  assert.equal((await r.call("/v1/billing/auto-topup/enable", { body })).status, 400);
  assert.equal((await r.call("/v1/billing/auto-topup/enable", { body: { ...body, version: "0".repeat(64), consent: true } })).status, 409);
  const enabled = await r.call("/v1/billing/auto-topup/enable", { body: { ...body, consent: true } });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.json)); assert.equal(enabled.json.held, 21.1e6);
  assert.equal((await r.call("/v1/billing/auto-topup/disable", { body: {} })).json.state, "off");
});

test("healthy balances make no polling Stripe calls; nodes claim a low-balance scan only once", async t => {
  const f = await fixture(t); await f.billing.post([{ tenant: "alice", kind: "grant", amount: 10e6, key: "healthy" }]);
  await f.enable(); const before = f.calls.length;
  f.advance(3_600_000); await Promise.all([f.auto.pump(), f.restart().pump()]); assert.equal(f.calls.length, before);
  await f.billing.post([{ tenant: "alice", kind: "usage", amount: -10e6, key: "spend" }]);
  await Promise.all([f.auto.pump(), f.restart().pump()]);
  assert.equal(f.calls.slice(before).filter(c => c.path === "/v1/customers/cus_alice").length, 2, "one scan and one pre-payment card refresh");
  assert.equal(f.invoices.size, 1); assert.equal(await f.balance(), 20e6, "ready steps finish within one pump");
});

test("waiting attempts back off for an hour and portal returns wake card recovery", async t => {
  const f = await fixture(t); await f.enable(); f.setCard(null); await f.pump(1);
  const before = f.calls.length; f.advance(); await f.pump(1); assert.equal(f.calls.length, before);
  f.setCard({ id: "pm_back", type: "card", customer: "cus_alice", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } });
  await f.auto.refresh("alice"); await f.pump(1); assert.equal(await f.balance(), 20e6);
});

test("disable voids a declined invoice and releases its hold before re-enabling", async t => {
  const f = await fixture(t); f.setOutcome("decline"); await f.enable(); await f.pump(1);
  assert.equal((await f.auto.disable("alice")).state, "cancelling"); await f.pump(1);
  assert.equal([...f.invoices.values()][0].status, "void"); assert.equal((await f.auto.get("alice")).held, 0);
  f.setOutcome("success"); await f.enable(); await f.pump(1); assert.equal(f.invoices.size, 2); assert.equal(await f.balance(), 20e6);
});

test("disable reconciles a concurrent completed payment rather than voiding it", async t => {
  const f = await fixture(t); f.setOutcome("decline"); await f.enable(); await f.pump(1);
  await f.auto.disable("alice"); f.approve(); await f.pump(1);
  assert.equal(await f.balance(), 20e6); assert.equal(f.calls.filter(c => c.path.endsWith("/void")).length, 0);
});

test("bank confirmation can finish after disable, but an unpaid action expires after a day", async t => {
  const f = await fixture(t); f.setOutcome("action"); await f.enable(); await f.pump(1);
  await f.auto.disable("alice"); f.advance(23*3_600_000); await f.pump(1);
  assert.equal((await f.auto.get("alice")).held, 21.1e6); assert.equal(f.calls.filter(c => c.path.endsWith("/void")).length, 0);
  f.advance(2*3_600_000); await f.pump(1);
  assert.equal((await f.auto.get("alice")).held, 0); assert.equal([...f.invoices.values()][0].status, "void");
});

test("reconciliation mail explains the pause without assigning internal work to the customer", () => {
  const mail = billingEmail({ kind: "problems", tenant: "alice", email: "b@example.test", origin: "https://agents.example.test", payment: { notice: "reconcile" } });
  assert.match(mail.text, /We’re checking a recent top-up/); assert.doesNotMatch(mail.html, /ACTION NEEDED/);
});

test("a lost void response retains the hold until Stripe confirms the invoice is void", async t => {
  const f = await fixture(t); f.setOutcome("decline"); await f.enable(); await f.pump(1);
  const invoice = [...f.invoices.values()][0]; await f.auto.disable("alice"); f.lose(`/v1/invoices/${invoice.id}/void`); await f.pump(1);
  assert.equal((await f.auto.get("alice")).held, 21.1e6); f.advance(); await f.pump(1);
  assert.equal((await f.auto.get("alice")).held, 0); assert.equal(f.calls.filter(c => c.path.endsWith("/void")).length, 1);
});
