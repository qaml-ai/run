import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import PostalMime, { type Email } from "postal-mime";
import { newText, replyMime } from "../../../src/core/channels/email.ts";
import type { ContractFixture, FixtureOptions } from "../fixture.ts";
import { createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contractTest, free, listen, OPERATOR, OTHER_OPERATOR, sleep, toolCall, until, type T } from "../support.ts";
import { EMAIL_TOPIC, SNS_CERT_URL, type Receipt } from "../fixtures/email.ts";

/**
 * Email channels on either backend. Mail comes in through each backend's own ingress (ECS: SES through SNS;
 * Workers: Email Routing's Email Worker, see fixtures/email.ts), and replies go out through its mail service
 * (ECS: SES raw sends; Workers: Cloudflare Email Service), both to the local sink below.
 */
const DOMAIN = "in.example.test";

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

/**
 * Where replies land: SES v2 SendEmail's raw message (ECS), or Email Service's message as JSON (Workers), which the
 * sink renders as the MIME message the service would send, its Message-ID the one the service answers with.
 */
async function mailSink(t: T) {
  const sent: { from: string; to: string[]; raw: Uint8Array }[] = [];
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    if (req.url === "/channel-mail") {
      const messageId = `${randomUUID()}@email-service.example`;
      const address = typeof body.from === "string" ? body.from : body.from.email;
      const raw = replyMime({
        from: address, ...(typeof body.from === "object" ? { fromName: body.from.name } : {}), to: body.to, subject: body.subject.replace(/^Re: /, ""), messageId,
        inReplyTo: body.headers["In-Reply-To"]?.replace(/^<|>$/g, ""), references: (body.headers.References ?? "").match(/[^<>\s]+(?=>)/g) ?? [],
        text: body.text, headers: Object.entries(body.headers as Record<string, string>).filter(([name]) => !["In-Reply-To", "References", "Auto-Submitted"].includes(name)).map(([name, value]) => `${name}: ${value}`),
        ...(body.attachments?.[0] ? { file: { name: body.attachments[0].filename, contentType: body.attachments[0].type, data: Buffer.from(body.attachments[0].content, "base64") } } : {}),
      });
      sent.push({ from: address, to: [body.to], raw: Buffer.from(raw) });
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ messageId }));
      return;
    }
    // SES v2 SendEmail with a raw message.
    sent.push({ from: body.FromEmailAddress, to: body.Destination.ToAddresses, raw: Buffer.from(body.Content.Raw.Data, "base64") });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ MessageId: randomUUID() }));
  });
  const mails = () => Promise.all(sent.map(async message => ({ ...message, parsed: await PostalMime.parse(message.raw) as Email })));
  return { url, sent, mails };
}
type Sink = Awaited<ReturnType<typeof mailSink>>;

/** A prompt as the agent got it: the text the sender wrote and who they are, from the model request's runtime context. */
function promptsOf(r: ContractFixture) {
  return r.model.bodies.map(body => {
    const user = body.messages.filter((message: any) => message.role === "user").at(-1);
    const content = typeof user.content === "string" ? user.content : user.content.map((part: any) => part.text ?? "").join("\n");
    const context = /^<<<RUNTIME_CONTEXT>>>\n(.*)\n<<<END_RUNTIME_CONTEXT>>>\n/s.exec(content);
    const text = context ? content.slice(context[0].length) : content;
    return { text, from: context ? JSON.parse(context[1]!).from : undefined, history: body.messages.filter((message: any) => message.role === "user").length };
  });
}

/** The text of a model request's last user message, attachment notes aside. */
const lastLine = (body: any) => promptsOf({ model: { bodies: [body] } } as never)[0]!.text.split("\n[File ")[0]!.split("\n").at(-1)!;
/** The agent answers the last line its sender wrote. */
const echo = (body: any) => ({ role: "assistant", content: `re: ${lastLine(body)}` });
/** Messages that reached an agent as a new prompt (not a tool result's follow-up). */
const arrived = (r: ContractFixture) => r.model.bodies.filter(body => body.messages.at(-1).role === "user").map(lastLine);

type R = ContractFixture & { sink: Sink; deliver(mail: Mail, receipt?: Receipt): Promise<number>; prompts(): ReturnType<typeof promptsOf> };
function emailTest(source: string, name: string, body: (t: TestContext, r: R) => Promise<void>, options: FixtureOptions = {}) {
  let sink: Sink;
  contractTest("channels", source, name, (t, fixture) => body(t, Object.assign(fixture, {
    sink, deliver: (mail: Mail, receipt?: Receipt) => fixture.deliverEmail(mime(mail), receipt), prompts: () => promptsOf(fixture),
  })), {
    ...options,
    respond: options.respond ?? echo,
    env: { AGENT_EMAIL_DOMAIN: DOMAIN, AGENT_CHANNEL_RETRY_MS: "100", ...options.env },
    prepare: async t => {
      sink = await mailSink(t);
      return { AWS_ENDPOINT_URL_SESV2: sink.url, ...await options.prepare?.(t) };
    },
  });
}

const create = (r: ContractFixture, fields: Record<string, unknown>, token?: string) => r.call("/v1/channels", { body: { type: "email", ...fields }, ...(token ? { token } : {}) });
/** Resolves once the channels' queue is empty: everything received was answered, sent or dropped. */
const drained = (r: ContractFixture) => until(async () => Number((await r.channelQuery("select count(*)::int as count from channel_items")).rows[0].count) === 0, "the queue to drain");

emailTest("tests/channels-email.test.ts:143", "email channels need no credentials and take a unique address on the runtime's domain", async (_t, r) => {
  const plain = (await create(r, {})).json;
  assert.deepEqual(plain.settings, { address: `${plain.id}@${DOMAIN}` });
  assert.equal(plain.webhookUrl, undefined, "mail arrives at the shared route, not a channel's own");
  const support = (await create(r, { settings: { address: "Support", fromName: "Acme Support" } })).json;
  assert.deepEqual(support.settings, { address: `support@${DOMAIN}`, fromName: "Acme Support" });
  assert.equal((await create(r, { settings: { address: `SUPPORT@${DOMAIN}` } }, OTHER_OPERATOR)).status, 409);
  for (const address of ["postmaster", "x@elsewhere.com", "-bad", "ch_0123456789abcdef0123", "a b"]) {
    assert.equal((await create(r, { settings: { address } })).status, 400, address);
  }
  assert.equal((await create(r, { settings: { replyUrl: "https://x" } })).status, 400);
  const renamed = (await r.call(`/v1/channels/${support.id}`, { method: "PATCH", body: { settings: { address: "help" } } })).json;
  assert.deepEqual(renamed.settings, { address: `help@${DOMAIN}`, fromName: "Acme Support" });
  // Its old address is free again.
  assert.equal((await create(r, { settings: { address: "support" } })).json.settings?.address, `support@${DOMAIN}`);
});

emailTest("tests/channels-email.test.ts:207", "a message starts a thread; replies thread under it, quoted history is left out, attachments are saved", async (_t, r) => {
  const channel = (await create(r, { settings: { address: "support", fromName: "Acme" }, access: { allow: ["ada@example.com"] } })).json;
  const status = await r.deliver({
    from: "Ada@Example.com", fromName: "Ada Lovelace", messageId: "m1@example.com", subject: "Invoice 42",
    text: "Can you check the invoice?\r\n\r\nOn Mon, Sep 28, 2026 at 3:00 PM Bob <bob@example.com>\r\nwrote:\r\n> the old thread\r\n> more",
    attachment: { name: "invoice.txt", type: "text/plain", data: Buffer.from("total: 42") },
  });
  assert.equal(status, 200);
  const first = await until(() => r.prompts()[0], "the first prompt");
  // The attachment is saved to the agent's workspace and attached by path, a text file with its first lines.
  const file = /\n\[File (\/workspace\/uploads\/in_[a-f0-9]{40}\/invoice\.txt) \(text\/plain, 1 KB\), beginning:\ntotal: 42\]$/.exec(first.text);
  assert.ok(file, first.text);
  assert.equal(first.text.slice(0, file.index), "Subject: Invoice 42\n\nCan you check the invoice?");
  assert.deepEqual(first.from, { id: "email:ada@example.com", name: "Ada Lovelace", username: "ada@example.com" });
  const [agent] = (await r.call("/v1/agents")).json;
  const [mount] = (await r.call(`/v1/agents/${agent.id}/mounts`)).json;
  assert.equal((await r.call(`/v1/volumes/${mount.volumeId}/files${file[1]!.slice("/workspace".length)}`)).text, "total: 42");

  const [reply] = await until(async () => r.sink.sent.length === 1 && await r.sink.mails(), "the reply");
  assert.equal(reply.from, `support@${DOMAIN}`);
  assert.deepEqual(reply.to, ["ada@example.com"]);
  assert.equal(reply.parsed.subject, "Re: Invoice 42");
  assert.deepEqual(reply.parsed.from, { address: `support@${DOMAIN}`, name: "Acme" });
  assert.equal(reply.parsed.inReplyTo, "<m1@example.com>");
  assert.equal(reply.parsed.references, "<m1@example.com>");
  assert.equal(reply.parsed.text?.trim(), "re: Can you check the invoice?");
  assert.equal(reply.parsed.headers.find(header => header.key === "auto-submitted")?.value, "auto-replied");
  // ECS sets the Message-ID on the runtime's domain; Cloudflare Email Service assigns its own. Either is what replies thread by.
  assert.ok(reply.parsed.messageId?.endsWith(">"));

  // Ada answers our reply; her client names only the message it answers.
  await r.deliver({ from: "ada@example.com", messageId: "m2@example.com", subject: "Re: Invoice 42", inReplyTo: reply.parsed.messageId!.slice(1, -1), text: "Thanks!\n> re: Can you check" });
  const second = await until(() => r.prompts()[1], "the second prompt");
  assert.equal(second.history, 2, "the reply reaches the thread's agent");
  assert.equal(second.text, "Subject: Re: Invoice 42\n\nThanks!");
  const [, again] = await until(async () => r.sink.sent.length === 2 && await r.sink.mails(), "the second reply");
  assert.equal(again.parsed.inReplyTo, "<m2@example.com>");
  assert.equal(again.parsed.references, "<m1@example.com> <m2@example.com>");

  // Delivered at least once: the same message again is dropped.
  await r.deliver({ from: "ada@example.com", messageId: "m2@example.com", subject: "Re: Invoice 42", inReplyTo: "m1@example.com", text: "Thanks!" });
  // A new message is a new thread, with an agent of its own.
  await r.deliver({ from: "ada@example.com", messageId: "m3@example.com", subject: "Another thing", text: "New topic" });
  const third = await until(() => r.prompts()[2], "the new thread's prompt");
  assert.equal(third.history, 1);
  assert.equal((await r.call("/v1/agents")).json.length, 2);
  await sleep(200);
  assert.equal(r.prompts().length, 3);
  assert.equal(Number((await r.channelQuery("select count(*)::int as count from email_threads where channel = $1", [channel.id])).rows[0].count), 2);

  // Deleting the channel deletes its threads' addresses, subjects and Message-IDs.
  await drained(r);
  assert.equal((await r.call(`/v1/channels/${channel.id}`, { method: "DELETE" })).status, 200);
  for (const table of ["email_threads", "email_messages", "channel_seen", "channel_items"]) {
    assert.equal(Number((await r.channelQuery(`select count(*)::int as count from ${table}`)).rows[0].count), 0, table);
  }
});

contractTest("channels", "tests/channels-email.test.ts:306", "quoted history is cut at the usual markers", () => {
  assert.equal(newText("Yes.\n\nOn Tue, 29 Sep 2026, Ada <a@b.c> wrote:\n> earlier"), "Yes.");
  assert.equal(newText("Sure\r\n-----Original Message-----\r\nFrom: x"), "Sure");
  assert.equal(newText("Top\n________________________________\nFrom: someone"), "Top");
  assert.equal(newText("> quoted\nmine\n>> deeper"), "mine");
  assert.equal(newText("One day in October\nwe wrote: a plan"), "One day in October\nwe wrote: a plan");
});

// The filter -----------------------------------------------------------------------

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const OPS = "ops-operator-token-at-least-24-chars";
// A tenant with an OpenRouter key of its own, so decisions need no billing.
const filterTenants = { tenants: { ops: { tokenSha256: sha(OPS), apiKeys: { openrouter: "fixture-model-key" } } }, platformKeys: { openrouter: "fixture-platform-model-key" } };
let asked: any[] = [];

emailTest("tests/channels-email.test.ts:182", "a filter judges a new email, with its from, subject and body; a reply in a thread with an agent is not judged, and a reply to a filtered one is", async (_t, r) => {
  const channel = (await create(r, { settings: { address: "support" }, access: { public: true }, filter: { instructions: "A customer needs a reply", threshold: 0.7 } }, OPS)).json;
  await r.deliver({ from: "ada@example.com", fromName: "Ada", messageId: "c1@example.com", subject: "Broken", text: "It is broken" });
  await until(() => r.prompts()[0], "the customer's prompt");
  assert.deepEqual(asked[0], { channel: "email", from: { id: "ada@example.com", name: "Ada", username: "ada@example.com" }, title: "Broken", text: "Subject: Broken\n\nIt is broken" });
  await r.deliver({ from: "ada@example.com", messageId: "c2@example.com", subject: "Re: Broken", inReplyTo: "c1@example.com", text: "Unsubscribe" });
  await until(() => arrived(r).includes("Unsubscribe"), "the reply in the thread");
  assert.equal(asked.length, 1, "a reply in a thread with an agent goes straight on");

  await r.deliver({ from: "news@example.com", messageId: "n1@example.com", subject: "Deals", text: "Unsubscribe" });
  await r.deliver({ from: "news@example.com", messageId: "n2@example.com", subject: "Re: Deals", inReplyTo: "n1@example.com", text: "Unsubscribe" });
  const events = await until(async () => {
    const page = (await r.call(`/v1/channels/${channel.id}/events?outcome=filtered`, { token: OPS })).json;
    return page.events.length === 2 && page.events;
  }, "both filtered");
  assert.equal(asked.length, 3);
  assert.deepEqual(events.map((event: any) => event.message?.from.id), ["news@example.com", "news@example.com"]);
  assert.equal(arrived(r).length, 2);
}, {
  tenants: filterTenants, respond: free(echo),
  env: { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" },
  prepare: async t => {
    // A stand-in for OpenRouter's decisions API: mail that says "Unsubscribe" is not for a reply.
    asked = [];
    const url = await listen(t, async (req, res) => {
      let text = "";
      for await (const chunk of req) text += chunk;
      const body = JSON.parse(text);
      asked.push(body.state);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        model: "typesafe/jev-1.14-20261014", answers: { passes: { type: "noul", noul: String(body.state.text).includes("Unsubscribe") ? 0.1 : 0.9 } }, usage: { input_tokens: 1, output_tokens: 1, cost: 0.00001 },
      }));
    });
    return { AGENT_DECISIONS_URL: url };
  },
});

// Who is let in -------------------------------------------------------------------

emailTest("tests/channels-email.test.ts:259", "mail is dropped unless SES proves its sender, and automatic or bulk mail never reaches an agent", async (_t, r) => {
  assert.equal((await create(r, { settings: { address: "support" }, access: { allow: ["ada@example.com", "@example.org"] } })).status, 201);
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
  await until(() => r.prompts().length === 2, "the proven messages");
  await sleep(300);
  assert.deepEqual(r.prompts().map(prompt => prompt.text.split("\n").at(-1)).sort(), ["domain", "spf"]);
});

// Reply modes and forwarders ------------------------------------------------------

const ACME = "support+caf_=support=in.example.test@acme.com";
/** A message Acme's support mailbox forwarded on: the envelope is Acme's and passes SPF; the From is the customer's, which nothing proves. */
const forwardedReceipt = (receipt: Receipt = {}): Receipt => ({ dmarc: "GRAY", spf: "PASS", source: ACME, ...receipt });

emailTest("tests/channels-email.test.ts:356", "reply and forwarder settings are validated; forwarders need replies that never reach an unverified sender", async (_t, r) => {
  const make = (settings: Record<string, unknown>) => create(r, { settings });
  const patch = (id: string, settings: Record<string, unknown>) => r.call(`/v1/channels/${id}`, { method: "PATCH", body: { settings } });
  assert.deepEqual((await make({ address: "a1", replies: "sender" })).json.settings, { address: `a1@${DOMAIN}` }, "the default is not stored");
  assert.deepEqual((await make({ address: "a2", replies: "none" })).json.settings, { address: `a2@${DOMAIN}`, replies: "none" });
  assert.deepEqual((await make({ address: "a3", replies: { to: " Triage@Acme.com " } })).json.settings, { address: `a3@${DOMAIN}`, replies: { to: "triage@acme.com" } });
  const bad: Record<string, unknown>[] = [
    { replies: "everyone" }, { replies: { to: "not an address" } }, { replies: { to: "a@acme.com", cc: "b@acme.com" } }, { replies: { to: `other@${DOMAIN}` } }, { replies: ["a@acme.com"] },
    { forwarders: "support@acme.com" }, { forwarders: ["acme.com"] }, { forwarders: ["@nodot"] }, { forwarders: [`support@${DOMAIN}`] }, { forwarders: [`@sub.${DOMAIN}`] }, { forwarders: [7] },
    { forwarders: Array.from({ length: 21 }, (_, index) => `@d${index}.com`), replies: "none" }, { replyToForwarded: "yes" },
  ];
  for (const settings of bad) assert.equal((await make(settings)).status, 400, JSON.stringify(settings));
  // Forwarded mail's sender is unverified: with the default replies it would be mailed.
  const unsafe = await make({ forwarders: ["support@acme.com"] });
  assert.equal(unsafe.status, 400);
  assert.match(unsafe.json.error, /settings\.replies.*"none".*replyToForwarded/);
  assert.equal((await make({ forwarders: ["support@acme.com"], replies: "sender" })).status, 400);
  assert.equal((await make({ forwarders: ["support@acme.com"], replyToForwarded: false })).status, 400);
  const intake = (await make({ address: "a4", forwarders: ["Support@Acme.com", "@acme.org", "support@acme.com"], replies: "none" })).json;
  assert.deepEqual(intake.settings, { address: `a4@${DOMAIN}`, replies: "none", forwarders: ["support@acme.com", "@acme.org"] });
  // An update is held to the same rule, against the settings it would leave.
  assert.equal((await patch(intake.id, { replies: "sender" })).status, 400);
  assert.deepEqual((await patch(intake.id, { replies: { to: "triage@acme.com" } })).json.settings?.replies, { to: "triage@acme.com" });
  assert.deepEqual((await patch(intake.id, { replies: "sender", replyToForwarded: true })).json.settings,
    { address: `a4@${DOMAIN}`, forwarders: ["support@acme.com", "@acme.org"], replyToForwarded: true });
  assert.equal((await patch(intake.id, { replyToForwarded: false })).status, 400);
  assert.deepEqual((await patch(intake.id, { forwarders: [], replyToForwarded: false })).json.settings, { address: `a4@${DOMAIN}` });
});

/** A definition whose agents can ask the person they are answering a question. */
const askingDefinition = async (r: ContractFixture) => (await r.call("/v1/definitions", { body: { name: "Asker", builtins: ["ask_user"] } })).json.id as string;

/** The agent answering the thread whose latest message is `messageId`. */
const agentOf = (r: ContractFixture, channel: string) => (messageId: string) => until(async () =>
  (await r.channelQuery("select c.agent from email_threads t join channel_conversations c on c.channel = t.channel and c.conversation = t.conversation where t.channel = $1 and t.last_message = $2", [channel, messageId])).rows[0]?.agent as string | undefined,
  "the thread's agent");

const FIRST = "first@customer.example";
/**
 * The agent for every way a channel sends mail: `first` writes a file, presents it and one too large to attach (a
 * link), then asks the sender a question; `second`'s model call fails; `third` writes a file and sends it with
 * send_message; `scheduled` is a prompt over the API that no message started. Anything else is echoed.
 */
function outboundModel(r: ContractFixture, thread: (messageId: string) => Promise<string>) {
  const big = Buffer.alloc(11 * 1024 * 1024);
  // A call's id is what a replayed call is told apart by: each gets its own.
  const call = (name: string, args: unknown) => toolCall(name, args, `call_${randomUUID()}`);
  return (body: any) => {
    const step = body.messages.slice(body.messages.map((message: any) => message.role).lastIndexOf("user") + 1).filter((message: any) => message.role === "tool").length;
    const text = lastLine(body);
    if (text === "first") {
      if (step === 0) {
        // The file too large to attach is put in the agent's volume while its first call waits.
        const upload = (async () => {
          const [mount] = (await r.call(`/v1/agents/${await thread(FIRST)}/mounts`)).json;
          const put = await fetch(`${r.base}/v1/volumes/${mount.volumeId}/files/out/big.bin`, { method: "PUT", headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/octet-stream" }, body: big });
          assert.equal(put.status, 201, await put.text());
        })();
        return { ...call("write", { path: "/workspace/out/draft.txt", content: "draft", contentType: "text/plain" }), wait: upload };
      }
      if (step === 1) return call("present_file", { path: "/workspace/out/draft.txt" });
      if (step === 2) return call("present_file", { path: "/workspace/out/big.bin" });
      return { ...call("ask_user", { questions: [{ question: "Approve the draft?", header: "Draft", options: [{ label: "Yes" }, { label: "No" }] }] }), content: "Here is the draft." };
    }
    if (text === "second") return { httpStatus: 400, message: "the model failed" };
    if (text === "third") {
      if (step === 0) return call("write", { path: "/workspace/out/notes.txt", content: "notes", contentType: "text/plain" });
      if (step === 1) return call("send_message", { text: "Working on it", files: ["/workspace/out/notes.txt"] });
      return { role: "assistant", content: "Sent." };
    }
    if (text === "scheduled") return { role: "assistant", content: "A scheduled note." };
    return echo(body);
  };
}

/**
 * Every way a channel sends mail, set off by `mail`: a turn's reply with a file, a file too large to attach (a link)
 * and a question the agent waits on; a failed turn's apology; send_message with a file; a turn no message started
 * (a prompt over the API); and the notice to a sender over the rate limit. Returns the agent of the first thread.
 */
async function everyOutboundPath(r: R, channel: string, mail: Mail, receipt: Receipt) {
  const thread = agentOf(r, channel);
  r.setModel(outboundModel(r, thread));
  const before = arrived(r).length;
  const customer = (messageId: string, text: string, more: Partial<Mail> = {}) => r.deliver({ ...mail, messageId, text, ...more }, receipt);
  const next = async (count: number, what: string) => { await until(() => arrived(r).length === before + count, what); await drained(r); };
  await customer(FIRST, "first");
  await next(1, "the first turn");  const secondId = `${randomUUID()}@customer.example`, thirdId = `${randomUUID()}@customer.example`;
  await customer(secondId, "second");
  await next(2, "the failed turn");
  // The failed thread's agent sends a message with a file mid-turn, then a prompt no message started reaches it.
  await customer(thirdId, "third", { inReplyTo: secondId });
  await next(3, "the send_message turn");
  await r.prompt(await thread(thirdId), "scheduled");
  await sleep(100);
  await drained(r);
  // Over the per-sender limit: the first message past it is told so.
  assert.equal((await r.call(`/v1/channels/${channel}`, { method: "PATCH", body: { limits: { perSenderPerMinute: 1 } } })).status, 200);
  const hasty = { ...mail, from: `hasty@${mail.from.split("@")[1]}` };
  for (const text of ["one", "two"]) await r.deliver({ ...hasty, messageId: `${randomUUID()}@customer.example`, text }, receipt);
  await until(() => arrived(r).includes("one"), "the hasty sender's turn");
  await sleep(200);
  await drained(r);
  return thread(FIRST);
}

emailTest("tests/channels-email.test.ts:383", "replies: none mails nobody, whatever the agent or the runtime has to say", async (_t, r) => {
  const channel = (await create(r, { settings: { address: "support", replies: "none" }, access: { allow: ["@example.com"] }, definition: await askingDefinition(r) })).json;
  await everyOutboundPath(r, channel.id, { from: "ada@example.com" }, {});
  assert.deepEqual(arrived(r).sort(), ["first", "one", "scheduled", "second", "third"], "the messages still reach the agent");
  assert.equal(r.sink.sent.length, 0);
});

emailTest("tests/channels-email.test.ts:391", "replies: { to } mails only that address, and only once it has written to the channel itself", async (_t, r) => {
  const channel = (await create(r, { settings: { address: "support", replies: { to: "triage@acme.com" } }, access: { allow: ["@example.com"] }, definition: await askingDefinition(r) })).json;
  const verified = async () => (await r.call(`/v1/channels/${channel.id}`)).json.account.verifiedReplyTo;
  await r.deliver({ from: "ada@example.com", messageId: "m1@example.com", subject: "Invoice 42", text: "before" });
  await until(() => r.prompts()[0], "the first prompt");
  await drained(r);
  assert.equal(r.sink.sent.length, 0, "an address that has not proven itself gets nothing, and neither does the sender");
  // Not proof: mail that only claims the address, its auto-reply, and a forwarder's copy of mail from it.
  await r.deliver({ from: "triage@acme.com", text: "spoofed" }, { dmarc: "GRAY", spf: "PASS", source: "x@attacker.com" });
  await r.deliver({ from: "triage@acme.com", text: "vacation", headers: ["Auto-Submitted: auto-replied"] });
  await r.deliver({ from: "triage@acme.com", text: "forwarded" }, forwardedReceipt({ source: "x+caf_=y@elsewhere.com" }));
  assert.equal(await verified(), undefined);
  // Proof: SES vouches for the From. The address is not on the allowlist, so this is not a message for the agent.
  await r.deliver({ from: "Triage@acme.com", text: "hello" });
  assert.equal(await verified(), "triage@acme.com");
  await sleep(200);
  assert.equal(r.prompts().length, 1);

  await everyOutboundPath(r, channel.id, { from: "ada@example.com", subject: "Invoice 42" }, {});
  const mails = await r.sink.mails();
  assert.ok(mails.length >= 8, `every path sent something (${mails.length})`);
  for (const mail of mails) {
    assert.deepEqual(mail.to, ["triage@acme.com"]);
    assert.equal(mail.parsed.to?.[0].address, "triage@acme.com");
    assert.equal(mail.parsed.headers.find(header => header.key === "x-original-from")?.value, mail.parsed.text!.includes("hasty@") ? "hasty@example.com" : "ada@example.com");
    assert.match(mail.parsed.text!, /^Reply for (ada|hasty)@example\.com, subject "Invoice 42"\. Sent only to triage@acme\.com, not to them\.\n\n/);
    assert.equal(mail.parsed.headers.find(header => header.key === "auto-submitted")?.value, "auto-replied");
  }
  const texts = mails.map(mail => mail.parsed.text!.split("\n\n").slice(1).join("\n\n").trim());
  for (const expected of [/^Here is the draft\.\n\nApprove the draft\?/, /^draft\.txt$/, /big\.bin \(11\.0 MB, too large to send here/, /^Sorry, something went wrong/, /^Working on it$/, /^notes\.txt$/, /^A scheduled note\.$/, /^You're sending messages too quickly/]) {
    assert.ok(texts.some(text => expected.test(text)), `${expected} in ${JSON.stringify(texts)}`);
  }
  assert.deepEqual(mails.flatMap(mail => mail.parsed.attachments.map(attachment => attachment.filename)).sort(), ["draft.txt", "notes.txt"]);

  // Another address starts unproven; "none" stops everything at once.
  const count = r.sink.sent.length;
  assert.equal((await r.call(`/v1/channels/${channel.id}`, { method: "PATCH", body: { settings: { replies: { to: "other@acme.com" } }, limits: { perSenderPerMinute: 100 } } })).status, 200);
  await r.deliver({ from: "ada@example.com", text: "after the change" });
  await until(() => arrived(r).includes("after the change"), "the prompt after the change");
  await drained(r);
  assert.equal(r.sink.sent.length, count);
});

/** The email_inbound lines the runtime logged, as the decision each records (what identifies the mail or channel left out), taken once. */
function inboundLog(r: ContractFixture) {
  let taken = 0;
  // Each decision is one JSON object on a line; workerd may color a line or split a long one, so only whole objects count.
  const all = () => r.logs.flatMap(line => {
    const found = /\{"type":"email_(?:inbound|outbound)".*\}/.exec(line);
    if (!found) return [];
    try { return [JSON.parse(found[0])]; } catch { return []; }
  });
  return {
    /** The decisions logged since the last call, once there are `count` of them. */
    async reasons(count = 1) {
      await until(() => all().length >= taken + count, `${count} logged decision(s)`);
      const lines = all().slice(taken);
      taken = all().length;
      return lines.map(({ type: _type, ses: _ses, mail: _mail, channel: _channel, conversation: _conversation, ...rest }) => rest);
    },
    text: () => all().map(line => JSON.stringify(line)).join("\n"),
  };
}

emailTest("tests/channels-email.test.ts:435", "a trusted forwarder's mail is taken on proof of the forwarder, its sender marked unverified and never mailed", async (_t, r) => {
  const log = inboundLog(r);
  const intake = (await create(r, { settings: { address: "support", forwarders: ["support@acme.com"], replies: "none" }, access: { allow: ["support@acme.com", "vip@customer.example"] } })).json;
  const conversation = async (messageId: string) => (await r.channelQuery("select conversation from email_threads where channel = $1 and last_message = $2", [intake.id, messageId])).rows[0]?.conversation;
  const ada = { from: "ada@customer.example", fromName: "Ada Lovelace", subject: "Refund please" };
  await r.deliver({ ...ada, messageId: "c1@customer.example", text: "My bot is down. SECRET-BODY" }, forwardedReceipt());
  const first = await until(() => r.prompts()[0], "the forwarded message");
  assert.equal(first.text, "From (forwarded by support@acme.com, unverified): Ada Lovelace <ada@customer.example>\nSubject: Refund please\n\nMy bot is down. SECRET-BODY");
  assert.deepEqual(first.from, { id: "email:unverified:ada@customer.example", name: "Ada Lovelace", username: "ada@customer.example" });
  const firstThread = await until(() => conversation("c1@customer.example"), "the forwarded thread");
  // A failed DMARC check is what forwarding does to mail (the envelope is no longer the sender's); it is still the forwarder's mail.
  await r.deliver({ ...ada, messageId: "c2@customer.example", text: "dmarc" }, forwardedReceipt({ dmarc: "FAIL" }));
  await until(() => r.prompts()[1], "the message that failed DMARC");
  assert.deepEqual(await log.reasons(2), [{ accepted: "forwarded" }, { accepted: "forwarded" }]);

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
    assert.deepEqual(await log.reasons(), [{ dropped: reason }], what);
  }
  // The allowlist is asked about the forwarder: allowing the customer does not let a forward in, and the forwarder brings anyone's mail.
  const strict = (await create(r, { settings: { address: "strict", forwarders: ["@acme.com"], replies: "none" }, access: { allow: ["ada@customer.example"] } })).json;
  await r.deliver({ ...ada, text: "to strict" }, forwardedReceipt({ recipients: [`strict@${DOMAIN}`] }));
  assert.deepEqual(await log.reasons(), [{ dropped: "access", forwarded: true }]);
  assert.equal((await r.call(`/v1/channels/${strict.id}`, { method: "PATCH", body: { access: { allow: ["@acme.com"] } } })).status, 200);
  await r.deliver({ from: "eve@unknown.example", text: "to strict, allowed" }, forwardedReceipt({ recipients: [`strict@${DOMAIN}`], source: "sales+caf_=x@acme.com" }));
  assert.deepEqual(await log.reasons(), [{ accepted: "forwarded" }]);
  await until(() => r.prompts().length === 3, "the domain forwarder's message");
  // A channel that names no forwarder takes no forwards, whoever it allows.
  await create(r, { settings: { address: "plain" }, access: { public: true } });
  await r.deliver({ ...ada, text: "to plain" }, forwardedReceipt({ recipients: [`plain@${DOMAIN}`] }));
  assert.deepEqual(await log.reasons(), [{ dropped: "unauthenticated" }]);
  // Mail from the forwarder's own domain is not a forward: its sender is proven, and is who must be allowed.
  await r.deliver({ from: "boss@acme.com", text: "direct from acme" }, { dmarc: "GRAY", spf: "PASS", source: "boss@acme.com" });
  assert.deepEqual(await log.reasons(), [{ dropped: "access" }]);
  await r.deliver({ from: "support@acme.com", messageId: "s1@acme.com", text: "from staff" }, { dmarc: "PASS", spf: "PASS", source: "support@acme.com" });
  const staff = await until(() => r.prompts()[3], "the staff message");
  assert.deepEqual(staff.from, { id: "email:support@acme.com", username: "support@acme.com" });
  assert.equal(staff.text, "Subject: Invoice\n\nfrom staff");
  assert.deepEqual(await log.reasons(), [{ accepted: "direct" }]);

  // A forwarded thread stays one conversation: the customer answers a person's reply, and the forward names the thread's root.
  await r.deliver({ ...ada, messageId: "c3@customer.example", subject: "Re: Refund please", references: ["c1@customer.example", "human-reply@acme.com"], inReplyTo: "human-reply@acme.com", text: "Still down" }, forwardedReceipt());
  const followUp = await until(() => r.prompts()[4], "the follow-up");
  assert.equal(followUp.text, "From (forwarded by support@acme.com, unverified): Ada Lovelace <ada@customer.example>\nSubject: Re: Refund please\n\nStill down");
  assert.equal(await conversation("c3@customer.example"), firstThread);
  assert.notEqual(await conversation("s1@acme.com"), firstThread);

  await drained(r);
  assert.equal(r.sink.sent.length, 0, "nobody was mailed");
  assert.ok(!log.text().includes("SECRET-BODY") && !log.text().includes("ada@customer.example"), "decisions are logged without bodies or addresses");
  assert.equal(intake.settings?.replies, "none");
});

emailTest("tests/channels-email.test.ts:524", "forwarded mail with replies: { to } goes to the fixed address; its sender is mailed only on an explicit opt-in", async (_t, r) => {
  const channel = (await create(r, { settings: { address: "support", forwarders: ["@acme.com"], replies: { to: "triage@acme.com" } }, access: { allow: ["@acme.com"] }, definition: await askingDefinition(r) })).json;
  await r.deliver({ from: "triage@acme.com", text: "hello" }, { dmarc: "PASS", spf: "PASS", source: "triage@acme.com" });
  await until(() => r.prompts()[0], "the staff message");
  const [hello] = await until(async () => r.sink.sent.length === 1 && await r.sink.mails(), "its reply");
  assert.deepEqual(hello.to, ["triage@acme.com"]);
  await everyOutboundPath(r, channel.id, { from: "ada@customer.example", subject: "Refund" }, forwardedReceipt());
  const mails = (await r.sink.mails()).slice(1);
  assert.ok(mails.length >= 8);
  for (const mail of mails) {
    assert.deepEqual(mail.to, ["triage@acme.com"]);
    assert.match(mail.parsed.text!, /^Reply for (ada|hasty)@customer\.example \(forwarded, unverified\), subject "Refund"\. Sent only to triage@acme\.com, not to them\./);
  }

  // Opted in, replies go to whoever the forwarded message says wrote it.
  assert.equal((await r.call(`/v1/channels/${channel.id}`, { method: "PATCH", body: { settings: { replies: "sender", replyToForwarded: true }, limits: { perSenderPerMinute: 100 } } })).status, 200);
  let count = r.sink.sent.length;
  await r.deliver({ from: "ada@customer.example", subject: "Refund", messageId: "opt@customer.example", text: "opted in" }, forwardedReceipt());
  const [reply] = await until(async () => r.sink.sent.length === count + 1 && (await r.sink.mails()).slice(count), "the reply to the customer");
  assert.deepEqual(reply.to, ["ada@customer.example"]);
  assert.equal(reply.parsed.text?.trim(), "re: opted in");
  // The opt-in gone (and with it the forwarders), threads a forwarder last wrote into still mail nobody.
  assert.equal((await r.call(`/v1/channels/${channel.id}`, { method: "PATCH", body: { settings: { forwarders: [], replyToForwarded: false } } })).status, 200);
  count = r.sink.sent.length;
  await r.prompt(await agentOf(r, channel.id)("opt@customer.example"), "scheduled");
  await sleep(200);
  await drained(r);
  assert.equal(r.sink.sent.length, count);
});

// Mail ingress that only ECS has (accepted differences; Node runs them) ------------------------

/** An SNS signing certificate of this file's own, which the runtime is told to fetch (the Node fixture's TEST_SNS_CERT_FILE). */
const sns = (() => {
  const dir = mkdtempSync(join(tmpdir(), "sns-cert-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"), "-subj", "/CN=sns.amazonaws.com", "-days", "2"], { stdio: "ignore" });
  return { certFile: join(dir, "cert.pem"), key: createPrivateKey(readFileSync(join(dir, "key.pem"))) };
})();

/** Sign an SNS message as SNS does, over its fields in order. */
function signed(message: Record<string, string>, version = "2", key = sns.key) {
  const fields = message.Type === "Notification"
    ? ["Message", "MessageId", ...(message.Subject !== undefined ? ["Subject"] : []), "Timestamp", "TopicArn", "Type"]
    : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  const text = fields.map(field => `${field}\n${message[field]}\n`).join("");
  return { SigningCertURL: SNS_CERT_URL, ...message, SignatureVersion: version, Signature: sign(version === "2" ? "sha256" : "sha1", Buffer.from(text), key).toString("base64") };
}
const postSns = async (r: ContractFixture, message: object) => {
  const response = await fetch(`${r.base}/channels/email/inbound`, { method: "POST", headers: { "Content-Type": "text/plain; charset=UTF-8" }, body: JSON.stringify(message) });
  await response.arrayBuffer();
  return response.status;
};

emailTest("tests/channels-email.test.ts:161", "SNS messages must be signed by SNS for the configured topic; a subscription is confirmed", async (_t, r) => {
  const subscribe = `https://sns.us-west-2.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${EMAIL_TOPIC}&Token=abc`;
  const confirmation = { Type: "SubscriptionConfirmation", MessageId: randomUUID(), Token: "abc", TopicArn: EMAIL_TOPIC, Message: "You have chosen to subscribe", SubscribeURL: subscribe, Timestamp: new Date().toISOString() };
  // The runtime's fetches are not observable here: a confirmed subscription is a 200 (the fixture answers ConfirmSubscription).
  assert.equal(await postSns(r, signed(confirmation)), 200);

  assert.equal(await postSns(r, { ...signed(confirmation), Message: "tampered" }), 401);
  assert.equal(await postSns(r, signed({ ...confirmation, TopicArn: "arn:aws:sns:us-west-2:999:other" })), 403);
  const elsewhere = { ...signed(confirmation), SigningCertURL: "https://evil.example.com/SimpleNotificationService.pem" };
  assert.equal(await postSns(r, elsewhere), 401, "a certificate is only fetched from SNS");
  const otherKey = createPrivateKey(execFileSync("openssl", ["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048"], { stdio: ["ignore", "pipe", "ignore"] }));
  assert.equal(await postSns(r, signed(confirmation, "2", otherKey)), 401);
  assert.equal(await postSns(r, signed({ ...confirmation, SubscribeURL: "https://evil.example.com/confirm" })), 400);
  assert.equal(await postSns(r, signed({ ...confirmation, Timestamp: new Date(Date.now() - 2 * 86_400_000).toISOString() })), 400, "an old message is a replay");
  // Version 1 signatures (SHA1) still verify.
  assert.equal(await postSns(r, signed({ ...confirmation, MessageId: randomUUID() }, "1")), 200);
}, { env: { TEST_SNS_CERT_FILE: sns.certFile } });

const BUCKET = "fixture-mail";
const objects = new Map<string, Buffer>();
emailTest("tests/channels-email.test.ts:287", "mail SES stored in S3 is read from there, and so are its attachments", async (_t, r) => {
  assert.equal((await create(r, { settings: { address: "support" }, access: { public: true } })).status, 201);
  const big = randomBytes(300 * 1024);
  objects.set(`${BUCKET}/inbound/abc`, Buffer.from(mime({ from: "ada@example.com", text: "See attached", attachment: { name: "data.bin", type: "application/octet-stream", data: big } })));
  const stored = (key: string, bucket = BUCKET) => postSns(r, signed({
    Type: "Notification", MessageId: randomUUID(), TopicArn: EMAIL_TOPIC, Subject: "Amazon SES Email Receipt Notification", Timestamp: new Date().toISOString(),
    Message: JSON.stringify({
      notificationType: "Received", mail: { messageId: randomBytes(8).toString("hex"), source: "bounces@example.com", headers: [] },
      receipt: {
        recipients: [`support@${DOMAIN}`], spfVerdict: { status: "GRAY" }, dkimVerdict: { status: "GRAY" }, dmarcVerdict: { status: "PASS" }, spamVerdict: { status: "PASS" }, virusVerdict: { status: "PASS" },
        action: { type: "S3", bucketName: bucket, objectKey: key, topicArn: EMAIL_TOPIC },
      },
    }),
  }));
  assert.equal(await stored("inbound/abc"), 200);
  const prompt = await until(() => r.prompts()[0], "the prompt");
  const file = /\n\[File (\/workspace\/uploads\/in_[a-f0-9]{40}\/data\.bin) /.exec(prompt.text);
  assert.ok(file, prompt.text);
  assert.equal(prompt.text.slice(0, file.index), "Subject: Invoice\n\nSee attached");
  const [agent] = (await r.call("/v1/agents")).json;
  const [mount] = (await r.call(`/v1/agents/${agent.id}/mounts`)).json;
  const saved = await fetch(`${r.base}/v1/volumes/${mount.volumeId}/files${file[1]!.slice("/workspace".length)}`, { headers: { Authorization: `Bearer ${OPERATOR}` } });
  assert.ok(Buffer.from(await saved.arrayBuffer()).equals(big));
  const item = await r.channelQuery("select count(*)::int as count from channel_items where item::text like '%\"content\"%'");
  assert.equal(Number(item.rows[0].count), 0, "attachments are not copied into the item");
  // Another bucket is not read.
  assert.equal(await stored("inbound/abc", "someone-elses"), 200);
  await sleep(200);
  assert.equal(r.prompts().length, 1);
  // A missing object is SNS's to retry.
  assert.equal(await stored("inbound/missing"), 500);
}, {
  env: { TEST_SNS_CERT_FILE: sns.certFile, AGENT_EMAIL_BUCKET: BUCKET },
  prepare: async t => ({
    // A fake S3, path-style: GET /<bucket>/<key>.
    AWS_ENDPOINT_URL_S3: await listen(t, (req, res) => {
      const data = objects.get(decodeURIComponent(new URL(req.url!, "http://s3").pathname.slice(1)));
      if (!data) return void res.writeHead(404, { "Content-Type": "application/xml" }).end("<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>");
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": data.length }).end(data);
    }),
  }),
});
