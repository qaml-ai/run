import { AwsClient } from "aws4fetch";
import { z } from "zod";
import { accountEmail, type AccountEmailKind } from "../../../src/account-emails.ts";

export interface MailEnv {
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  AGENT_ACCOUNT_EMAIL_FROM?: string;
  AGENT_ACCOUNT_EMAIL_NAME?: string;
  AGENT_ACCOUNT_EMAIL_CONFIGURATION_SET?: string;
  AGENT_ACCOUNT_SES_REGION?: string;
  AGENT_ACCOUNT_SES_ACCESS_KEY_ID?: string;
  AGENT_ACCOUNT_SES_SECRET_ACCESS_KEY?: string;
  AGENT_ACCOUNT_SES_SESSION_TOKEN?: string;
  AGENT_BILLING_EMAIL_FROM?: string;
  AGENT_BILLING_EMAIL_NAME?: string;
  AGENT_BILLING_EMAIL_CONFIGURATION_SET?: string;
  TEST_MODE?: string;
  MAIL_TEST_URL?: string;
}
export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: { Name: string; Value: string }[];
  delivery?: string;
  tags?: { Name: string; Value: string }[];
  kind?: "account" | "billing";
}

function accountSes(env: MailEnv) {
  const region = env.AGENT_ACCOUNT_SES_REGION;
  if (!region) return;
  const accessKeyId = env.AGENT_ACCOUNT_SES_ACCESS_KEY_ID;
  const secretAccessKey = env.AGENT_ACCOUNT_SES_SECRET_ACCESS_KEY;
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region) || !accessKeyId || !secretAccessKey) {
    throw new Error("Account SES requires a region and an account-sender AWS credential");
  }
  return { accessKeyId, secretAccessKey, sessionToken: env.AGENT_ACCOUNT_SES_SESSION_TOKEN, region };
}

export function canSendAccountMail(env: MailEnv) {
  return Boolean((env.AGENT_ACCOUNT_EMAIL_FROM || env.EMAIL_FROM)
    && (accountSes(env) || env.EMAIL || (env.TEST_MODE === "1" && env.MAIL_TEST_URL)));
}

export async function sendEmail(env: MailEnv, mail: MailMessage, signal?: AbortSignal) {
  const billing = mail.kind === "billing";
  const from = (billing ? env.AGENT_BILLING_EMAIL_FROM : env.AGENT_ACCOUNT_EMAIL_FROM) ?? env.EMAIL_FROM;
  if (!from || !z.email().safeParse(from).success) throw new Error("A valid email sender is required");
  const displayName = billing ? env.AGENT_BILLING_EMAIL_NAME ?? "camelRun Billing" : env.AGENT_ACCOUNT_EMAIL_NAME ?? "camelRun";
  if (!displayName.trim() || displayName.length > 80 || /[\r\n]/.test(displayName)) throw new Error("AGENT_ACCOUNT_EMAIL_NAME must be a single display name, at most 80 characters");
  const ses = billing ? undefined : accountSes(env);
  let testUrl: URL | undefined;
  // The fake cannot send outside loopback, and is unavailable on a deployed experiment.
  if (env.TEST_MODE === "1" && env.MAIL_TEST_URL) {
    testUrl = new URL(env.MAIL_TEST_URL);
    if (testUrl.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(testUrl.hostname)
      || testUrl.username || testUrl.password || testUrl.hash) throw new Error("Mail fake must be loopback");
  }
  const endpoint = testUrl ?? (ses ? new URL(`https://email.${ses.region}.amazonaws.com/v2/email/outbound-emails`) : undefined);
  if (endpoint) {
    const envelope = {
      FromEmailAddress: `=?UTF-8?B?${Buffer.from(displayName).toString("base64")}?= <${from}>`,
      Destination: { ToAddresses: [mail.to] },
      ConfigurationSetName: billing ? env.AGENT_BILLING_EMAIL_CONFIGURATION_SET : env.AGENT_ACCOUNT_EMAIL_CONFIGURATION_SET,
      EmailTags: mail.tags,
      Content: { Simple: { Subject: { Data: mail.subject, Charset: "UTF-8" }, Headers: mail.headers, Body: {
        Html: { Data: mail.html, Charset: "UTF-8" }, Text: { Data: mail.text, Charset: "UTF-8" },
      } } },
    };
    const init: RequestInit = { method: "POST", body: JSON.stringify(envelope), headers: { "Content-Type": "application/json" }, redirect: "manual", signal };
    // SES has no idempotency key. Let the account flow handle an explicit failure.
    const request = ses ? await new AwsClient({ ...ses, service: "ses", retries: 0 }).sign(endpoint, init) : new Request(endpoint, init);
    const response = await fetch(request);
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Account mail delivery rejected (HTTP ${response.status})`);
    }
    const result = await response.json() as { MessageId?: string };
    return { messageId: result.MessageId };
  }
  if (!env.EMAIL) throw new Error("Email Sending is not configured");
  signal?.throwIfAborted();
  return env.EMAIL.send({
    from: { email: from, name: displayName },
    to: mail.to, subject: mail.subject, html: mail.html, text: mail.text,
    ...(mail.headers?.length ? { headers: Object.fromEntries(mail.headers.map(h => [h.Name, h.Value])) } : {}),
  });
}

/** Same background-send behavior as AccountMail in src, retained with waitUntil by its caller. */
export class AccountMail {
  readonly config: { origin: string };
  private readonly sending = new Set<Promise<void>>();
  private readonly env: MailEnv;
  constructor(env: MailEnv, origin: string) {
    this.env = env;
    const url = new URL(origin);
    const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !loopback)) throw new Error("Account email requires a public HTTPS origin (HTTP is allowed for loopback development)");
    const from = env.AGENT_ACCOUNT_EMAIL_FROM ?? env.EMAIL_FROM;
    if (!from || !z.email().safeParse(from).success) throw new Error("A valid account email sender is required");
    this.config = { origin: url.origin };
  }
  send(kind: AccountEmailKind, to: string, link?: string) {
    const mail = accountEmail(kind, this.config.origin, link);
    const sent = sendEmail(this.env, { to, ...mail, kind: "account", tags: [{ Name: "product", Value: "camelrun-account" }, { Name: "kind", Value: kind }] }, AbortSignal.timeout(15_000))
      .then(() => {}, () => console.error(JSON.stringify({ type: "account_mail_failed", kind })))
      .finally(() => this.sending.delete(sent));
    this.sending.add(sent);
  }
  async stop() { await Promise.all(this.sending); }
}
