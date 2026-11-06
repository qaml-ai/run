import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listen, type T } from "../http.ts";

/**
 * Inbound mail for email channel cases, as each backend receives it.
 *
 * ECS: SES receives the mail, judges it (SPF, DKIM, DMARC, spam) and publishes it to SNS, which posts a
 * signed notification to /channels/email/inbound. The fixture signs notifications with its own SNS
 * certificate, which the runtime fetches through fixtures/sns-fetch.mjs (a test-only preload).
 *
 * Workers: Cloudflare Email Routing hands the raw message to the Email Worker (`email()`), which proves
 * the sender with DKIM. The fixture translates SES's verdicts into what would prove the same thing: a
 * DKIM signature by the From's domain where SES would prove the From (DMARC, or SPF for its domain), and
 * by the envelope sender's domain where SES's SPF would prove a forwarder. Keys are published by a local
 * DNS-over-HTTPS stand-in (AGENT_EMAIL_DNS_URL). Mail is posted to workerd's local email trigger.
 */
export type Receipt = {
  recipients?: string[]; source?: string; authResults?: string;
  spf?: string; dkim?: string; dmarc?: string; spam?: string;
};
export const EMAIL_TOPIC = "arn:aws:sns:us-west-2:123456789012:agent-email";
export const SNS_CERT_URL = "https://sns.us-west-2.amazonaws.com/SimpleNotificationService-fixture.pem";
const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase();
const vouches = (proven: string, from: string) => proven.includes(".") && (from === proven || from.endsWith(`.${proven}`));
const fromOf = (raw: string) => /^From:.*?<?([^<>\s]+@[^<>\s]+?)>?\s*$/im.exec(raw)?.[1]?.toLowerCase() ?? "";

/** ECS's side: an SNS signing certificate the runtime will fetch, and SES notifications signed with it. */
export function snsSigner() {
  const dir = mkdtempSync(join(tmpdir(), "sns-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-subj", "/CN=sns.amazonaws.com", "-days", "2"], { stdio: "ignore" });
  const key = createPrivateKey(readFileSync(join(dir, "key.pem")));
  const certFile = join(dir, "cert.pem");
  const signed = (message: Record<string, string>) => {
    const fields = ["Message", "MessageId", ...(message.Subject !== undefined ? ["Subject"] : []), "Timestamp", "TopicArn", "Type"];
    const text = fields.map(field => `${field}\n${message[field]}\n`).join("");
    return { SigningCertURL: SNS_CERT_URL, ...message, SignatureVersion: "2", Signature: sign("sha256", Buffer.from(text), key).toString("base64") };
  };
  const notification = (raw: string, receipt: Receipt, domain: string) => signed({
    Type: "Notification", MessageId: randomUUID(), TopicArn: EMAIL_TOPIC, Subject: "Amazon SES Email Receipt Notification", Timestamp: new Date().toISOString(),
    Message: JSON.stringify({
      notificationType: "Received",
      mail: { messageId: randomBytes(8).toString("hex"), source: receipt.source ?? "bounces@example.com", headers: receipt.authResults ? [{ name: "Authentication-Results", value: receipt.authResults }] : [] },
      receipt: {
        recipients: receipt.recipients ?? [`support@${domain}`],
        spfVerdict: { status: receipt.spf ?? "GRAY" }, dkimVerdict: { status: receipt.dkim ?? "GRAY" }, dmarcVerdict: { status: receipt.dmarc ?? "PASS" },
        spamVerdict: { status: receipt.spam ?? "PASS" }, virusVerdict: { status: "PASS" },
        action: { type: "SNS", encoding: "BASE64", topicArn: EMAIL_TOPIC },
      },
      content: Buffer.from(raw).toString("base64"),
    }),
  });
  return { certFile, notification, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Workers' side: DKIM keys per domain, published by a local DNS-over-HTTPS stand-in. */
export async function dkimSigner(t: T) {
  const keys = new Map<string, KeyObject>();
  const records = new Map<string, string>();
  const keyFor = (domain: string) => {
    let key = keys.get(domain);
    if (!key) {
      const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
      key = pair.privateKey;
      keys.set(domain, key);
      const spki = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
      records.set(`fixture._domainkey.${domain}`, `v=DKIM1; k=rsa; p=${spki}`);
    }
    return key;
  };
  const url = await listen(t, (req, res) => {
    const query = new URL(req.url!, "http://dns").searchParams;
    const record = records.get((query.get("name") ?? "").toLowerCase());
    const answer = record ? [{ name: query.get("name"), type: 16, TTL: 60, data: `"${record.match(/.{1,250}/g)!.join('" "')}"` }] : [];
    res.writeHead(200, { "Content-Type": "application/dns-json" }).end(JSON.stringify({ Status: record ? 0 : 3, Answer: answer }));
  });
  /** `raw` signed by `domain` (relaxed/relaxed, rsa-sha256), the signature prepended. */
  const signWith = (raw: string, domain: string) => {
    const normalized = raw.replace(/\r?\n/g, "\r\n");
    const split = normalized.indexOf("\r\n\r\n");
    const head = normalized.slice(0, split + 2), body = normalized.slice(split + 4);
    const relaxedBody = body.split("\r\n").map(line => line.replace(/[ \t]+/g, " ").replace(/ $/, "")).join("\r\n").replace(/(\r\n)*$/, "");
    const bh = createHash("sha256").update(relaxedBody ? `${relaxedBody}\r\n` : "").digest("base64");
    const headers = head.split(/\r\n(?=[^ \t])/).filter(Boolean).map(line => line.replace(/\r\n$/, ""));
    const names = ["from", "to", "subject", "date", "message-id"].filter(name => headers.some(line => line.toLowerCase().startsWith(`${name}:`)));
    const relaxed = (line: string) => `${line.slice(0, line.indexOf(":")).trim().toLowerCase()}:${line.slice(line.indexOf(":") + 1).replace(/\r\n/g, "").replace(/[ \t]+/g, " ").trim()}`;
    const used = new Map<string, string[]>();
    for (const line of headers) { const name = line.slice(0, line.indexOf(":")).trim().toLowerCase(); used.set(name, [...used.get(name) ?? [], line]); }
    const signedLines = names.map(name => relaxed(used.get(name)!.pop()!));
    const unsigned = `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=${domain}; s=fixture; t=${Math.floor(Date.now() / 1000)}; h=${names.join(":")}; bh=${bh}; b=`;
    const data = [...signedLines.map(line => `${line}\r\n`), relaxed(unsigned)].join("");
    const b = sign("sha256", Buffer.from(data), keyFor(domain)).toString("base64");
    return `${unsigned}${b}\r\n${normalized}`;
  };
  /** The message as Email Routing would hand it over, signed where SES would have proven its sender or its forwarder. */
  const prepare = (raw: string, receipt: Receipt) => {
    const from = fromOf(raw), fromDomain = domainOf(from);
    const failed = [receipt.dmarc, receipt.spam].some(verdict => verdict?.toUpperCase() === "FAIL");
    const source = (receipt.source ?? "bounces@example.com").trim().toLowerCase();
    const spf = receipt.spf?.toUpperCase() === "PASS" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(source);
    const direct = !failed && ((receipt.dmarc ?? "PASS").toUpperCase() === "PASS" || (spf && vouches(domainOf(source), fromDomain)));
    const forwarder = spf && receipt.spam?.toUpperCase() !== "FAIL";
    let signed = raw;
    if (forwarder && domainOf(source) !== fromDomain) signed = signWith(signed, domainOf(source));
    if (direct) signed = signWith(signed, fromDomain);
    // The envelope sender: the forwarder's where SPF vouched for one; otherwise the From (SES's default bounce address proves nothing).
    return { raw: signed, envelope: spf ? source : from || "unknown@example.com" };
  };
  return { url, prepare };
}
