import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { Definitions } from "../src/definitions.ts";
import { Channels } from "../src/channels.ts";
import { Ownership } from "../src/ownership.ts";
import { discord, parseMessage } from "../src/channels-discord.ts";
import { testDatabase } from "./database.ts";

type T = { after(fn: () => Promise<void> | void): void };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const BOT_TOKEN = "MTAxMjM0NTY3ODkwMTIzNDU2.GFixture.DiscordBotTokenSecretPart_abcdefXYZ0123";
const BOT_ID = "999000000000000001";
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

/** A local stand-in for Discord's REST API and Gateway; the real ones are never called. */
async function fakeDiscord(t: T) {
  const calls: { method: string; path: string; body: any }[] = [];
  /** Every gateway payload a client sent, by connection. */
  const received: { socket: WebSocket; op: number; d: any }[] = [];
  const state = { closeOnIdentify: 0 as number, sessions: 0, hello: true, ready: true };
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const answer = (status: number, value?: object) => value ? res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(value)) : res.writeHead(status).end();
    if (req.headers.authorization !== `Bot ${BOT_TOKEN}`) return answer(401, { message: "401: Unauthorized", code: 0 });
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ method: req.method!, path: req.url!, body });
    if (req.url === "/users/@me") return answer(200, { id: BOT_ID, username: "fixture_bot", bot: true });
    if (req.url === "/gateway/bot") return answer(200, { url: gatewayUrl });
    if (/^\/channels\/\d+\/typing$/.test(req.url!)) return answer(204);
    if (req.url === "/channels/404/messages") return answer(404, { message: "Unknown Channel", code: 10003 });
    return answer(200, { id: "1" });
  });
  const wss = new WebSocketServer({ server });
  const sockets = new Set<WebSocket>();
  let sequence = 0;
  const dispatch = (socket: WebSocket, t: string, d: unknown) => socket.send(JSON.stringify({ op: 0, t, s: ++sequence, d }));
  wss.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    if (state.hello) socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 200 } }));
    socket.on("message", data => {
      const payload = JSON.parse(String(data));
      received.push({ socket, ...payload });
      if (payload.op === 1) socket.send(JSON.stringify({ op: 11 }));
      if (payload.op === 2) {
        if (payload.d.token !== BOT_TOKEN || state.closeOnIdentify) { socket.close(state.closeOnIdentify || 4004, "Authentication failed."); return; }
        if (state.ready) dispatch(socket, "READY", { session_id: `session-${++state.sessions}`, resume_gateway_url: gatewayUrl, user: { id: BOT_ID, username: "fixture_bot", bot: true } });
      }
      if (payload.op === 6) dispatch(socket, "RESUMED", {});
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const gatewayUrl = `ws://127.0.0.1:${port}`;
  t.after(async () => { for (const socket of wss.clients) socket.terminate(); wss.close(); server.closeAllConnections(); server.close(); });
  const identified = () => received.filter(entry => entry.op === 2);
  return {
    url: `http://127.0.0.1:${port}`, calls, received, state, sockets, identified,
    /** Push a message to whichever connection has identified, as Discord would. */
    message: (d: Record<string, unknown>) => {
      const ready = [...sockets].filter(socket => received.some(entry => entry.socket === socket && (entry.op === 2 || entry.op === 6)));
      assert.equal(ready.length, 1, "exactly one live gateway connection");
      dispatch(ready[0], "MESSAGE_CREATE", { type: 0, mentions: [], attachments: [], ...d });
    },
    sent: (channel?: string) => calls.filter(call => call.method === "POST" && /\/messages$/.test(call.path) && (!channel || call.path === `/channels/${channel}/messages`)).map(call => call.body),
  };
}

async function node(t: T, api: { url: string }, db: Awaited<ReturnType<typeof testDatabase>>["db"], secretsKey: string, name: string) {
  const ownership = new Ownership(db, { node: name, ttlMs: 60_000 });
  await ownership.start();
  const prompts: { agent: string; text: string; from?: unknown }[] = [];
  const channels: Channels = new Channels({
    db, definitions: new Definitions({ db }), accounts: new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db, secretsKey }),
    node: name, publicUrl: "https://agents.example.test", ownership,
    providers: { discord: discord({ apiUrl: api.url }) },
    createAgent: async (_tenant, _params, key) => ({ id: `client_${sha(key).slice(0, 40)}` }), agentId: (_tenant, key) => `client_${sha(key).slice(0, 40)}`, live: async () => true,
    submit: async (agent, tenant, request) => {
      const { text, from } = request.params as { text: string; from?: unknown };
      prompts.push({ agent, text, from });
      setImmediate(() => channels.hooks.runEnded!({ id: agent, tenant }, {
        id: request.id, method: "prompt", fingerprint: "", state: "completed", outcome: { result: { reply: `re: ${text.split("\n").at(-1)} @everyone` } },
      }));
      return { id: request.id, method: "prompt", fingerprint: "", state: "running" };
    },
  });
  t.after(async () => { channels.stop(); await ownership.close().catch(() => {}); });
  return { channels, ownership, prompts };
}

const ada = { id: "111", username: "ada", global_name: "Ada" };

test("a Discord bot is checked, holds one gateway connection across nodes, and answers DMs and mentions", async t => {
  const api = await fakeDiscord(t);
  const { db } = await testDatabase();
  const secretsKey = randomBytes(32).toString("hex");
  const a = await node(t, api, db, secretsKey, "a");
  const b = await node(t, api, db, secretsKey, "b");

  await assert.rejects(a.channels.create("default", { type: "discord", credentials: { botToken: `${BOT_TOKEN}x` } }), /rejected/);
  const channel = await a.channels.create("default", { type: "discord", credentials: { botToken: BOT_TOKEN }, access: { allow: ["@ada"] } });
  assert.equal(channel.webhookUrl, undefined, "Discord has no webhook");
  assert.deepEqual(channel.account, { id: BOT_ID, username: "fixture_bot" });
  assert.deepEqual(channel.credentials, { botToken: "…0123" });
  assert.equal((await a.channels.app.request(`/channels/discord/${channel.id}`, { method: "POST", body: "{}" })).status, 404);

  // Both nodes scan; only one takes the channel and identifies.
  await Promise.all([a.channels.scan(), b.channels.scan()]);
  await until(() => api.received.some(entry => entry.op === 2), "an identify");
  await Promise.all([a.channels.scan(), b.channels.scan()]);
  await sleep(300);
  assert.equal(api.identified().length, 1);
  assert.equal(api.identified()[0].d.intents, (1 << 9) | (1 << 12));
  assert.ok(api.received.some(entry => entry.op === 1), "the connection heartbeats");

  // A DM is answered; mentions are never pinged by the reply.
  api.message({ id: "5001", channel_id: "2001", author: ada, content: "hello there" });
  await until(() => api.sent("2001").length === 1, "the DM reply");
  assert.deepEqual(api.sent("2001")[0], { content: "re: hello there @everyone", allowed_mentions: { parse: [] } });
  const prompts = () => [...a.prompts, ...b.prompts];
  assert.equal(prompts()[0].text, "hello there");
  assert.deepEqual(prompts()[0].from, { id: "discord:111", name: "Ada", username: "ada" });
  assert.ok(api.calls.some(call => call.path === "/channels/2001/typing"), "typing is shown");

  // In a server, only messages that mention the bot are answered, without the mention.
  api.message({ id: "5002", channel_id: "3001", guild_id: "9", author: ada, content: "just chatting" });
  api.message({ id: "5003", channel_id: "3001", guild_id: "9", author: ada, content: `<@${BOT_ID}> summarize`, mentions: [{ id: BOT_ID }] });
  api.message({ id: "5004", channel_id: "3001", guild_id: "9", author: { id: "222", username: "eve" }, content: `<@${BOT_ID}> hi`, mentions: [{ id: BOT_ID }] });
  api.message({ id: "5005", channel_id: "3001", guild_id: "9", author: { id: "333", username: "otherbot", bot: true }, content: `<@${BOT_ID}> hi`, mentions: [{ id: BOT_ID }] });
  await until(() => api.sent("3001").length === 1, "the mention reply");
  assert.equal(prompts()[1].text, "summarize");
  // A repeated delivery (as after a resume) is answered once.
  api.message({ id: "5003", channel_id: "3001", guild_id: "9", author: ada, content: `<@${BOT_ID}> summarize`, mentions: [{ id: BOT_ID }] });
  await sleep(300);
  assert.equal(prompts().length, 2);
  assert.equal(api.sent("3001").length, 1);
});

test("a Discord connection resumes when asked to reconnect, moves to another node when its holder leaves, and stops on a rejected token", async t => {
  const api = await fakeDiscord(t);
  const { db } = await testDatabase();
  const secretsKey = randomBytes(32).toString("hex");
  const a = await node(t, api, db, secretsKey, "a");
  const b = await node(t, api, db, secretsKey, "b");
  const channel = await a.channels.create("default", { type: "discord", credentials: { botToken: BOT_TOKEN }, access: { public: true } });
  await a.channels.scan();
  await until(() => api.identified().length === 1, "a's identify");

  // Discord asks for a reconnect: the client resumes its session rather than identifying again.
  const [first] = api.sockets;
  first.send(JSON.stringify({ op: 7, d: null }));
  const resume = await until(() => api.received.find(entry => entry.op === 6), "a resume");
  assert.equal(resume.d.session_id, "session-1");
  assert.equal(api.identified().length, 1);
  api.message({ id: "6001", channel_id: "2001", author: ada, content: "still there?" });
  await until(() => api.sent("2001").length === 1, "the reply after resuming");

  // a leaves (a drain releases its channels); b's next scan connects.
  await b.channels.scan();
  assert.equal(api.identified().length, 1, "b does not connect while a holds the channel");
  a.channels.stop();
  await until(() => api.sockets.size === 0, "a's connection closed");
  await sleep(50);
  await b.channels.scan();
  await until(() => api.identified().length === 2, "b's identify");
  await until(() => api.received.filter(entry => entry.op === 2 && api.sockets.has(entry.socket)).length === 1, "b's connection ready");
  api.message({ id: "6002", channel_id: "2001", author: ada, content: "hello b" });
  await until(() => b.prompts.length === 1, "b's prompt");

  // A token Discord rejects (4004) is not retried in a loop.
  api.state.closeOnIdentify = 4004;
  await b.channels.update("default", channel.id, { credentials: { botToken: BOT_TOKEN } });
  await b.channels.scan();
  await until(() => api.identified().length === 3, "the identify with rejected credentials");
  await sleep(500);
  await b.channels.scan();
  await sleep(300);
  assert.equal(api.identified().length, 3);
});

test("Discord messages that are not for the bot are ignored", () => {
  const base = { id: "1", channel_id: "2", type: 0, author: ada, attachments: [], mentions: [] };
  assert.equal(parseMessage({ ...base, guild_id: "9", content: "no mention" }, BOT_ID), undefined);
  assert.equal(parseMessage({ ...base, content: "joined", type: 7 }, BOT_ID), undefined);
  assert.equal(parseMessage({ ...base, content: "via webhook", webhook_id: "4" }, BOT_ID), undefined);
  assert.equal(parseMessage({ ...base, content: `<@${BOT_ID}>` , mentions: [{ id: BOT_ID }], guild_id: "9" }, BOT_ID), undefined, "a bare mention has nothing to answer");
  const reply = parseMessage({ ...base, type: 19, guild_id: "9", content: `<@!${BOT_ID}> hi`, mentions: [{ id: BOT_ID }] }, BOT_ID);
  assert.equal(reply?.text, "hi");
  const photo = parseMessage({ ...base, content: "", attachments: [
    { content_type: "image/png", size: 100, url: "https://cdn.discordapp.com/attachments/1/2/a.png" },
    { content_type: "image/png", size: 5_000_000, url: "https://cdn.discordapp.com/attachments/1/2/big.png" },
  ] }, BOT_ID);
  assert.deepEqual(photo?.images, ["https://cdn.discordapp.com/attachments/1/2/a.png"]);
});

for (const stage of ["hello", "ready"] as const) {
  test(`Discord retries a stalled ${stage} handshake and logs no secrets`, async t => {
    const api = await fakeDiscord(t);
    api.state[stage] = false;
    const events: { event: string; fields: Record<string, unknown> }[] = [];
    const gateway = discord({ apiUrl: api.url, handshakeTimeoutMs: 120 }).connect!({ botToken: BOT_TOKEN }, {
      message: async () => {}, failed: error => assert.fail(error.message),
      diagnostic: (event, fields) => events.push({ event, fields }),
    });
    t.after(() => gateway.close());
    await until(() => events.some(x => x.event === "handshake_timeout"), "handshake timeout");
    api.state[stage] = true;
    await until(() => events.some(x => x.event === "ready"), "recovered connection");
    await until(() => events.some(x => x.event === "health"), "heartbeat health");
    gateway.close();
    const serialized = JSON.stringify(events);
    assert.ok(events.some(x => x.event === "connecting"));
    assert.ok(events.some(x => x.event === "closed"));
    assert.ok(events.some(x => x.event === "stopped"));
    assert.ok(!serialized.includes(BOT_TOKEN));
    assert.ok(!serialized.includes("session-"));
  });
}

test("Discord keeps delivering while a deployment retires its owner, then hands off on stop", async t => {
  const api = await fakeDiscord(t);
  const { db } = await testDatabase();
  const key = randomBytes(32).toString("hex");
  const a = await node(t, api, db, key, "retiring");
  const b = await node(t, api, db, key, "replacement");
  await a.channels.create("default", { type: "discord", credentials: { botToken: BOT_TOKEN }, access: { public: true } });
  await a.channels.scan();
  await until(() => api.identified().length === 1, "first connection");
  await a.ownership.drain();
  await Promise.all([a.channels.scan(), b.channels.scan()]);
  api.message({ id: "7001", channel_id: "2001", author: ada, content: "during retirement" });
  await until(() => api.sent().length === 1, "reply during retirement");
  a.channels.stop();
  await until(() => api.sockets.size === 0, "old connection closes");
  await until(async () => { await b.channels.scan(); return api.identified().length === 2; }, "replacement connects");
  api.message({ id: "7002", channel_id: "2001", author: ada, content: "after handoff" });
  await until(() => api.sent().length === 2, "reply after handoff");
});
