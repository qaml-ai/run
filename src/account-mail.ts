import { z } from "zod";
import { accountEmail, type AccountEmailKind } from "./account-emails.ts";
import { MailTransport } from "./mail-transport.ts";
import { safeError } from "./metrics.ts";

/**
 * Account mail: the links sign-up, password reset and adding a password send (src/email-accounts.ts). Configured by
 * AGENT_ACCOUNT_EMAIL_FROM, sent through Amazon SES (the task's AWS credentials, AWS_REGION) or, on a runtime of one's
 * own, written to the log for the operator to pass on (`log`). Without it there is no sign-up or reset by email.
 */
export interface AccountMailConfig {
  provider: "ses" | "log";
  from: string;
  displayName: string;
  /** The public origin links point at. */
  origin: string;
  region?: string;
  configurationSet?: string;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The account mail configuration, if AGENT_ACCOUNT_EMAIL_FROM is set. The `log` provider writes each link to the log,
 * so it is refused where anyone may sign up (`openSignup`) unless the runtime is only on this machine: a hosted runtime
 * never logs a link.
 */
export function accountMailConfig(env: NodeJS.ProcessEnv, publicUrl: string, openSignup: boolean): AccountMailConfig | undefined {
  const from = env.AGENT_ACCOUNT_EMAIL_FROM?.trim();
  if (!from) return undefined;
  if (!z.email().safeParse(from).success) throw new Error("AGENT_ACCOUNT_EMAIL_FROM must be an email address");
  const displayName = env.AGENT_ACCOUNT_EMAIL_NAME ?? "camelRun";
  if (!displayName.trim() || displayName.length > 80 || /[\r\n]/.test(displayName)) throw new Error("AGENT_ACCOUNT_EMAIL_NAME must be a single display name, at most 80 characters");
  const provider = env.AGENT_ACCOUNT_EMAIL_PROVIDER ?? "ses";
  if (provider !== "ses" && provider !== "log") throw new Error("AGENT_ACCOUNT_EMAIL_PROVIDER must be ses or log");
  const origin = new URL(publicUrl);
  const loopback = origin.protocol === "http:" && LOOPBACK.has(origin.hostname);
  if (origin.username || origin.password || origin.search || origin.hash || (origin.protocol !== "https:" && !loopback)) {
    throw new Error("Account email requires a public HTTPS origin in AGENT_PUBLIC_URL (HTTP is allowed for loopback development)");
  }
  if (provider === "log" && openSignup && !loopback) {
    throw new Error("AGENT_ACCOUNT_EMAIL_PROVIDER=log writes sign-up links to the log: not with AGENT_OPEN_SIGNUP=true on a public URL. Use ses");
  }
  return { provider, from, displayName, origin: origin.origin, region: env.AWS_REGION || undefined, configurationSet: env.AGENT_ACCOUNT_EMAIL_CONFIGURATION_SET || undefined };
}

/**
 * Sends account mail in the background, so a request answers as fast whichever mail it sends (or none): how long it
 * takes says nothing about whether an address has an account. A failed send is logged with its kind alone; the person
 * asks again.
 */
export class AccountMail {
  readonly config: AccountMailConfig;
  private readonly transport?: MailTransport;
  private readonly sending = new Set<Promise<void>>();

  constructor(config: AccountMailConfig) {
    this.config = config;
    if (config.provider === "ses") this.transport = new MailTransport({ from: config.from, displayName: config.displayName, region: config.region, configurationSet: config.configurationSet });
  }

  /** Mail `kind` to `to`, with `link` (the token's page) where it has one. Returns at once. */
  send(kind: AccountEmailKind, to: string, link?: string) {
    if (!this.transport) {
      // Only where accountMailConfig allows it: the operator reads the link here and passes it on.
      console.log(JSON.stringify({ type: "account_mail_link", kind, to, link: link ?? null }));
      return;
    }
    const mail = accountEmail(kind, this.config.origin, link);
    const sent = this.transport.send({ to, subject: mail.subject, html: mail.html, text: mail.text, tags: [{ Name: "product", Value: "camelrun-account" }, { Name: "kind", Value: kind }] }, AbortSignal.timeout(15_000))
      .then(() => {}, error => console.error(JSON.stringify({ type: "account_mail_failed", kind, error: safeError(error) })))
      .finally(() => this.sending.delete(sent));
    this.sending.add(sent);
  }

  /** Wait for mail being sent, then let the transport go. */
  async stop() {
    await Promise.all(this.sending);
    this.transport?.destroy();
  }
}
