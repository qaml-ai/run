import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { Ownership } from "../src/ownership.ts";
import { randomUUID } from "node:crypto";
import type { ConsoleAuth } from "../src/console-auth.ts";
import type { Channels, Channel, ChannelInput, Inbound } from "../src/channels.ts";
import { ManagedDiscord, type ManagedDiscordOptions } from "../src/discord-managed.ts";
import { HttpError } from "../src/http.ts";
import { testDatabase } from "./database.ts";

const APP = "999000000000000001";
const TOKEN = "MTAxMjM0NTY3ODkwMTIzNDU2.GFixture.DiscordBotTokenSecretPart_abcdefXYZ0123";
const OWNER = "111";
const guildA = "101"; const guildB = "102";
const channelA = "201"; const channelB = "202";

async function fixture(t: { after(fn: () => Promise<void> | void): void }, extra: Partial<ManagedDiscordOptions> & { owned?: boolean } = {}) {
  const owned = extra.owned ?? false;
  const { db } = await testDatabase();
  const received: { channel: string; message: Inbound }[] = [];
  const sent: { channel: string; content: string }[] = [];
  const left: string[] = [];
  const state = { present: true, noGuild: false, scope: "bot", memberRoles: [] as string[] | undefined, shards: 1, gatewayCalls: 0, limited: false, gatewayWait: undefined as Promise<void> | undefined, identified: 0, limitedGet: false, routeLimited: false };
  let gatewayUrl = "";
  const discord = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const json = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    const url = new URL(req.url!, "http://localhost");
    // The authorization code names the server Discord added the bot to (the test's choice).
    if (url.pathname === "/oauth2/token") {
      const code = new URLSearchParams(raw).get("code") ?? "";
      if (code === "used") return json(400, { error: "invalid_grant" });
      // Discord's documented shape: `scope` need not list every scope asked for.
      return json(200, { token_type: "Bearer", access_token: "verified-token", scope: state.scope, expires_in: 604800, refresh_token: "refresh-secret",
        ...(state.noGuild ? {} : { guild: { id: code, name: code === guildA ? "Alpha" : "Beta", icon: null, owner_id: "999" } }) });
    }
    if (req.headers.authorization === "Bearer verified-token" && url.pathname === "/users/@me") return json(200, { id: OWNER });
    if (req.headers.authorization !== `Bot ${TOKEN}`) return json(401, {});
    if (req.method === "DELETE" && url.pathname.startsWith("/users/@me/guilds/")) { left.push(url.pathname.split("/")[4]); return res.writeHead(204).end(); }
    if (url.pathname === "/gateway/bot") { state.gatewayCalls++; await state.gatewayWait; return json(200, { url: gatewayUrl, shards: state.shards, session_start_limit: { remaining: 100 } }); }
    if (url.pathname.startsWith("/guilds/")) {
      const id = url.pathname.split("/")[2];
      if (!state.present) return json(404, {});
      if (url.pathname.includes("/members/")) return state.memberRoles ? json(200, { user: { id: url.pathname.split("/")[4] }, roles: state.memberRoles }) : json(404, {});
      if (url.pathname.endsWith("/channels")) return json(200, [{ id: id === guildA ? channelA : channelB, name: "test", type: 0 }]);
      return json(200, { id, name: id === guildA ? "Alpha" : "Beta", owner_id: "999", roles: [{ id, permissions: "1024" }, { id: "role-manager", permissions: "32" }, { id: "role-member", permissions: "3072" }] });
    }
    const channel = url.pathname.split("/")[2];
    if (req.method === "GET" && url.pathname.startsWith("/channels/")) {
      if (state.limitedGet) return json(429, { retry_after: 1, global: true });
      if (channel === "203") return json(200, { id: channel, guild_id: guildA, type: 11, parent_id: channelA });
      return json(200, { id: channel, guild_id: channel === channelA ? guildA : guildB, type: 0 });
    }
    if (url.pathname.endsWith("/messages")) {
      if (state.limited) return json(429, { retry_after: 0.15, global: true });
      if (state.routeLimited) return json(429, { retry_after: 0.15, global: false });
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
    create: async (tenant: string, input: ChannelInput, internal?: { sql?: Pick<typeof db, "query"> }) => {
      if (input.definition === "missing") throw new HttpError(404, "Unknown definition");
      const id = `ch_${randomUUID()}`;
      const account = await managed.provider.setup(input.credentials!, { url: "", secret: "" });
      const channel = { id, tenant, type: input.type!, name: input.name!, definition: input.definition!, access: { public: true, allow: [], ...input.access }, limits: { perSenderPerMinute: 5, turnsPerDay: 100, ...input.limits }, account: account.account, masked: {}, createdAt: Date.now(), updatedAt: Date.now(), sealed: {} } as Channel;
      saved.set(id, channel); await (internal?.sql ?? db).query("insert into channels(id,tenant,channel,created_at) values($1,$2,$3,$4)", [id, tenant, JSON.stringify(channel), Date.now()]);
      return { ...channel, credentials: {} };
    },
    update: async (tenant: string, id: string, input: ChannelInput, internal?: { sql?: Pick<typeof db, "query"> }) => {
      if (input.definition === "missing") throw new HttpError(404, "Unknown definition");
      const channel = saved.get(id)!; Object.assign(channel, input);
      await (internal?.sql ?? db).query("update channels set channel=$2 where id=$1", [id, JSON.stringify(channel)]); return channel;
    },
    remove: async (_tenant: string, id: string) => { saved.delete(id); await db.query("delete from channels where id=$1", [id]); },
    get: async (tenant: string, id: string) => { const channel = saved.get(id)!; assert.equal(channel.tenant, tenant); return channel; },
    inbound: async (channel: string, message: Inbound) => { received.push({ channel, message }); return true; },
    allowed: (channel: Channel, sender: { id: string }) => channel.access.public || channel.access.allow.includes(sender.id),
  } as unknown as Channels;
  const ownership = owned ? new Ownership(db, { node: "first", ttlMs: 60_000 }) : undefined;
  if (ownership) { await ownership.start(); t.after(() => ownership.close()); }
  const options: ManagedDiscordOptions = { db, consoleAuth: auth, channels: () => channels, node: "test", publicUrl: "https://camel.test", botToken: TOKEN, applicationId: APP, clientSecret: "secret", apiUrl: base, ownership, ...extra };
  managed = new ManagedDiscord(options);
  t.after(() => managed.stop());
  const request = (path: string, method = "GET", body?: unknown, tenant = "tenant-a", cookie = "ar_session=session-a") => managed.app.request(`https://camel.test${path}`, {
    method, headers: { cookie, "x-test-tenant": tenant, "x-agent-runtime-console": "1", "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  /** Start adding Camel from the console, then come back from Discord having added it to `guild`. */
  const install = async (guild = guildA, tenant = "tenant-a", cookie = "ar_session=session-a") => {
    const started = await request("/console/discord/install", "GET", undefined, tenant, cookie);
    assert.equal(started.status, 302);
    const state = new URL(started.headers.get("location")!).searchParams.get("state")!;
    // Discord appends the chosen server and permissions to the redirect.
    const callback = await request(`/console/discord/callback?code=${guild}&state=${state}&guild_id=${guild}&permissions=274878008320`, "GET", undefined, tenant, cookie);
    return { state, location: new URL(callback.headers.get("location")!) };
  };
  /** Add Camel to a server and finish its setup with one allowed channel open to everyone. */
  const bind = async (guildId = guildA, allowedChannelId = channelA, tenant = "tenant-a", cookie = "ar_session=session-a") => {
    const { location } = await install(guildId, tenant, cookie);
    assert.equal(location.searchParams.get("discord_server"), guildId, location.searchParams.get("discord_error") ?? "");
    const response = await request(`/console/discord/bindings/${guildId}`, "PATCH", { definition: "def-test", allowedChannelIds: [allowedChannelId], access: { public: true } }, tenant, cookie);
    assert.equal(response.status, 200, await response.clone().text()); return response.json() as Promise<any>;
  };
  const message = (guild = guildA, channel = channelA, id = "301") => managed.dispatch("MESSAGE_CREATE", { id, guild_id: guild, channel_id: channel, type: 0, author: { id: OWNER, username: "admin" }, mentions: [{ id: APP }], content: `<@${APP}> hello`, attachments: [] });
  const ready = () => managed.dispatch("READY", { user: { id: APP }, guilds: [{ id: guildA }, { id: guildB }] });
  const binding = async () => (await db.query("select * from discord_server_bindings")).rows;
  return { db, managed, state, request, bind, install, ready, message, received, sent, saved, left, auth, base, options, ownership, binding };
}

test("adding Camel from Get started's Discord path returns there, with the server or the error", async t => {
  const f = await fixture(t);
  const begin = async () => new URL((await f.request(`/console/discord/install?from=start`)).headers.get("location")!).searchParams.get("state")!;
  const state = await begin();
  assert.match(state, /~start$/);
  const back = new URL((await f.request(`/console/discord/callback?code=${guildA}&state=${state}&guild_id=${guildA}`)).headers.get("location")!);
  assert.equal(back.pathname, "/console/");
  assert.equal(back.searchParams.get("start"), "discord");
  assert.equal(back.searchParams.get("discord_server"), guildA, back.searchParams.get("discord_error") ?? "");
  const cancelled = new URL((await f.request(`/console/discord/callback?error=access_denied&state=${await begin()}`)).headers.get("location")!);
  assert.equal(cancelled.pathname + cancelled.searchParams.get("start"), "/console/discord");
  assert.equal(cancelled.searchParams.get("discord_error"), "Discord authorization was cancelled");
  // Without it, Discord returns to Channels as before.
  assert.equal((await f.install(guildB)).location.pathname, "/console/channels");
});

test("adding Camel starts one Discord authorization: bot and identity only, message permissions only, and a single-use state", async t => {
  const f = await fixture(t);
  const started = await f.request("/console/discord/install?guild_id=101");
  const url = new URL(started.headers.get("location")!);
  assert.equal(url.origin + url.pathname, "https://discord.com/oauth2/authorize");
  assert.equal(url.searchParams.get("scope"), "bot identify");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), "https://camel.test/console/discord/callback");
  assert.equal(url.searchParams.get("guild_id"), guildA);
  const bits = BigInt(url.searchParams.get("permissions")!);
  for (const bit of [10n, 11n, 15n, 16n, 38n]) assert.notEqual(bits & (1n << bit), 0n);
  assert.equal(bits & 8n, 0n, "never Administrator");
  const state = url.searchParams.get("state")!;
  assert.equal((await f.db.query("select count(*)::int n from discord_setup_attempts where state_hash<>$1", [state])).rows[0].n, 1, "only a hash is stored");
  // Signed out: sign in first, then come back to the same start URL.
  const signedOut = await f.managed.app.request("https://camel.test/console/discord/install?guild_id=101");
  assert.equal(signedOut.status, 302); assert.equal(signedOut.headers.get("location"), "/console/channels?discord_install=1&guild_id=101");
});

test("the callback binds the server Discord added Camel to, after confirming the bot is there", async t => {
  const f = await fixture(t);
  const { location } = await f.install();
  assert.equal(location.pathname, "/console/channels"); assert.equal(location.searchParams.get("discord_server"), guildA);
  const [binding] = await f.binding();
  assert.equal(binding.tenant, "tenant-a"); assert.equal(binding.guild_id, guildA); assert.equal(binding.state, "paused");
  assert.equal(binding.channel_id, null); assert.equal(binding.administrator_id, OWNER);
  assert.equal((await f.db.query("select state from discord_installations where guild_id=$1", [guildA])).rows[0].state, "present");
  // Setup finishes in the console: a definition and allowed channels are required, then it is active.
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { access: { public: true } })).status, 400);
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { definition: "def-test", allowedChannelIds: [channelB] })).status, 400, "channels of another server");
  const done = await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { definition: "def-test", allowedChannelIds: [channelA], access: { public: true } });
  assert.equal(done.status, 200); const view = await done.json() as any;
  assert.equal(view.state, "active"); assert.ok(view.channelId);
  await f.ready(); await f.message(); assert.deepEqual(f.received.map(item => item.channel), [view.channelId]);
});

test("a replayed, expired, cross-session or cancelled callback binds nothing", async t => {
  const f = await fixture(t);
  const { state } = await f.install();
  const replay = await f.request(`/console/discord/callback?state=${state}&code=${guildB}`);
  assert.match(replay.headers.get("location")!, /discord_error=/);
  const started = await f.request("/console/discord/install");
  const other = new URL(started.headers.get("location")!).searchParams.get("state");
  assert.match((await f.request(`/console/discord/callback?state=${other}&code=${guildB}`, "GET", undefined, "tenant-a", "ar_session=other")).headers.get("location")!, /discord_error=/, "another session");
  assert.match((await f.request(`/console/discord/callback?state=${other}&code=${guildB}`, "GET", undefined, "tenant-b")).headers.get("location")!, /discord_error=/, "another account");
  const cancelled = new URL((await f.request("/console/discord/install")).headers.get("location")!).searchParams.get("state");
  assert.match((await f.request(`/console/discord/callback?state=${cancelled}&error=access_denied`)).headers.get("location")!, /cancelled/);
  const expired = new URL((await f.request("/console/discord/install")).headers.get("location")!).searchParams.get("state");
  await f.db.query("update discord_setup_attempts set expires_at=0");
  assert.match((await f.request(`/console/discord/callback?state=${expired}&code=${guildB}`)).headers.get("location")!, /discord_error=/);
  assert.match((await f.managed.app.request(`https://camel.test/console/discord/callback?state=x&code=${guildB}`)).headers.get("location")!, /discord_error=.*Sign/, "signed out");
  assert.deepEqual((await f.binding()).map(row => row.guild_id), [guildA]);
});

test("a callback without a server, for a different server, or where the bot is absent binds nothing", async t => {
  const f = await fixture(t);
  f.state.noGuild = true;
  const bare = new URL((await f.request("/console/discord/install")).headers.get("location")!).searchParams.get("state");
  assert.match(new URL((await f.request(`/console/discord/callback?state=${bare}&code=${guildA}`)).headers.get("location")!).searchParams.get("discord_error")!, /did not add Camel to a server/);
  f.state.noGuild = false;
  const started = await f.request("/console/discord/install?guild_id=101");
  const state = new URL(started.headers.get("location")!).searchParams.get("state");
  assert.match(new URL((await f.request(`/console/discord/callback?state=${state}&code=${guildB}`)).headers.get("location")!).searchParams.get("discord_error")!, /different server/);
  f.state.present = false;
  assert.ok((await f.install()).location.searchParams.get("discord_error"));
  assert.equal((await f.binding()).length, 0);
});

test("a server another account runs cannot be bound; added again by its own account it is kept", async t => {
  const f = await fixture(t); const a = await f.bind();
  const { location } = await f.install(guildA, "tenant-b", "ar_session=session-b");
  assert.match(location.searchParams.get("discord_error")!, /connected to another camelRun account/);
  const [binding] = await f.binding();
  assert.equal(binding.tenant, "tenant-a"); assert.equal(binding.state, "active"); assert.equal(binding.channel_id, a.channelId);
  assert.deepEqual(f.left, [], "Camel stays for the account that runs it");
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { state: "paused" }, "tenant-b", "ar_session=session-b")).status, 404);
  assert.equal((await f.install()).location.searchParams.get("discord_server"), guildA);
  assert.equal((await f.binding())[0].channel_id, a.channelId);
});

test("after a disconnect, a fresh install by another account's administrator takes the server over; the old account sees no new conversation", async t => {
  const f = await fixture(t); const a = await f.bind(); await f.ready();
  await f.db.query("insert into channel_agents(agent,channel,tenant,conversation) values('agent-a',$1,'tenant-a',$2)", [a.channelId, channelA]);
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { state: "disconnected" })).status, 200);
  const b = await f.bind(guildA, channelA, "tenant-b", "ar_session=session-b");
  const [binding] = await f.binding();
  assert.equal(binding.tenant, "tenant-b"); assert.equal(binding.state, "active"); assert.equal(binding.channel_id, b.channelId);
  assert.equal((await f.db.query("select count(*)::int n from channels where id=$1", [a.channelId])).rows[0].n, 0);
  assert.equal((await f.db.query("select count(*)::int n from channel_agents where agent='agent-a'")).rows[0].n, 0);
  assert.deepEqual((await (await f.request("/console/discord/bindings")).json() as any).bindings, []);
  await f.message(guildA, channelA, "501");
  assert.deepEqual(f.received.map(item => item.channel), [b.channelId]);
});

test("removing Camel disconnects the server, so it can be added again under another account", async t => {
  const f = await fixture(t); await f.bind(); await f.ready();
  await f.managed.dispatch("GUILD_DELETE", { id: guildA });
  assert.equal((await f.binding())[0].state, "disconnected");
  await f.bind(guildA, channelA, "tenant-b", "ar_session=session-b");
  assert.equal((await f.binding())[0].tenant, "tenant-b");
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
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { state: "paused" })).status, 200);
  await assert.rejects(f.managed.provider.send({ bindingId: binding }, channelA, "late"), /not permitted/);
  assert.deepEqual(f.sent.map(item => item.content), ["safe", "thread safe"]);
});

test("in a server nobody set up, a mention makes Camel leave; role mentions, DMs and servers being set up are ignored", async t => {
  const f = await fixture(t); await f.ready();
  await f.managed.dispatch("MESSAGE_CREATE", { id: "303", guild_id: guildA, channel_id: channelA, type: 0, author: { id: OWNER }, mention_roles: [APP], mentions: [], content: "role hello" });
  await f.managed.dispatch("MESSAGE_CREATE", { id: "304", channel_id: "999", type: 0, author: { id: OWNER }, mentions: [], content: "a DM" });
  await f.message();
  for (const deadline = Date.now() + 2000; !f.left.length && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(f.left, [guildA]); assert.equal(f.sent.length, 0); assert.equal(f.received.length, 0);
  await f.install(guildB); await f.message(guildB, channelB, "305");
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(f.left, [guildA], "a server being set up keeps Camel"); assert.equal(f.sent.length, 0);
  assert.equal((await f.db.query("select count(*)::int n from discord_setup_cooldowns")).rows[0].n, 0, "no state for unbound servers");
});

test("guild unavailability differs from removal; removal cancels queued work and re-adding requires explicit resume", async t => {
  const f = await fixture(t); const a = await f.bind(); await f.ready();
  await f.managed.dispatch("GUILD_DELETE", { id: guildA, unavailable: true });
  assert.equal((await f.binding())[0].state, "active");
  await f.message(); assert.equal(f.received.length, 0);
  await f.managed.dispatch("GUILD_CREATE", { id: guildA, name: "Alpha" }); await f.message(guildA, channelA, "302"); assert.equal(f.received.length, 1);
  await f.db.query("insert into channel_items(id,item,revision,due) values($1,$2,1,0)", [randomUUID(), JSON.stringify({ channel: a.channelId })]);
  await f.managed.dispatch("GUILD_DELETE", { id: guildA });
  assert.equal((await f.db.query("select count(*) from channel_items")).rows[0].count, 0);
  await f.managed.dispatch("GUILD_CREATE", { id: guildA }); assert.equal((await f.binding())[0].state, "disconnected");
  await f.message(guildA, channelA, "303"); assert.equal(f.received.length, 1);
  assert.equal((await f.install()).location.searchParams.get("discord_server"), guildA);
  assert.equal((await f.binding())[0].state, "paused", "added again by its account: paused until resumed");
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { state: "active" })).status, 200);
  await f.message(guildA, channelA, "304"); assert.equal(f.received.length, 2);
  await f.managed.dispatch("READY", { user: { id: APP }, guilds: [] });
  assert.equal((await f.db.query("select state from discord_installations where guild_id=$1", [guildA])).rows[0].state, "removed");
});

test("there is no interactions endpoint", async t => {
  const f = await fixture(t);
  assert.equal((await f.managed.app.request("https://camel.test/channels/discord-managed/interactions", { method: "POST", body: "{}" })).status, 404);
});

test("startup shard refusal is recoverable and does not break the runtime", async t => {
  const f = await fixture(t); f.state.shards = 2;
  await f.managed.start(); assert.equal(f.state.gatewayCalls, 1);
  await f.managed.stop();
});

test("definition switches apply to existing conversations and show exact outcomes", async t => {
  const calls: unknown[] = [];
  const f = await fixture(t, { applyDefinition: async (tenant: string, channel: string, definition: string) => {
    calls.push({ tenant, channel, definition }); return [{ agent: "agent-1", requestId: "request-1", status: "queued" as const }];
  } });
  const a = await f.bind();
  assert.deepEqual(calls, [], "the first setup applies nothing");
  const response = await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { definition: "def-next" });
  assert.equal(response.status, 200); const result = await response.json() as any;
  assert.deepEqual(calls, [{ tenant: "tenant-a", channel: a.channelId, definition: "def-next" }]);
  assert.deepEqual(result.applied, [{ agent: "agent-1", requestId: "request-1", status: "queued" }]);
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
  const f = await fixture(t, { owned: true });
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

test("unfunded server mentions produce bounded deterministic status without submitting agent work", async t => {
  const f = await fixture(t); await f.bind();
  const unfunded = new ManagedDiscord({ ...f.options, canStart: async () => "no credit" }); t.after(() => unfunded.stop());
  await unfunded.dispatch("READY", { user: { id: APP }, guilds: [{ id: guildA }] });
  await unfunded.dispatch("MESSAGE_CREATE", { id: "301", guild_id: guildA, channel_id: channelA, type: 0, author: { id: OWNER }, mentions: [{ id: APP }], content: `<@${APP}> hello`, attachments: [] });
  assert.equal(f.received.length, 0);
  for (const deadline = Date.now() + 2000; !f.sent.length && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].content, /balance and spending limits/);
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

test("the bound account pauses, resumes and disconnects its server, even with Camel gone; no other account can", async t => {
  const f = await fixture(t); await f.bind();
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { state: "paused" })).status, 200);
  assert.equal((await f.binding())[0].state, "paused");
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { state: "active" })).status, 200);
  f.state.present = false;
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { state: "paused" })).status, 200);
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { state: "active" })).status, 404, "resuming needs Camel in the server");
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { state: "disconnected" }, "tenant-b", "ar_session=session-b")).status, 404);
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { state: "disconnected" })).status, 200);
});

test("members without access cost no Discord REST lookup", async t => {
  const f = await fixture(t); const a = await f.bind(); await f.ready();
  f.saved.get(a.channelId)!.access = { public: false, allow: [] };
  f.state.limitedGet = true;
  await f.managed.dispatch("MESSAGE_CREATE", { id: "402", guild_id: guildA, channel_id: "203", type: 0, author: { id: "998" }, mentions: [{ id: APP }], content: "hi", attachments: [] });
  assert.equal((await f.db.query("select count(*) from discord_setup_cooldowns where key=$1", [`${APP}:rest`])).rows[0].count, 0);
  assert.equal(f.received.length, 0);
});

test("a route's own 429 delays only that send; other servers and nodes keep delivering", async t => {
  const f = await fixture(t); await f.bind(); const binding = (await f.db.query("select id from discord_server_bindings")).rows[0].id;
  f.state.routeLimited = true;
  await assert.rejects(f.managed.provider.send({ bindingId: binding }, channelA, "first"), (error: any) => error.retryAfterMs > 0 && !error.global);
  assert.equal((await f.db.query("select count(*) from discord_setup_cooldowns where key=$1", [`${APP}:rest`])).rows[0].count, 0);
  f.state.routeLimited = false;
  const peer = new ManagedDiscord({ ...f.options, node: "second" }); t.after(() => peer.stop());
  await peer.provider.send({ bindingId: binding }, channelA, "second");
  await f.managed.provider.send({ bindingId: binding }, channelA, "third");
  assert.deepEqual(f.sent.map(item => item.content), ["second", "third"]);
});

test("a failed configuration change leaves the server as it was, and edits that do not affect delivery keep queued work", async t => {
  const f = await fixture(t); const a = await f.bind();
  await f.db.query("insert into channel_items(id,item,revision,due) values($1,$2,1,0)", [randomUUID(), JSON.stringify({ channel: a.channelId })]);
  const failed = await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { definition: "missing", allowedChannelIds: [channelA, "203"] });
  assert.equal(failed.status, 404);
  const binding = (await f.db.query("select state,allowed_channel_ids from discord_server_bindings")).rows[0];
  assert.equal(binding.state, "active"); assert.deepEqual(binding.allowed_channel_ids, [channelA]);
  assert.equal((await f.db.query("select count(*)::int n from channel_items")).rows[0].n, 1);
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { name: "Renamed", definition: "def-two" })).status, 200);
  assert.equal((await f.db.query("select count(*)::int n from channel_items")).rows[0].n, 1);
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { state: "paused" })).status, 200);
  assert.equal((await f.db.query("select count(*)::int n from channel_items")).rows[0].n, 0);
});

test("free accounts connect one server with at most 500 turns a day; an extra install is refused and Camel leaves it", async t => {
  const plans: Record<string, { free: boolean; servers: number; turnsPerDay: number }> = { "tenant-a": { free: true, servers: 1, turnsPerDay: 500 } };
  const f = await fixture(t, { plan: async tenant => plans[tenant] });
  await f.install();
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { definition: "d", allowedChannelIds: [channelA], limits: { turnsPerDay: 501 } })).status, 400);
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { definition: "d", allowedChannelIds: [channelA], limits: { turnsPerDay: 500 } })).status, 200);
  assert.match((await f.install(guildB)).location.searchParams.get("discord_error")!, /at most 1 Discord server/);
  for (const deadline = Date.now() + 2000; !f.left.length && Date.now() < deadline;) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(f.left, [guildB]); assert.deepEqual((await f.binding()).map(row => row.guild_id), [guildA]);
  assert.equal((await (await f.request("/console/discord/config")).json() as any).limits.turnsPerDay, 500);
  plans["tenant-a"] = { free: false, servers: 2, turnsPerDay: 10_000 };
  assert.equal((await f.install(guildB)).location.searchParams.get("discord_server"), guildB);
});

test("a definition with a self-starting builtin cannot serve a server", async t => {
  const f = await fixture(t, { definitionBuiltins: async (_tenant, id) => id === "def-scheduled" ? ["web_search", "schedule"] : ["web_search"] });
  await f.install();
  const refused = await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { definition: "def-scheduled", allowedChannelIds: [channelA] });
  assert.equal(refused.status, 400); assert.match((await refused.json() as any).error, /cannot use the schedule builtin/);
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { definition: "def-plain", allowedChannelIds: [channelA] })).status, 200);
  assert.equal((await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { definition: "def-scheduled" })).status, 400);
});

test("saving a server whose definition has a builtin the account cannot use answers with its warning", async t => {
  const hint = "Web search isn't available for this account: add an Exa, Brave or Parallel key under Models & keys (PUT /v1/providers/<provider>/key)";
  const f = await fixture(t, { definitionWarnings: async (_tenant, id) => id === "def-unkeyed" ? [hint] : [] });
  await f.install();
  const saved = await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { definition: "def-unkeyed", allowedChannelIds: [channelA] });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json() as any).warnings, [hint]);
  const keyed = await f.request(`/console/discord/bindings/${guildA}`, "PATCH", { definition: "def-plain" });
  assert.equal((await keyed.json() as any).warnings, undefined);
});

test("Discord's real token response binds whatever its scope string lists", async t => {
  const f = await fixture(t);
  for (const scope of ["bot", "identify bot", "bot identify", "identify", ""]) {
    f.state.scope = scope;
    const { location } = await f.install();
    assert.equal(location.searchParams.get("discord_server"), guildA, `${JSON.stringify(scope)}: ${location.searchParams.get("discord_error")}`);
  }
  assert.equal((await f.binding()).length, 1, "installing again into a server Camel is already in keeps one binding");
});

test("without a guild in the token response, the redirect's guild_id counts only for a user who manages that server", async t => {
  const f = await fixture(t); f.state.noGuild = true;
  const logs: string[] = []; const original = console.log;
  console.log = (line: string) => { logs.push(String(line)); };
  let refused;
  try { refused = await f.install(); } finally { console.log = original; }
  assert.match(refused.location.searchParams.get("discord_error")!, /Manage Server/);
  assert.equal((await f.binding()).length, 0);
  const line = JSON.parse(logs.find(entry => entry.includes("discord_managed_install_failed"))!);
  assert.deepEqual({ fields: line.fields, scope: line.scope, guild: line.guild, hint: line.hint, exchange: line.exchange },
    { fields: ["access_token", "expires_in", "refresh_token", "scope", "token_type"], scope: "bot", guild: false, hint: true, exchange: 200 });
  for (const secret of ["verified-token", "refresh-secret", `code=${guildA}`]) assert.ok(!logs.join("\n").includes(secret), `the log leaves out ${secret}`);
  f.state.memberRoles = undefined;
  assert.match((await f.install()).location.searchParams.get("discord_error")!, /Manage Server/, "not a member");
  f.state.memberRoles = ["role-member"];
  assert.match((await f.install()).location.searchParams.get("discord_error")!, /Manage Server/, "a role without Manage Server");
  f.state.memberRoles = ["role-member", "role-manager"];
  assert.equal((await f.install()).location.searchParams.get("discord_server"), guildA);
  assert.equal((await f.binding())[0].administrator_id, OWNER);
});
