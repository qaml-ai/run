import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import { conversationKey, matches, render, verifySignature, webhookSettings } from "../../../src/core/channels/webhook.ts";
import { inboundItemId } from "../../../src/core/channels/channels.ts";
import type { ContractFixture, FixtureOptions } from "../fixture.ts";
import { contractTest, listen, OPERATOR, sleep, until, type T } from "../support.ts";
import { asked, uploaded } from "../channel-service-fakes.ts";

const SECRET = "whsec_" + randomBytes(24).toString("base64");
const PLAIN = "a-plain-shared-secret-0123456789";

/** Where replies are posted, when a channel has a replyUrl. */
async function receiver(t: T, status = 200) {
  const posts: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  const url = await listen(t, async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    posts.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(status).end();
  });
  return { url: `${url}/replies`, posts };
}

type Receiver = Awaited<ReturnType<typeof receiver>>;
/** Webhook channels on either backend: deliveries signed as a sending service signs them, the fixture's model for the agent's. */
type R = ContractFixture & { target: Receiver };
function channelTest(source: string, name: string, body: (t: TestContext, r: R) => Promise<void>, options: FixtureOptions = {}) {
  let target: Receiver;
  contractTest("channels", source, name, (t, fixture) => body(t, Object.assign(fixture, { target })), {
    ...options, env: { AGENT_CHANNEL_RETRY_MS: "100", AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", ...options.env },
    prepare: async t => {
      target = await receiver(t);
      return await options.prepare?.(t) ?? {};
    },
  });
}

const createChannel = async (r: R, input: Record<string, unknown> = {}) => {
  const created = await r.call("/v1/channels", { body: { type: "webhook", credentials: { secret: SECRET }, ...input } });
  if (created.status !== 201) throw new Error(`Channel creation failed: ${created.status} ${created.text}`);
  return created.json;
};
/** Deliver a payload signed per Standard Webhooks, or with the given headers instead. */
const post = (r: R, channel: { id: string }, payload: unknown, headers?: Record<string, string>, options: { id?: string; timestamp?: number; secret?: string } = {}) => {
  const body = JSON.stringify(payload);
  const id = options.id ?? `msg_${randomBytes(6).toString("hex")}`;
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const key = Buffer.from((options.secret ?? SECRET).slice(6), "base64");
  const standard = { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}` };
  return fetch(`${r.base}/channels/webhook/${channel.id}`, { method: "POST", headers: { "Content-Type": "application/json", ...(headers ?? standard) }, body });
};
const agents = (r: R) => r.call("/v1/agents").then(response => response.json as { id: string; name: string }[]);

contractTest("channels", "tests/channels-webhook.test.ts:81", "templates, filters and keys are small pure functions", () => {
  const payload = { action: "created", data: { issue: { id: 42, title: "Boom" }, tags: ["a", "b"] }, actor: { email: "ada@example.com" } };
  const headers = new Headers({ "X-Event": "issue" });
  assert.equal(render("sentry-{{data.issue.id}} {{ headers.x-event }} {{data.tags.1}} {{missing.path}}|", payload, headers), "sentry-42 issue b |");
  assert.equal(render("{{data.tags}}", payload), '["a","b"]');
  assert.equal(render("{{body.action}}", payload), "created");
  assert.ok(matches([{ path: "action", in: ["created", "resolved"] }, { path: "data.issue.id", equals: 42 }, { path: "actor", exists: true }], payload));
  assert.ok(!matches([{ path: "action", in: ["resolved"] }], payload));
  assert.ok(!matches([{ path: "data.nothing", exists: true }], payload));
  assert.ok(matches([{ path: "headers.x-event", equals: "issue" }], payload, headers));
  assert.equal(conversationKey("sentry-42"), "sentry-42");
  const long = conversationKey("linear/ENG-12 #big issue");
  assert.match(long, /^linear-ENG-12-big-issue-[a-f0-9]{16}$/);
  assert.notEqual(conversationKey("a/b"), conversationKey("a b"), "different keys stay apart once cleaned");
  assert.match(conversationKey("x".repeat(200)), /^[A-Za-z0-9_.-]{1,64}$/);

  assert.deepEqual(webhookSettings(undefined), { signature: { type: "standard" } });
  assert.throws(() => webhookSettings({ signature: { type: "hmac-sha256" } }), /header/);
  assert.throws(() => webhookSettings({ signature: "rot13" }), /standard, hmac-sha256 or token/);
  assert.throws(() => webhookSettings({ filter: [{ path: "action" }] }), /in, equals or exists/);
  assert.throws(() => webhookSettings({ bogus: 1 }), /Unknown setting bogus/);
  assert.deepEqual(webhookSettings({ key: "k" }, { signature: { type: "token", header: "X-Token" }, prompt: "p" }), { signature: { type: "token", header: "x-token" }, key: "k", prompt: "p" });
});

contractTest("channels", "tests/channels-webhook.test.ts:105", "each signature mode accepts good deliveries and refuses bad or stale ones", async () => {
  const body = '{"a":1}';
  const now = Date.now();
  const ts = String(Math.floor(now / 1000));
  const std = (secret: string, timestamp = ts) => new Headers({ "webhook-id": "m1", "webhook-timestamp": timestamp, "webhook-signature": `v1,wrong v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`m1.${timestamp}.${body}`).digest("base64")}` });
  assert.ok(await verifySignature({ type: "standard" }, SECRET, std(SECRET), body, now), "any of several signatures");
  assert.ok(!await verifySignature({ type: "standard" }, SECRET, std("whsec_" + randomBytes(24).toString("base64")), body, now));
  assert.ok(!await verifySignature({ type: "standard" }, SECRET, std(SECRET, String(Math.floor(now / 1000) - 600)), body, now), "stale");
  assert.ok(!await verifySignature({ type: "standard" }, SECRET, std(SECRET), '{"a":2}', now), "tampered body");

  const hmac = { type: "hmac-sha256" as const, header: "x-hub-signature-256", prefix: "sha256=" };
  const digest = createHmac("sha256", PLAIN).update(body).digest("hex");
  assert.ok(await verifySignature(hmac, PLAIN, new Headers({ "X-Hub-Signature-256": `sha256=${digest}` }), body));
  assert.ok(!await verifySignature(hmac, PLAIN, new Headers({ "X-Hub-Signature-256": digest }), body), "prefix required");
  assert.ok(!await verifySignature(hmac, PLAIN, new Headers({ "X-Hub-Signature-256": `sha256=${digest}` }), '{"a":2}'));
  const b64 = { type: "hmac-sha256" as const, header: "linear-signature", encoding: "base64" as const };
  assert.ok(await verifySignature(b64, PLAIN, new Headers({ "Linear-Signature": createHmac("sha256", PLAIN).update(body).digest("base64") }), body));

  assert.ok(await verifySignature({ type: "token", header: "x-token" }, PLAIN, new Headers({ "X-Token": PLAIN }), body));
  assert.ok(!await verifySignature({ type: "token", header: "x-token" }, PLAIN, new Headers({ "X-Token": PLAIN + "x" }), body));
  assert.ok(!await verifySignature({ type: "token", header: "x-token" }, PLAIN, new Headers(), body));
});

channelTest("tests/channels-webhook.test.ts:128", "a webhook channel is public by default, masks its secret and takes only valid settings", async (_t, r) => {
  const channel = await createChannel(r);
  assert.equal(channel.webhookUrl, `https://agents.example.test/channels/webhook/${channel.id}`);
  assert.deepEqual(channel.access, { public: true, allow: [] });
  assert.equal(channel.limits.perSenderPerMinute, 60);
  assert.deepEqual(channel.credentials, { secret: `…${SECRET.slice(-4)}` });
  assert.deepEqual(channel.settings, { signature: { type: "standard" } });
  const short = await r.call("/v1/channels", { body: { type: "webhook", credentials: { secret: "short" } } });
  assert.equal(short.status, 400);
  assert.match(short.json.error, /at least 16/);
  const ftp = await r.call("/v1/channels", { body: { type: "webhook", credentials: { secret: PLAIN, replyUrl: "ftp://example.com" } } });
  assert.equal(ftp.status, 400);
  assert.match(ftp.json.error, /replyUrl/);
  const nope = await r.call(`/v1/channels/${channel.id}`, { method: "PATCH", body: { settings: { signature: "nope" } } });
  assert.equal(nope.status, 400);
  assert.match(nope.json.error, /standard, hmac-sha256 or token/);
  const updated = await r.call(`/v1/channels/${channel.id}`, { method: "PATCH", body: { settings: { key: "k-{{id}}" } } });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.json.settings, { signature: { type: "standard" }, key: "k-{{id}}" });
  const locked = await createChannel(r, { credentials: { secret: PLAIN }, access: { public: false, allow: ["ops"] } });
  assert.deepEqual(locked.access, { public: false, allow: ["ops"] });
});

channelTest("tests/channels-webhook.test.ts:144", "deliveries are verified, filtered, deduped, keyed to one agent each, and carry the payload as a file", async (_t, r) => {
  r.setModel(() => ({ role: "assistant", content: "Triaged." }));
  const channel = await createChannel(r, { settings: { key: "sentry-{{data.issue.id}}", filter: [{ path: "action", in: ["created"] }], sender: "{{actor.email}}" } });
  const issue = (id: number, action = "created") => ({ action, data: { issue: { id, title: `Issue ${id}` } }, actor: { email: "ada@example.com" } });

  assert.equal((await post(r, channel, issue(1), { "webhook-id": "x", "webhook-timestamp": "1", "webhook-signature": "v1,AAAA" })).status, 401);
  assert.equal((await post(r, channel, issue(1), undefined, { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
  assert.equal((await post(r, channel, issue(1), undefined, { secret: "whsec_" + randomBytes(24).toString("base64") })).status, 401);
  assert.equal((await post(r, channel, issue(1, "resolved"))).status, 200);
  await sleep(500);
  assert.equal(r.model.bodies.length, 0, "filtered out");

  assert.equal((await post(r, channel, issue(1), undefined, { id: "evt_1" })).status, 200);
  assert.equal((await post(r, channel, issue(1), undefined, { id: "evt_1" })).status, 200);
  await post(r, channel, issue(1), undefined, { id: "evt_2" });
  await post(r, channel, issue(2), undefined, { id: "evt_3" });
  await until(() => r.model.bodies.length >= 3, "three prompts");
  await sleep(500);
  assert.equal(r.model.bodies.length, 3, "the retried delivery is dropped");
  // Deliveries for different keys run independently, so issue 2's prompt may come before issue 1's second.
  const prompts = r.model.bodies.map(body => ({ body, ...asked(body) }));
  const of = (id: number) => prompts.filter(prompt => prompt.text.includes(`"id": ${id},`));
  const [first, second] = of(1), [third] = of(2);
  assert.equal(of(1).length, 2);
  const users = (prompt: { body: any }) => prompt.body.messages.filter((message: any) => message.role === "user").length;
  assert.deepEqual([users(first!), users(second!), users(third!)].sort(), [1, 1, 2], "one agent per key");
  assert.deepEqual((await agents(r)).map(agent => agent.name).sort(), ["Webhook: sentry-1", "Webhook: sentry-2"]);
  assert.match(first!.text, /^A webhook delivery arrived:\n```json\n\{\n  "action": "created"/);
  assert.equal(first!.from.id, "webhook:ada@example.com");
  assert.ok(first!.rest.length > 0, "the payload came as a file");
  const one = (await agents(r)).find(agent => agent.name === "Webhook: sentry-1")!;
  const workspace = await uploaded(r.call, r.base, OPERATOR, one.id, inboundItemId(channel.id, "id:evt_1"));
  assert.equal(workspace.listed.length, 1);
  assert.match(workspace.listed[0]!.path, /\/payload\.json$/);
  assert.equal(workspace.listed[0]!.contentType, "application/json");
  assert.deepEqual(JSON.parse((await workspace.read(workspace.listed[0]!.path)).toString()), issue(1));
});

channelTest("tests/channels-webhook.test.ts:179", "an HMAC channel with a prompt template and no delivery id dedupes by body", async (_t, r) => {
  r.setModel(() => ({ role: "assistant", content: "Triaged." }));
  const channel = await createChannel(r, { credentials: { secret: PLAIN }, settings: { signature: { type: "hmac-sha256", header: "X-Signature", prefix: "sha256=" }, prompt: "Linear issue {{data.identifier}} was {{action}}: {{data.title}}" } });
  const payload = { action: "create", data: { identifier: "ENG-12", title: "Fix login" } };
  const signature = `sha256=${createHmac("sha256", PLAIN).update(JSON.stringify(payload)).digest("hex")}`;
  assert.equal((await post(r, channel, payload, { "X-Signature": signature })).status, 200);
  assert.equal((await post(r, channel, payload, { "X-Signature": signature })).status, 200);
  assert.equal((await post(r, channel, payload, { "X-Signature": "sha256=00" })).status, 401);
  await until(() => r.model.bodies.length, "a prompt");
  await sleep(500);
  assert.equal(r.model.bodies.length, 1);
  assert.equal(asked(r.model.bodies[0]).text, "Linear issue ENG-12 was create: Fix login");
  const conversations = (await r.channelQuery("select conversation from channel_conversations")).rows.map(row => row.conversation);
  assert.deepEqual(conversations, ["default"], "one conversation for the channel without a key");
});

channelTest("tests/channels-webhook.test.ts:193", "with a replyUrl the reply is posted there, signed with the channel's secret", async (_t, r) => {
  r.setModel(() => ({ role: "assistant", content: "Triaged." }));
  const channel = await createChannel(r, { credentials: { secret: SECRET, replyUrl: r.target.url } });
  assert.deepEqual(channel.credentials, { secret: `…${SECRET.slice(-4)}`, replyUrl: new URL(r.target.url).origin });
  await post(r, channel, { hello: "world" });
  const reply = await until(() => r.target.posts[0], "the reply");
  assert.deepEqual(JSON.parse(reply.body), { type: "message", conversationId: "default", text: "Triaged." });
  const headers = new Headers(reply.headers as Record<string, string>);
  assert.ok(await verifySignature({ type: "standard" }, SECRET, headers, reply.body), "signed per Standard Webhooks");
});

channelTest("tests/channels-webhook.test.ts:144", "a key too long or with dots for an agent id still gets its own agent, the same one each time", async (_t, r) => {
  r.setModel(() => ({ role: "assistant", content: "Triaged." }));
  const channel = await createChannel(r, { settings: { key: "{{thread}}" } });
  const long = "ticket-" + "x".repeat(55), dotted = "1699999999.123456";
  for (const [thread, id] of [[long, "a1"], [dotted, "a2"], [long, "a3"]] as const) await post(r, channel, { thread }, undefined, { id });
  await until(() => r.model.bodies.length === 3, "three prompts");
  assert.equal((await agents(r)).length, 2, "one agent per key, however the key looks");
  assert.deepEqual(r.model.bodies.map(body => body.messages.filter((message: any) => message.role === "user").length).sort(), [1, 1, 2]);
});
