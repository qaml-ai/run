import { verify, X509Certificate, type KeyObject } from "node:crypto";
import { Hono } from "hono";
import type { Db } from "./db.ts";
import { readText } from "./http.ts";
import { errorText } from "./protocol.ts";
import { safeError } from "./metrics.ts";
import { fetchWithoutRedirects } from "./core/no-redirect.ts";
import { SendError, type ChannelProvider, type Channels } from "./channels.ts";
import {
  domainOf, emailProvider, forwarderOf, forwardingProof, parseMail, receiveEmail, replyMime, senderOf, vouches, type Forwarder,
} from "./core/channels/email.ts";

export { newText, replyMime, automatic, type Replies } from "./core/channels/email.ts";

/**
 * Email channels on ECS (src/core/channels/email.ts holds what Workers shares): SES receives
 * the domain's mail and publishes each message to an SNS topic, whose HTTPS subscription is
 * one route for all channels, `/channels/email/inbound`. A message is handed to every
 * channel it is addressed to, once its SNS signature, topic and SES's verdicts on the
 * sender check out. Replies go back as SES raw sends.
 */

export interface EmailOptions {
  db: Db;
  /** The domain SES receives for, e.g. in.agents.camelai.dev. */
  domain: string;
  /** SNS topics whose notifications are accepted; with none, nothing is received. */
  topics: string[];
  /** The bucket SES stores mail too large for SNS in (an S3 receipt action), if any. */
  bucket?: string;
  region?: string;
  /** Send a raw message; the default is SES v2 SendEmail in `region`. */
  send?(message: { from: string; to: string[]; raw: Uint8Array }): Promise<void>;
  /** An S3 object's bytes; the default is S3 GetObject in `region`. */
  getObject?(bucket: string, key: string): Promise<Uint8Array>;
  /** Fetches SNS signing certificates and subscription confirmations (tests pass a fake). */
  fetch?: typeof fetch;
}

/** SES's limit is 40 MB a raw message; files past this go as links. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/**
 * Attachments of mail SNS delivered (SES puts only messages up to 150 KB in a notification) ride inline
 * in the channel item, up to this; mail SES stored in S3 is read back from there instead.
 */
const MAX_INLINE_BYTES = 256 * 1024;
/** SNS notifications older than this are replays, not retries. */
const MAX_AGE_MS = 24 * 60 * 60_000;
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/**
 * The forwarder a message's envelope proves, or undefined. SES's SPF verdict is on the envelope
 * sender (`mail.source`, the SMTP MAIL FROM): PASS means the server that handed SES the message
 * is one that domain's SPF record authorizes. A forwarder that rewrites the envelope sender to
 * its own domain (Google's automatic forwarding and groups, Microsoft 365's SRS) therefore passes
 * for its own domain, and nobody outside that domain's servers can. Nothing in the message itself
 * (X-Forwarded-For, X-Forwarded-To, Delivered-To, ARC or Authentication-Results headers) counts:
 * the sender writes those. `address` is the envelope sender without its +tag, which is where
 * Google puts the forwarding mailbox (`support+caf_=…@acme.com`, `support+bnc…@acme.com`).
 */
export function forwardedBy(notification: SesNotification): Forwarder | undefined {
  const receipt = notification.receipt ?? {};
  const source = notification.mail?.source?.trim().toLowerCase() ?? "";
  if (receipt.spfVerdict?.status?.toUpperCase() !== "PASS") return undefined;
  if ([receipt.spamVerdict, receipt.virusVerdict].some(verdict => verdict?.status?.toUpperCase() === "FAIL")) return undefined;
  return forwarderOf(source);
}

/** SES v2 errors that will not change on a retry. */
const PERMANENT = new Set(["MessageRejected", "MailFromDomainNotVerifiedException", "BadRequestException", "NotFoundException", "AccountSuspendedException"]);

/** The email channel provider on ECS: replies as SES raw sends, stored mail read from S3. */
export function email(options: EmailOptions): ChannelProvider {
  const domain = options.domain.toLowerCase();
  let ses: { send(command: unknown): Promise<unknown> } | undefined, command: (new (input: unknown) => unknown) | undefined;
  const send = options.send ?? (async ({ from, to, raw }) => {
    if (!ses) {
      const sdk = await import("@aws-sdk/client-sesv2");
      ses = new sdk.SESv2Client({ region: options.region }) as never;
      command = sdk.SendEmailCommand as never;
    }
    await ses!.send(new command!({ FromEmailAddress: from, Destination: { ToAddresses: to }, Content: { Raw: { Data: raw } } }));
  });
  return emailProvider({
    sql: options.db, domain, setsMessageId: true, maxFileBytes: MAX_FILE_BYTES,
    async deliver(mail) {
      // replyMime writes Auto-Submitted itself; the rest go after it, as they always have.
      const { "Auto-Submitted": _auto, ...headers } = mail.headers;
      const raw = replyMime({
        from: mail.from, ...(mail.fromName ? { fromName: mail.fromName } : {}), to: mail.to, subject: mail.subject, messageId: mail.messageId!,
        inReplyTo: mail.inReplyTo, references: mail.references, text: mail.text, ...(mail.file ? { file: mail.file } : {}),
        ...(Object.keys(headers).length ? { headers: Object.entries(headers).map(([name, value]) => `${name}: ${value}`) } : {}),
      });
      try { await send({ from: mail.from, to: [mail.to], raw: Buffer.from(raw) }); }
      catch (error) {
        const name = (error as { name?: string }).name ?? "";
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 0;
        throw new SendError(`SES SendEmail failed: ${name || errorText(error)}`, PERMANENT.has(name) || (status >= 400 && status < 500 && status !== 429 && !/Throttl|TooMany|LimitExceeded/.test(name)));
      }
    },
    // Mail SES stored in S3: `s3://<bucket>/<key>`, only from the configured bucket.
    async stored(ref) {
      const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(ref);
      if (!match || match[1] !== options.bucket) throw new Error("Not a stored email attachment");
      return getObject(options, match[1], match[2]!);
    },
  });
}

let s3: { send(command: unknown): Promise<any> } | undefined, getCommand: (new (input: unknown) => unknown) | undefined;
async function getObject(options: EmailOptions, bucket: string, key: string): Promise<Uint8Array> {
  if (options.getObject) return options.getObject(bucket, key);
  if (!s3) {
    const sdk = await import("@aws-sdk/client-s3");
    s3 = new sdk.S3Client({ region: options.region }) as never;
    getCommand = sdk.GetObjectCommand as never;
  }
  const object = await s3!.send(new getCommand!({ Bucket: bucket, Key: key }));
  return object.Body.transformToByteArray();
}

// Receiving -----------------------------------------------------------------------

type SnsMessage = Record<string, string | undefined>;
const certificates = new Map<string, Promise<KeyObject>>();

/** Whether a URL is SNS's own: where signing certificates and subscription confirmations come from. */
const snsUrl = (value: string | undefined) => {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && SNS_HOST.test(url.hostname) ? url : undefined;
  } catch { return undefined; }
};

/** Whether an SNS message is signed by SNS: its certificate from SNS's host, version 1 (SHA1) or 2 (SHA256). */
export async function verifySns(message: SnsMessage, fetcher: typeof fetch = fetch): Promise<boolean> {
  const url = snsUrl(message.SigningCertURL ?? message.SigningCertUrl);
  if (!url || !url.pathname.endsWith(".pem") || !message.Signature || !["1", "2"].includes(message.SignatureVersion ?? "")) return false;
  const fields = message.Type === "Notification"
    ? ["Message", "MessageId", ...(message.Subject !== undefined ? ["Subject"] : []), "Timestamp", "TopicArn", "Type"]
    : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  if (fields.some(field => typeof message[field] !== "string")) return false;
  const signed = fields.map(field => `${field}\n${message[field]}\n`).join("");
  let key = certificates.get(url.href);
  if (!key) {
    if (certificates.size > 20) certificates.clear();
    key = fetchWithoutRedirects(fetcher, url, { signal: AbortSignal.timeout(10_000) }).then(async response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new X509Certificate(await response.text()).publicKey;
    });
    key.catch(() => certificates.delete(url.href));
    certificates.set(url.href, key);
  }
  try { return verify(message.SignatureVersion === "2" ? "sha256" : "sha1", Buffer.from(signed), await key, Buffer.from(message.Signature, "base64")); }
  catch { return false; }
}

type Verdict = { status?: string } | undefined;
interface SesNotification {
  notificationType?: string;
  mail?: { messageId?: string; source?: string; headers?: { name: string; value: string }[] };
  receipt?: {
    recipients?: string[];
    spfVerdict?: Verdict; dkimVerdict?: Verdict; dmarcVerdict?: Verdict; spamVerdict?: Verdict; virusVerdict?: Verdict;
    action?: { type?: string; encoding?: string; bucketName?: string; objectKey?: string };
  };
  content?: string;
}

/**
 * Whether SES's checks prove the From address: DMARC passed, or SPF passed for its domain (or
 * one above it). A DMARC failure, spam or a virus rejects the message outright. DKIM alone is not
 * enough: SES's verdict does not say which domain signed, and it adds no Authentication-Results
 * header of its own to say so, so any such header came with the message.
 */
export function authentic(notification: SesNotification, from: string): boolean {
  const receipt = notification.receipt ?? {};
  const status = (verdict: Verdict) => verdict?.status?.toUpperCase();
  if ([receipt.dmarcVerdict, receipt.spamVerdict, receipt.virusVerdict].some(verdict => status(verdict) === "FAIL")) return false;
  if (status(receipt.dmarcVerdict) === "PASS") return true;
  const domain = domainOf(from);
  return status(receipt.spfVerdict) === "PASS" && !!notification.mail?.source && vouches(domainOf(notification.mail.source), domain);
}

/**
 * The shared inbound route: SNS notifications from SES receipt rules, and SNS's
 * subscription handshake. Answers 5xx only when SNS should retry.
 */
export function emailReceiver(channels: Channels, options: EmailOptions) {
  const domain = options.domain.toLowerCase();
  const fetcher = options.fetch ?? fetch;
  const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ type: "email_inbound", ...fields }));

  async function receive(notification: SesNotification) {
    if (notification.notificationType !== "Received") return;
    const action = notification.receipt?.action;
    let raw: Uint8Array, stored: { bucket: string; key: string } | undefined;
    if (action?.type === "S3") {
      if (!action.bucketName || !action.objectKey || action.bucketName !== options.bucket) return log({ dropped: "unknown_bucket" });
      stored = { bucket: action.bucketName, key: action.objectKey };
      raw = await getObject(options, stored.bucket, stored.key);
    } else if (typeof notification.content === "string") {
      raw = Buffer.from(notification.content, action?.encoding === "BASE64" ? "base64" : "utf8");
    } else return log({ dropped: "no_content", ses: notification.mail?.messageId });
    const message = await parseMail(raw);
    const ses = notification.mail?.messageId;
    const found = senderOf(message, domain);
    if ("dropped" in found) return log({ dropped: found.dropped, ses });
    const { from } = found;
    // Either SES proves the From address, or it proves a forwarder, which a channel may trust to pass on others' mail.
    const proof = { direct: authentic(notification, from), forwarder: forwardingProof(forwardedBy(notification), from, domain) };
    await receiveEmail(channels, options.db, {
      domain, message, from, proof, recipients: notification.receipt?.recipients ?? [],
      ...(stored ? { stored: `s3://${stored.bucket}/${stored.key}` } : {}), inlineBytes: MAX_INLINE_BYTES, fallbackId: `${ses}@amazonses.com`,
      log: fields => log({ ...fields, ses }),
    });
  }

  return new Hono().post("/channels/email/inbound", async c => {
    let body: string, message: SnsMessage;
    try { body = await readText(c.req.raw.body, 2_000_000); } catch { return c.body(null, 413); }
    try { message = JSON.parse(body); } catch { return c.body(null, 400); }
    if (!message || typeof message !== "object") return c.body(null, 400);
    // The topic first: a post naming any other is refused without fetching a certificate for it.
    if (!message.TopicArn || !options.topics.includes(message.TopicArn)) { log({ rejected: "topic", topic: message.TopicArn }); return c.body(null, 403); }
    if (!await verifySns(message, fetcher)) { log({ rejected: "signature" }); return c.body(null, 401); }
    if (!(Date.now() - Date.parse(message.Timestamp ?? "") < MAX_AGE_MS)) { log({ rejected: "stale" }); return c.body(null, 400); }
    if (message.Type === "SubscriptionConfirmation") {
      const confirm = snsUrl(message.SubscribeURL);
      if (!confirm) return c.body(null, 400);
      const response = await fetchWithoutRedirects(fetcher, confirm, { signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
      log({ subscription: response?.ok ? "confirmed" : "failed", topic: message.TopicArn });
      return c.body(null, response?.ok ? 200 : 502);
    }
    if (message.Type !== "Notification") return c.body(null, 200);
    let notification: SesNotification;
    try { notification = JSON.parse(message.Message!); } catch { return c.body(null, 200); }
    try { await receive(notification); }
    catch (error) {
      console.error(JSON.stringify({ type: "email_inbound_failed", ses: notification.mail?.messageId, error: safeError(error) }));
      return c.body(null, 500);
    }
    return c.body(null, 200);
  });
}
