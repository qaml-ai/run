import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Billing } from "../src/billing.ts";
import { transaction } from "../src/db.ts";
import { Journey, journeyKept, type JourneyEvent, type JourneyOptions } from "../src/journey.ts";
import { Stripe, signWebhook } from "../src/stripe.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";
import { listen } from "./runtime-server.ts";

const STRIPE_SECRET = "whsec_journey_billing_fixture";
const SECRET = `whsec_${Buffer.from("journey-billing-test-key-0123456789").toString("base64")}`;

/** Billing over a fake Stripe that makes customers and Checkout sessions, with journey events on for accounts whose browsers have not answered. */
async function fixture(t: TestContext, journeyOptions: Partial<JourneyOptions> = {}) {
  const { db } = await testDatabase();
  const objects = new Map<string, any>();
  let count = 0;
  const url = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const path = new URL(req.url!, "http://local").pathname, params = new URLSearchParams(body);
    let value: any;
    if (req.method === "GET") value = objects.get(path);
    else if (path === "/v1/customers") value = { id: `cus_${++count}`, livemode: false, metadata: { purpose: params.get("metadata[purpose]"), tenant: params.get("metadata[tenant]") }, invoice_settings: { default_payment_method: null } };
    else if (path === "/v1/checkout/sessions") value = {
      id: `cs_${++count}`, livemode: false, mode: params.get("mode"), customer: params.get("customer"), status: "open", payment_status: "unpaid", currency: "usd",
      amount_total: Number(params.get("line_items[0][price_data][unit_amount]")) + Number(params.get("line_items[1][price_data][unit_amount]")), client_reference_id: params.get("client_reference_id"),
      metadata: { purpose: params.get("metadata[purpose]"), tenant: params.get("metadata[tenant]"), credit: params.get("metadata[credit]"), order: params.get("metadata[order]") },
      expires_at: Math.floor(Date.now() / 1000) + 86400, url: `https://checkout.stripe.test/${count}`,
    };
    if (value?.id) objects.set(`${path}/${value.id}`, value);
    res.writeHead(value ? 200 : 404, { "Content-Type": "application/json", "request-id": "req_fixture" }).end(JSON.stringify(value ?? { error: { message: "Missing fixture", code: "resource_missing" } }));
  });
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { alice: { tokenSha256: "a".repeat(64), billing: "prepaid" } } }) });
  await tenants.reload();
  const billing = new Billing({ db, tenants, stripe: new Stripe({ secretKey: "sk_test_fixture", webhookSecret: STRIPE_SECRET, apiUrl: url }), publicUrl: "https://agents.example.test" });
  const journey = new Journey({ db, url: "http://127.0.0.1:9", secret: SECRET, collectUnknown: true, ...journeyOptions });
  billing.journey = journey;
  /** Stripe's word that a session was paid, as its webhook brings it. */
  const pay = (session: string) => {
    const body = JSON.stringify({ id: `evt_${randomUUID()}`, type: "checkout.session.completed", livemode: false,
      data: { object: { ...objects.get(`/v1/checkout/sessions/${session}`), status: "complete", payment_status: "paid", payment_intent: `pi_${session}`, invoice: `in_${session}` } } });
    return billing.webhook(body, signWebhook(STRIPE_SECRET, body));
  };
  const events = async () => (await db.query("select body from journey_outbox where target = 'events' order by created_at, id")).rows.map(row => row.body as JourneyEvent);
  return { db, billing, journey, pay, events };
}

test("credit paid for is told of once a payment, by Stripe's word and not the browser's, with the credit bought and whether it is the account's first", async t => {
  const { db, billing, journey, pay, events } = await fixture(t);
  const first = await billing.checkout("alice", 10_000_000);
  // Starting Checkout is its own event, once a session however often the page asks for it.
  await journey.checkoutStarted({ tenant: "alice", amountMinor: 1000, session: first.id });
  await journey.checkoutStarted({ tenant: "alice", amountMinor: 1000, session: first.id });
  assert.deepEqual((await events()).map(event => [event.name, event.properties]), [["run_checkout_started", { amount_minor: 1000, currency: "USD" }]]);
  // Nothing is bought until Stripe says it was paid; said twice, it is bought once.
  assert.deepEqual(await pay(first.id), { handled: "purchase" });
  assert.deepEqual(await pay(first.id), { handled: "purchase" });
  const second = await billing.checkout("alice", 25_500_000);
  await pay(second.id);
  const purchases = (await events()).filter(event => event.name === "run_credit_purchased");
  assert.deepEqual(purchases.map(event => event.properties), [
    { amount_minor: 1000, currency: "USD", is_first: true, transaction_ref: `pi_${first.id}` },
    { amount_minor: 2550, currency: "USD", is_first: false, transaction_ref: `pi_${second.id}` },
  ]);
  assert.deepEqual(purchases.map(event => [event.visitor_id, event.observed_by, event.analytics_consent]), [[null, "server", "unknown"], [null, "server", "unknown"]]);
  assert.equal(new Set(purchases.map(event => event.event_id)).size, 2);
  assert.equal(Number((await db.query("select purchased from credit_accounts where tenant = 'alice'")).rows[0].purchased), 35_500_000);
  assert.ok(!JSON.stringify(await events()).includes("alice") && !JSON.stringify(await events()).includes("cus_"));
});

test("a fault writing a payment's event never touches the payment", async t => {
  const { db, billing, pay, events } = await fixture(t, { internal: () => { throw new Error("journey unavailable"); } });
  const checkout = await billing.checkout("alice", 10_000_000);
  assert.deepEqual(await pay(checkout.id), { handled: "purchase" });
  assert.equal(Number((await db.query("select balance from credit_accounts where tenant = 'alice'")).rows[0].balance), 10_000_000);
  assert.deepEqual(await events(), []);
});

test("a card check and switching on automatic top-up are told of in the transactions that did them; a refusal silences an account's payments too", async t => {
  const { db, journey, events } = await fixture(t);
  await transaction(db, sql => journey.cardVerified(sql, "alice"));
  await transaction(db, sql => journey.cardVerified(sql, "alice"));
  await transaction(db, sql => journey.autoTopupEnabled(sql, "alice"));
  await transaction(db, sql => journey.autoTopupEnabled(sql, "alice"));
  assert.deepEqual((await events()).map(event => [event.name, event.properties]), [["run_card_verified", {}], ["run_auto_topup_enabled", {}], ["run_auto_topup_enabled", {}]]);
  // A payment whose transaction fails takes its event with it.
  await assert.rejects(transaction(db, async sql => { await journey.creditPurchased(sql, { tenant: "alice", amountMinor: 500, payment: "pi_rolled_back" }); throw new Error("payment failed"); }));
  // What is not Stripe's id for a payment is not sent as one.
  await transaction(db, sql => journey.creditPurchased(sql, { tenant: "alice", amountMinor: 500, payment: "alice@example.com" }));
  assert.equal((await events()).length, 3);
  // The account's browser refuses: from then on nothing of its payments is told.
  await journey.signedIn({ tenant: "alice", method: "github", surface: "console", browser: { visitor: null, consent: "denied", collect: false } });
  await transaction(db, sql => journey.creditPurchased(sql, { tenant: "alice", amountMinor: 500, payment: "pi_after_refusal" }));
  await transaction(db, sql => journey.cardVerified(sql, "alice"));
  await journey.checkoutStarted({ tenant: "alice", amountMinor: 500, session: "cs_after_refusal" });
  assert.equal((await events()).length, 3);
});

test("an account's export has what this runtime kept of its journey and, page by page, what the store holds", async t => {
  const pages = { events: [[{ name: "page_viewed" }, { name: "run_account_created" }], [{ name: "run_token_created" }]], touches: [[{ source: "github" }]] };
  const asked: { kind: string; cursor?: unknown; account_ref: string }[] = [];
  const store = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as { kind: "events" | "touches"; cursor?: { at: number }; account_ref: string };
    asked.push(request);
    const page = request.cursor?.at ?? 0, records = pages[request.kind][page]!;
    res.writeHead(req.url === "/api/journey/account-export" && req.headers["webhook-signature"] ? 200 : 401, { "Content-Type": "application/json" }).end(JSON.stringify({
      schema_version: 1, kind: request.kind, status: "ok", account: { handoff_status: "matched" }, events: request.kind === "events" ? records : [], touches: request.kind === "touches" ? records : [],
      next_cursor: page + 1 < pages[request.kind].length ? { at: page + 1, id: "next" } : null,
    }));
  });
  const { db, journey } = await fixture(t, { url: store });
  assert.equal(await journeyKept(db, "alice"), undefined);
  await journey.tokenCreated({ tenant: "alice" });
  const kept = (await journeyKept(db, "alice"))!;
  assert.deepEqual([kept.consent, kept.seenSinceSignup, kept.milestones.map(milestone => milestone.name), kept.eventsNotYetSent.map(event => event.name)], ["unknown", false, ["run_token_created"], ["run_token_created"]]);
  const collected: Record<string, unknown[]> = { events: [], touches: [] };
  for (const kind of ["events", "touches"] as const) for await (const page of journey.stored(kept.accountRef, kind)) {
    assert.deepEqual([page.status, page.account, page.consent, page.googleCopies], ["ok", { handoff_status: "matched" }, null, []]);
    collected[kind]!.push(page.records);
  }
  assert.deepEqual(collected, pages);
  // Each page was asked for the account this runtime chose, with the store's own cursor.
  assert.deepEqual(asked.map(request => [request.kind, request.account_ref === kept.accountRef, request.cursor ?? null]), [["events", true, null], ["events", true, { at: 1, id: "next" }], ["touches", true, null]]);
  // A store that cannot be asked, or does not answer what was asked, fails the export: it is whole or it fails.
  const down = new Journey({ db, url: "http://127.0.0.1:9", secret: SECRET });
  await assert.rejects(async () => { for await (const _page of down.stored(kept.accountRef, "events")); });
  const confused = new Journey({ db, url: store, secret: SECRET, fetch: async () => Response.json({ kind: "touches", status: "ok", touches: [], next_cursor: null }) });
  await assert.rejects(async () => { for await (const _page of confused.stored(kept.accountRef, "events")); }, /did not give the account's events/);
});
