import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "./db.ts";
import type { BillingAlerts } from "./billing-alerts.ts";
import { billingEmail, type BillingEmail, type BillingEmailInput } from "./billing-emails.ts";
import { verifySns } from "./channels-email.ts";
import { readText } from "./http.ts";
import { MailTransport } from "./mail-transport.ts";
import { createHash, timingSafeEqual } from "node:crypto";

export interface BillingMailOptions {
  db: Db; alerts: BillingAlerts; origin: string; from: string; displayName?: string; configurationSet?: string; topics?: string[]; region?: string;
  cloudflare?: { url: string; secret: string };
  /** Test transport; production uses the configured provider. Must honor the abort signal. */
  send?: (mail: BillingEmail & { to: string; delivery: string }, signal: AbortSignal) => Promise<string | undefined>;
  fetch?: typeof fetch;
}
export function billingMailConfig(env = process.env, cloudflareSecret?: string) {
  if (!env.AGENT_BILLING_EMAIL_FROM) return undefined;
  if (!z.email().safeParse(env.AGENT_BILLING_EMAIL_FROM).success) throw new Error("AGENT_BILLING_EMAIL_FROM must be an email address");
  const displayName = env.AGENT_BILLING_EMAIL_NAME ?? "camelRun Billing";
  if (!displayName.trim() || displayName.length > 80 || /[\r\n]/.test(displayName)) throw new Error("AGENT_BILLING_EMAIL_NAME must be a single display name, at most 80 characters");
  const configurationSet = env.AGENT_BILLING_EMAIL_CONFIGURATION_SET;
  const topics = (env.AGENT_BILLING_EMAIL_SNS_TOPICS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  const provider = env.AGENT_BILLING_EMAIL_PROVIDER ?? "ses";
  if (!["ses", "cloudflare"].includes(provider)) throw new Error("Unknown AGENT_BILLING_EMAIL_PROVIDER");
  let cloudflare: BillingMailOptions["cloudflare"];
  if (provider === "cloudflare") {
    const url = new URL(env.AGENT_BILLING_EMAIL_URL ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !cloudflareSecret || !/^[a-f0-9]{64}$/.test(cloudflareSecret)) {
      throw new Error("Cloudflare billing email requires an HTTPS Worker URL and a 32-byte billing-email secret");
    }
    cloudflare = { url: url.href, secret: cloudflareSecret };
  } else if (!configurationSet || !topics.length || topics.some(t => !/^arn:aws(?:-cn|-us-gov)?:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]+$/.test(t))) {
    throw new Error("Billing email requires AGENT_BILLING_EMAIL_CONFIGURATION_SET and AGENT_BILLING_EMAIL_SNS_TOPICS for bounce/complaint feedback");
  }
  const origin = new URL(env.AGENT_PUBLIC_URL ?? "");
  if (origin.username || origin.password || origin.search || origin.hash || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
    throw new Error("Billing email requires a public HTTPS origin (HTTP is allowed for loopback development)");
  }
  return { origin: origin.origin, from: env.AGENT_BILLING_EMAIL_FROM, displayName, configurationSet, topics, region: env.AWS_REGION, cloudflare };
}

/** Five concurrent sends per node, each bounded to 15s, comfortably inside the 60s outbox lease. */
export class BillingMailer {
  private readonly options: BillingMailOptions;
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private transport?: MailTransport;
  constructor(options: BillingMailOptions) { this.options = options; }
  start() { if (!this.timer) { this.timer = setInterval(() => void this.pump().catch(() => console.error(JSON.stringify({ type: "billing_mail_poll_failed" }))), 5_000); this.timer.unref(); } }
  async stop() { clearInterval(this.timer); this.timer = undefined; await this.active; this.transport?.destroy(); }
  pump(): Promise<void> { return this.active ??= this.deliver().finally(() => { this.active = undefined; }); }
  private async deliver() {
    const { alerts } = this.options;
    const rows = await alerts.claim(Date.now(), 5);
    await Promise.all(rows.map(async row => {
      try {
        if (!["confirmation", "low", "depleted", "problems", "receipts"].includes(row.kind)) throw new Error("Unsupported billing email type");
        const mail = billingEmail({ kind: row.kind as BillingEmailInput["kind"], tenant: row.tenant, email: row.email,
          origin: this.options.origin, token: row.token, unsubscribeToken: await alerts.unsubscribeToken(row.tenant, row.recipient),
          payment: row.payload.data, balance: row.payload.data?.balance, threshold: row.payload.data?.threshold });
        if (!await alerts.deliverable(row.id, row.lease)) { await alerts.retry(row.id, row.lease); return; }
        const signal = AbortSignal.timeout(15_000);
        const message = { ...mail, to: row.email, delivery: row.id };
        const id = this.options.send ? await this.options.send(message, signal) : await this.send(message, signal);
        await alerts.sent(row.id, row.lease, id);
      } catch {
        // No addresses, tokens, provider request payloads or secret-bearing URLs in logs.
        console.error(JSON.stringify({ type: "billing_mail_send_failed", delivery: row.id, attempt: row.attempts }));
        await alerts.retry(row.id, row.lease);
      }
    }));
  }
  private async send(mail: BillingEmail & { to: string; delivery: string }, signal: AbortSignal) {
    const { from, displayName = "camelRun Billing", region, configurationSet, cloudflare } = this.options;
    this.transport ??= new MailTransport({ from, displayName, region, configurationSet, cloudflare, fetch: this.options.fetch });
    const result = await this.transport.send({ to: mail.to, subject: mail.subject, html: mail.html, text: mail.text, headers: mail.headers,
      tags: [{ Name: "product", Value: "camelrun-billing" }, { Name: "billing_delivery", Value: mail.delivery }] }, signal);
    if ("suppressed" in result) { await this.options.alerts.suppress(mail.to); return undefined; }
    return result.messageId;
  }

  /** Accept authenticated provider feedback tied to one of our recorded deliveries. */
  feedback() {
    if (this.options.cloudflare) return this.cloudflareFeedback();
    const { db, alerts, topics = [], from } = this.options;
    const fetcher = this.options.fetch ?? fetch;
    return new Hono().post("/v1/billing/email/feedback", async c => {
      let message: Record<string, string>;
      try { message = JSON.parse(await readText(c.req.raw.body, 512_000)); } catch { return c.body(null, 400); }
      if (!message || !topics.includes(message.TopicArn)) return c.body(null, 403);
      if (!await verifySns(message, fetcher)) return c.body(null, 401);
      const age = Date.now() - Date.parse(message.Timestamp);
      if (!Number.isFinite(age) || age < -300_000 || age > 3 * 86_400_000) return c.body(null, 400);
      if (message.Type === "SubscriptionConfirmation") {
        const region = message.TopicArn.split(":")[3];
        let url: URL;
        try { url = new URL(message.SubscribeURL); } catch { return c.body(null, 400); }
        if (url.protocol !== "https:" || ![`sns.${region}.amazonaws.com`, `sns.${region}.amazonaws.com.cn`].includes(url.hostname) || url.port || url.username || url.password || url.searchParams.get("Action") !== "ConfirmSubscription" || url.searchParams.get("TopicArn") !== message.TopicArn) return c.body(null, 400);
        const result = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
        return c.body(null, result?.ok ? 200 : 502);
      }
      if (message.Type !== "Notification") return c.body(null, 200);
      let event: any;
      try { event = JSON.parse(message.Message); } catch { return c.body(null, 400); }
      const source = typeof event?.mail?.source === "string" ? (/<([^<>]+)>$/.exec(event.mail.source)?.[1] ?? event.mail.source).trim().toLowerCase() : "";
      if (source !== from.toLowerCase() || !event.mail.tags?.product?.includes("camelrun-billing")) return c.body(null, 200);
      const id = event.mail.tags.billing_delivery?.[0];
      if (typeof id !== "string" || !z.uuid().safeParse(id).success) return c.body(null, 200);
      const row = (await db.query(`select r.email from billing_email_outbox o join billing_recipients r on r.id=o.recipient where o.id=$1`, [id])).rows[0];
      if (!row || !event.mail.destination?.includes(row.email)) return c.body(null, 200);
      const kind = event.eventType;
      const rejected = kind === "Complaint" ? event.complaint?.complainedRecipients
        : kind === "Bounce" && event.bounce?.bounceType === "Permanent" ? event.bounce?.bouncedRecipients : [];
      if (Array.isArray(rejected) && rejected.some(r => typeof r.emailAddress === "string" && r.emailAddress.toLowerCase() === row.email)) await alerts.suppress(row.email);
      return c.body(null, 200);
    });
  }

  /** Private Worker callbacks; authenticate before reading a body, and match a recorded delivery. */
  private cloudflareFeedback() {
    const { db, alerts, from, cloudflare } = this.options;
    const expected = createHash("sha256").update(`Bearer ${cloudflare!.secret}`).digest();
    return new Hono().post("/v1/billing/email/feedback", async c => {
      const actual = createHash("sha256").update(c.req.header("authorization") ?? "").digest();
      if (!timingSafeEqual(expected, actual)) return c.body(null, 401);
      let event: { sender?: string; recipient?: string; messageId?: string; kind?: string };
      try { event = JSON.parse(await readText(c.req.raw.body, 4096)); } catch { return c.body(null, 400); }
      if (!event || event.sender !== from || typeof event.messageId !== "string" || event.messageId.length > 512 ||
        !z.email().safeParse(event.recipient).success || !["bounce", "complaint", "suppressed"].includes(event.kind ?? "")) return c.body(null, 400);
      const row = (await db.query(`select r.email from billing_email_outbox o join billing_recipients r on r.id=o.recipient
        where o.provider_message_id=$1 and r.email=$2 limit 1`, [event.messageId, event.recipient])).rows[0];
      // Delivery feedback can race the transaction recording the provider ID. Let the queue retry.
      if (!row) return c.body(null, 503);
      await alerts.suppress(row.email);
      return c.body(null, 204);
    });
  }
}
