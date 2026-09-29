import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { BillingAlerts, type AlertChoices } from "../src/billing-alerts.ts";
import { accrueUsage, postLedger } from "../src/billing.ts";
import { transaction, type Db } from "../src/db.ts";
import { micros } from "../src/pricing.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";
import { listen, runtime, until } from "./runtime-server.ts";
import { signedHeaders } from "../src/webhooks.ts";

const ALL: AlertChoices = { low: true, depleted: true, problems: true, receipts: true };
const NONE: AlertChoices = { low: false, depleted: false, problems: false, receipts: false };
const NOW = Date.now();
async function fixture() {
  const { db } = await testDatabase();
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: {} }) });
  const accounts = new Accounts({ db, tenants, secretsKey: "ab".repeat(32) });
  const alerts = new BillingAlerts(db, accounts);
  const confirm = async (tenant = "a", email = `${randomUUID()}@example.test`, choices = ALL) => {
    const recipient = await alerts.add(tenant, email, choices);
    const row = (await db.query("select * from billing_email_outbox where recipient=$1 and kind='confirmation' order by created_at desc limit 1", [recipient.id])).rows[0];
    const token = accounts.unseal(`billing-confirmation:${row.id}`, row.secret);
    assert.equal(await alerts.confirm(token), true);
    return { recipient, token };
  };
  return { db, accounts, alerts, confirm };
}
const move = (db: Db, amount: number, tenant = "a", key: string = randomUUID(), kind: "grant" | "purchase" | "storage" | "refund" | "adjustment" = "adjustment") =>
  postLedger(db, [{ tenant, kind, amount: micros(amount), key }]);
const events = async (db: Db) => (await db.query("select type, data from billing_events order by created_at, type")).rows;
const mail = async (db: Db) => (await db.query("select * from billing_email_outbox where state='pending' and kind <> 'confirmation' order by created_at, id")).rows;
async function endpoint(db: Db, tenant = "a") {
  await db.query(`insert into webhook_endpoints (id, tenant, url, events, secret, created_at)
    values ($1,$2,'https://example.test/hook',ARRAY['billing.balance.low','billing.balance.depleted'],'{}',0)`, [randomUUID(), tenant]);
}

test("balance crossings fan out atomically, dedupe retries and re-arm only after recovery", async () => {
  const { db, confirm } = await fixture();
  await confirm();
  await endpoint(db);
  await endpoint(db, "other");
  await move(db, 5, "a", "funded", "grant");
  assert.equal((await events(db)).length, 0);
  await move(db, -3); // Equal to the threshold is not below it.
  assert.equal((await events(db)).length, 0);
  await move(db, -0.5, "a", "first-low", "storage");
  await move(db, -0.5, "a", "first-low", "storage");
  await move(db, -0.5, "a", "still-low", "refund");
  assert.deepEqual((await events(db)).map(r => r.type), ["billing.balance.low"]);
  assert.deepEqual((await mail(db)).map(r => r.kind), ["low"]);
  await move(db, -1);
  await move(db, -1);
  assert.equal((await events(db)).length, 2);
  assert.equal((await mail(db)).length, 2);
  await move(db, 6, "a", "refill", "purchase");
  await move(db, -5);
  assert.equal((await events(db)).length, 4, "one debit crosses low and depleted after recovering");
  assert.deepEqual((await mail(db)).map(r => r.kind).sort(), ["depleted", "depleted", "low"]);
  const deliveries = (await db.query("select * from webhook_deliveries")).rows;
  assert.equal(deliveries.length, 4);
  assert.ok(deliveries.every(r => r.tenant === "a" && r.body.id.startsWith("evt_")));
  assert.ok(deliveries.every(r => typeof r.body.created === "number" && typeof r.body.data.balance === "number"));
});

test("an unfunded signup stays quiet, including its confirmation; an opted-in funded empty account gets one notice", async () => {
  const { db, alerts, confirm } = await fixture();
  const { token } = await confirm();
  await alerts.confirm(token);
  await move(db, -1, "other"); // No funded positive balance to cross.
  assert.deepEqual(await events(db), []);
  assert.deepEqual(await mail(db), []);
  await move(db, 5);
  await move(db, -5);
  const prior = (await mail(db)).length;
  const next = await confirm();
  await alerts.confirm(next.token);
  assert.equal((await mail(db)).length, prior + 1);
  assert.equal((await events(db)).length, 2, "recipient opt-in does not replay webhooks");
});

test("concurrent usage flushes emit each crossing once and rollback includes all outboxes", async () => {
  const { db, confirm } = await fixture();
  await confirm();
  await endpoint(db);
  await move(db, 5);
  await assert.rejects(transaction(db, async sql => {
    await accrueUsage(sql, [{ tenant: "a", amount: micros(6), metadata: { tokens: micros(6) } }]);
    throw new Error("rollback");
  }), /rollback/);
  assert.equal((await events(db)).length, 0);
  assert.equal((await mail(db)).length, 0);
  assert.equal((await db.query("select count(*) from webhook_deliveries")).rows[0].count, 0);
  await Promise.all(Array.from({ length: 12 }, () => transaction(db, sql =>
    accrueUsage(sql, [{ tenant: "a", amount: micros(0.5), metadata: { tokens: micros(0.5) } }]))));
  assert.equal((await db.query("select balance from credit_accounts where tenant='a'")).rows[0].balance, micros(-1));
  assert.equal((await events(db)).length, 2);
  assert.equal((await mail(db)).length, 2);
});

test("an outbox write failure rolls the balance and ledger back", async () => {
  const { db, confirm } = await fixture();
  await confirm();
  await move(db, 5);
  await db.query("alter table billing_email_outbox add constraint reject_balance_mail check (kind = 'confirmation')");
  await assert.rejects(move(db, -6, "a", "must-rollback"), /reject_balance_mail/);
  assert.equal((await db.query("select balance from credit_accounts where tenant='a'")).rows[0].balance, micros(5));
  assert.equal((await db.query("select count(*) from credit_ledger where idempotency_key='must-rollback'")).rows[0].count, 0);
  assert.deepEqual(await events(db), []);
});

test("raising the threshold issues one current notice; setting it again and lowering it stay quiet", async () => {
  const { db, alerts, confirm } = await fixture();
  await confirm();
  await move(db, 4);
  await alerts.setThreshold("a", micros(5));
  await Promise.all(Array.from({ length: 5 }, () => alerts.setThreshold("a", micros(5))));
  await alerts.setThreshold("a", micros(1));
  assert.equal((await events(db)).length, 1);
  assert.equal((await mail(db)).length, 1);
  assert.equal((await alerts.get("a")).threshold, micros(1));
  for (const amount of [0, 1, micros(500.01), NaN]) await assert.rejects(alerts.setThreshold("a", amount), /threshold/);
});

test("recipients are normalized, capped across concurrent adds, isolated by tenant and secrets stay private", async () => {
  const { db, alerts } = await fixture();
  const recipient = await alerts.add("a", " Billing@Example.test ");
  assert.equal(recipient.email, "billing@example.test");
  assert.deepEqual(recipient.events, { ...ALL, receipts: false });
  assert.deepEqual(await alerts.add("a", "billing@example.test", NONE), recipient, "retry does not replace preferences or resend");
  assert.equal((await db.query("select count(*) from billing_email_outbox")).rows[0].count, 1);
  const adds = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => alerts.add("a", `person${i}@example.test`)));
  assert.equal(adds.filter(r => r.status === "fulfilled").length, 4);
  assert.equal((await alerts.get("a")).recipients.length, 5);
  assert.equal(JSON.stringify(await alerts.get("a")).includes("confirmation"), false);
  await assert.rejects(alerts.update("other", recipient.id, ALL), /Unknown/);
  await assert.rejects(alerts.resend("other", recipient.id), /Unknown/);
  assert.equal(await alerts.remove("other", recipient.id), false);
  assert.equal(await alerts.remove("a", recipient.id), true);
  assert.equal((await db.query("select count(*) from billing_email_outbox where recipient=$1", [recipient.id])).rows[0].count, 0);
});

test("confirmation requires the live unexpired token, and resend invalidates the previous one", async () => {
  const { db, accounts, alerts } = await fixture();
  const recipient = await alerts.add("a", "billing@example.test", ALL, NOW);
  const tokenFor = async () => {
    const row = (await db.query("select * from billing_email_outbox where state='pending' order by created_at desc limit 1")).rows[0];
    return accounts.unseal(`billing-confirmation:${row.id}`, row.secret);
  };
  const original = await tokenFor();
  assert.equal(await alerts.confirm("invalid", NOW), false);
  await assert.rejects(alerts.resend("a", recipient.id, NOW + 1), /wait/);
  await alerts.resend("a", recipient.id, NOW + 61_000);
  const replacement = await tokenFor();
  assert.equal(await alerts.confirm(original, NOW + 62_000), false);
  assert.equal(await alerts.confirm(replacement, NOW + 2 * 86_400_000), false);
  assert.equal(await alerts.confirm(replacement, NOW + 62_000), true);
  assert.equal(await alerts.confirm(replacement, NOW + 62_000), true);
  assert.equal((await alerts.get("a")).recipients[0].status, "verified");
});

test("confirmation limits survive remove/re-add and apply across tenants", async () => {
  const { alerts } = await fixture();
  const r = await alerts.add("a", "billing@example.test", ALL, NOW);
  await alerts.remove("a", r.id);
  await assert.rejects(alerts.add("a", r.email, ALL, NOW + 1), /wait/);
  await assert.rejects(alerts.add("b", r.email, ALL, NOW + 1), /wait/);
  await alerts.add("b", r.email, ALL, NOW + 61_000);
  await alerts.add("c", r.email, ALL, NOW + 122_000);
  await assert.rejects(alerts.add("d", r.email, ALL, NOW + 183_000), /wait/);
});

test("per-recipient choices select notices and opting back in below threshold does not notify others", async () => {
  const { db, alerts, confirm } = await fixture();
  const first = await confirm("a", "first@example.test", { ...NONE, low: true });
  const second = await confirm("a", "second@example.test", { ...NONE, depleted: true });
  await move(db, 5);
  await move(db, -4);
  assert.deepEqual((await mail(db)).map(r => r.recipient), [first.recipient.id]);
  await alerts.update("a", second.recipient.id, ALL);
  await alerts.update("a", second.recipient.id, ALL);
  assert.equal((await mail(db)).length, 2);
  await alerts.update("a", first.recipient.id, NONE);
  await alerts.update("a", first.recipient.id, { ...NONE, low: true });
  assert.equal((await mail(db)).filter(r => r.recipient === first.recipient.id).length, 1, "opting back in does not resurrect old deliveries");
  await move(db, -1);
  assert.equal((await mail(db)).filter(r => r.kind === "depleted").length, 1);
});

test("delivery leases fence stale acknowledgements, retry, and re-check preferences before sending", async () => {
  const { db, alerts, confirm } = await fixture();
  const { recipient } = await confirm();
  await move(db, 5);
  await move(db, -4);
  const now = Date.now();
  const [one, two] = await Promise.all([alerts.claim(now), alerts.claim(now)]);
  assert.equal(one.length + two.length, 1);
  const first = [...one, ...two][0];
  const [reclaimed] = await alerts.claim(now + 61_000);
  assert.ok(reclaimed);
  assert.notEqual(reclaimed.lease, first.lease);
  assert.equal(await alerts.sent(first.id, first.lease), false);
  assert.equal(await alerts.retry(reclaimed.id, reclaimed.lease, now + 61_000), true);
  assert.equal((await alerts.claim(now + 61_001)).length, 0);
  await alerts.update("a", recipient.id, NONE);
  assert.equal((await alerts.claim(now + 3_600_000)).length, 0, "queued email respects an opt-out");
  assert.equal((await mail(db)).length, 0);
});

test("confirmed bounces suppress queued mail and future re-adds", async () => {
  const { db, alerts, confirm } = await fixture();
  const { recipient, token } = await confirm("a", "bounce@example.test");
  await move(db, 5);
  await move(db, -5);
  await alerts.suppress(recipient.email);
  assert.equal((await alerts.get("a")).recipients[0].status, "bounced");
  assert.equal(await alerts.confirm(token), false);
  assert.equal((await alerts.claim()).length, 0);
  await alerts.remove("a", recipient.id);
  await assert.rejects(alerts.add("a", recipient.email), /cannot receive/);
});

test("a confirmation delivery decrypts only while claimed and removes its secret after acknowledgement", async () => {
  const { db, alerts } = await fixture();
  await alerts.add("a", "billing@example.test");
  const [delivery] = await alerts.claim();
  assert.equal(delivery.kind, "confirmation");
  assert.match(delivery.token!, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(delivery.payload, {});
  assert.equal(await alerts.sent(delivery.id, delivery.lease), true);
  assert.equal((await db.query("select secret from billing_email_outbox where id=$1", [delivery.id])).rows[0].secret, null);
  assert.equal(await alerts.confirm(delivery.token!), true, "mailbox proof still works after sending");
});


test("registered billing webhooks are delivered by the existing worker with valid signatures", async t => {
  const received: { body: string; headers: any }[] = [];
  const target = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ body, headers: req.headers });
    res.writeHead(204).end();
  });
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), {
    AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32",
    AGENT_SCHEDULER_INTERVAL_MS: "100",
  });
  const endpoint = await r.call("/v1/webhooks", { body: { url: target, events: ["billing.balance.low", "billing.balance.depleted"] } });
  assert.equal(endpoint.status, 201, endpoint.text);
  await move(r.db, 5, "alice");
  await move(r.db, -6, "alice");
  await until(() => received.length === 2, "billing events delivered");
  assert.deepEqual(received.map(r => JSON.parse(r.body).type).sort(), ["billing.balance.depleted", "billing.balance.low"]);
  for (const entry of received) {
    const body = JSON.parse(entry.body);
    assert.equal(body.id, entry.headers["webhook-id"]);
    const headers = signedHeaders(body.id, entry.body, [endpoint.json.secret], Number(entry.headers["webhook-timestamp"]) * 1000);
    assert.equal(entry.headers["webhook-signature"], headers["webhook-signature"]);
    assert.equal(body.data.balance, micros(-1));
  }
});
