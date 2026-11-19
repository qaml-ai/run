import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { signWebhook, STRIPE_API_VERSION } from "../src/stripe.ts";
import { callbackRole } from "./billing-callback-role.ts";
import { testDatabase } from "./database.ts";
import { until } from "./runtime-server.ts";

test("the restricted callback listener settles purchases once, wakes invoices and disables disputed top-ups", async t => {
  const { db, url } = await testDatabase();
  const order = randomUUID();
  const signingSecret = "whsec_fixture_only";
  const topic = "arn:aws:sns:us-west-2:123456789012:fixture";
  await db.query(`insert into billing_checkouts (id,tenant,livemode,request_id,customer,amount,fee,currency,api_version,parameters,created_at)
    values ($1,'t',true,$2,'cus_fixture',10000000,550000,'usd',$3,'{}',$4)`, [order, randomUUID(), STRIPE_API_VERSION, Date.now()]);
  const due = Date.now() + 900_000;
  const attempt = randomUUID();
  await db.query("insert into billing_auto_settings (tenant,livemode,enabled) values ('t',true,true)");
  await db.query(`insert into billing_auto_attempts (id,tenant,livemode,settings_version,period,customer,amount,fee,monthly_limit,
    threshold,card,api_version,state,step,invoice,due,created_at)
    values ($1,'t',true,1,'2026-11','cus_fixture',10000000,550000,100000000,5000000,'{}',$2,'processing','prepare','in_fixture',$3,$4)`,
    [attempt, STRIPE_API_VERSION, due, Date.now()]);
  const restricted = await callbackRole(db, url);
  t.after(restricted.release);
  const event = { type: "checkout.session.completed", id: "evt_fixture", livemode: true, data: { object: {
    id: "cs_fixture", customer: "cus_fixture", livemode: true, currency: "usd", mode: "payment", payment_status: "paid", amount_total: 1055,
    payment_intent: "pi_fixture", invoice: "in_fixture", client_reference_id: order, metadata: { purpose: "agent-runtime-credit", order },
  } } };
  const payload = JSON.stringify(event, null, 2) + "\n";
  const env = {
    AGENT_DATABASE_URL: restricted.url, AGENT_V1_BILLING_CALLBACK_PORT: "0",
    AGENT_TENANTS_JSON: JSON.stringify({ tenants: { t: { tokenSha256: "ab".repeat(32), billing: "prepaid" } } }),
    AGENT_PUBLIC_URL: "https://run.example.test", AGENT_BILLING_EMAIL_FROM: "billing@example.test",
    AGENT_BILLING_EMAIL_SNS_TOPICS: topic, AGENT_BILLING_EMAIL_CONFIGURATION_SET: "fixture",
    STRIPE_SECRET_KEY: "sk_live_fixture_not_a_real_key", STRIPE_WEBHOOK_SECRET: signingSecret, AGENT_STRIPE_API_URL: "http://127.0.0.1:9",
    AGENT_JOURNEY_URL: "http://127.0.0.1:9", AGENT_JOURNEY_COLLECT_UNKNOWN: "true",
    AGENT_JOURNEY_SECRET: `whsec_${Buffer.alloc(24, 1).toString("base64")}`,
  };
  const worker = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/v1-billing-callbacks-server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const done = once(worker, "exit");
  let logs = "";
  worker.stdout.on("data", part => { logs += part; });
  worker.stderr.on("data", part => { logs += part; });
  try {
    const port = await until(() => {
      assert.equal(worker.exitCode, null, logs);
      return /"type":"v1_billing_callbacks_started","port":(\d+)/.exec(logs)?.[1];
    }, "the loopback callback listener");
    const origin = `http://127.0.0.1:${port}`;
    const stripeUrl = origin + "/v1/billing/stripe/webhook";
    const signature = signWebhook(signingSecret, payload);
    const post = (body: string, stripeSignature: string) => fetch(stripeUrl, { method: "POST", headers: { "Stripe-Signature": stripeSignature }, body });
    const invalid = await post(payload.trim(), signature);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, "Invalid Stripe signature");
    assert.equal((await post(payload, signWebhook(signingSecret, payload, Math.floor(Date.now()/1000)-600))).status, 400);
    assert.equal((await fetch(origin + "/v1/billing")).status, 404);
    assert.equal((await fetch(stripeUrl)).status, 404);
    assert.equal((await fetch(origin + "/v1/billing/email/feedback", { method: "POST", body: JSON.stringify({ TopicArn: topic }) })).status, 401);
    assert.equal((await db.query("select count(*)::int n from credit_ledger where kind='purchase'")).rows[0].n, 0);
    const responses = await Promise.all([post(payload, signature), post(payload, signature)]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { handled: "purchase" });
    }
    assert.deepEqual((await db.query("select amount from credit_ledger where kind='purchase'")).rows, [{ amount: 10_000_000 }]);
    assert.equal((await db.query("select payment_intent from billing_checkouts where id=$1", [order])).rows[0].payment_intent, "pi_fixture");
    assert.deepEqual((await db.query("select body->'properties'->>'transaction_ref' as payment from journey_outbox")).rows, [{ payment: "pi_fixture" }], logs);
    const send = (type: string, object: Record<string, unknown>) => {
      const body = JSON.stringify({ type, livemode: true, data: { object } });
      return post(body, signWebhook(signingSecret, body));
    };
    const invoice = await send("invoice.paid", {
      id: "in_fixture", status: "paid", livemode: true, customer: "cus_fixture", currency: "usd", total: 1055,
      hosted_invoice_url: "https://example.test/invoice",
    });
    assert.equal(invoice.status, 200, await invoice.text());
    assert.equal((await db.query("select invoice_url from billing_checkouts where id=$1", [order])).rows[0].invoice_url, "https://example.test/invoice");
    assert.ok((await db.query("select due from billing_auto_attempts where id=$1", [attempt])).rows[0].due < due);
    const dispute = await send("charge.dispute.created", { id: "dp_fixture", payment_intent: "pi_fixture", amount: 1055, status: "needs_response" });
    assert.equal(dispute.status, 200, await dispute.text());
    assert.deepEqual((await db.query("select enabled from billing_auto_settings where tenant='t'")).rows, [{ enabled: false }], logs);
    assert.deepEqual((await db.query("select state from billing_auto_attempts where id=$1", [attempt])).rows, [{ state: "cancelled" }]);
    assert.equal((await db.query("select balance from credit_accounts where tenant='t'")).rows[0].balance, 0);
    assert.ok(!logs.includes("billing_dispute_auto_topup"), logs);
  } finally {
    worker.kill("SIGTERM");
    assert.deepEqual(await done, [0, null], logs);
  }
});
