import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { Ownership } from "../src/ownership.ts";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import type { ConsoleAuth } from "../src/console-auth.ts";
import type { Channels, Channel, ChannelInput, Inbound } from "../src/channels.ts";
import { ManagedDiscord, managesGuild, verifyInteraction, type ManagedDiscordOptions } from "../src/discord-managed.ts";
import { testDatabase } from "./database.ts";

const APP = "999000000000000001";
const TOKEN = "MTAxMjM0NTY3ODkwMTIzNDU2.GFixture.DiscordBotTokenSecretPart_abcdefXYZ0123";
const OWNER = "111";
const guildA = "101"; const guildB = "102";
const channelA = "201"; const channelB = "202";

test("Discord management permissions use owner or exact Administrator/Manage Guild bits", () => {
  assert.equal(managesGuild({ owner: true }), true);
  assert.equal(managesGuild({ permissions: "32" }), true);
  assert.equal(managesGuild({ permissions: "8" }), true);
  for (const permissions of ["0", "16", 32, null, "garbage", "-1"]) assert.equal(managesGuild({ permissions }), false);
});

test("interaction verification covers timestamp plus exact body and rejects tampering, stale and invalid signatures", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const hex = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
  const now = Date.now(); const timestamp = String(Math.floor(now / 1000)); const body = '{"type":1}';
  const headers = new Headers({ "x-signature-timestamp": timestamp, "x-signature-ed25519": sign(null, Buffer.from(timestamp + body), privateKey).toString("hex") });
  assert.equal(verifyInteraction(hex, headers, body, now), true);
  assert.equal(verifyInteraction(hex, headers, body + " ", now), false);
  assert.equal(verifyInteraction(hex, headers, body, now + 360_000), false);
  assert.equal(verifyInteraction(hex, new Headers(), body), false);
});

async function fixture(t: { after(fn: () => Promise<void> | void): void }, owned = false) {
  const { db } = await testDatabase();
  const received: { channel: string; message: Inbound }[] = [];
  const sent: { channel: string; content: string }[] = [];
  const state = { manage: true, present: true, shards: 1, gatewayCalls: 0, limited: false, gatewayWait: undefined as Promise<void> | undefined, identified: 0, paginated: false, limitedGet: false };
  const keypair = generateKeyPairSync("ed25519");
  const publicKey = (keypair.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");
  let gatewayUrl = "";
  const discord = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const json = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname === "/oauth2/token") return json(200, { access_token: "verified-token", scope: "identify guilds", expires_in: 3600 });
    if (req.headers.authorization === "Bearer verified-token") {
      if (url.pathname === "/users/@me") return json(200, { id: OWNER });
      if (url.pathname === "/users/@me/guilds" && state.paginated) return json(200, url.searchParams.has("after") ? [{ id: "2000", name: "Later page", permissions: "32" }] : Array.from({ length: 200 }, (_, index) => ({ id: String(1000 + index), permissions: "0" })));
      if (url.pathname === "/users/@me/guilds") return json(200, [{ id: guildA, name: "Alpha", permissions: state.manage ? "32" : "0" }, { id: guildB, name: "Beta", permissions: state.manage ? "8" : "0" }]);
    }
    if (req.headers.authorization !== `Bot ${TOKEN}`) return json(401, {});
    if (url.pathname === "/gateway/bot") { state.gatewayCalls++; await state.gatewayWait; return json(200, { url: gatewayUrl, shards: state.shards, session_start_limit: { remaining: 100 } }); }
    if (url.pathname.startsWith("/guilds/")) {
      const id = url.pathname.split("/")[2];
      if (!state.present) return json(404, {});
      if (url.pathname.endsWith("/channels")) return json(200, [{ id: id === guildA ? channelA : channelB, name: "test", type: 0 }]);
      return json(200, { id, name: id === guildA ? "Alpha" : "Beta" });
    }
    const channel = url.pathname.split("/")[2];
    if (req.method === "GET" && url.pathname.startsWith("/channels/")) {
      if (state.limitedGet) return json(429, { retry_after: 1, global: true });
      if (channel === "203") return json(200, { id: channel, guild_id: guildA, type: 11, parent_id: channelA });
      return json(200, { id: channel, guild_id: channel === channelA ? guildA : guildB, type: 0 });
    }
    if (url.pathname.endsWith("/messages")) {
      if (state.limited) return json(429, { retry_after: 0.15, global: true });
      sent.push({ channel, content: JSON.parse(raw).content }); return json(200, { id: "1" });
    }
    return json(204, {});
  });
  const wss = new WebSocketServer({ server: discord });
  wss.on("connection", socket => {
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 200 } }));
    socket.on("message", raw => {
      const payload = JSON.parse(String(raw));
      if (payload.op === 1) socket.send(JSON.stringify({ op: 11 }));
      if (payload.op === 2) {
        state.identified++;
        socket.send(JSON.stringify({ op: 0, t: "READY", s: 1, d: { user: { id: APP }, session_id: "test", resume_gateway_url: gatewayUrl, guilds: [{ id: guildA }, { id: guildB }] } }));
      }
    });
  });
  t.after(() => { for (const socket of wss.clients) socket.terminate(); wss.close(); });
  discord.listen(0, "127.0.0.1"); await once(discord, "listening");
  t.after(() => { discord.closeAllConnections(); discord.close(); });
  const base = `http://127.0.0.1:${(discord.address() as { port: number }).port}`;
  gatewayUrl = base.replace("http:", "ws:");
  const auth = {
    options: { secret: "console-secret", publicUrl: "https://camel.test" },
    principal: async (req: Request) => req.headers.get("cookie")?.includes("ar_session=") ? { tenant: req.headers.get("x-test-tenant") ?? "tenant-a", via: "console" } : undefined,
    allowsMutation: (req: Request) => req.headers.get("x-agent-runtime-console") === "1",
  } as unknown as ConsoleAuth;
  const saved = new Map<string, Channel>();
  let managed: ManagedDiscord;
  const channels = {
    create: async (tenant: string, input: ChannelInput) => {
      const id = `ch_${randomUUID()}`;
      const account = await managed.provider.setup(input.credentials!, { url: "", secret: "" });
      const channel = { id, tenant, type: input.type!, name: input.name!, definition: input.definition!, access: { public: true, allow: [], ...input.access }, limits: { perSenderPerMinute: 5, turnsPerDay: 100, ...input.limits }, account: account.account, masked: {}, createdAt: Date.now(), updatedAt: Date.now(), sealed: {} } as Channel;
      saved.set(id, channel); await db.query("insert into channels(id,tenant,channel,created_at) values($1,$2,$3,$4)", [id, tenant, JSON.stringify(channel), Date.now()]);
      return { ...channel, credentials: {} };
    },
    update: async (tenant: string, id: string, input: ChannelInput) => {
      const channel = saved.get(id)!; Object.assign(channel, input);
      await db.query("update channels set channel=$2 where id=$1", [id, JSON.stringify(channel)]); return channel;
    },
    remove: async (_tenant: string, id: string) => { saved.delete(id); await db.query("delete from channels where id=$1", [id]); },
    get: async (tenant: string, id: string) => { const channel = saved.get(id)!; assert.equal(channel.tenant, tenant); return channel; },
    inbound: async (channel: string, message: Inbound) => { received.push({ channel, message }); return true; },
    allowed: (channel: Channel, sender: { id: string }) => channel.access.public || channel.access.allow.includes(sender.id),
  } as unknown as Channels;
  const ownership = owned ? new Ownership(db, { node: "first", ttlMs: 60_000 }) : undefined;
  if (ownership) { await ownership.start(); t.after(() => ownership.close()); }
  const options: ManagedDiscordOptions = { db, consoleAuth: auth, channels: () => channels, node: "test", publicUrl: "https://camel.test", botToken: TOKEN, applicationId: APP, clientSecret: "secret", publicKey, apiUrl: base, ownership };
  managed = new ManagedDiscord(options);
  t.after(() => managed.stop());
  const request = (path: string, method = "GET", body?: unknown, tenant = "tenant-a", cookie = "ar_session=session-a") => managed.app.request(`https://camel.test${path}`, {
    method, headers: { cookie, "x-test-tenant": tenant, "x-agent-runtime-console": "1", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const link = async (tenant = "tenant-a", cookie = "ar_session=session-a") => {
    const response = await request("/console/discord/authorize", "POST", {}, tenant, cookie); assert.equal(response.status, 200);
    const { url } = await response.json() as any; const state = new URL(url).searchParams.get("state");
    const callback = await request(`/console/discord/callback?state=${state}&code=valid`, "GET", undefined, tenant, cookie);
    assert.match(callback.headers.get("location")!, /discord_connected=1/);
    return state;
  };
  const bind = async (guildId = guildA, allowedChannelId = channelA, tenant = "tenant-a", cookie = "ar_session=session-a") => {
    await link(tenant, cookie);
    const response = await request("/console/discord/bindings", "POST", { guildId, definition: "def-test", allowedChannelIds: [allowedChannelId], access: { public: true } }, tenant, cookie);
    assert.equal(response.status, 201, await response.clone().text()); return response.json() as Promise<any>;
  };
  const message = (guild = guildA, channel = channelA, id = "301") => managed.dispatch("MESSAGE_CREATE", { id, guild_id: guild, channel_id: channel, type: 0, author: { id: OWNER, username: "admin" }, mentions: [{ id: APP }], content: `<@${APP}> hello`, attachments: [] });
  const ready = () => managed.dispatch("READY", { user: { id: APP }, guilds: [{ id: guildA }, { id: guildB }] });
  return { db, managed, state, request, bind, link, ready, message, received, sent, saved, keypair, publicKey, auth, base, options, ownership };
}

test("OAuth state is single-use, session-bound, encrypted, and expired grants cannot mutate a server", async t => {
  const f = await fixture(t);
  const state = await f.link();
  const token = (await f.db.query("select token from discord_account_links")).rows[0].token;
  assert.ok(!token.includes("verified-token"));
  const replay = await f.request(`/console/discord/callback?state=${state}&code=valid`);
  assert.match(replay.headers.get("location")!, /discord_error=/);
  const wrongSession = await f.request("/console/discord/bindings", "POST", { guildId: guildA, definition: "def-test", allowedChannelIds: [channelA] }, "tenant-a", "ar_session=other");
  assert.equal(wrongSession.status, 403);
  await f.db.query("update discord_account_links set expires_at=0");
  assert.equal((await f.request("/console/discord/bindings", "POST", { guildId: guildA, definition: "def-test", allowedChannelIds: [channelA] })).status, 403);
});

test("claims verify fresh management, bot membership and allowed destination; concurrent or cross-tenant claims conflict", async t => {
  const f = await fixture(t); await f.link();
  const body = { guildId: guildA, definition: "def-test", allowedChannelIds: [channelA] };
  f.state.manage = false; assert.equal((await f.request("/console/discord/bindings", "POST", body)).status, 403);
  f.state.manage = true; f.state.present = false; assert.equal((await f.request("/console/discord/bindings", "POST", body)).status, 404);
  f.state.present = true;
  assert.equal((await f.request("/console/discord/bindings", "POST", { ...body, allowedChannelIds: [channelB] })).status, 400);
  const responses = await Promise.all([f.request("/console/discord/bindings", "POST", body), f.request("/console/discord/bindings", "POST", body)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  assert.equal((await f.db.query("select count(*) from channels")).rows[0].count, 1);
  await f.link("tenant-b", "ar_session=session-b");
  assert.equal((await f.request("/console/discord/bindings", "POST", body, "tenant-b", "ar_session=session-b")).status, 409);
});

test("two guilds route to separate tenant channels; outbound text/files/typing reject cross-guild and disabled destinations", async t => {
  const f = await fixture(t); const a = await f.bind(); const b = await f.bind(guildB, channelB, "tenant-b", "ar_session=session-b"); await f.ready();
  await f.message(); await f.message(guildB, channelB, "302");
  assert.deepEqual(f.received.map(item => item.channel), [a.channelId, b.channelId]);
  const binding = (await f.db.query("select id from discord_server_bindings where guild_id=$1", [guildA])).rows[0].id;
  await f.managed.provider.send({ bindingId: binding }, channelA, "safe");
  await f.managed.provider.send({ bindingId: binding }, "203", "thread safe");
  await assert.rejects(f.managed.provider.send({ bindingId: binding }, channelB, "leak"), /not permitted/);
  await assert.rejects(f.managed.provider.typing!({ bindingId: binding }, channelB), /not permitted/);
  await assert.rejects(f.managed.provider.sendFile({ bindingId: binding }, channelB, { name: "secret", contentType: "text/plain", size: 1, blob: async () => new Blob(["x"]) }), /not permitted/);
  f.state.manage = false;
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { name: "renamed" })).status, 403);
  await assert.rejects(f.managed.authorizeDefinition(new Request("https://camel.test", { headers: { cookie: "ar_session=session-a" } }), "tenant-a", "def-test"), /Manage Server/);
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { state: "paused" })).status, 200);
  await assert.rejects(f.managed.provider.send({ bindingId: binding }, channelA, "late"), /not permitted/);
  assert.deepEqual(f.sent.map(item => item.content), ["safe", "thread safe"]);
});

test("invite-first mentions have zero agent submissions with shared cooldown; role mentions ignored and disconnect suppresses setup nudges", async t => {
  const f = await fixture(t); await f.ready();
  await f.message(); await f.message(guildA, channelA, "302");
  assert.equal(f.received.length, 0); assert.equal(f.sent.length, 1); assert.match(f.sent[0].content, /discord_setup=101/);
  await f.managed.dispatch("MESSAGE_CREATE", { id: "303", guild_id: guildA, channel_id: channelA, type: 0, author: { id: OWNER }, mention_roles: [APP], mentions: [], content: "role hello" });
  assert.equal(f.sent.length, 1);
  const a = await f.bind(); await f.message(guildA, channelA, "304"); assert.equal(f.received[0].channel, a.channelId);
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { state: "disconnected" })).status, 200);
  await f.db.query("delete from discord_setup_cooldowns"); await f.message(guildA, channelA, "305"); assert.equal(f.sent.length, 1);
  assert.equal((await f.db.query("select count(*) from channels")).rows[0].count, 1, "history/config retained on disconnect");
});

test("guild unavailability differs from removal; removal cancels queued work and re-invite requires explicit resume", async t => {
  const f = await fixture(t); const a = await f.bind(); await f.ready();
  await f.managed.dispatch("GUILD_DELETE", { id: guildA, unavailable: true });
  assert.equal((await f.db.query("select state from discord_server_bindings")).rows[0].state, "active");
  await f.message(); assert.equal(f.received.length, 0);
  await f.managed.dispatch("GUILD_CREATE", { id: guildA, name: "Alpha" }); await f.message(guildA, channelA, "302"); assert.equal(f.received.length, 1);
  await f.db.query("insert into channel_items(id,item,revision,due) values($1,$2,1,0)", [randomUUID(), JSON.stringify({ channel: a.channelId })]);
  await f.managed.dispatch("GUILD_DELETE", { id: guildA });
  assert.equal((await f.db.query("select count(*) from channel_items")).rows[0].count, 0);
  await f.managed.dispatch("GUILD_CREATE", { id: guildA }); assert.equal((await f.db.query("select state from discord_server_bindings")).rows[0].state, "paused");
  await f.message(guildA, channelA, "303"); assert.equal(f.received.length, 1);
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { state: "active" })).status, 200);
  await f.message(guildA, channelA, "304"); assert.equal(f.received.length, 2);
  await f.managed.dispatch("READY", { user: { id: APP }, guilds: [] });
  assert.equal((await f.db.query("select state from discord_installations where guild_id=$1", [guildA])).rows[0].state, "removed");
});

test("signed setup interactions acknowledge immediately, are ephemeral, and never submit model work", async t => {
  const f = await fixture(t);
  const interaction = async (body: unknown, valid = true) => {
    const raw = JSON.stringify(body); const timestamp = String(Math.floor(Date.now() / 1000));
    return f.managed.app.request("https://camel.test/channels/discord-managed/interactions", { method: "POST", headers: { "x-signature-timestamp": timestamp, "x-signature-ed25519": valid ? sign(null, Buffer.from(timestamp + raw), f.keypair.privateKey).toString("hex") : "00".repeat(64) }, body: raw });
  };
  assert.equal((await interaction({ type: 1 }, false)).status, 401);
  assert.deepEqual(await (await interaction({ type: 1 })).json(), { type: 1 });
  const response = await interaction({ application_id: APP, type: 2, guild_id: guildA, member: { permissions: "32" }, data: { name: "camel", options: [{ name: "setup" }] } });
  const body = await response.json() as any; assert.equal(body.data.flags, 64); assert.match(body.data.content, /discord_setup=101/); assert.equal(f.received.length, 0);
});

test("startup shard refusal is recoverable and does not break the runtime", async t => {
  const f = await fixture(t); f.state.shards = 2;
  await f.managed.start(); assert.equal(f.state.gatewayCalls, 1);
  await f.managed.stop();
});

test("managed invite requests attachment and message permissions without Administrator", async t => {
  const f = await fixture(t); const config = await (await f.request("/console/discord/config")).json() as any;
  const bits = BigInt(new URL(config.inviteUrl).searchParams.get("permissions")!);
  for (const bit of [10n, 11n, 15n, 16n, 38n]) assert.notEqual(bits & (1n << bit), 0n);
  assert.equal(bits & 8n, 0n);
});

test("definition switches apply to existing conversations and show exact outcomes", async t => {
  const f = await fixture(t); const a = await f.bind(); const calls: unknown[] = [];
  f.options.applyDefinition = async (tenant: string, channel: string, definition: string) => {
    calls.push({ tenant, channel, definition }); return [{ agent: "agent-1", requestId: "request-1", status: "queued" as const }];
  };
  const response = await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { definition: "def-next" });
  assert.equal(response.status, 200); const result = await response.json() as any;
  assert.deepEqual(calls, [{ tenant: "tenant-a", channel: a.channelId, definition: "def-next" }]);
  assert.deepEqual(result.applied, [{ agent: "agent-1", requestId: "request-1", status: "queued" }]);
});

test("same-tenant retries recover an incomplete reservation without creating duplicate channels", async t => {
  const f = await fixture(t); await f.ready(); await f.link(); const id = randomUUID();
  await f.db.query(`insert into discord_server_bindings(id,application_id,guild_id,tenant,state,allowed_channel_ids,administrator_id,created_at,updated_at) values($1,$2,$3,'tenant-a','paused','[]','111',0,0)`, [id, APP, guildA]);
  const response = await f.request("/console/discord/bindings", "POST", { guildId: guildA, definition: "def-test", allowedChannelIds: [channelA] });
  assert.equal(response.status, 201); assert.equal((await f.db.query("select id,state from discord_server_bindings")).rows[0].id, id);
  assert.equal((await f.db.query("select count(*) from channels")).rows[0].count, 1);
});

test("global Discord 429 cooldown is persisted and stops a different delivery node", async t => {
  const f = await fixture(t); await f.bind(); const binding = (await f.db.query("select id from discord_server_bindings")).rows[0].id;
  f.state.limited = true;
  await assert.rejects(f.managed.provider.send({ bindingId: binding }, channelA, "first"), /HTTP 429/);
  const peer = new ManagedDiscord({ ...f.options, node: "second" }); t.after(() => peer.stop());
  f.state.limited = false;
  await assert.rejects(peer.provider.send({ bindingId: binding }, channelA, "second"), /cooldown/);
  assert.equal(f.sent.length, 0);
  await f.db.query("delete from discord_setup_cooldowns where key=$1", [`${APP}:rest`]);
  await peer.provider.send({ bindingId: binding }, channelA, "after cooldown"); assert.equal(f.sent.length, 1);
});

test("shutdown during Gateway discovery never opens a late connection", async t => {
  const f = await fixture(t); let release!: () => void;
  f.state.gatewayWait = new Promise<void>(resolve => { release = resolve; });
  const starting = f.managed.start();
  while (!f.state.gatewayCalls) await new Promise(resolve => setTimeout(resolve, 5));
  await f.managed.stop(); release(); await starting;
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(f.state.identified, 0);
});

test("one shared Gateway survives ownership handoff with only one live identification per owner", async t => {
  const f = await fixture(t, true);
  const peerOwnership = new Ownership(f.db, { node: "second", ttlMs: 60_000 }); await peerOwnership.start(); t.after(() => peerOwnership.close());
  const peer = new ManagedDiscord({ ...f.options, node: "second", ownership: peerOwnership }); t.after(() => peer.stop());
  await f.managed.start();
  while (!f.state.identified) await new Promise(resolve => setTimeout(resolve, 5));
  await peer.start(); assert.equal(f.state.identified, 1);
  await f.managed.stop(); await peer.stop(); await peer.start();
  const deadline = Date.now() + 5000;
  while (f.state.identified < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.state.identified, 2);
});

test("eligible guild discovery paginates Discord account membership", async t => {
  const f = await fixture(t); await f.link(); f.state.paginated = true;
  const response = await f.request("/console/discord/guilds"); assert.equal(response.status, 200);
  const result = await response.json() as any; assert.deepEqual(result.guilds.map((guild: any) => guild.id), ["2000"]);
});

test("older definitions still attached to managed agents require fresh server management permissions", async t => {
  const f = await fixture(t); const a = await f.bind();
  await f.db.query(`insert into agents(id,tenant,header,revision,name,type,model) values('agent-old','tenant-a',$1,1,'old','client','test')`, [JSON.stringify({ definition: { id: "def-old", revision: 1 } })]);
  await f.db.query(`insert into channel_agents(agent,channel,tenant,conversation) values('agent-old',$1,'tenant-a',$2)`, [a.channelId, channelA]);
  f.state.manage = false;
  await assert.rejects(f.managed.authorizeDefinition(new Request("https://camel.test", { headers: { cookie: "ar_session=session-a" } }), "tenant-a", "def-old"), /Manage Server/);
  await assert.rejects(f.managed.authorizeAgent(new Request("https://camel.test", { headers: { cookie: "ar_session=session-a" } }), "tenant-a", "agent-old"), /Manage Server/);
});

test("unfunded server mentions produce bounded deterministic status without submitting agent work", async t => {
  const f = await fixture(t); await f.bind();
  const unfunded = new ManagedDiscord({ ...f.options, canStart: async () => "no credit" }); t.after(() => unfunded.stop());
  await unfunded.dispatch("READY", { user: { id: APP }, guilds: [{ id: guildA }] });
  await unfunded.dispatch("MESSAGE_CREATE", { id: "301", guild_id: guildA, channel_id: channelA, type: 0, author: { id: OWNER }, mentions: [{ id: APP }], content: `<@${APP}> hello`, attachments: [] });
  assert.equal(f.received.length, 0);
  for (const deadline = Date.now() + 2000; !f.sent.length && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].content, /balance and spending limits/);
});

test("OAuth continuation tolerates unrelated cookies and cookie ordering changes", async t => {
  const f = await fixture(t);
  const started = await f.request("/console/discord/authorize", "POST", { guildId: guildA }, "tenant-a", "analytics=one; ar_session=session-a; preference=dark");
  const { url } = await started.json() as any; const state = new URL(url).searchParams.get("state");
  const callback = await f.request(`/console/discord/callback?state=${state}&code=valid`, "GET", undefined, "tenant-a", "preference=light; ar_session=session-a; analytics=two");
  assert.match(callback.headers.get("location")!, /discord_connected=1/);
  assert.match(callback.headers.get("location")!, /discord_setup=101/);
  const guilds = await f.request("/console/discord/guilds", "GET", undefined, "tenant-a", "ar_session=session-a; preference=third");
  assert.equal((await guilds.json() as any).linked, true);
});

test("startup maintenance removes expired OAuth material while retaining active cooldowns", async t => {
  const f = await fixture(t); await f.link();
  await f.db.query("update discord_account_links set expires_at=0");
  await f.db.query(`insert into discord_setup_attempts(state_hash,tenant,session_hash,expires_at) values('old','tenant-a','old',0)`);
  await f.db.query("insert into discord_setup_cooldowns(key,until_at) values('old',0),('active',$1)", [Date.now() + 60_000]);
  f.state.shards = 2; await f.managed.start();
  assert.equal((await f.db.query("select count(*) from discord_account_links")).rows[0].count, 0);
  assert.equal((await f.db.query("select count(*) from discord_setup_attempts")).rows[0].count, 0);
  assert.deepEqual((await f.db.query("select key from discord_setup_cooldowns")).rows.map(row => row.key), ["active"]);
});

test("a global 429 on an inbound destination check fences other delivery nodes", async t => {
  const f = await fixture(t); const a = await f.bind(); f.state.limitedGet = true;
  assert.equal(await f.managed.provider.guard!(f.saved.get(a.channelId)!, channelA, "inbound"), true);
  await assert.rejects(f.managed.provider.guard!(f.saved.get(a.channelId)!, "203", "inbound"), /rate limiting/);
  const peer = new ManagedDiscord({ ...f.options, node: "other" }); t.after(() => peer.stop());
  f.state.limitedGet = false;
  await assert.rejects(peer.provider.guard!(f.saved.get(a.channelId)!, "203", "submit"), /cooldown/);
  assert.equal(f.sent.length, 0);
});

test("a Gateway reconnect's READY (unavailable guild stubs) does not fence delivery to a present server", async t => {
  const f = await fixture(t); const a = await f.bind(); await f.ready();
  await f.managed.dispatch("READY", { user: { id: APP }, guilds: [{ id: guildA, unavailable: true }, { id: guildB, unavailable: true }] });
  assert.equal(await f.managed.provider.guard!(f.saved.get(a.channelId)!, channelA, "send"), true);
});

test("the paying account can pause or disconnect a server without a current Discord role", async t => {
  const f = await fixture(t); await f.bind(); f.state.manage = false;
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { state: "paused" })).status, 200);
  assert.equal((await f.db.query("select state from discord_server_bindings")).rows[0].state, "paused");
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { state: "active" })).status, 403);
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { state: "disconnected" }, "tenant-b")).status, 404);
});

test("members without access cost no Discord REST lookup", async t => {
  const f = await fixture(t); const a = await f.bind(); await f.ready();
  f.saved.get(a.channelId)!.access = { public: false, allow: [] };
  f.state.limitedGet = true;
  await f.managed.dispatch("MESSAGE_CREATE", { id: "402", guild_id: guildA, channel_id: "203", type: 0, author: { id: "998" }, mentions: [{ id: APP }], content: "hi", attachments: [] });
  assert.equal((await f.db.query("select count(*) from discord_setup_cooldowns where key=$1", [`${APP}:rest`])).rows[0].count, 0);
  assert.equal(f.received.length, 0);
});
