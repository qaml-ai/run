import { Hono } from "hono";
import { z } from "zod";
import type { Db } from "./db.ts";
import type { BillingAlerts } from "./billing-alerts.ts";
import { billingEmail, type BillingEmail, type BillingEmailInput } from "./billing-emails.ts";
import { verifySns } from "./channels-email.ts";
import { readText } from "./http.ts";

export interface BillingMailOptions {
  db: Db; alerts: BillingAlerts; origin: string; from: string; displayName?: string; configurationSet: string; topics: string[]; region?: string;
  /** Test transport; production uses SES v2, one recipient per call. Must honor the abort signal. */
  send?: (mail: BillingEmail & { to: string; delivery: string }, signal: AbortSignal) => Promise<string | undefined>;
  fetch?: typeof fetch;
}
export function billingMailConfig(env = process.env) {
  if (!env.AGENT_BILLING_EMAIL_FROM) return undefined;
  if (!z.email().safeParse(env.AGENT_BILLING_EMAIL_FROM).success) throw new Error("AGENT_BILLING_EMAIL_FROM must be an email address");
  const displayName = env.AGENT_BILLING_EMAIL_NAME ?? "camelRun Billing";
  if (!displayName.trim() || displayName.length > 80 || /[\r\n]/.test(displayName)) throw new Error("AGENT_BILLING_EMAIL_NAME must be a single display name, at most 80 characters");
  const configurationSet = env.AGENT_BILLING_EMAIL_CONFIGURATION_SET;
  const topics = (env.AGENT_BILLING_EMAIL_SNS_TOPICS ?? "").split(",").map(s => s.trim()).filter(Boolean);
  if (!configurationSet || !topics.length || topics.some(t => !/^arn:aws(?:-cn|-us-gov)?:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]+$/.test(t))) {
    throw new Error("Billing email requires AGENT_BILLING_EMAIL_CONFIGURATION_SET and AGENT_BILLING_EMAIL_SNS_TOPICS for bounce/complaint feedback");
  }
  const origin = new URL(env.AGENT_PUBLIC_URL ?? "");
  if (origin.username || origin.password || origin.search || origin.hash || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) {
    throw new Error("Billing email requires a public HTTPS origin (HTTP is allowed for loopback development)");
  }
  return { origin: origin.origin, from: env.AGENT_BILLING_EMAIL_FROM, displayName, configurationSet, topics, region: env.AWS_REGION };
}

/** Five concurrent sends per node, each bounded to 15s, comfortably inside the 60s outbox lease. */
export class BillingMailer {
  private readonly options: BillingMailOptions;
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private client?: import("@aws-sdk/client-sesv2").SESv2Client;
  constructor(options: BillingMailOptions) { this.options = options; }
  start() { if (!this.timer) { this.timer = setInterval(() => void this.pump().catch(() => console.error(JSON.stringify({ type: "billing_mail_poll_failed" }))), 5_000); this.timer.unref(); } }
  async stop() { clearInterval(this.timer); this.timer = undefined; await this.active; this.client?.destroy(); }
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
    const { SESv2Client, SendEmailCommand } = await import("@aws-sdk/client-sesv2");
    const { NodeHttpHandler } = await import("@smithy/node-http-handler");
    this.client ??= new SESv2Client({ region: this.options.region, maxAttempts: 1,
      requestHandler: new NodeHttpHandler({ connectionTimeout: 5_000, requestTimeout: 15_000 }) });
    const result = await this.client.send(new SendEmailCommand({
      FromEmailAddress: `=?UTF-8?B?${Buffer.from(this.options.displayName ?? "camelRun Billing").toString("base64")}?= <${this.options.from}>`, Destination: { ToAddresses: [mail.to] },
      ConfigurationSetName: this.options.configurationSet,
      EmailTags: [{ Name: "product", Value: "camelrun-billing" }, { Name: "billing_delivery", Value: mail.delivery }],
      Content: { Simple: { Subject: { Data: mail.subject, Charset: "UTF-8" }, Headers: mail.headers, Body: {
        Html: { Data: mail.html, Charset: "UTF-8" }, Text: { Data: mail.text, Charset: "UTF-8" },
      } } },
    }), { abortSignal: signal });
    return result.MessageId;
  }

  /** Accept only configured, signed SNS notifications tied to one of our tagged deliveries. */
  feedback() {
    const { db, alerts, topics, from } = this.options;
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
}
