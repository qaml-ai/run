import { domainOf, forwarderOf, forwardingProof, parseMail, attachmentsOf, bytesOf, receiveEmail, senderOf, vouches } from "../../../src/core/channels/email.ts";
import { dohLookup, verifyDkim } from "../../../src/core/channels/dkim.ts";
import { sha256, toHex } from "../../../src/core/channels/crypto.ts";
import type { Env } from "./agent-types.ts";
import { STORED_MAIL_PREFIX, workerChannels } from "./channels.ts";
import { withSql } from "./postgres.ts";
import { safeError } from "./observability.ts";

/**
 * Email channels' inbound mail on Workers: Cloudflare Email Routing hands each message for the
 * channel domain (a catch-all rule, "Send to a Worker") to this handler. The handler parses the
 * MIME (postal-mime), proves who sent it, and gives it to src/core/channels/email.ts, which
 * finds the channel by its address, threads the conversation by Message-ID, In-Reply-To and
 * References, and records the message as ECS does.
 *
 * Email Routing hands the Worker no SPF or DMARC verdicts, so the proof is DKIM, checked here:
 * a valid signature by the From's domain (or one above it) proves the From address. Mail a
 * trusted forwarder passes on is proven by a valid signature of the envelope sender's domain,
 * the forwarder's (the envelope sender is the forwarder's address, as a forward rewrites it).
 * Mail with neither is dropped, as SES-unproven mail is on ECS.
 *
 * Mail is acknowledged once recorded: a throw here makes Email Routing refuse the message with a
 * temporary failure, so the sending server retries, and a retry is deduplicated by its Message-ID.
 */

type EmailEnv = Env & { AGENT_EMAIL_DOMAIN?: string; AGENT_EMAIL_DNS_URL?: string; TEST_MODE?: string };

/** Email Routing's own limit is 25 MiB a message. */
const MAX_RAW_BYTES = 25 * 1024 * 1024;
/** Attachments up to this ride inline in the channel item; the raw message of one with larger ones is kept in R2 and read back. */
const MAX_INLINE_BYTES = 256 * 1024;

async function readRaw(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array | undefined> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.length;
    if (bytes > limit) { await reader.cancel(); return undefined; }
    chunks.push(next.value);
  }
  const raw = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
  return raw;
}

/** The TXT lookups DKIM keys come from: Cloudflare's DNS-over-HTTPS, or a loopback fake in tests. */
function lookup(env: EmailEnv) {
  const endpoint = env.AGENT_EMAIL_DNS_URL;
  if (endpoint && env.TEST_MODE !== "1") throw new Error("AGENT_EMAIL_DNS_URL is for tests");
  return dohLookup(((input: string, init?: RequestInit) => fetch(input, init)) as typeof fetch, endpoint || undefined);
}

export async function receiveChannelEmail(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
  const config = env as EmailEnv;
  const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ type: "email_inbound", ...fields }));
  const domain = config.AGENT_EMAIL_DOMAIN?.toLowerCase();
  if (!domain) { message.setReject("This address receives no mail"); return; }
  if (message.rawSize > MAX_RAW_BYTES) { message.setReject("Message too large"); return; }
  const raw = await readRaw(message.raw, MAX_RAW_BYTES);
  if (!raw) { message.setReject("Message too large"); return; }
  const id = toHex(await sha256(raw)).slice(0, 32);
  try {
    const parsed = await parseMail(raw);
    const found = senderOf(parsed, domain);
    if ("dropped" in found) return log({ dropped: found.dropped, mail: id });
    const { from } = found;
    const dkim = await verifyDkim(raw, lookup(config));
    const direct = dkim.passed.some(signer => vouches(signer, domainOf(from)));
    // The envelope sender is the forwarder when a forward rewrote it (SRS, Google's +caf_ addresses); its domain's signature proves it.
    const envelope = forwarderOf(message.from);
    const proven = envelope && dkim.passed.some(signer => vouches(signer, envelope.domain)) ? envelope : undefined;
    // Why no signature proved anything, apart from the decision lines ECS logs too.
    if (!direct && !proven) console.log(JSON.stringify({ type: "channel_mail_dkim", failed: dkim.failed.slice(0, 5), mail: id }));
    // Attachments too large to ride in the item: the raw message is kept, and they are read back from it.
    let stored: string | undefined;
    if (attachmentsOf(parsed).some(attachment => bytesOf(attachment.content).length > MAX_INLINE_BYTES)) {
      const key = `${STORED_MAIL_PREFIX}${id}`;
      await env.BUCKET.put(key, raw, { httpMetadata: { contentType: "message/rfc822" } });
      stored = `r2:${key}`;
    }
    const channels = await workerChannels(env, work => ctx.waitUntil(work));
    await receiveEmail(channels, { query: (text, values) => withSql(env, sql => sql.query(text, values as unknown[])) }, {
      domain, message: parsed, from, proof: { direct, forwarder: forwardingProof(proven, from, domain) },
      recipients: [message.to], ...(stored ? { stored } : {}), inlineBytes: MAX_INLINE_BYTES, fallbackId: `${id}@${domain}`,
      log: fields => log({ ...fields, mail: id }),
    });
  } catch (error) {
    console.error(JSON.stringify({ type: "email_inbound_failed", mail: id, error: safeError(error) }));
    throw error;
  }
}
