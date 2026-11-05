import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { BillingAlerts } from "../src/billing-alerts.ts";
import { postLedger } from "../src/billing.ts";
import { pumpBillingMail } from "../src/billing-mail.ts";
import { createStripe } from "../src/billing-routes.ts";
import { testDatabase } from "./billing-database.ts";

test("native mail adapter sends the unchanged billing template and acknowledges its fenced outbox", async () => {
  const { db } = await testDatabase();
  const accounts = new Accounts({ db, tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), secretsKey: "ab".repeat(32) });
  const alerts = new BillingAlerts(db, accounts);
  const recipient = await alerts.add("billing-mail-test", "billing@example.test");
  const row = (await db.query("select * from billing_email_outbox where recipient=$1", [recipient.id])).rows[0];
  const token = accounts.unseal(`billing-confirmation:${row.id}`, row.secret);
  const sent: any[] = [];
  const env = { PUBLIC_URL: "https://workers.example.test", EMAIL_FROM: "noreply@example.test", EMAIL: { send: async (value: unknown) => { sent.push(value); return { messageId: "fake-native-message" }; } } as unknown as SendEmail };
  assert.equal(await pumpBillingMail(env, alerts), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subject, "Confirm your email for camelRun billing alerts");
  assert.match(sent[0].text, /https:\/\/workers\.example\.test\/console\/billing\/confirm#/);
  const delivered = (await db.query("select state,secret,provider_message_id from billing_email_outbox where id=$1", [row.id])).rows[0];
  assert.deepEqual(delivered, { state: "sent", secret: null, provider_message_id: "fake-native-message" });
  assert.equal(await alerts.confirm(token), true);
  await postLedger(db, [{ tenant: "billing-mail-test", kind: "purchase", amount: 5_000_000, key: "fake-funding" }]);
  await postLedger(db, [{ tenant: "billing-mail-test", kind: "adjustment", amount: -4_000_000, key: "fake-spend" }]);
  assert.equal(await pumpBillingMail(env, alerts), 1);
  assert.equal(sent.length, 2);
  assert.match(sent[1].subject, /balance is low/);
  assert.equal(sent[1].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.equal(await pumpBillingMail(env, alerts), 0);
});

test("deployed Stripe factory refuses live credentials and nonlocal fake endpoints", () => {
  const base = { HYPERDRIVE: { connectionString: "unused" }, STRIPE_WEBHOOK_SECRET: "whsec_not_a_live_secret" };
  assert.throws(() => createStripe({ ...base, STRIPE_SECRET_KEY: "sk_live_not_a_key" }), /only accepts Stripe test keys/);
  assert.throws(() => createStripe({ ...base, STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_API_URL: "https://external.example", TEST_MODE: "1" }), /local fake/);
  assert.equal(createStripe(base), undefined);
});
