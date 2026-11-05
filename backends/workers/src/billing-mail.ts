import { billingEmail, type BillingEmailInput } from "../../../src/billing-emails.ts";
import { BillingAlerts } from "./billing-alerts.ts";
import { sendEmail, type MailEnv } from "./account-mail.ts";

/** One bounded pass from Cron or a Queue consumer; no process-local poller. */
export async function pumpBillingMail(env: MailEnv & { PUBLIC_URL?: string; AGENT_PUBLIC_URL?: string }, alerts: BillingAlerts) {
  const origin = env.PUBLIC_URL ?? env.AGENT_PUBLIC_URL;
  if (!origin || !(env.EMAIL || env.MAIL_TEST_URL)) return 0;
  const rows = await alerts.claim(Date.now(), 5);
  await Promise.all(rows.map(async row => {
    try {
      if (!["confirmation", "low", "depleted", "problems", "receipts"].includes(row.kind)) throw new Error("Unsupported billing email type");
      const mail = billingEmail({ kind: row.kind as BillingEmailInput["kind"], tenant: row.tenant, email: row.email,
        origin, token: row.token, unsubscribeToken: await alerts.unsubscribeToken(row.tenant, row.recipient),
        payment: row.payload.data, balance: row.payload.data?.balance, threshold: row.payload.data?.threshold });
      if (!await alerts.deliverable(row.id, row.lease)) { await alerts.retry(row.id, row.lease); return; }
      const sent = await sendEmail(env, { ...mail, to: row.email, delivery: row.id, kind: "billing", tags: [{ Name: "product", Value: "camelrun-billing" }, { Name: "kind", Value: row.kind }] }, AbortSignal.timeout(15_000));
      await alerts.sent(row.id, row.lease, sent.messageId);
    } catch {
      console.error(JSON.stringify({ type: "billing_mail_send_failed", delivery: row.id, attempt: row.attempts }));
      await alerts.retry(row.id, row.lease);
    }
  }));
  return rows.length;
}

/** Balance crossings enqueue mail in migration 032's credit_accounts trigger. */
export async function maintainBilling(
  env: MailEnv & { PUBLIC_URL?: string; AGENT_PUBLIC_URL?: string },
  billing: import("./billing.ts").Billing,
  alerts: BillingAlerts,
) {
  await billing.autoTopup?.pump();
  await billing.payments?.refreshInvoices();
  return pumpBillingMail(env, alerts);
}
