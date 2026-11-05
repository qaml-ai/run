import { z } from "zod";
import { accountEmail, type AccountEmailKind } from "../../../src/account-emails.ts";

export interface MailEnv {
  EMAIL?: SendEmail;
  EMAIL_FROM?: string;
  AGENT_ACCOUNT_EMAIL_FROM?: string;
  AGENT_ACCOUNT_EMAIL_NAME?: string;
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
}

/** Cloudflare Email Sending needs a binding and verified sending domain, not AWS keys. */
export async function sendEmail(env: MailEnv, mail: MailMessage, signal?: AbortSignal) {
  const from = env.AGENT_ACCOUNT_EMAIL_FROM ?? env.EMAIL_FROM;
  if (!from || !z.email().safeParse(from).success) throw new Error("A valid email sender is required");
  const displayName = env.AGENT_ACCOUNT_EMAIL_NAME ?? "camelRun";
  if (!displayName.trim() || displayName.length > 80 || /[\r\n]/.test(displayName)) throw new Error("AGENT_ACCOUNT_EMAIL_NAME must be a single display name, at most 80 characters");
  const message: EmailMessageBuilder = {
    from: { email: from, name: displayName },
    to: mail.to, subject: mail.subject, html: mail.html, text: mail.text,
    ...(mail.headers?.length ? { headers: Object.fromEntries(mail.headers.map(h => [h.Name, h.Value])) } : {}),
  };
  // The fake cannot send outside loopback, and is unavailable on a deployed experiment.
  if (env.TEST_MODE === "1" && env.MAIL_TEST_URL) {
    const url = new URL(env.MAIL_TEST_URL);
    if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("Mail fake must be loopback");
    const response = await fetch(url, { method: "POST", body: JSON.stringify(message), headers: { "Content-Type": "application/json" }, signal });
    if (!response.ok) throw new Error("Mail fake refused delivery");
    return { messageId: "local-fake" };
  }
  if (!env.EMAIL) throw new Error("Email Sending is not configured");
  signal?.throwIfAborted();
  return env.EMAIL.send(message);
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
    const sent = sendEmail(this.env, { to, ...mail }, AbortSignal.timeout(15_000))
      .then(() => {}, () => console.error(JSON.stringify({ type: "account_mail_failed", kind })))
      .finally(() => this.sending.delete(sent));
    this.sending.add(sent);
  }
  async stop() { await Promise.all(this.sending); }
}
