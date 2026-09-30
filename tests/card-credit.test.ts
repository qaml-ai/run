import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { type Db } from "../src/db.ts";
import { DEFAULT_PRICING, micros } from "../src/pricing.ts";
import { Stripe, signWebhook } from "../src/stripe.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";
import { listen } from "./runtime-server.ts";

const SECRET = "whsec_card_credit_fixture";
const DAY = 86_400_000;
const count = async (db: Db, table: string, where = "true") => Number((await db.query(`select count(*) as n from ${table} where ${where}`)).rows[0].n);

/** A Stripe with customers, setup-mode Checkout sessions and their SetupIntents. `verify` finishes one with a card. */
async function fixture(t: TestContext) {
  const { db } = await testDatabase();
  const objects = new Map<string, any>();
  let count = 0;
  const url = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const path = new URL(req.url!, "http://local").pathname, params = new URLSearchParams(body);
    let value: any;
    if (req.method === "GET") value = objects.get(path);
    else if (path === "/v1/customers") {
      value = { id: `cus_${++count}`, livemode: false, metadata: { purpose: params.get("metadata[purpose]"), tenant: params.get("metadata[tenant]") } };
      objects.set(`/v1/customers/${value.id}`, value);
    } else if (path === "/v1/checkout/sessions") {
      assert.equal(params.get("mode"), "setup");
      assert.equal(params.get("payment_method_types[0]"), "card");
      assert.equal(params.get("setup_intent_data[metadata][tenant]"), params.get("metadata[tenant]"));
      value = { id: `cs_${++count}`, livemode: false, mode: "setup", customer: params.get("customer"), status: "open", setup_intent: null,
        metadata: { purpose: params.get("metadata[purpose]"), tenant: params.get("metadata[tenant]") }, url: `https://checkout.stripe.test/${count}`, success_url: params.get("success_url") };
      objects.set(`/v1/checkout/sessions/${value.id}`, value);
    }
    res.writeHead(value ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify(value ?? { error: { message: "Missing fixture", code: "resource_missing" } }));
  });
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { root: { tokenSha256: "a".repeat(64), billing: "prepaid" } } }) });
  await tenants.reload();
  const stripe = new Stripe({ secretKey: "sk_test_fixture", webhookSecret: SECRET, apiUrl: url });
  const accounts = new Accounts({ db, tenants, stripe, publicUrl: "https://agents.example.test", pricing: { ...DEFAULT_PRICING, startingGrant: micros(5) } });
  const cards = accounts.billing.cardCredit!;
  /** Start a card check for `tenant` and finish it in Stripe with a card of this fingerprint; returns the completed session. */
  const verify = async (tenant: string, fingerprint: string, options: { funding?: string; status?: string } = {}) => {
    const { url: checkout } = await cards.start(tenant);
    const session = objects.get(`/v1/checkout/sessions/cs_${checkout.split("/").pop()}`);
    const intent = { id: `seti_${randomUUID().replaceAll("-", "")}`, livemode: false, customer: session.customer, status: options.status ?? "succeeded",
      payment_method: { id: `pm_${fingerprint}`, type: "card", card: { fingerprint, funding: options.funding ?? "credit", brand: "visa", last4: "4242" } } };
    objects.set(`/v1/setup_intents/${intent.id}`, intent);
    Object.assign(session, { status: "complete", setup_intent: intent.id });
    return session;
  };
  const send = (session: any) => {
    const body = JSON.stringify({ id: `evt_${randomUUID()}`, type: "checkout.session.completed", livemode: false, data: { object: session } });
    return accounts.billing.webhook(body, signWebhook(SECRET, body));
  };
  const google = (name: string) => accounts.tenantForGoogle({ sub: `sub-${name}`, email: `${name}@example.com` });
  return { db, accounts, cards, verify, send, google };
}

test("a Google signup gets no automatic credit; a verified card unlocks it once, through webhook retries and races", async t => {
  const f = await fixture(t);
  const tenant = await f.google("gina");
  assert.equal(tenant, "gina");
  assert.deepEqual(await f.accounts.billing.startingCredit(tenant), { status: "not_granted", amount: 0, cardCheck: { amount: micros(5) } });
  assert.equal((await f.accounts.billing.summary(tenant)).balance, 0);
  const session = await f.verify(tenant, "fp_gina");
  const second = await f.verify(tenant, "fp_gina_2");
  assert.equal(session.success_url, "https://agents.example.test/console/billing?card_check={CHECKOUT_SESSION_ID}");
  // The webhook, its retries and the console's confirmation race; the grant posts once.
  const outcomes = await Promise.all(Array.from({ length: 8 }, (_, i) => i % 2 ? f.send(session) : f.cards.confirm(tenant, session.id)));
  assert.deepEqual(outcomes.filter(outcome => "status" in outcome), Array(4).fill({ status: "granted", amount: micros(5) }));
  assert.deepEqual(await f.send(session), { handled: "card check" });
  assert.equal(await count(f.db, "credit_ledger"), 1);
  assert.equal(await count(f.db, "card_checks"), 1);
  assert.equal((await f.accounts.billing.summary(tenant)).balance, micros(5));
  assert.deepEqual(await f.accounts.billing.startingCredit(tenant), { status: "granted", amount: micros(5) });
  // Once unlocked, a check started earlier settles with nothing, and another is refused up front.
  assert.deepEqual(await f.send(second), { handled: "card check" });
  assert.deepEqual(await f.cards.confirm(tenant, second.id), { status: "not_granted", amount: 0 });
  await assert.rejects(f.cards.start(tenant), /not available/);
  assert.equal(await count(f.db, "credit_ledger"), 1);
});

test("a card unlocks credit once across tenants, even when two tenants race with it", async t => {
  const f = await fixture(t);
  const [first, second] = [await f.google("first"), await f.google("second")];
  assert.deepEqual(await f.cards.confirm(first, (await f.verify(first, "fp_shared")).id), { status: "granted", amount: micros(5) });
  assert.deepEqual(await f.cards.confirm(second, (await f.verify(second, "fp_shared")).id), { status: "not_granted", amount: 0 });
  assert.equal((await f.accounts.billing.summary(second)).balance, 0);
  // Another card still can; the refused check does not use up the tenant's chance.
  assert.ok((await f.accounts.billing.startingCredit(second)).cardCheck);
  assert.equal((await f.cards.confirm(second, (await f.verify(second, "fp_second")).id)).status, "granted");

  const racers = await Promise.all(["racer-a", "racer-b", "racer-c"].map(name => f.google(name)));
  const sessions = await Promise.all(racers.map(tenant => f.verify(tenant, "fp_race")));
  const results = await Promise.all(sessions.flatMap(session => [f.send(session), f.cards.confirm(session.metadata.tenant, session.id)]));
  assert.equal(results.filter(result => "status" in result && result.status === "granted").length, 1);
  assert.equal(await count(f.db, "card_checks", "fingerprint = 'fp_race' and granted"), 1);
  assert.equal(await count(f.db, "credit_ledger"), 3);
  // A tenant's own session only: another tenant cannot confirm it.
  await assert.rejects(f.cards.confirm(racers[0], sessions[1].id), /Unknown card check/);
});

test("prepaid cards and unfinished checks add nothing; admin tenants and granted signups are not offered a check", async t => {
  const f = await fixture(t);
  const tenant = await f.google("pat");
  assert.deepEqual(await f.cards.confirm(tenant, (await f.verify(tenant, "fp_prepaid", { funding: "prepaid" })).id), { status: "not_granted", amount: 0 });
  const unfinished = await f.verify(tenant, "fp_pending", { status: "requires_action" });
  assert.deepEqual(await f.cards.confirm(tenant, unfinished.id), { status: "pending", amount: 0 });
  assert.equal(await count(f.db, "card_checks"), 1);
  assert.equal(await count(f.db, "credit_ledger"), 0);
  await assert.rejects(f.cards.start("root"), /not available/);

  // A GitHub signup that got its grant is not offered a check; one refused at signup is, through the same path.
  const policy = { minAccountAgeMs: 30 * DAY };
  const veteran = await f.accounts.tenantForGithub({ id: 901, login: "veteran", createdAt: Date.now() - 400 * DAY }, policy);
  assert.deepEqual(await f.accounts.billing.startingCredit(veteran), { status: "granted", amount: micros(5) });
  await assert.rejects(f.cards.start(veteran), /not available/);
  const newcomer = await f.accounts.tenantForGithub({ id: 902, login: "newcomer", createdAt: Date.now() - DAY }, policy);
  assert.deepEqual(await f.accounts.billing.startingCredit(newcomer), { status: "not_eligible", amount: 0, cardCheck: { amount: micros(5) } });
  assert.equal((await f.cards.confirm(newcomer, (await f.verify(newcomer, "fp_newcomer")).id)).status, "granted");
  assert.deepEqual(await f.accounts.billing.startingCredit(newcomer), { status: "granted", amount: micros(5) });
  // Support cannot add a second starting grant on top.
  await assert.rejects(f.accounts.billing.grantStartingCredit(newcomer, micros(5), "appeal", "operator"), /already unlocked/);
  assert.equal((await f.accounts.billing.summary(newcomer)).balance, micros(5));
});

test("Google tenants never take an admin tenant's or another account's id, and are never merged by address", async t => {
  const f = await fixture(t);
  await f.accounts.tenantForGithub({ id: 903, login: "taken", createdAt: Date.now() - 400 * DAY }, { minAccountAgeMs: 0 });
  const root = await f.accounts.tenantForGoogle({ sub: "sub-root", email: "root@example.com" });
  assert.notEqual(root, "root");
  assert.match(root, /^root-[0-9a-f]{8}$/);
  const taken = await f.accounts.tenantForGoogle({ sub: "sub-taken", email: "Taken@example.com" });
  assert.match(taken, /^taken-[0-9a-f]{8}$/);
  // The same address on another Google account is another tenant; the same account keeps its tenant when its address changes.
  const twin = await f.accounts.tenantForGoogle({ sub: "sub-twin", email: "taken@example.com" });
  assert.notEqual(twin, taken);
  assert.equal(await f.accounts.tenantForGoogle({ sub: "sub-taken", email: "renamed@example.org" }), taken);
  assert.equal((await f.db.query("select google_email from tenants where id = $1", [taken])).rows[0].google_email, "renamed@example.org");
  assert.match(await f.accounts.tenantForGoogle({ sub: "sub-odd", email: "--@example.com" }), /^google-[0-9a-f]{8}$/);
  // Concurrent first sign-ins of one account make one tenant.
  const same = await Promise.all(Array.from({ length: 6 }, () => f.accounts.tenantForGoogle({ sub: "sub-once", email: "once@example.com" })));
  assert.deepEqual(new Set(same), new Set(["once"]));
  assert.equal(await count(f.db, "credit_ledger", "tenant <> 'taken'"), 0, "Google signups get no automatic grant");
  await assert.rejects(f.accounts.tenantForGoogle({ sub: "", email: "x@example.com" }), /valid account/);
});
