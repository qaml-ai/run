import { createHash, randomBytes, randomUUID, verify, X509Certificate, type KeyObject } from "node:crypto";
import { Hono } from "hono";
import PostalMime, { type Email, type Mailbox } from "postal-mime";
import type { Db } from "./db.ts";
import { HttpError, readText } from "./http.ts";
import { readableText } from "./html-text.ts";
import { errorText } from "./protocol.ts";
import { safeError } from "./metrics.ts";
import { SendError, type Channel, type ChannelProvider, type Channels, type ChannelSettings, type InboundFile, type Sender } from "./channels.ts";

/**
 * Email channels on the runtime's own domain. Each channel has an address,
 * `<local>@AGENT_EMAIL_DOMAIN` (its id unless the tenant picks one); SES receives
 * the domain's mail and publishes each message to an SNS topic, whose HTTPS
 * subscription is one route for all channels, `/channels/email/inbound`. A message
 * is handed to every channel it is addressed to, once its SNS signature, topic and
 * SES's verdicts on the sender check out.
 *
 * A conversation is an email thread, found by its root Message-ID (or by any
 * message of ours it replies to), and replies go back as SES raw sends that
 * thread under the last message received. What a reply needs (who to, the
 * subject, References) is kept per conversation:
 *
 *   email_threads    a conversation's channel, who replies go to, subject and References
 *   email_messages   the Message-IDs of a channel's threads, so a reply to any of them finds its thread
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
/** What of a message's text the agent gets. */
const MAX_TEXT = 20_000;
/** References kept per thread: the root and the most recent. */
const MAX_REFERENCES = 20;
/** SNS notifications older than this are replays, not retries. */
const MAX_AGE_MS = 24 * 60 * 60_000;
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
/** Local parts no channel may take: role addresses mail systems and people expect to mean something else. */
const RESERVED = new Set(["postmaster", "abuse", "mailer-daemon", "hostmaster", "webmaster", "admin", "administrator", "root", "security", "noreply", "no-reply", "support-noreply"]);
const LOCAL = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
/** Message-IDs in a header, without their angle brackets. */
const messageIds = (value: string | undefined) => [...(value ?? "").matchAll(/<([^<>\s]+)>/g)].map(match => match[1]);
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();
/** A domain proven by SPF or DKIM vouches for a From domain that is it or under it. */
const vouches = (proven: string, from: string) => proven.includes(".") && (from === proven || from.endsWith(`.${proven}`));

/** A channel's address from the tenant's choice: a local part, or the whole address on this domain. */
function address(value: unknown, domain: string, id: string): string {
  if (typeof value !== "string") throw new HttpError(400, "settings.address must be a string");
  let local = value.trim().toLowerCase();
  if (local.includes("@")) {
    if (!local.endsWith(`@${domain.toLowerCase()}`)) throw new HttpError(400, `settings.address must be on ${domain}`);
    local = local.slice(0, local.lastIndexOf("@"));
  }
  if (!LOCAL.test(local)) throw new HttpError(400, "settings.address: letters, digits, and . _ + - inside, up to 64 characters");
  if (RESERVED.has(local)) throw new HttpError(400, `settings.address: ${local} is reserved`);
  // Channel ids are default addresses; only a channel's own id may be chosen.
  if (local.startsWith("ch_") && local !== id) throw new HttpError(400, "settings.address may not start with ch_");
  return `${local}@${domain.toLowerCase()}`;
}

/** Attachments the agent gets: not the images an HTML body shows inline (logos, signatures). */
const attachmentsOf = (email: Email) => email.attachments.filter(attachment => !attachment.related);
const bytesOf = (content: ArrayBuffer | Uint8Array | string) => typeof content === "string" ? Buffer.from(content) : Buffer.from(content instanceof Uint8Array ? content : new Uint8Array(content));
const fileName = (name: string | null, index: number) => (name ?? "").replace(/[/\\\0\r\n]/g, "_").trim().slice(0, 200) || `attachment-${index + 1}`;

/** What someone wrote, without the history their client quoted below it. */
export function newText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i.test(line) || /^_{10,}\s*$/.test(line)) break;
    // "On <date>, <someone> wrote:", which clients wrap onto a second line.
    if (/^On\b.*\bwrote:\s*$/.test(line) || (/^On\b/.test(line) && /^\s*\S*.*\bwrote:\s*$/.test(lines[index + 1] ?? "") && !/^On\b/.test(lines[index + 1] ?? ""))) break;
    if (/^\s*>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** A header value as RFC 2047 encoded words when it is not plain ASCII, each at most 75 characters. */
function encodeWord(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const words: string[] = [];
  let current = "";
  for (const char of value) {
    if (Buffer.byteLength(current + char) > 45) { words.push(current); current = ""; }
    current += char;
  }
  if (current) words.push(current);
  return words.map(word => `=?UTF-8?B?${Buffer.from(word).toString("base64")}?=`).join(" ");
}
const mailbox = (address: string, name?: string) => {
  if (!name) return address;
  const clean = oneLine(name);
  return /^[\x20-\x7e]*$/.test(clean) ? `"${clean.replace(/["\\]/g, "\\$&")}" <${address}>` : `${encodeWord(clean)} <${address}>`;
};
const base64Lines = (data: Buffer) => data.toString("base64").replace(/.{76}/g, "$&\r\n");

/** A reply as a raw MIME message: text, and optionally one file. */
export function replyMime(reply: {
  from: string; fromName?: string; to: string; subject: string; messageId: string; inReplyTo?: string; references: string[];
  text: string; file?: { name: string; contentType: string; data: Buffer }; date?: Date;
}): string {
  const subject = oneLine(reply.subject) || "(no subject)";
  const headers = [
    `From: ${mailbox(reply.from, reply.fromName)}`,
    `To: ${reply.to}`,
    `Subject: ${encodeWord(/^re:/i.test(subject) ? subject : `Re: ${subject}`)}`,
    `Date: ${(reply.date ?? new Date()).toUTCString()}`,
    `Message-ID: <${reply.messageId}>`,
    ...(reply.inReplyTo ? [`In-Reply-To: <${reply.inReplyTo}>`] : []),
    ...(reply.references.length ? [`References: ${reply.references.map(id => `<${id}>`).join(" ")}`] : []),
    // Tells vacation responders and other agents not to answer an automatic message.
    "Auto-Submitted: auto-replied",
    "MIME-Version: 1.0",
  ];
  const text = ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", base64Lines(Buffer.from(reply.text || " "))].join("\r\n");
  if (!reply.file) return [...headers, text].join("\r\n");
  const boundary = `=_${randomBytes(12).toString("hex")}`;
  const name = oneLine(reply.file.name).replace(/["\\]/g, "_");
  const ascii = /^[\x20-\x7e]*$/.test(name);
  const part = [
    `Content-Type: ${reply.file.contentType.replace(/[^\w.+/-]/g, "") || "application/octet-stream"}; name="${ascii ? name : "attachment"}"`,
    `Content-Disposition: attachment; ${ascii ? `filename="${name}"` : `filename*=UTF-8''${encodeURIComponent(name)}`}`,
    "Content-Transfer-Encoding: base64", "", base64Lines(reply.file.data),
  ].join("\r\n");
  return [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, text, `--${boundary}`, part, `--${boundary}--`, ""].join("\r\n");
}

/** SES v2 errors that will not change on a retry. */
const PERMANENT = new Set(["MessageRejected", "MailFromDomainNotVerifiedException", "BadRequestException", "NotFoundException", "AccountSuspendedException"]);

/** The email channel provider: no credentials, one address per channel, replies through SES. */
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

  async function sendMail(conversationId: string, text: string, file?: { name: string; contentType: string; data: Buffer }) {
    const { rows } = await options.db.query(`
      select t.channel as id, t.reply_to, t.subject, t.refs, t.last_message, c.channel
      from email_threads t join channels c on c.id = t.channel where t.conversation = $1`, [conversationId]);
    const thread = rows[0];
    if (!thread) throw new SendError("No such email thread", true);
    const settings = ((thread.channel as Channel).settings ?? {}) as { address?: string; fromName?: string };
    const from = settings.address ?? `${thread.id}@${domain}`;
    const messageId = `${randomUUID()}@${domain}`;
    const raw = replyMime({
      from, ...(settings.fromName ? { fromName: settings.fromName } : {}), to: thread.reply_to, subject: thread.subject, messageId,
      inReplyTo: thread.last_message, references: thread.refs, text, ...(file ? { file } : {}),
    });
    // Recorded first: a reply to this message must find its thread even if it comes back at once.
    await options.db.query("insert into email_messages (channel, message_id, conversation, created_at) values ($1, $2, $3, $4) on conflict do nothing", [thread.id, messageId, conversationId, Date.now()]);
    try { await send({ from, to: [thread.reply_to], raw: Buffer.from(raw) }); }
    catch (error) {
      const name = (error as { name?: string }).name ?? "";
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 0;
      throw new SendError(`SES SendEmail failed: ${name || errorText(error)}`, PERMANENT.has(name) || (status >= 400 && status < 500 && status !== 429 && !/Throttl|TooMany|LimitExceeded/.test(name)));
    }
  }

  return {
    label: "Email",
    // One message a reply; the core's own cap (32,000 characters) applies.
    maxMessageLength: 1_000_000,
    needsCredentials: false,
    async setup() { return { account: {}, masked: {} }; },
    // The address stops receiving when the channel is deleted: nothing maps it to a channel.
    async teardown() {},
    settings(input: ChannelSettings | undefined, current?: ChannelSettings, channel?: { id: string }) {
      if (!channel) throw new Error("The email provider needs the channel's id for its default address");
      const merged = { ...current, ...input };
      for (const key of Object.keys(merged)) if (key !== "address" && key !== "fromName") throw new HttpError(400, `Unknown email setting ${key}; supported: address, fromName`);
      const fromName = merged.fromName;
      if (fromName !== undefined && (typeof fromName !== "string" || !oneLine(fromName) || fromName.length > 100)) throw new HttpError(400, "settings.fromName must be 1–100 characters");
      return { address: address(merged.address ?? channel.id, domain, channel.id), ...(typeof fromName === "string" ? { fromName: oneLine(fromName) } : {}) };
    },
    // Entries are addresses, or @domain for everyone at a domain.
    allows(entry: string, sender: Sender) {
      const value = entry.trim().toLowerCase();
      return value.startsWith("@") ? domainOf(sender.id) === value.slice(1) : value === sender.id;
    },
    // Attachments of mail SES stored in S3 are read from the stored message; smaller mail brings them inline.
    async download(_credentials, file) {
      const match = /^s3:\/\/([^/]+)\/(.+)#(\d+)$/.exec(file.id);
      if (!match || match[1] !== options.bucket) throw new Error("Not a stored email attachment");
      const message = await PostalMime.parse(await getObject(options, match[1], match[2]));
      const attachment = attachmentsOf(message)[Number(match[3])];
      if (!attachment) throw new Error("No such attachment");
      const data = bytesOf(attachment.content);
      return { body: (async function* () { yield data; })(), contentType: attachment.mimeType };
    },
    async send(_credentials, conversationId, text) { await sendMail(conversationId, text); },
    maxFileBytes: MAX_FILE_BYTES,
    async sendFile(_credentials, conversationId, file, caption) {
      await sendMail(conversationId, caption ?? file.name, { name: file.name, contentType: file.contentType, data: Buffer.from(await (await file.blob()).arrayBuffer()) });
    },
  };
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
    key = fetcher(url, { redirect: "error", signal: AbortSignal.timeout(10_000) }).then(async response => {
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

/** Why a message is not for an agent (automatic, bulk, a bounce, or from this domain), or undefined when it is. */
export function automatic(message: Email, from: string, domain: string): string | undefined {
  const header = (name: string) => message.headers.find(entry => entry.key === name)?.value.trim().toLowerCase();
  const sender = domainOf(from);
  if (sender === domain || sender.endsWith(`.${domain}`)) return "own_domain";
  const auto = header("auto-submitted");
  if (auto && auto !== "no") return "auto_submitted";
  if (["bulk", "list", "junk"].includes(header("precedence") ?? "")) return "bulk";
  if (["mailer-daemon", "postmaster"].includes(from.slice(0, from.lastIndexOf("@")).toLowerCase())) return "bounce";
  return undefined;
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
    const message = await PostalMime.parse(raw);
    const from = (message.from as Mailbox | undefined)?.address?.toLowerCase();
    const ses = notification.mail?.messageId;
    if (!from || !/^[^@\s]+@[^@\s]+$/.test(from)) return log({ dropped: "no_from", ses });
    const skipped = automatic(message, from, domain);
    if (skipped) return log({ dropped: skipped, ses });
    if (!authentic(notification, from)) return log({ dropped: "unauthenticated", ses });

    const recipients = [...new Set((notification.receipt?.recipients ?? []).map(value => value.toLowerCase()).filter(value => value.endsWith(`@${domain}`)))];
    if (!recipients.length) return;
    const { rows } = await options.db.query("select id from channels where channel->>'type' = 'email' and lower(channel->'settings'->>'address') = any($1)", [recipients]);
    const messageId = message.messageId ? messageIds(message.messageId)[0] ?? oneLine(message.messageId) : `${ses}@amazonses.com`;
    const earlier = [...messageIds(message.references), ...messageIds(message.inReplyTo)];
    const subject = oneLine(message.subject ?? "").slice(0, 500) || "(no subject)";
    const body = newText(message.text ?? (message.html ? readableText(message.html).text : ""));
    const text = `Subject: ${subject}\n\n${body.length > MAX_TEXT ? `${body.slice(0, MAX_TEXT)}\n(message truncated)` : body}`.trim();
    const files: InboundFile[] = attachmentsOf(message).map((attachment, index) => {
      const data = bytesOf(attachment.content);
      return {
        id: stored ? `s3://${stored.bucket}/${stored.key}#${index}` : `inline:${index}`, name: fileName(attachment.filename, index),
        size: data.length, contentType: attachment.mimeType, ...(!stored && data.length <= MAX_INLINE_BYTES ? { content: data.toString("base64") } : {}),
      };
    });
    const name = (message.from as Mailbox).name ? oneLine((message.from as Mailbox).name).slice(0, 200) : undefined;
    const sender: Sender = { id: from, username: from, ...(name ? { name } : {}) };

    for (const { id } of rows) {
      const found = await channels.lookup(id);
      // Only allowed senders move a thread: its replies go to whoever wrote last.
      if (!found || !channels.allowed(found.channel, sender)) { log({ dropped: "access", channel: id, ses }); continue; }
      const known = earlier.length
        ? (await options.db.query("select conversation from email_messages where channel = $1 and message_id = any($2) limit 1", [id, earlier])).rows[0]?.conversation as string | undefined
        : undefined;
      const conversationId = known ?? sha(`${id}:${earlier[0] ?? messageId}`).slice(0, 40);
      const now = Date.now();
      // References: the root, then the most recent, ending with this message.
      const stored = (await options.db.query("select refs from email_threads where conversation = $1", [conversationId])).rows[0]?.refs as string[] | undefined;
      const all = [...new Set([...stored ?? earlier, messageId])];
      const refs = all.length > MAX_REFERENCES ? [all[0], ...all.slice(all.length - MAX_REFERENCES + 1)] : all;
      await options.db.query(`
        insert into email_threads (conversation, channel, reply_to, subject, refs, last_message, updated_at) values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (conversation) do update set reply_to = excluded.reply_to, refs = excluded.refs, last_message = excluded.last_message, updated_at = excluded.updated_at`,
        [conversationId, id, from, subject, JSON.stringify(refs), messageId, now]);
      await options.db.query("insert into email_messages (channel, message_id, conversation, created_at) values ($1, $2, $3, $4) on conflict do nothing", [id, messageId, conversationId, now]);
      await channels.inbound(id, { conversationId, messageId, sender, text, files, title: subject.slice(0, 100) });
    }
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
      const response = await fetcher(confirm, { redirect: "error", signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
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
