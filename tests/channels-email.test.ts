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
import { Decider } from "../src/decisions.ts";
import { Channels, type ChannelsOptions } from "../src/channels.ts";
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

async function setup(t: T, extra: Partial<ChannelsOptions> = {}) {
  const { db } = await testDatabase();
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db, secretsKey: randomBytes(32).toString("hex") });
  const prompts: { agent: string; text: string; from?: any; files?: { path: string }[] }[] = [];
  const sent: { from: string; to: string[]; raw: Uint8Array }[] = [];
  const fetched: string[] = [];
  const objects = new Map<string, Buffer>();
  const workspace = memoryFiles();
  /** What a turn ends with (default: a reply echoing the message's last line), and the inputs the agent waits on. */
  const state: { outcome?: (text: string) => object; pending: any[]; answers: any[] } = { pending: [], answers: [] };
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
        id: request.id, method: "prompt", fingerprint: "", state: "completed", outcome: (state.outcome?.(params.text) as { result: { reply: string } } | undefined) ?? { result: { reply: `re: ${params.text.split("\n").at(-1)}` } },
      }));
      return { id: request.id, method: "prompt", fingerprint: "", state: "running" };
    },
    inputs: { pending: async () => state.pending, answer: async (_agent, _tenant, input, answer) => { state.answers.push({ input, answer }); state.pending = []; } },
    ...extra,
  });
  const receiver = emailReceiver(channels, options);
  const post = async (message: object) => (await receiver.request("/channels/email/inbound", { method: "POST", headers: { "Content-Type": "text/plain; charset=UTF-8" }, body: JSON.stringify(message) })).status;
  /** SES's notification of a message, through SNS. */
  const deliver = (mail: Mail, receipt: Receipt = {}) => post(signed({
    Type: "Notification", MessageId: randomUUID(), TopicArn: TOPIC, Subject: "Amazon SES Email Receipt Notification",
    Message: JSON.stringify(ses(mime(mail), receipt)), Timestamp: new Date().toISOString(),
  }));
  const mails = () => Promise.all(sent.map(async message => ({ ...message, parsed: await PostalMime.parse(message.raw) })));
  /** Resolves once the channel's queue is empty: everything received was answered, sent or dropped. */
  const drained = () => until(async () => (await db.query("select count(*)::int as count from channel_items")).rows[0].count === 0, "the queue to drain");
  return { db, channels, prompts, sent, mails, fetched, objects, post, deliver, workspace, state, drained };
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

test("a filter judges a new email, with its from, subject and body; a reply in a thread with an agent is not judged, and a reply to a filtered one is", async t => {
  const asked: any[] = [];
  const r = await setup(t, { decisions: {
    decider: new Decider({
      provider: { id: "openrouter", async decide(item, model) { asked.push(item.state); return { answers: { passes: { noul: (item.state as any).text.includes("Unsubscribe") ? 0.1 : 0.9 } }, model, inputTokens: 1, outputTokens: 1, costUsd: 0.00001 }; } },
      key: async () => ({ apiKey: "k", platform: false }),
    }),
    admit: async () => {}, record: () => {},
  } });
  const channel = await r.channels.create("default", { type: "email", settings: { address: "support" }, access: { public: true }, filter: { instructions: "A customer needs a reply", threshold: 0.7 } });
  await r.deliver({ from: "ada@example.com", fromName: "Ada", messageId: "c1@example.com", subject: "Broken", text: "It is broken" });
  await until(() => r.prompts[0], "the customer's prompt");
  assert.deepEqual(asked[0], { channel: "email", from: { id: "ada@example.com", name: "Ada", username: "ada@example.com" }, title: "Broken", text: "Subject: Broken\n\nIt is broken" });
  await r.deliver({ from: "ada@example.com", messageId: "c2@example.com", subject: "Re: Broken", inReplyTo: "c1@example.com", text: "Unsubscribe" });
  await until(() => r.prompts[1], "the reply in the thread");
  assert.equal(asked.length, 1, "a reply in a thread with an agent goes straight on");

  await r.deliver({ from: "news@example.com", messageId: "n1@example.com", subject: "Deals", text: "Unsubscribe" });
  await r.deliver({ from: "news@example.com", messageId: "n2@example.com", subject: "Re: Deals", inReplyTo: "n1@example.com", text: "Unsubscribe" });
  const events = await until(async () => { const page = await r.channels.events("default", channel.id, { outcome: "filtered" }); return page.events.length === 2 && page.events; }, "both filtered");
  assert.equal(asked.length, 3);
  assert.deepEqual(events.map(event => event.message?.from.id), ["news@example.com", "news@example.com"]);
  assert.equal(r.prompts.length, 2);
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

  // Deleting the channel deletes its threads' addresses, subjects and Message-IDs.
  await r.channels.remove("default", channel.id);
  for (const table of ["email_threads", "email_messages", "channel_seen", "channel_items"]) {
    assert.equal((await r.db.query(`select count(*)::int as count from ${table}`)).rows[0].count, 0, table);
  }
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

// Reply modes and forwarders ------------------------------------------------------

const ACME = "support+caf_=support=in.example.test@acme.com";
/** A message Acme's support mailbox forwarded on: the envelope is Acme's and passes SPF; the From is the customer's, which nothing proves. */
const forwardedReceipt = (receipt: Receipt = {}): Receipt => ({ dmarc: "GRAY", spf: "PASS", source: ACME, ...receipt });
const APPROVAL = { id: "inp_1", requestId: "req_1", kind: "approval", message: "", detail: { tool: "shop__refund", source: "shop", arguments: { id: "a" } } };

/**
 * Every way a channel sends mail, set off by `mail`: a turn's reply with a file, a file too large to
 * attach (a link) and a question the agent waits on; a failed turn's apology; send_message with a
 * file; a turn no message started (a schedule); and the notice to a sender over the rate limit.
 */
async function everyOutboundPath(r: Awaited<ReturnType<typeof setup>>, channel: string, mail: Mail, receipt: Receipt) {
  const before = r.prompts.length;
  r.state.outcome = () => ({ result: {
    reply: "Here is the draft.", inputs: [APPROVAL],
    presented: [r.workspace.present("/workspace/draft.txt", Buffer.from("draft"), "text/plain"), r.workspace.present("/workspace/big.bin", Buffer.alloc(0), "application/octet-stream", { size: 11 * 1024 * 1024 })],
  } });
  await r.deliver({ ...mail, messageId: `${randomUUID()}@customer.example`, text: "first" }, receipt);
  const { agent } = await until(() => r.prompts[before], "the turn");
  await r.drained();
  r.state.outcome = () => ({ error: "the model failed" });
  await r.deliver({ ...mail, messageId: `${randomUUID()}@customer.example`, text: "second" }, receipt);
  await until(() => r.prompts[before + 1], "the failed turn");
  await r.drained();
  r.state.outcome = undefined;
  const server = (await r.channels.hooks.server!({ id: agent, tenant: "default" }))!;
  r.workspace.saved.set("/workspace/notes.txt", { data: Buffer.from("notes"), contentType: "text/plain" });
  await server.call({ name: "send_message", args: { text: "Working on it", files: ["/workspace/notes.txt"] }, signal: new AbortController().signal } as never);
  r.channels.hooks.runEnded!({ id: agent, tenant: "default" }, { id: "schedule-1", method: "prompt", fingerprint: "", state: "completed", outcome: { result: { reply: "A scheduled note." } } });
  await sleep(100);
  await r.drained();
  // Over the per-sender limit: the first message past it is told so.
  await r.channels.update("default", channel, { limits: { perSenderPerMinute: 1 } });
  const hasty = { ...mail, from: `hasty@${mail.from.split("@")[1]}` };
  for (const text of ["one", "two"]) await r.deliver({ ...hasty, messageId: `${randomUUID()}@customer.example`, text }, receipt);
  await until(() => r.prompts[before + 2], "the hasty sender's turn");
  await sleep(200);
  await r.drained();
  return agent;
}

test("reply and forwarder settings are validated; forwarders need replies that never reach an unverified sender", async t => {
  const r = await setup(t);
  const create = (settings: Record<string, unknown>) => r.channels.create("default", { type: "email", settings });
  assert.deepEqual((await create({ address: "a1", replies: "sender" })).settings, { address: `a1@${DOMAIN}` }, "the default is not stored");
  assert.deepEqual((await create({ address: "a2", replies: "none" })).settings, { address: `a2@${DOMAIN}`, replies: "none" });
  assert.deepEqual((await create({ address: "a3", replies: { to: " Triage@Acme.com " } })).settings, { address: `a3@${DOMAIN}`, replies: { to: "triage@acme.com" } });
  const bad: Record<string, unknown>[] = [
    { replies: "everyone" }, { replies: { to: "not an address" } }, { replies: { to: "a@acme.com", cc: "b@acme.com" } }, { replies: { to: `other@${DOMAIN}` } }, { replies: ["a@acme.com"] },
    { forwarders: "support@acme.com" }, { forwarders: ["acme.com"] }, { forwarders: ["@nodot"] }, { forwarders: [`support@${DOMAIN}`] }, { forwarders: [`@sub.${DOMAIN}`] }, { forwarders: [7] },
    { forwarders: Array.from({ length: 21 }, (_, index) => `@d${index}.com`), replies: "none" }, { replyToForwarded: "yes" },
  ];
  for (const settings of bad) await assert.rejects(create(settings), { status: 400 }, JSON.stringify(settings));
  // Forwarded mail's sender is unverified: with the default replies it would be mailed.
  await assert.rejects(create({ forwarders: ["support@acme.com"] }), { status: 400, message: /settings\.replies.*"none".*replyToForwarded/ });
  await assert.rejects(create({ forwarders: ["support@acme.com"], replies: "sender" }), { status: 400 });
  await assert.rejects(create({ forwarders: ["support@acme.com"], replyToForwarded: false }), { status: 400 });
  const intake = await create({ address: "a4", forwarders: ["Support@Acme.com", "@acme.org", "support@acme.com"], replies: "none" });
  assert.deepEqual(intake.settings, { address: `a4@${DOMAIN}`, replies: "none", forwarders: ["support@acme.com", "@acme.org"] });
  // An update is held to the same rule, against the settings it would leave.
  await assert.rejects(r.channels.update("default", intake.id, { settings: { replies: "sender" } }), { status: 400 });
  assert.deepEqual((await r.channels.update("default", intake.id, { settings: { replies: { to: "triage@acme.com" } } })).settings?.replies, { to: "triage@acme.com" });
  assert.deepEqual((await r.channels.update("default", intake.id, { settings: { replies: "sender", replyToForwarded: true } })).settings,
    { address: `a4@${DOMAIN}`, forwarders: ["support@acme.com", "@acme.org"], replyToForwarded: true });
  await assert.rejects(r.channels.update("default", intake.id, { settings: { replyToForwarded: false } }), { status: 400 });
  assert.deepEqual((await r.channels.update("default", intake.id, { settings: { forwarders: [], replyToForwarded: false } })).settings, { address: `a4@${DOMAIN}` });
});

test("replies: none mails nobody, whatever the agent or the runtime has to say", async t => {
  const r = await setup(t);
  const channel = await r.channels.create("default", { type: "email", settings: { address: "support", replies: "none" }, access: { allow: ["@example.com"] } });
  await everyOutboundPath(r, channel.id, { from: "ada@example.com" }, {});
  assert.equal(r.prompts.length, 3, "the messages still reach the agent");
  assert.equal(r.sent.length, 0);
});

test("replies: { to } mails only that address, and only once it has written to the channel itself", async t => {
  const r = await setup(t);
  const channel = await r.channels.create("default", { type: "email", settings: { address: "support", replies: { to: "triage@acme.com" } }, access: { allow: ["@example.com"] } });
  const verified = async () => (await r.channels.get("default", channel.id)).account.verifiedReplyTo;
  await r.deliver({ from: "ada@example.com", messageId: "m1@example.com", subject: "Invoice 42", text: "before" });
  await until(() => r.prompts[0], "the first prompt");
  await r.drained();
  assert.equal(r.sent.length, 0, "an address that has not proven itself gets nothing, and neither does the sender");
  // Not proof: mail that only claims the address, its auto-reply, and a forwarder's copy of mail from it.
  await r.deliver({ from: "triage@acme.com", text: "spoofed" }, { dmarc: "GRAY", spf: "PASS", source: "x@attacker.com" });
  await r.deliver({ from: "triage@acme.com", text: "vacation", headers: ["Auto-Submitted: auto-replied"] });
  await r.deliver({ from: "triage@acme.com", text: "forwarded" }, forwardedReceipt({ source: "x+caf_=y@elsewhere.com" }));
  assert.equal(await verified(), undefined);
  // Proof: SES vouches for the From. The address is not on the allowlist, so this is not a message for the agent.
  await r.deliver({ from: "Triage@acme.com", text: "hello" });
  assert.equal(await verified(), "triage@acme.com");
  await sleep(200);
  assert.equal(r.prompts.length, 1);

  await everyOutboundPath(r, channel.id, { from: "ada@example.com", subject: "Invoice 42" }, {});
  const mails = await r.mails();
  assert.ok(mails.length >= 8, `every path sent something (${mails.length})`);
  for (const mail of mails) {
    assert.deepEqual(mail.to, ["triage@acme.com"]);
    assert.equal(mail.parsed.to?.[0].address, "triage@acme.com");
    assert.equal(mail.parsed.headers.find(header => header.key === "x-original-from")?.value, mail.parsed.text!.includes("hasty@") ? "hasty@example.com" : "ada@example.com");
    assert.match(mail.parsed.text!, /^Reply for (ada|hasty)@example\.com, subject "Invoice 42"\. Sent only to triage@acme\.com, not to them\.\n\n/);
    assert.equal(mail.parsed.headers.find(header => header.key === "auto-submitted")?.value, "auto-replied");
  }
  const texts = mails.map(mail => mail.parsed.text!.split("\n\n").slice(1).join("\n\n").trim());
  for (const expected of [/^Here is the draft\.\n\nApprove this action\? shop__refund/, /^draft\.txt$/, /big\.bin \(11\.0 MB, too large to send here/, /^Sorry, something went wrong/, /^Working on it$/, /^notes\.txt$/, /^A scheduled note\.$/, /^You're sending messages too quickly/]) {
    assert.ok(texts.some(text => expected.test(text)), String(expected));
  }
  assert.deepEqual(mails.flatMap(mail => mail.parsed.attachments.map(attachment => attachment.filename)).sort(), ["draft.txt", "notes.txt"]);

  // Another address starts unproven; "none" stops everything at once.
  const count = r.sent.length;
  await r.channels.update("default", channel.id, { settings: { replies: { to: "other@acme.com" } }, limits: { perSenderPerMinute: 100 } });
  await r.deliver({ from: "ada@example.com", text: "after the change" });
  await until(() => r.prompts.length === 5, "the prompt after the change");
  await r.drained();
  assert.equal(r.sent.length, count);
});

test("a trusted forwarder's mail is taken on proof of the forwarder, its sender marked unverified and never mailed", async t => {
  const r = await setup(t);
  const logs: string[] = [];
  const log = console.log;
  console.log = (line: unknown) => { if (typeof line === "string" && line.includes('"email_')) logs.push(line); else log(line); };
  t.after(() => { console.log = log; });
  const reasons = () => logs.splice(0).map(line => { const { type: _type, ses: _ses, channel: _channel, conversation: _conversation, ...rest } = JSON.parse(line); return rest; });

  const intake = await r.channels.create("default", { type: "email", settings: { address: "support", forwarders: ["support@acme.com"], replies: "none" }, access: { allow: ["support@acme.com", "vip@customer.example"] } });
  const ada = { from: "ada@customer.example", fromName: "Ada Lovelace", subject: "Refund please" };
  await r.deliver({ ...ada, messageId: "c1@customer.example", text: "My bot is down. SECRET-BODY" }, forwardedReceipt());
  const first = await until(() => r.prompts[0], "the forwarded message");
  assert.equal(first.text, "From (forwarded by support@acme.com, unverified): Ada Lovelace <ada@customer.example>\nSubject: Refund please\n\nMy bot is down. SECRET-BODY");
  assert.deepEqual(first.from, { id: "email:unverified:ada@customer.example", name: "Ada Lovelace", username: "ada@customer.example" });
  // A failed DMARC check is what forwarding does to mail (the envelope is no longer the sender's); it is still the forwarder's mail.
  await r.deliver({ ...ada, messageId: "c2@customer.example", text: "dmarc" }, forwardedReceipt({ dmarc: "FAIL" }));
  await until(() => r.prompts[1], "the message that failed DMARC");
  assert.deepEqual(reasons(), [{ accepted: "forwarded" }, { accepted: "forwarded" }]);

  // No proof, no forward: headers anyone can write, an envelope that does not pass SPF, or one that passes for someone else.
  const claims = ["X-Forwarded-For: support@acme.com support@in.example.test", "X-Forwarded-To: support@in.example.test", "Delivered-To: support@acme.com",
    "ARC-Authentication-Results: i=1; mx.google.com; spf=pass smtp.mailfrom=acme.com", "Authentication-Results: amazonses.com; spf=pass smtp.mailfrom=support@acme.com", "Return-Path: <support@acme.com>"];
  const drops: [string, Mail, Receipt, string][] = [
    ["headers claim the forwarder, SPF does not pass", { ...ada, headers: claims }, { dmarc: "GRAY", spf: "GRAY", source: ACME }, "unauthenticated"],
    ["headers claim the forwarder, SPF fails", { ...ada, headers: claims }, { dmarc: "GRAY", spf: "FAIL", source: ACME }, "unauthenticated"],
    ["headers claim the forwarder, SPF passes for the attacker", { ...ada, headers: claims }, { dmarc: "GRAY", spf: "PASS", source: "support@attacker.com" }, "unauthenticated"],
    ["a domain that only looks like the forwarder's", ada, forwardedReceipt({ source: "support@acme.com.attacker.com" }), "unauthenticated"],
    ["another mailbox at the forwarder's domain", ada, forwardedReceipt({ source: "sales+caf_=x@acme.com" }), "unauthenticated"],
    ["no envelope sender", ada, forwardedReceipt({ source: "" }), "unauthenticated"],
    ["spam, forwarded", ada, forwardedReceipt({ spam: "FAIL" }), "unauthenticated"],
    ["an auto-reply, forwarded", { ...ada, headers: ["Auto-Submitted: auto-generated"] }, forwardedReceipt(), "auto_submitted"],
    ["bulk mail, forwarded", { ...ada, headers: ["Precedence: bulk"] }, forwardedReceipt(), "bulk"],
    ["a bounce, forwarded", { from: "mailer-daemon@customer.example" }, forwardedReceipt(), "bounce"],
    ["our own reply, forwarded back", { from: `support@${DOMAIN}` }, forwardedReceipt(), "own_domain"],
    // Written straight to the channel, the customer is who must be allowed.
    ["the customer, directly", ada, {}, "access"],
  ];
  for (const [what, mail, receipt, reason] of drops) {
    await r.deliver({ ...mail, text: what }, receipt);
    assert.deepEqual(reasons(), [{ dropped: reason }], what);
  }
  // The allowlist is asked about the forwarder: allowing the customer does not let a forward in, and the forwarder brings anyone's mail.
  const strict = await r.channels.create("default", { type: "email", settings: { address: "strict", forwarders: ["@acme.com"], replies: "none" }, access: { allow: ["ada@customer.example"] } });
  await r.deliver({ ...ada, text: "to strict" }, forwardedReceipt({ recipients: [`strict@${DOMAIN}`] }));
  assert.deepEqual(reasons(), [{ dropped: "access", forwarded: true }]);
  await r.channels.update("default", strict.id, { access: { allow: ["@acme.com"] } });
  await r.deliver({ from: "eve@unknown.example", text: "to strict, allowed" }, forwardedReceipt({ recipients: [`strict@${DOMAIN}`], source: "sales+caf_=x@acme.com" }));
  assert.deepEqual(reasons(), [{ accepted: "forwarded" }]);
  await until(() => r.prompts.length === 3, "the domain forwarder's message");
  // A channel that names no forwarder takes no forwards, whoever it allows.
  await r.channels.create("default", { type: "email", settings: { address: "plain" }, access: { public: true } });
  await r.deliver({ ...ada, text: "to plain" }, forwardedReceipt({ recipients: [`plain@${DOMAIN}`] }));
  assert.deepEqual(reasons(), [{ dropped: "unauthenticated" }]);
  // Mail from the forwarder's own domain is not a forward: its sender is proven, and is who must be allowed.
  await r.deliver({ from: "boss@acme.com", text: "direct from acme" }, { dmarc: "GRAY", spf: "PASS", source: "boss@acme.com" });
  assert.deepEqual(reasons(), [{ dropped: "access" }]);
  await r.deliver({ from: "support@acme.com", messageId: "s1@acme.com", text: "from staff" }, { dmarc: "PASS", spf: "PASS", source: "support@acme.com" });
  const staff = await until(() => r.prompts[3], "the staff message");
  assert.deepEqual(staff.from, { id: "email:support@acme.com", username: "support@acme.com" });
  assert.equal(staff.text, "Subject: Invoice\n\nfrom staff");
  assert.deepEqual(reasons(), [{ accepted: "direct" }]);

  // A forwarded thread stays one conversation: the customer answers a person's reply, and the forward names the thread's root.
  await r.deliver({ ...ada, messageId: "c3@customer.example", subject: "Re: Refund please", references: ["c1@customer.example", "human-reply@acme.com"], inReplyTo: "human-reply@acme.com", text: "Still down" }, forwardedReceipt());
  const followUp = await until(() => r.prompts[4], "the follow-up");
  assert.equal(followUp.agent, first.agent);
  assert.notEqual(staff.agent, first.agent);

  // An unverified sender answers nothing the agent waits on: "approve" is only a message. (Mail opens with its
  // subject, so no email answers an input today; the rule is the core's, shown here on the bare text.)
  r.state.pending = [APPROVAL];
  const conversationId = (await r.db.query("select conversation from email_threads where channel = $1 and last_message = $2", [intake.id, "c3@customer.example"])).rows[0].conversation;
  const say = (messageId: string, sender: string, unverified: boolean) => r.channels.inbound(intake.id, { conversationId, messageId, sender: { id: sender }, text: "approve", files: [], ...(unverified ? { trusted: true, unverified: true } : {}) });
  await say("c4@customer.example", "ada@customer.example", true);
  const approve = await until(() => r.prompts[5], "the would-be approval");
  assert.equal(approve.text, "approve");
  assert.equal(approve.from.id, "email:unverified:ada@customer.example");
  assert.deepEqual(r.state.answers, []);
  // A proven sender on the same channel does.
  await say("s2@acme.com", "support@acme.com", false);
  await until(() => r.state.answers.length === 1, "the approval");
  assert.equal((r.state.answers as any[])[0].answer.from.id, "email:support@acme.com");

  await r.drained();
  assert.equal(r.sent.length, 0, "nobody was mailed");
  assert.ok(!logs.join("").includes("SECRET-BODY") && !reasons().some(entry => JSON.stringify(entry).includes("customer.example")), "decisions are logged without bodies or addresses");
  assert.equal(intake.settings?.replies, "none");
});

test("forwarded mail with replies: { to } goes to the fixed address; its sender is mailed only on an explicit opt-in", async t => {
  const r = await setup(t);
  const channel = await r.channels.create("default", { type: "email", settings: { address: "support", forwarders: ["@acme.com"], replies: { to: "triage@acme.com" } }, access: { allow: ["@acme.com"] } });
  await r.deliver({ from: "triage@acme.com", text: "hello" }, { dmarc: "PASS", spf: "PASS", source: "triage@acme.com" });
  await until(() => r.prompts[0], "the staff message");
  const [hello] = await until(async () => r.sent.length === 1 && await r.mails(), "its reply");
  assert.deepEqual(hello.to, ["triage@acme.com"]);
  const agent = await everyOutboundPath(r, channel.id, { from: "ada@customer.example", subject: "Refund" }, forwardedReceipt());
  const mails = (await r.mails()).slice(1);
  assert.ok(mails.length >= 8);
  for (const mail of mails) {
    assert.deepEqual(mail.to, ["triage@acme.com"]);
    assert.match(mail.parsed.text!, /^Reply for (ada|hasty)@customer\.example \(forwarded, unverified\), subject "Refund"\. Sent only to triage@acme\.com, not to them\./);
  }

  // Opted in, replies go to whoever the forwarded message says wrote it.
  await r.channels.update("default", channel.id, { settings: { replies: "sender", replyToForwarded: true }, limits: { perSenderPerMinute: 100 } });
  let count = r.sent.length;
  await r.deliver({ from: "ada@customer.example", subject: "Refund", messageId: "opt@customer.example", text: "opted in" }, forwardedReceipt());
  const [reply] = await until(async () => r.sent.length === count + 1 && (await r.mails()).slice(count), "the reply to the customer");
  assert.deepEqual(reply.to, ["ada@customer.example"]);
  assert.equal(reply.parsed.text?.trim(), "re: opted in");
  // The opt-in gone (and with it the forwarders), threads a forwarder last wrote into still mail nobody.
  await r.channels.update("default", channel.id, { settings: { forwarders: [], replyToForwarded: false } });
  count = r.sent.length;
  r.channels.hooks.runEnded!({ id: reply.parsed.text ? (await until(() => r.prompts.at(-1), "the prompt")).agent : agent, tenant: "default" }, { id: "schedule-2", method: "prompt", fingerprint: "", state: "completed", outcome: { result: { reply: "A scheduled note." } } });
  await sleep(200);
  await r.drained();
  assert.equal(r.sent.length, count);
});
