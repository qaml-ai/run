import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker, { type MailEnv } from "../infra/billing-email/worker.ts";
import { BillingMailer, billingMailConfig } from "../src/billing-mailer.ts";
import { BillingAlerts } from "../src/billing-alerts.ts";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";

const secret = "ab".repeat(32);
const from = "billing@mail.camelai.com";
const config = { AGENT_BILLING_EMAIL_FROM: from, AGENT_BILLING_EMAIL_PROVIDER: "cloudflare",
  AGENT_BILLING_EMAIL_URL: "https://mail.example.test/send", AGENT_PUBLIC_URL: "https://example.test" };
const env: MailEnv = { MAIL_SECRET: secret, FROM: from, FEEDBACK_URL: "https://example.test/v1/billing/email/feedback",
  EMAIL: { send: async () => ({ messageId: "cf-1" }) } };
const mail = { from, to: "notify@example.test", displayName: "camelRun Billing", subject: "Your balance is low", text: "Balance: $1", html: "<p>Balance: $1</p>",
  headers: [{ Name: "List-Unsubscribe", Value: "<https://example.test/unsubscribe>" }, { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" }] };
const request = (body: unknown, token = secret) => new Request(config.AGENT_BILLING_EMAIL_URL, { method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("Cloudflare configuration requires a private secret and HTTPS URL without credentials", () => {
  assert.throws(() => billingMailConfig(config));
  assert.throws(() => billingMailConfig({ ...config, AGENT_BILLING_EMAIL_URL: "http://mail.example.test" }, secret));
  assert.throws(() => billingMailConfig({ ...config, AGENT_BILLING_EMAIL_URL: "https://secret@mail.example.test" }, secret));
  assert.equal(billingMailConfig(config, secret)?.cloudflare?.url, config.AGENT_BILLING_EMAIL_URL);
});

test("Worker authenticates, bounds input, fixes the sender and preserves unsubscribe headers", async () => {
  let sent: unknown;
  const e = { ...env, EMAIL: { send: async (value: unknown) => { sent = value; return { messageId: "cf-sent" }; } } };
  assert.equal((await worker.fetch(request(mail, "wrong"), e)).status, 401);
  assert.equal(sent, undefined);
  for (const invalid of [{ ...mail, from: "other@example.test" }, { ...mail, to: [mail.to] }, { ...mail, subject: "bad\r\nBcc: other" },
    { ...mail, headers: [{ Name: "Bcc", Value: "other@example.test" }] }, { ...mail, html: "x".repeat(128_000) }]) {
    assert.equal((await worker.fetch(request(invalid), e)).status, 400);
  }
  const response = await worker.fetch(request(mail), e);
  assert.deepEqual(await response.json(), { messageId: "cf-sent" });
  assert.deepEqual(sent, { from: { email: from, name: "camelRun Billing" }, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html,
    headers: { "List-Unsubscribe": mail.headers[0].Value, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
});

test("Worker reports suppression without retrying mail and sanitizes provider failures", async () => {
  const suppressed = { ...env, EMAIL: { send: async () => { throw Object.assign(new Error("private recipient"), { code: "E_RECIPIENT_SUPPRESSED" }); } } };
  assert.deepEqual(await (await worker.fetch(request(mail), suppressed)).json(), { suppressed: true });
  const failed = { ...env, EMAIL: { send: async () => { throw new Error("private provider body"); } } };
  const response = await worker.fetch(request(mail), failed);
  assert.equal(response.status, 502);
  assert.equal(await response.text(), "");
});

test("Cloudflare mail, recorded provider IDs, authenticated feedback and suppression work together", async () => {
  const { db } = await testDatabase();
  const accounts = new Accounts({ db, secretsKey: secret, tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {
    alice: { tokenSha256: createHash("sha256").update("operator").digest("hex"), billing: "prepaid", apiKeys: {} },
  } }) }) });
  const alerts = new BillingAlerts(db, accounts);
  await alerts.add("alice", mail.to);
  const mailer = new BillingMailer({ db, alerts, ...billingMailConfig(config, secret)!, fetch: (async (url, options) => worker.fetch(new Request(url, options), env)) as typeof fetch });
  await mailer.pump();
  const row = (await db.query("select * from billing_email_outbox")).rows[0];
  assert.equal(row.state, "sent"); assert.equal(row.provider_message_id, "cf-1"); assert.equal(row.secret, null);
  const feedback = mailer.feedback();
  const post = (body: unknown, token = secret) => feedback.request("/v1/billing/email/feedback", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const event = { sender: from, recipient: mail.to, messageId: "cf-1", kind: "bounce" };
  assert.equal((await post(event, "wrong")).status, 401);
  assert.equal((await post({ ...event, sender: "different@example.test" })).status, 400);
  assert.equal((await post({ ...event, messageId: "not-recorded-yet" })).status, 503);
  assert.equal((await post(event)).status, 204);
  assert.equal((await post(event)).status, 204, "feedback repeats are harmless");
  assert.equal((await db.query("select status from billing_recipients")).rows[0].status, "bounced");
  await mailer.stop();
});

test("Cloudflare feedback queue ignores other senders and temporary bounces, retries failed delivery", async t => {
  const calls: Array<{ body: unknown; auth: string | null }> = [];
  let fail = true;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    assert.equal(url, env.FEEDBACK_URL);
    calls.push({ body: JSON.parse(options.body as string), auth: new Headers(options.headers).get("authorization") });
    return new Response(null, { status: fail ? 503 : 204 });
  });
  const event = (sender: string, type = "hard") => ({ source: { type: "email.sending" }, type: "cf.email.sending.message.bounced",
    payload: { sender, recipient: mail.to, messageId: "cf-1", bounce: { type } } });
  let acked = 0, retried = 0;
  const message = (body: unknown) => ({ body, ack: () => { acked++; }, retry: (o: { delaySeconds: number }) => { assert.equal(o.delaySeconds, 300); retried++; } });
  await worker.queue({ messages: [message(event("no-reply@mail.camelai.com")), message(event(from, "soft")), message(event(from))] }, env);
  assert.equal(acked, 2); assert.equal(retried, 1);
  assert.deepEqual(calls[0], { auth: `Bearer ${secret}`, body: { sender: from, recipient: mail.to, messageId: "cf-1", kind: "bounce" } });
  fail = false;
  await worker.queue({ messages: [message(event(from))] }, env);
  assert.equal(acked, 3);
});
