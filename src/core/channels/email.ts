import PostalMime, { type Email, type Mailbox } from "postal-mime";
import type { Sql } from "../host.ts";
import { HttpError } from "../http-error.ts";
import { readableText } from "../html-text.ts";
import { SendError, type Channel, type ChannelProvider, type ChannelSettings, type Channels, type InboundFile, type Sender } from "./channels.ts";
import { randomHex, sha256Hex, toBase64, utf8 } from "./crypto.ts";

/**
 * Email channels on the runtime's own domain. Each channel has an address,
 * `<local>@<domain>` (its id unless the tenant picks one). A host receives the
 * domain's mail its own way (ECS: SES through SNS, src/channels-email.ts; Workers:
 * Cloudflare Email Routing to an Email Worker), proves the sender, and hands the
 * parsed message to `receiveEmail`, which gives it to every channel it is addressed to.
 *
 * A conversation is an email thread, found by its root Message-ID (or by any
 * message of ours it replies to), and replies go back through the host's mail
 * service, threaded under the last message received. What a reply needs (who to,
 * the subject, References) is kept per conversation:
 *
 *   email_threads    a conversation's channel, who wrote last (and whether a forwarder brought it), subject and References
 *   email_messages   the Message-IDs of a channel's threads, so a reply to any of them finds its thread
 *
 * Who a reply is mailed to is the channel's `settings.replies`, read when it is sent:
 * whoever wrote last (`sender`, the default), nobody (`none`), or one fixed address
 * (`{ to }`) that has proven itself by writing to the channel. Mail a trusted
 * forwarder (`settings.forwarders`) passes on keeps its original From, which nothing
 * proves: such a sender is never mailed unless the channel says so (`replyToForwarded`).
 */

/** What of a message's text the agent gets. */
const MAX_TEXT = 20_000;
/** References kept per thread: the root and the most recent. */
const MAX_REFERENCES = 20;
/** Local parts no channel may take: role addresses mail systems and people expect to mean something else. */
const RESERVED = new Set(["postmaster", "abuse", "mailer-daemon", "hostmaster", "webmaster", "admin", "administrator", "root", "security", "noreply", "no-reply", "support-noreply"]);
const LOCAL = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;
const ADDRESS = /^[^@\s<>,;"]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/;
const MAX_FORWARDERS = 20;

const sha = sha256Hex;
export const oneLine = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
/** Message-IDs in a header, without their angle brackets. */
export const messageIds = (value: string | undefined) => [...(value ?? "").matchAll(/<([^<>\s]+)>/g)].map(match => match[1]!);
export const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();
/** A domain proven by SPF or DKIM vouches for a From domain that is it or under it. */
export const vouches = (proven: string, from: string) => proven.includes(".") && (from === proven || from.endsWith(`.${proven}`));

/** Who a channel's replies are mailed to: the last sender, nobody, or one fixed address. */
export type Replies = "sender" | "none" | { to: string };
/** An email channel's settings as stored: defaults (`replies: "sender"`, no forwarders) are left out. */
export interface EmailSettings { address?: string; fromName?: string; replies?: Exclude<Replies, "sender">; forwarders?: string[]; replyToForwarded?: true }
export const repliesOf = (settings: EmailSettings): Replies => settings.replies ?? "sender";

/** `settings.replies` as given: "sender", "none", or { to } with an address off the runtime's own domain. */
function repliesInput(value: unknown, domain: string): Replies {
  if (value === "sender" || value === "none") return value;
  const to = value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).join() === "to" ? (value as { to: unknown }).to : undefined;
  if (typeof to !== "string") throw new HttpError(400, 'settings.replies must be "sender", "none" or { "to": "<address>" }');
  const address = to.trim().toLowerCase();
  if (address.length > 254 || !ADDRESS.test(address)) throw new HttpError(400, "settings.replies.to must be an email address");
  if (vouches(domain, domainOf(address))) throw new HttpError(400, `settings.replies.to may not be on ${domain}`);
  return { to: address };
}

/** `settings.forwarders` as given: addresses, or @domain for every mailbox of a domain. */
function forwardersInput(value: unknown, domain: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_FORWARDERS) throw new HttpError(400, `settings.forwarders must be a list of at most ${MAX_FORWARDERS} addresses or @domains`);
  return [...new Set(value.map(entry => {
    const text = typeof entry === "string" ? entry.trim().toLowerCase() : "";
    if (text.length > 254 || !ADDRESS.test(text.startsWith("@") ? `x${text}` : text)) throw new HttpError(400, "settings.forwarders: each entry is an address or @domain");
    if (vouches(domain, domainOf(text))) throw new HttpError(400, `settings.forwarders may not name ${domain}`);
    return text;
  }))];
}

/** A forwarder its envelope proves: the envelope sender without its +tag, and its domain. */
export type Forwarder = { address: string; domain: string };
/** A proven envelope sender as a forwarder: the address without its +tag (where Google puts the forwarding mailbox). */
export function forwarderOf(source: string): Forwarder | undefined {
  const value = source.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return undefined;
  const local = value.slice(0, value.lastIndexOf("@")), domain = domainOf(value);
  return { address: `${local.split("+")[0]}@${domain}`, domain };
}
/** Whether a forwarders entry names a proven forwarder: its address, or @domain for its whole domain. */
const forwarderMatches = (entry: string, forwarder: Forwarder) => entry.startsWith("@") ? entry.slice(1) === forwarder.domain : entry === forwarder.address;

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
export const attachmentsOf = (email: Email) => email.attachments.filter(attachment => !attachment.related);
export const bytesOf = (content: ArrayBuffer | Uint8Array | string) => typeof content === "string" ? utf8(content) : content instanceof Uint8Array ? content : new Uint8Array(content);
const fileName = (name: string | null, index: number) => (name ?? "").replace(/[/\\\0\r\n]/g, "_").trim().slice(0, 200) || `attachment-${index + 1}`;

/** A raw message, parsed. */
export const parseMail = (raw: Uint8Array | ArrayBuffer | string) => PostalMime.parse(raw as ArrayBuffer);

/** What someone wrote, without the history their client quoted below it. */
export function newText(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
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
    if (utf8(current + char).length > 45) { words.push(current); current = ""; }
    current += char;
  }
  if (current) words.push(current);
  return words.map(word => `=?UTF-8?B?${toBase64(utf8(word))}?=`).join(" ");
}
const mailbox = (address: string, name?: string) => {
  if (!name) return address;
  const clean = oneLine(name);
  return /^[\x20-\x7e]*$/.test(clean) ? `"${clean.replace(/["\\]/g, "\\$&")}" <${address}>` : `${encodeWord(clean)} <${address}>`;
};
const base64Lines = (data: Uint8Array) => toBase64(data).replace(/.{76}/g, "$&\r\n");

/** A reply's subject: the thread's, with Re: once. */
export function replySubject(subject: string) {
  const line = oneLine(subject) || "(no subject)";
  return /^re:/i.test(line) ? line : `Re: ${line}`;
}

/** A reply as a raw MIME message: text, and optionally one file. */
export function replyMime(reply: {
  from: string; fromName?: string; to: string; subject: string; messageId: string; inReplyTo?: string; references: string[];
  text: string; file?: { name: string; contentType: string; data: Uint8Array }; date?: Date;
  /** Further headers, each a whole `Name: value` line. */
  headers?: string[];
}): string {
  const headers = [
    `From: ${mailbox(reply.from, reply.fromName)}`,
    `To: ${reply.to}`,
    `Subject: ${encodeWord(replySubject(reply.subject))}`,
    `Date: ${(reply.date ?? new Date()).toUTCString()}`,
    `Message-ID: <${reply.messageId}>`,
    ...(reply.inReplyTo ? [`In-Reply-To: <${reply.inReplyTo}>`] : []),
    ...(reply.references.length ? [`References: ${reply.references.map(id => `<${id}>`).join(" ")}`] : []),
    // Tells vacation responders and other agents not to answer an automatic message.
    "Auto-Submitted: auto-replied",
    ...(reply.headers ?? []),
    "MIME-Version: 1.0",
  ];
  const text = ["Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: base64", "", base64Lines(utf8(reply.text || " "))].join("\r\n");
  if (!reply.file) return [...headers, text].join("\r\n");
  const boundary = `=_${randomHex(12)}`;
  const name = oneLine(reply.file.name).replace(/["\\]/g, "_");
  const ascii = /^[\x20-\x7e]*$/.test(name);
  const part = [
    `Content-Type: ${reply.file.contentType.replace(/[^\w.+/-]/g, "") || "application/octet-stream"}; name="${ascii ? name : "attachment"}"`,
    `Content-Disposition: attachment; ${ascii ? `filename="${name}"` : `filename*=UTF-8''${encodeURIComponent(name)}`}`,
    "Content-Transfer-Encoding: base64", "", base64Lines(reply.file.data),
  ].join("\r\n");
  return [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, text, `--${boundary}`, part, `--${boundary}--`, ""].join("\r\n");
}

/** A reply as the host's mail service sends it. */
export interface OutgoingMail {
  from: string; fromName?: string; to: string;
  /** The thread's subject; the host adds Re: (replySubject). */
  subject: string;
  /** The Message-ID this reply carries, for hosts whose service lets the sender set it. */
  messageId?: string;
  inReplyTo?: string; references: string[];
  text: string; file?: { name: string; contentType: string; data: Uint8Array };
  /** Further headers, by name. */
  headers: Record<string, string>;
}

export interface EmailProviderOptions {
  sql: Sql;
  /** The domain mail is received for, e.g. in.agents.camelai.dev. */
  domain: string;
  /** Send one reply; resolve with the Message-ID the service gave it when the host could not set its own. Throw a SendError when it fails. */
  deliver(mail: OutgoingMail): Promise<{ messageId?: string } | void>;
  /** Whether the host sets each reply's Message-ID itself (SES raw sends do; Cloudflare Email Service assigns its own). */
  setsMessageId: boolean;
  /** A stored message's bytes, for attachments too large to ride in the channel item (`stored:<ref>#<index>` file ids). */
  stored?(ref: string): Promise<Uint8Array>;
  /** The largest file sent as an attachment; larger ones go as links. */
  maxFileBytes: number;
  log?(fields: Record<string, unknown>): void;
}

/** The email channel provider: no credentials, one address per channel, replies through the host's mail service. */
export function emailProvider(options: EmailProviderOptions): ChannelProvider {
  const domain = options.domain.toLowerCase();
  const log = options.log ?? (fields => console.log(JSON.stringify({ type: "email_outbound", ...fields })));

  async function sendMail(conversationId: string, text: string, file?: { name: string; contentType: string; data: Uint8Array }) {
    const { rows } = await options.sql.query(`
      select t.channel as id, t.reply_to, t.forwarded, t.subject, t.refs, t.last_message, c.channel
      from email_threads t join channels c on c.id = t.channel where t.conversation = $1`, [conversationId]);
    const thread = rows[0];
    if (!thread) throw new SendError("No such email thread", true);
    const channel = thread.channel as Channel;
    const settings = (channel.settings ?? {}) as EmailSettings;
    const replies = repliesOf(settings);
    // Decided here, by the settings as they are now, so no queued or retried message outlives a change of them.
    const skip = (reason: string) => log({ skipped: reason, channel: thread.id, conversation: conversationId });
    if (replies === "none") return skip("replies_none");
    if (replies === "sender" && thread.forwarded && !settings.replyToForwarded) return skip("forwarded_sender");
    if (replies !== "sender" && channel.account.verifiedReplyTo !== replies.to) return skip("reply_to_unverified");
    const fixed = replies !== "sender";
    const to = fixed ? replies.to : thread.reply_to as string;
    const from = settings.address ?? `${thread.id}@${domain}`;
    const messageId = options.setsMessageId ? `${crypto.randomUUID()}@${domain}` : undefined;
    const record = (id: string) => options.sql.query("insert into email_messages (channel, message_id, conversation, created_at) values ($1, $2, $3, $4) on conflict do nothing", [thread.id, id, conversationId, Date.now()]);
    // Recorded first: a reply to this message must find its thread even if it comes back at once.
    if (messageId) await record(messageId);
    const sent = await options.deliver({
      from, ...(settings.fromName ? { fromName: settings.fromName } : {}), to, subject: thread.subject, ...(messageId ? { messageId } : {}),
      inReplyTo: thread.last_message, references: thread.refs, ...(file ? { file } : {}),
      // A fixed address is told whose message this answers; that person is not mailed.
      text: fixed ? `Reply for ${thread.reply_to}${thread.forwarded ? " (forwarded, unverified)" : ""}, subject "${oneLine(thread.subject)}". Sent only to ${to}, not to them.\n\n${text}` : text,
      headers: { "Auto-Submitted": "auto-replied", ...(fixed && /^[\x21-\x7e]+$/.test(thread.reply_to) ? { "X-Original-From": thread.reply_to } : {}) },
    });
    // A Message-ID the service chose: recorded now, so a reply to it finds its thread (References name the thread's root too).
    const given = sent && sent.messageId ? messageIds(`<${sent.messageId.replace(/^<|>$/g, "")}>`)[0] : undefined;
    if (!messageId && given) await record(given);
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
      const supported = ["address", "fromName", "replies", "forwarders", "replyToForwarded"];
      for (const key of Object.keys(merged)) if (!supported.includes(key)) throw new HttpError(400, `Unknown email setting ${key}; supported: ${supported.join(", ")}`);
      const fromName = merged.fromName;
      if (fromName !== undefined && (typeof fromName !== "string" || !oneLine(fromName) || fromName.length > 100)) throw new HttpError(400, "settings.fromName must be 1–100 characters");
      const replies = merged.replies === undefined ? "sender" : repliesInput(merged.replies, domain);
      const forwarders = merged.forwarders === undefined ? [] : forwardersInput(merged.forwarders, domain);
      if (merged.replyToForwarded !== undefined && typeof merged.replyToForwarded !== "boolean") throw new HttpError(400, "settings.replyToForwarded must be true or false");
      // Forwarded mail's From is whatever the message says: replying to it mails an address nobody proved.
      if (forwarders.length && replies === "sender" && merged.replyToForwarded !== true) {
        throw new HttpError(400, 'An email channel with settings.forwarders must set settings.replies to "none" or { "to": "<address>" }: a forwarded message\'s sender is unverified. To reply to such senders anyway, set settings.replyToForwarded to true');
      }
      return {
        address: address(merged.address ?? channel.id, domain, channel.id), ...(typeof fromName === "string" ? { fromName: oneLine(fromName) } : {}),
        ...(replies !== "sender" ? { replies } : {}), ...(forwarders.length ? { forwarders } : {}), ...(merged.replyToForwarded === true ? { replyToForwarded: true } : {}),
      };
    },
    // With "none" nothing is mailed: a turn's reply stays in the agent's history, and send_message and files go nowhere.
    replies: settings => settings.replies !== "none",
    // Entries are addresses, or @domain for everyone at a domain.
    allows(entry: string, sender: Sender) {
      const value = entry.trim().toLowerCase();
      return value.startsWith("@") ? domainOf(sender.id) === value.slice(1) : value === sender.id;
    },
    // Attachments of mail stored aside (too large to ride inline) are read from the stored message; smaller mail brings them inline.
    async download(_credentials, file) {
      const match = /^(.+)#(\d+)$/.exec(file.id);
      if (!match || !options.stored || match[1]!.startsWith("inline:")) throw new Error("Not a stored email attachment");
      const message = await parseMail(await options.stored(match[1]!));
      const attachment = attachmentsOf(message)[Number(match[2])];
      if (!attachment) throw new Error("No such attachment");
      const data = bytesOf(attachment.content);
      return { body: (async function* () { yield data; })(), contentType: attachment.mimeType };
    },
    async send(_credentials, conversationId, text) { await sendMail(conversationId, text); },
    maxFileBytes: options.maxFileBytes,
    async sendFile(_credentials, conversationId, file, caption) {
      await sendMail(conversationId, caption ?? file.name, { name: file.name, contentType: file.contentType, data: new Uint8Array(await (await file.blob()).arrayBuffer()) });
    },
  };
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

/** A received message's sender, or why it is dropped before any proof is asked. */
export function senderOf(message: Email, domain: string): { from: string } | { dropped: string } {
  const from = (message.from as Mailbox | undefined)?.address?.toLowerCase();
  if (!from || !/^[^@\s]+@[^@\s]+$/.test(from)) return { dropped: "no_from" };
  const skipped = automatic(message, from, domain.toLowerCase());
  return skipped ? { dropped: skipped } : { from };
}

/** What the host proved about a received message: the From address (`direct`), or a forwarder that passed it on. */
export interface EmailProof {
  direct: boolean;
  /** A forwarder the envelope proves, when it is not the From's own domain (that is a direct message, or none). */
  forwarder?: Forwarder;
}

/** A forwarder that counts as one: not the From's own domain (its From is what it proves) and not this domain. */
export function forwardingProof(proven: Forwarder | undefined, from: string, domain: string): Forwarder | undefined {
  return proven && !vouches(proven.domain, domainOf(from)) && !vouches(domain.toLowerCase(), proven.domain) ? proven : undefined;
}

/**
 * Hand a received message to every email channel it is addressed to. `recipients` are the envelope's; `stored`
 * names where the raw message is kept when its attachments are read back later (else they ride inline, up to
 * `inlineBytes` each); `fallbackId` names a message that has no Message-ID of its own.
 */
export async function receiveEmail(channels: Channels, sql: Sql, input: {
  domain: string; message: Email; from: string; proof: EmailProof; recipients: string[];
  stored?: string; inlineBytes: number; fallbackId: string;
  log(fields: Record<string, unknown>): void;
}): Promise<void> {
  const { message, from, proof, log } = input;
  const domain = input.domain.toLowerCase();
  if (!proof.direct && !proof.forwarder) return log({ dropped: "unauthenticated" });
  const recipients = [...new Set(input.recipients.map(value => value.toLowerCase()).filter(value => value.endsWith(`@${domain}`)))];
  if (!recipients.length) return;
  const { rows } = await sql.query("select id from channels where channel->>'type' = 'email' and lower(channel->'settings'->>'address') = any($1)", [recipients]);
  const messageId = message.messageId ? messageIds(message.messageId)[0] ?? oneLine(message.messageId) : input.fallbackId;
  const earlier = [...messageIds(message.references), ...messageIds(message.inReplyTo)];
  const subject = oneLine(message.subject ?? "").slice(0, 500) || "(no subject)";
  const body = newText(message.text ?? (message.html ? readableText(message.html).text : ""));
  const content = `Subject: ${subject}\n\n${body.length > MAX_TEXT ? `${body.slice(0, MAX_TEXT)}\n(message truncated)` : body}`.trim();
  const files: InboundFile[] = attachmentsOf(message).map((attachment, index) => {
    const data = bytesOf(attachment.content);
    return {
      id: input.stored ? `${input.stored}#${index}` : `inline:${index}`, name: fileName(attachment.filename, index),
      size: data.length, contentType: attachment.mimeType, ...(!input.stored && data.length <= input.inlineBytes ? { content: toBase64(data) } : {}),
    };
  });
  const name = (message.from as Mailbox).name ? oneLine((message.from as Mailbox).name).slice(0, 200) : undefined;
  const sender: Sender = { id: from, username: from, ...(name ? { name } : {}) };
  const forwarder = proof.forwarder;

  for (const { id } of rows) {
    const found = await channels.lookup(id);
    if (!found) continue;
    const settings = (found.channel.settings ?? {}) as EmailSettings;
    // A forward counts only on a channel that names its forwarder; there the forwarder, not the From it carries, is who must be allowed.
    const forwarded = !!forwarder && (settings.forwarders ?? []).some(entry => forwarderMatches(entry, forwarder));
    if (!forwarded && !proof.direct) { log({ dropped: "unauthenticated", channel: id }); continue; }
    // A fixed reply address proves itself by writing to the channel, so nobody is mailed who did not ask to be.
    const replies = repliesOf(settings);
    if (!forwarded && replies !== "sender" && replies !== "none" && replies.to === from && found.channel.account.verifiedReplyTo !== from) {
      await sql.query("update channels set channel = jsonb_set(channel::jsonb, '{account,verifiedReplyTo}', to_jsonb($2::text))::json where id = $1 and channel->'settings'->'replies'->>'to' = $2", [id, from]);
      log({ verified: "reply_to", channel: id });
    }
    // Only allowed senders move a thread: its replies go to whoever wrote last.
    if (!channels.allowed(found.channel, forwarded ? { id: forwarder!.address, username: forwarder!.address } : sender)) { log({ dropped: "access", channel: id, ...(forwarded ? { forwarded: true } : {}) }); continue; }
    const text = forwarded ? `From (forwarded by ${forwarder!.address}, unverified): ${name ? `${name} <${from}>` : from}\n${content}` : content;
    const known = earlier.length
      ? (await sql.query("select conversation from email_messages where channel = $1 and message_id = any($2) limit 1", [id, earlier])).rows[0]?.conversation as string | undefined
      : undefined;
    const conversationId = known ?? sha(`${id}:${earlier[0] ?? messageId}`).slice(0, 40);
    const now = Date.now();
    // References: the root, then the most recent, ending with this message.
    const stored = (await sql.query("select refs from email_threads where conversation = $1", [conversationId])).rows[0]?.refs as string[] | undefined;
    const all = [...new Set([...stored ?? earlier, messageId])];
    const refs = all.length > MAX_REFERENCES ? [all[0]!, ...all.slice(all.length - MAX_REFERENCES + 1)] : all;
    await sql.query(`
      insert into email_threads (conversation, channel, reply_to, subject, refs, last_message, updated_at, forwarded) values ($1, $2, $3, $4, $5, $6, $7, $8)
      on conflict (conversation) do update set reply_to = excluded.reply_to, refs = excluded.refs, last_message = excluded.last_message, updated_at = excluded.updated_at, forwarded = excluded.forwarded`,
      [conversationId, id, from, subject, JSON.stringify(refs), messageId, now, forwarded]);
    await sql.query("insert into email_messages (channel, message_id, conversation, created_at) values ($1, $2, $3, $4) on conflict do nothing", [id, messageId, conversationId, now]);
    log({ accepted: forwarded ? "forwarded" : "direct", channel: id });
    // The forwarder was checked against the allowlist above; the sender it carries is on nobody's.
    await channels.inbound(id, { conversationId, messageId, sender, text, files, title: subject.slice(0, 100), ...(known ? { followUp: true } : {}), ...(forwarded ? { trusted: true, unverified: true } : {}) });
  }
}
