import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { Definitions } from "../src/definitions.ts";
import { Channels, type ChannelInput } from "../src/channels.ts";
import { Outbound } from "../src/outbound.ts";
import { conversationKey, matches, render, verifySignature, webhook, webhookSettings } from "../src/channels-webhook.ts";
import { testDatabase } from "./database.ts";
import { memoryFiles } from "./channel-files.ts";

type T = { after(fn: () => Promise<void> | void): void };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const SECRET = "whsec_" + randomBytes(24).toString("base64");
const PLAIN = "a-plain-shared-secret-0123456789";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function until<V>(check: () => V | Promise<V>, what: string, timeoutMs = 10_000): Promise<Exclude<V, false | 0 | "" | null | undefined>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as Exclude<V, false | 0 | "" | null | undefined>;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** Where replies are posted, when a channel has a replyUrl. */
async function receiver(t: T, status = 200) {
  const posts: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    posts.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(status).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/replies`, posts };
}

async function setup(t: T, input: Partial<ChannelInput> = {}) {
  const { db } = await testDatabase();
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db, secretsKey: randomBytes(32).toString("hex") });
  const prompts: { agent: string; text: string; from?: { id: string }; files?: { path: string }[] }[] = [];
  const created: { key: string; name: string }[] = [];
  const workspace = memoryFiles();
  const outbound = new Outbound({ allowHttp: true, allow: ["127.0.0.0/8"] });
  const channels: Channels = new Channels({
    db, definitions: new Definitions({ db }), accounts, node: "a", publicUrl: "https://agents.example.test", files: workspace.files,
    providers: { webhook: webhook({ outbound }) },
    createAgent: async (_tenant, params, key) => { created.push({ key, name: params.name }); return { id: `client_${sha(key).slice(0, 40)}` }; },
    agentId: (_tenant, key) => `client_${sha(key).slice(0, 40)}`, live: async () => true,
    submit: async (agent, tenant, request) => {
      const params = request.params as { text: string; from?: { id: string }; files?: { path: string }[] };
      prompts.push({ agent, text: params.text, from: params.from, ...(params.files ? { files: params.files } : {}) });
      setImmediate(() => channels.hooks.runEnded!({ id: agent, tenant }, {
        id: request.id, method: "prompt", fingerprint: "", state: "completed", outcome: { result: { reply: "Triaged.", presented: [] } },
      }));
      return { id: request.id, method: "prompt", fingerprint: "", state: "running" };
    },
  });
  t.after(() => channels.stop());
  const channel = await channels.create("default", { type: "webhook", credentials: { secret: SECRET }, ...input });
  /** Deliver a payload signed per Standard Webhooks, or with the given headers instead. */
  const post = (payload: unknown, headers?: Record<string, string>, options: { id?: string; timestamp?: number; secret?: string } = {}) => {
    const body = JSON.stringify(payload);
    const id = options.id ?? `msg_${randomBytes(6).toString("hex")}`;
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    const key = Buffer.from((options.secret ?? SECRET).slice(6), "base64");
    const standard = { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}` };
    return channels.app.request(`/channels/webhook/${channel.id}`, { method: "POST", headers: { "Content-Type": "application/json", ...(headers ?? standard) }, body });
  };
  return { db, channels, channel, prompts, created, post, workspace };
}

test("templates, filters and keys are small pure functions", () => {
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

test("each signature mode accepts good deliveries and refuses bad or stale ones", () => {
  const body = '{"a":1}';
  const now = Date.now();
  const ts = String(Math.floor(now / 1000));
  const std = (secret: string, timestamp = ts) => new Headers({ "webhook-id": "m1", "webhook-timestamp": timestamp, "webhook-signature": `v1,wrong v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`m1.${timestamp}.${body}`).digest("base64")}` });
  assert.ok(verifySignature({ type: "standard" }, SECRET, std(SECRET), body, now), "any of several signatures");
  assert.ok(!verifySignature({ type: "standard" }, SECRET, std("whsec_" + randomBytes(24).toString("base64")), body, now));
  assert.ok(!verifySignature({ type: "standard" }, SECRET, std(SECRET, String(Math.floor(now / 1000) - 600)), body, now), "stale");
  assert.ok(!verifySignature({ type: "standard" }, SECRET, std(SECRET), '{"a":2}', now), "tampered body");

  const hmac = { type: "hmac-sha256" as const, header: "x-hub-signature-256", prefix: "sha256=" };
  const digest = createHmac("sha256", PLAIN).update(body).digest("hex");
  assert.ok(verifySignature(hmac, PLAIN, new Headers({ "X-Hub-Signature-256": `sha256=${digest}` }), body));
  assert.ok(!verifySignature(hmac, PLAIN, new Headers({ "X-Hub-Signature-256": digest }), body), "prefix required");
  assert.ok(!verifySignature(hmac, PLAIN, new Headers({ "X-Hub-Signature-256": `sha256=${digest}` }), '{"a":2}'));
  const b64 = { type: "hmac-sha256" as const, header: "linear-signature", encoding: "base64" as const };
  assert.ok(verifySignature(b64, PLAIN, new Headers({ "Linear-Signature": createHmac("sha256", PLAIN).update(body).digest("base64") }), body));

  assert.ok(verifySignature({ type: "token", header: "x-token" }, PLAIN, new Headers({ "X-Token": PLAIN }), body));
  assert.ok(!verifySignature({ type: "token", header: "x-token" }, PLAIN, new Headers({ "X-Token": PLAIN + "x" }), body));
  assert.ok(!verifySignature({ type: "token", header: "x-token" }, PLAIN, new Headers(), body));
});

test("a webhook channel is public by default, masks its secret and takes only valid settings", async t => {
  const r = await setup(t);
  assert.equal(r.channel.webhookUrl, `https://agents.example.test/channels/webhook/${r.channel.id}`);
  assert.deepEqual(r.channel.access, { public: true, allow: [] });
  assert.equal(r.channel.limits.perSenderPerMinute, 60);
  assert.deepEqual(r.channel.credentials, { secret: `…${SECRET.slice(-4)}` });
  assert.deepEqual(r.channel.settings, { signature: { type: "standard" } });
  await assert.rejects(r.channels.create("default", { type: "webhook", credentials: { secret: "short" } }), /at least 16/);
  await assert.rejects(r.channels.create("default", { type: "webhook", credentials: { secret: PLAIN, replyUrl: "ftp://example.com" } }), /replyUrl/);
  await assert.rejects(r.channels.update("default", r.channel.id, { settings: { signature: "nope" } }), /standard, hmac-sha256 or token/);
  const updated = await r.channels.update("default", r.channel.id, { settings: { key: "k-{{id}}" } });
  assert.deepEqual(updated.settings, { signature: { type: "standard" }, key: "k-{{id}}" });
  const locked = await r.channels.create("default", { type: "webhook", credentials: { secret: PLAIN }, access: { public: false, allow: ["ops"] } });
  assert.deepEqual(locked.access, { public: false, allow: ["ops"] });
});

test("deliveries are verified, filtered, deduped, keyed to one agent each, and carry the payload as a file", async t => {
  const r = await setup(t, { settings: { key: "sentry-{{data.issue.id}}", filter: [{ path: "action", in: ["created"] }], sender: "{{actor.email}}" } });
  const issue = (id: number, action = "created") => ({ action, data: { issue: { id, title: `Issue ${id}` } }, actor: { email: "ada@example.com" } });

  assert.equal((await r.post(issue(1), { "webhook-id": "x", "webhook-timestamp": "1", "webhook-signature": "v1,AAAA" })).status, 401);
  assert.equal((await r.post(issue(1), undefined, { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
  assert.equal((await r.post(issue(1), undefined, { secret: "whsec_" + randomBytes(24).toString("base64") })).status, 401);
  assert.equal((await r.post(issue(1, "resolved"))).status, 200);
  await sleep(100);
  assert.equal(r.prompts.length, 0, "filtered out");

  assert.equal((await r.post(issue(1), undefined, { id: "evt_1" })).status, 200);
  assert.equal((await r.post(issue(1), undefined, { id: "evt_1" })).status, 200);
  await r.post(issue(1), undefined, { id: "evt_2" });
  await r.post(issue(2), undefined, { id: "evt_3" });
  await until(() => r.prompts.length >= 3, "three prompts");
  await sleep(100);
  assert.equal(r.prompts.length, 3, "the retried delivery is dropped");
  // Deliveries for different keys run independently, so issue 2's prompt may come before issue 1's second.
  const of = (id: number) => r.prompts.filter(prompt => prompt.text.includes(`"id": ${id},`));
  const [first, second] = of(1), [third] = of(2);
  assert.equal(of(1).length, 2);
  assert.equal(first.agent, second.agent, "one agent per key");
  assert.notEqual(first.agent, third.agent);
  assert.deepEqual(r.created.map(agent => agent.name).sort(), ["Webhook: sentry-1", "Webhook: sentry-2"]);
  assert.match(first.text, /^A webhook delivery arrived:\n```json\n\{\n  "action": "created"/);
  assert.equal(first.from?.id, "webhook:ada@example.com");
  assert.equal(first.files?.length, 1);
  const saved = r.workspace.saved.get(first.files![0].path)!;
  assert.match(first.files![0].path, /\/payload\.json$/);
  assert.deepEqual(JSON.parse(saved.data.toString()), issue(1));
  assert.equal(saved.contentType, "application/json");
});

test("an HMAC channel with a prompt template and no delivery id dedupes by body", async t => {
  const r = await setup(t, { credentials: { secret: PLAIN }, settings: { signature: { type: "hmac-sha256", header: "X-Signature", prefix: "sha256=" }, prompt: "Linear issue {{data.identifier}} was {{action}}: {{data.title}}" } });
  const payload = { action: "create", data: { identifier: "ENG-12", title: "Fix login" } };
  const signature = `sha256=${createHmac("sha256", PLAIN).update(JSON.stringify(payload)).digest("hex")}`;
  assert.equal((await r.post(payload, { "X-Signature": signature })).status, 200);
  assert.equal((await r.post(payload, { "X-Signature": signature })).status, 200);
  assert.equal((await r.post(payload, { "X-Signature": "sha256=00" })).status, 401);
  await until(() => r.prompts.length, "a prompt");
  await sleep(100);
  assert.equal(r.prompts.length, 1);
  assert.equal(r.prompts[0].text, "Linear issue ENG-12 was create: Fix login");
  assert.equal(r.created[0].key.endsWith("-default"), true, "one conversation for the channel without a key");
});

test("with a replyUrl the reply is posted there, signed with the channel's secret", async t => {
  const target = await receiver(t);
  const r = await setup(t, { credentials: { secret: SECRET, replyUrl: target.url } });
  assert.deepEqual(r.channel.credentials, { secret: `…${SECRET.slice(-4)}`, replyUrl: new URL(target.url).origin });
  await r.post({ hello: "world" });
  const post = await until(() => target.posts[0], "the reply");
  assert.deepEqual(JSON.parse(post.body), { type: "message", conversationId: "default", text: "Triaged." });
  const headers = new Headers(post.headers as Record<string, string>);
  assert.ok(verifySignature({ type: "standard" }, SECRET, headers, post.body), "signed per Standard Webhooks");
});
