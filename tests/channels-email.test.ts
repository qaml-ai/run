import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PostalMime from "postal-mime";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { Definitions } from "../src/definitions.ts";
import { Channels } from "../src/channels.ts";
import { email, emailReceiver, newText, type EmailOptions } from "../src/channels-email.ts";
import { testDatabase } from "./database.ts";
import { memoryFiles } from "./channel-files.ts";

type T = { after(fn: () => Promise<void> | void): void };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const DOMAIN = "in.example.test";
const TOPIC = "arn:aws:sns:us-west-2:123456789012:agent-email";
const CERT_URL = "https://sns.us-west-2.amazonaws.com/SimpleNotificationService-fixture.pem";
const BUCKET = "fixture-mail";

// One signing certificate for the file: the receiver caches certificates by URL.
const dir = mkdtempSync(join(tmpdir(), "sns-cert-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-subj", "/CN=sns.amazonaws.com", "-days", "2"], { stdio: "ignore" });
const KEY = createPrivateKey(readFileSync(join(dir, "key.pem")));
const CERT = readFileSync(join(dir, "cert.pem"), "utf8");
rmSync(dir, { recursive: true, force: true });

async function until<V>(check: () => V | Promise<V>, what: string, timeoutMs = 10_000): Promise<Exclude<V, false | 0 | "" | null | undefined>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as Exclude<V, false | 0 | "" | null | undefined>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** Sign an SNS message as SNS does, over its fields in order. */
function signed(message: Record<string, string>, version = "2", key = KEY) {
  const fields = message.Type === "Notification"
    ? ["Message", "MessageId", ...(message.Subject !== undefined ? ["Subject"] : []), "Timestamp", "TopicArn", "Type"]
    : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  const text = fields.map(field => `${field}\n${message[field]}\n`).join("");
  return { SigningCertURL: CERT_URL, ...message, SignatureVersion: version, Signature: sign(version === "2" ? "sha256" : "sha1", Buffer.from(text), key).toString("base64") };
}

interface Mail {
  from: string; fromName?: string; to?: string; subject?: string; messageId?: string; inReplyTo?: string; references?: string[];
  text?: string; headers?: string[]; attachment?: { name: string; type: string; data: Buffer };
}
function mime(mail: Mail) {
  const head = [
    `From: ${mail.fromName ? `${mail.fromName} <${mail.from}>` : mail.from}`, `To: ${mail.to ?? `support@${DOMAIN}`}`, `Subject: ${mail.subject ?? "Invoice"}`,
    `Message-ID: <${mail.messageId ?? `${randomUUID()}@example.com`}>`, "Date: Mon, 28 Sep 2026 15:00:00 +0000",
    ...(mail.inReplyTo ? [`In-Reply-To: <${mail.inReplyTo}>`] : []), ...(mail.references ? [`References: ${mail.references.map(id => `<${id}>`).join(" ")}`] : []),
    ...(mail.headers ?? []), "MIME-Version: 1.0",
  ];
  const text = mail.text ?? "Hello";
  if (!mail.attachment) return [...head, "Content-Type: text/plain; charset=utf-8", "", text].join("\r\n");
  const boundary = "FIXTURE-BOUNDARY";
  return [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", `--${boundary}`, "Content-Type: text/plain; charset=utf-8", "", text,
    `--${boundary}`, `Content-Type: ${mail.attachment.type}; name="${mail.attachment.name}"`, `Content-Disposition: attachment; filename="${mail.attachment.name}"`,
    "Content-Transfer-Encoding: base64", "", mail.attachment.data.toString("base64").replace(/.{76}/g, "$&\r\n"), `--${boundary}--`, ""].join("\r\n");
}

interface Receipt {
  recipients?: string[]; source?: string; authResults?: string;
  spf?: string; dkim?: string; dmarc?: string; spam?: string; s3Key?: string; bucket?: string;
}
/** SES's notification of a received message, its content inline (or in S3). */
function ses(raw: string, receipt: Receipt = {}) {
  return {
    notificationType: "Received",
    mail: {
      messageId: randomBytes(8).toString("hex"), source: receipt.source ?? "bounces@example.com",
      headers: receipt.authResults ? [{ name: "Authentication-Results", value: receipt.authResults }] : [],
    },
    receipt: {
      recipients: receipt.recipients ?? [`support@${DOMAIN}`],
      spfVerdict: { status: receipt.spf ?? "GRAY" }, dkimVerdict: { status: receipt.dkim ?? "GRAY" }, dmarcVerdict: { status: receipt.dmarc ?? "PASS" },
      spamVerdict: { status: receipt.spam ?? "PASS" }, virusVerdict: { status: "PASS" },
      action: receipt.s3Key ? { type: "S3", bucketName: receipt.bucket ?? BUCKET, objectKey: receipt.s3Key, topicArn: TOPIC } : { type: "SNS", encoding: "BASE64", topicArn: TOPIC },
    },
    ...(receipt.s3Key ? {} : { content: Buffer.from(raw).toString("base64") }),
  };
}

async function setup(t: T) {
  const { db } = await testDatabase();
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db, secretsKey: randomBytes(32).toString("hex") });
  const prompts: { agent: string; text: string; from?: any; files?: { path: string }[] }[] = [];
  const sent: { from: string; to: string[]; raw: Uint8Array }[] = [];
  const fetched: string[] = [];
  const objects = new Map<string, Buffer>();
  const workspace = memoryFiles();
  const options: EmailOptions = {
    db, domain: DOMAIN, topics: [TOPIC], bucket: BUCKET,
    send: async message => { sent.push(message); },
    getObject: async (bucket, key) => { const data = objects.get(`${bucket}/${key}`); if (!data) throw new Error("NoSuchKey"); return data; },
    fetch: (async (input: string | URL) => {
      const url = String(input);
      fetched.push(url);
      if (url === CERT_URL) return new Response(CERT);
      if (url.startsWith("https://sns.us-west-2.amazonaws.com/?Action=ConfirmSubscription")) return new Response("<ConfirmSubscriptionResponse/>");
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
  };
  const channels: Channels = new Channels({
    db, definitions: new Definitions({ db }), accounts, node: "a", publicUrl: "https://agents.example.test", files: workspace.files,
    providers: { email: email(options) },
    createAgent: async (_tenant, _params, key) => ({ id: `client_${sha(key).slice(0, 40)}` }), agentId: (_tenant, key) => `client_${sha(key).slice(0, 40)}`, live: async () => true,
    submit: async (agent, tenant, request) => {
      const params = request.params as { text: string; from?: unknown; files?: { path: string }[] };
      prompts.push({ agent, text: params.text, from: params.from, ...(params.files ? { files: params.files } : {}) });
      setImmediate(() => channels.hooks.runEnded!({ id: agent, tenant }, {
        id: request.id, method: "prompt", fingerprint: "", state: "completed", outcome: { result: { reply: `re: ${params.text.split("\n").at(-1)}` } },
      }));
      return { id: request.id, method: "prompt", fingerprint: "", state: "running" };
    },
  });
  const receiver = emailReceiver(channels, options);
  const post = async (message: object) => (await receiver.request("/channels/email/inbound", { method: "POST", headers: { "Content-Type": "text/plain; charset=UTF-8" }, body: JSON.stringify(message) })).status;
  /** SES's notification of a message, through SNS. */
  const deliver = (mail: Mail, receipt: Receipt = {}) => post(signed({
    Type: "Notification", MessageId: randomUUID(), TopicArn: TOPIC, Subject: "Amazon SES Email Receipt Notification",
    Message: JSON.stringify(ses(mime(mail), receipt)), Timestamp: new Date().toISOString(),
  }));
  const mails = () => Promise.all(sent.map(async message => ({ ...message, parsed: await PostalMime.parse(message.raw) })));
  return { db, channels, prompts, sent, mails, fetched, objects, post, deliver, workspace };
}

test("email channels need no credentials and take a unique address on the runtime's domain", async t => {
  const r = await setup(t);
  const plain = await r.channels.create("default", { type: "email" });
  assert.deepEqual(plain.settings, { address: `${plain.id}@${DOMAIN}` });
  assert.equal(plain.webhookUrl, undefined, "mail arrives at the shared route, not a channel's own");
  const support = await r.channels.create("default", { type: "email", settings: { address: "Support", fromName: "Acme Support" } });
  assert.deepEqual(support.settings, { address: `support@${DOMAIN}`, fromName: "Acme Support" });
  await assert.rejects(r.channels.create("other", { type: "email", settings: { address: `SUPPORT@${DOMAIN}` } }), { status: 409 });
  for (const address of ["postmaster", "x@elsewhere.com", "-bad", "ch_0123456789abcdef0123", "a b"]) {
    await assert.rejects(r.channels.create("default", { type: "email", settings: { address } }), { status: 400 }, address);
  }
  await assert.rejects(r.channels.create("default", { type: "email", settings: { replyUrl: "https://x" } }), { status: 400 });
  const renamed = await r.channels.update("default", support.id, { settings: { address: "help" } });
  assert.deepEqual(renamed.settings, { address: `help@${DOMAIN}`, fromName: "Acme Support" });
  // Its old address is free again.
  assert.equal((await r.channels.create("default", { type: "email", settings: { address: "support" } })).settings?.address, `support@${DOMAIN}`);
});

test("SNS messages must be signed by SNS for the configured topic; a subscription is confirmed", async t => {
  const r = await setup(t);
  const subscribe = `https://sns.us-west-2.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${TOPIC}&Token=abc`;
  const confirmation = { Type: "SubscriptionConfirmation", MessageId: randomUUID(), Token: "abc", TopicArn: TOPIC, Message: "You have chosen to subscribe", SubscribeURL: subscribe, Timestamp: new Date().toISOString() };
  assert.equal(await r.post(signed(confirmation)), 200);
  assert.ok(r.fetched.includes(subscribe), "the subscription is confirmed");

  assert.equal(await r.post({ ...signed(confirmation), Message: "tampered" }), 401);
  assert.equal(await r.post(signed({ ...confirmation, TopicArn: "arn:aws:sns:us-west-2:999:other" })), 403);
  const elsewhere = { ...signed(confirmation), SigningCertURL: "https://evil.example.com/SimpleNotificationService.pem" };
  assert.equal(await r.post(elsewhere), 401);
  assert.ok(!r.fetched.some(url => url.startsWith("https://evil.")), "a certificate is only fetched from SNS");
  const otherKey = createPrivateKey(execFileSync("openssl", ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048"], { stdio: ["ignore", "pipe", "ignore"] }));
  assert.equal(await r.post(signed(confirmation, "2", otherKey)), 401);
  assert.equal(await r.post(signed({ ...confirmation, SubscribeURL: "https://evil.example.com/confirm" })), 400);
  assert.ok(!r.fetched.some(url => url.startsWith("https://evil.")));
  assert.equal(await r.post(signed({ ...confirmation, Timestamp: new Date(Date.now() - 2 * 86_400_000).toISOString() })), 400, "an old message is a replay");
  // Version 1 signatures (SHA1) still verify.
  assert.equal(await r.post(signed({ ...confirmation, MessageId: randomUUID() }, "1")), 200);
});

test("a message starts a thread; replies thread under it, quoted history is left out, attachments are saved", async t => {
  const r = await setup(t);
  const channel = await r.channels.create("default", { type: "email", settings: { address: "support", fromName: "Acme" }, access: { allow: ["ada@example.com"] } });
  const status = await r.deliver({
    from: "Ada@Example.com", fromName: "Ada Lovelace", messageId: "m1@example.com", subject: "Invoice 42",
    text: "Can you check the invoice?\r\n\r\nOn Mon, Sep 28, 2026 at 3:00 PM Bob <bob@example.com>\r\nwrote:\r\n> the old thread\r\n> more",
    attachment: { name: "invoice.txt", type: "text/plain", data: Buffer.from("total: 42") },
  });
  assert.equal(status, 200);
  const first = await until(() => r.prompts[0], "the first prompt");
  assert.equal(first.text, "Subject: Invoice 42\n\nCan you check the invoice?");
  assert.deepEqual(first.from, { id: "email:ada@example.com", name: "Ada Lovelace", username: "ada@example.com" });
  assert.equal(first.files?.length, 1);
  assert.equal(r.workspace.saved.get(first.files![0].path)?.data.toString(), "total: 42");

  const [reply] = await until(async () => r.sent.length === 1 && await r.mails(), "the reply");
  assert.equal(reply.from, `support@${DOMAIN}`);
  assert.deepEqual(reply.to, ["ada@example.com"]);
  assert.equal(reply.parsed.subject, "Re: Invoice 42");
  assert.deepEqual(reply.parsed.from, { address: `support@${DOMAIN}`, name: "Acme" });
  assert.equal(reply.parsed.inReplyTo, "<m1@example.com>");
  assert.equal(reply.parsed.references, "<m1@example.com>");
  assert.equal(reply.parsed.text?.trim(), "re: Can you check the invoice?");
  assert.equal(reply.parsed.headers.find(header => header.key === "auto-submitted")?.value, "auto-replied");
  assert.ok(reply.parsed.messageId?.endsWith(`@${DOMAIN}>`));

  // Ada answers our reply; her client names only the message it answers.
  await r.deliver({ from: "ada@example.com", messageId: "m2@example.com", subject: "Re: Invoice 42", inReplyTo: reply.parsed.messageId!.slice(1, -1), text: "Thanks!\n> re: Can you check" });
  const second = await until(() => r.prompts[1], "the second prompt");
  assert.equal(second.agent, first.agent, "the reply reaches the thread's agent");
  assert.equal(second.text, "Subject: Re: Invoice 42\n\nThanks!");
  const [, again] = await until(async () => r.sent.length === 2 && await r.mails(), "the second reply");
  assert.equal(again.parsed.inReplyTo, "<m2@example.com>");
  assert.equal(again.parsed.references, "<m1@example.com> <m2@example.com>");

  // SNS delivers at least once: the same message again is dropped.
  await r.deliver({ from: "ada@example.com", messageId: "m2@example.com", subject: "Re: Invoice 42", inReplyTo: "m1@example.com", text: "Thanks!" });
  // A new message is a new thread, with an agent of its own.
  await r.deliver({ from: "ada@example.com", messageId: "m3@example.com", subject: "Another thing", text: "New topic" });
  const third = await until(() => r.prompts[2], "the new thread's prompt");
  assert.notEqual(third.agent, first.agent);
  await sleep(200);
  assert.equal(r.prompts.length, 3);
  assert.equal((await r.db.query("select count(*)::int as count from email_threads where channel = $1", [channel.id])).rows[0].count, 2);
});

test("mail is dropped unless SES proves its sender, and automatic or bulk mail never reaches an agent", async t => {
  const r = await setup(t);
  await r.channels.create("default", { type: "email", settings: { address: "support" }, access: { allow: ["ada@example.com", "@example.org"] } });
  const ada = { from: "ada@example.com" };
  const drops: [string, Mail, Receipt][] = [
    ["DMARC failed", ada, { dmarc: "FAIL", spf: "PASS", source: "ada@example.com" }],
    ["spam", ada, { spam: "FAIL" }],
    ["SPF passed for another domain", ada, { dmarc: "GRAY", spf: "PASS", source: "x@attacker.com" }],
    ["DKIM passed for another domain", ada, { dmarc: "GRAY", dkim: "PASS", authResults: "amazonses.com; dkim=pass header.i=@attacker.com" }],
    ["DKIM results the sender wrote", ada, { dmarc: "GRAY", dkim: "PASS", authResults: "mx.attacker.com; dkim=pass header.i=@example.com" }],
    // SES adds no Authentication-Results of its own, so even one naming amazonses.com may be the sender's.
    ["DKIM without DMARC", ada, { dmarc: "GRAY", dkim: "PASS", authResults: "amazonses.com; spf=fail smtp.mailfrom=x.net; dkim=pass header.i=@example.com; dmarc=none" }],
    ["an auto-reply", { ...ada, headers: ["Auto-Submitted: auto-replied"] }, {}],
    ["bulk mail", { ...ada, headers: ["Precedence: bulk"] }, {}],
    ["a bounce", { from: "MAILER-DAEMON@example.com" }, {}],
    ["mail from this domain", { from: `other@${DOMAIN}` }, {}],
    ["someone not allowed", { from: "eve@example.com" }, {}],
    ["mail to no channel", ada, { recipients: [`nobody@${DOMAIN}`] }],
  ];
  for (const [what, mail, receipt] of drops) assert.equal(await r.deliver({ ...mail, text: what }, receipt), 200, what);
  // Proven senders are let in: DMARC passed, SPF for the From domain, and anyone at an allowed domain.
  await r.deliver({ ...ada, text: "spf" }, { dmarc: "GRAY", spf: "PASS", source: "bounce@example.com" });
  await r.deliver({ from: "carol@example.org", text: "domain" });
  await until(() => r.prompts.length === 2, "the proven messages");
  await sleep(300);
  assert.deepEqual(r.prompts.map(prompt => prompt.text.split("\n").at(-1)).sort(), ["domain", "spf"]);
});

test("mail SES stored in S3 is read from there, and so are its attachments", async t => {
  const r = await setup(t);
  await r.channels.create("default", { type: "email", settings: { address: "support" }, access: { public: true } });
  const big = randomBytes(300 * 1024);
  r.objects.set(`${BUCKET}/inbound/abc`, Buffer.from(mime({ from: "ada@example.com", text: "See attached", attachment: { name: "data.bin", type: "application/octet-stream", data: big } })));
  assert.equal(await r.deliver({ from: "unused@example.com" }, { s3Key: "inbound/abc" }), 200);
  const prompt = await until(() => r.prompts[0], "the prompt");
  assert.equal(prompt.text, "Subject: Invoice\n\nSee attached");
  assert.ok(r.workspace.saved.get(prompt.files![0].path)!.data.equals(big));
  const item = await r.db.query("select count(*)::int as count from channel_items where item::text like '%\"content\"%'");
  assert.equal(item.rows[0].count, 0, "attachments are not copied into the item");
  // Another bucket is not read.
  assert.equal(await r.deliver({ from: "ada@example.com" }, { s3Key: "inbound/abc", bucket: "someone-elses" }), 200);
  await sleep(200);
  assert.equal(r.prompts.length, 1);
  // A missing object is SNS's to retry.
  assert.equal(await r.deliver({ from: "ada@example.com" }, { s3Key: "inbound/missing" }), 500);
});

test("quoted history is cut at the usual markers", () => {
  assert.equal(newText("Yes.\n\nOn Tue, 29 Sep 2026, Ada <a@b.c> wrote:\n> earlier"), "Yes.");
  assert.equal(newText("Sure\r\n-----Original Message-----\r\nFrom: x"), "Sure");
  assert.equal(newText("Top\n________________________________\nFrom: someone"), "Top");
  assert.equal(newText("> quoted\nmine\n>> deeper"), "mine");
  assert.equal(newText("One day in October\nwe wrote: a plan"), "One day in October\nwe wrote: a plan");
});
