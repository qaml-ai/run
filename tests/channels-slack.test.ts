import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { Definitions } from "../src/definitions.ts";
import { Channels } from "../src/channels.ts";
import { slack } from "../src/channels-slack.ts";
import { testDatabase } from "./database.ts";

type T = { after(fn: () => Promise<void> | void): void };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const BOT_TOKEN = "xoxb-1111-2222-FixtureSlackBotToken";
const SIGNING_SECRET = "8f742231b10e8888abcd99aaabbb85a5";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
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

/** A local stand-in for Slack's Web API and file host; the real one is never called. */
async function fakeSlack(t: T) {
  const calls: { method: string; body: any }[] = [];
  const downloads: string[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const answer = (value: object, status = 200) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value));
    if (req.url!.startsWith("/files/")) {
      downloads.push(req.headers.authorization ?? "");
      if (req.headers.authorization !== `Bearer ${BOT_TOKEN}`) { res.writeHead(200, { "Content-Type": "text/html" }).end("<html>sign in</html>"); return; }
      res.writeHead(200, { "Content-Type": "image/png" }).end(PNG);
      return;
    }
    if (req.headers.authorization !== `Bearer ${BOT_TOKEN}`) return answer({ ok: false, error: "invalid_auth" });
    const method = req.url!.slice(1);
    const body = text ? JSON.parse(text) : {};
    calls.push({ method, body });
    if (method === "auth.test") return answer({ ok: true, user_id: "UBOT", user: "fixture_bot", team_id: "T1", team: "Fixture" });
    if (method === "chat.postMessage" && body.channel === "CGONE") return answer({ ok: false, error: "channel_not_found" });
    return answer({ ok: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls, downloads,
    posts: () => calls.filter(call => call.method === "chat.postMessage").map(call => call.body),
  };
}

async function setup(t: T) {
  const api = await fakeSlack(t);
  const { db } = await testDatabase();
  const accounts = new Accounts({ tenants: new Tenants({ legacyToken: "slack-operator-token-at-least-24-chars" }), db, secretsKey: randomBytes(32).toString("hex") });
  const prompts: { agent: string; text: string; from?: unknown; images: number }[] = [];
  const channels: Channels = new Channels({
    db, definitions: new Definitions({ db }), accounts, node: "a", publicUrl: "https://agents.example.test",
    providers: { slack: slack({ apiUrl: api.url }) },
    createAgent: async (_tenant, _params, key) => ({ id: `client_${sha(key).slice(0, 40)}` }), agentId: (_tenant, key) => `client_${sha(key).slice(0, 40)}`, live: async () => true,
    // Each prompt's turn ends at once, answering with what it was asked.
    submit: async (agent, tenant, request) => {
      const params = request.params as { text: string; from?: unknown; images?: unknown[] };
      prompts.push({ agent, text: params.text, from: params.from, images: params.images?.length ?? 0 });
      setImmediate(() => channels.hooks.runEnded!({ id: agent, tenant }, {
        id: request.id, method: "prompt", fingerprint: "", state: "completed", outcome: { result: { reply: `re: ${params.text.split("\n").at(-1)} <ok> & done` } },
      }));
      return { id: request.id, method: "prompt", fingerprint: "", state: "running" };
    },
  });
  const channel = await channels.create("default", { type: "slack", credentials: { botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET }, access: { allow: ["U_ADA"] } });
  /** Deliver a payload as Slack would: signed with the signing secret over the timestamp and raw body. */
  const post = (payload: object, options: { secret?: string; timestamp?: number } = {}) => {
    const body = JSON.stringify(payload);
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac("sha256", options.secret ?? SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest("hex")}`;
    return channels.app.request(`/channels/slack/${channel.id}`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Slack-Request-Timestamp": timestamp, "X-Slack-Signature": signature }, body,
    });
  };
  const event = (fields: Record<string, unknown>) => post({ type: "event_callback", event_id: `Ev${randomBytes(4).toString("hex")}`, event: { user: "U_ADA", ...fields } });
  return { api, db, channels, channel, prompts, post, event };
}

test("a Slack channel checks its credentials, keeps them sealed, and gives the URL to paste into the app", async t => {
  const r = await setup(t);
  assert.equal(r.channel.webhookUrl, `https://agents.example.test/channels/slack/${r.channel.id}`);
  assert.deepEqual(r.channel.account, { id: "UBOT", username: "fixture_bot", teamId: "T1", team: "Fixture" });
  assert.deepEqual(r.channel.credentials, { botToken: "xoxb-…oken", signingSecret: `…${SIGNING_SECRET.slice(-4)}` });
  assert.equal(r.channel.name, "Slack @fixture_bot");
  const stored = JSON.stringify((await r.db.query("select channel from channels")).rows[0].channel);
  assert.ok(!stored.includes(BOT_TOKEN) && !stored.includes(SIGNING_SECRET), "credentials are stored sealed");

  await assert.rejects(r.channels.create("default", { type: "slack", credentials: { botToken: BOT_TOKEN } }), /signingSecret/);
  await assert.rejects(r.channels.create("default", { type: "slack", credentials: { botToken: "xoxb-9999-wrong-token-here", signingSecret: SIGNING_SECRET } }), /invalid_auth/);
});

test("Slack's URL check is answered only when signed, and stale or forged deliveries are refused", async t => {
  const r = await setup(t);
  const challenge = { type: "url_verification", challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P" };
  const answered = await r.post(challenge);
  assert.equal(answered.status, 200);
  assert.deepEqual(await answered.json(), { challenge: challenge.challenge });
  assert.equal((await r.post(challenge, { secret: "0".repeat(32) })).status, 401);
  assert.equal((await r.post(challenge, { timestamp: Math.floor(Date.now() / 1000) - 600 })).status, 401);
  const unsigned = await r.channels.app.request(`/channels/slack/${r.channel.id}`, { method: "POST", body: JSON.stringify(challenge) });
  assert.equal(unsigned.status, 401);
});

test("a mention starts a thread with its own agent; replies in it continue; DMs are their own conversation", async t => {
  const r = await setup(t);
  assert.equal((await r.event({ type: "app_mention", channel: "C1", ts: "100.0001", text: "<@UBOT> what's up?" })).status, 200);
  await until(() => r.api.posts().length === 1, "the threaded reply");
  // The answer goes into a thread on the mention, escaped for Slack.
  assert.deepEqual(r.api.posts()[0], { channel: "C1", thread_ts: "100.0001", text: "re: what's up? &lt;ok&gt; &amp; done", unfurl_links: false, unfurl_media: false });
  assert.equal(r.prompts[0].text, "what's up?");
  assert.deepEqual(r.prompts[0].from, { id: "slack:U_ADA" });

  // Slack sends the same message as `message` too, and retries: it is answered once.
  await r.event({ type: "message", channel_type: "channel", channel: "C1", ts: "100.0001", text: "<@UBOT> what's up?" });
  await r.event({ type: "app_mention", channel: "C1", ts: "100.0001", text: "<@UBOT> what's up?" });
  // A reply in the thread without a mention reaches the same agent.
  await r.event({ type: "message", channel_type: "channel", channel: "C1", ts: "101.0001", thread_ts: "100.0001", text: "and then?" });
  await until(() => r.api.posts().length === 2, "the reply in the thread");
  assert.equal(r.prompts.length, 2);
  assert.equal(r.prompts[1].agent, r.prompts[0].agent);
  assert.deepEqual({ ...r.api.posts()[1], text: undefined }, { channel: "C1", thread_ts: "100.0001", text: undefined, unfurl_links: false, unfurl_media: false });

  // Threads the bot was never asked into, plain channel chatter, bots and edits are ignored.
  await r.event({ type: "message", channel_type: "channel", channel: "C1", ts: "200.0001", thread_ts: "150.0001", text: "unrelated thread" });
  await r.event({ type: "message", channel_type: "channel", channel: "C1", ts: "201.0001", text: "chatter" });
  await r.event({ type: "message", channel_type: "channel", channel: "C1", ts: "202.0001", thread_ts: "100.0001", text: "bot says", bot_id: "B1" });
  await r.event({ type: "message", subtype: "message_changed", channel_type: "channel", channel: "C1", ts: "203.0001", thread_ts: "100.0001", text: "edited" });
  // Someone not on the allowlist is ignored even when mentioning the bot.
  await r.event({ type: "app_mention", channel: "C1", ts: "204.0001", text: "<@UBOT> hi", user: "U_EVE" });

  // A DM is one conversation, answered in place.
  await r.event({ type: "message", channel_type: "im", channel: "D1", ts: "300.0001", text: "hello in private" });
  await until(() => r.api.posts().length === 3, "the DM reply");
  assert.deepEqual(r.api.posts()[2].channel, "D1");
  assert.equal("thread_ts" in r.api.posts()[2], false);
  assert.notEqual(r.prompts[2].agent, r.prompts[0].agent);
  await sleep(200);
  assert.equal(r.prompts.length, 3);
  const conversations = (await r.db.query("select conversation from channel_conversations order by conversation")).rows.map(row => row.conversation);
  assert.deepEqual(conversations, ["C1-100.0001", "D1"]);
});

test("Slack images are fetched with the bot token from Slack's file host only", async t => {
  const r = await setup(t);
  await r.event({
    type: "message", subtype: "file_share", channel_type: "im", channel: "D1", ts: "1.0001", text: "look",
    files: [
      { mimetype: "image/png", size: PNG.length, url_private: `${r.api.url}/files/cat.png` },
      { mimetype: "image/png", size: PNG.length, url_private: "https://attacker.example/steal.png" },
      { mimetype: "application/pdf", size: 10, url_private: `${r.api.url}/files/doc.pdf` },
    ],
  });
  await until(() => r.prompts.length === 1, "the prompt");
  assert.equal(r.prompts[0].images, 1);
  assert.deepEqual(r.api.downloads, [`Bearer ${BOT_TOKEN}`]);
});

test("a Slack send to a channel that is gone is not retried", async t => {
  const r = await setup(t);
  await r.event({ type: "app_mention", channel: "CGONE", ts: "5.0001", text: "<@UBOT> hi" });
  await until(() => r.api.calls.some(call => call.method === "chat.postMessage"), "the send");
  await until(async () => (await r.db.query("select count(*)::int as count from channel_items")).rows[0].count === 0, "the item dropped");
  assert.equal(r.api.calls.filter(call => call.method === "chat.postMessage").length, 1);
});
