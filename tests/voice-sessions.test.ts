import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { HttpError } from "../src/http.ts";
import { VoiceSessions } from "../src/voice-sessions.ts";
import { AGENT, discordGrant, fakeTranscriber, fakeTransport, sleep, until, voiceCluster } from "./voice-fakes.ts";

test("a session is stored sealed, taken and connected by the node that took it, and is live once ready", async t => {
  const { db, fake, node, events } = await voiceCluster(t);
  const a = await node("http://a");
  const grant = discordGrant();
  const created = await a.voice.create("alice", { discord: grant, subject: "user-1", metadata: { bot: 7 } });
  assert.match(created.id, /^vs_[a-f0-9]{24}$/);
  assert.equal(created.state, "connecting");
  assert.deepEqual(created.discord, { guildId: grant.guildId, channelId: grant.channelId, userId: grant.userId });
  assert.deepEqual(created.notice, { required: true, channelId: grant.channelId, text: `<@${grant.userId}> is listening and transcribing speech in this channel. Audio is not stored.` });
  assert.equal(created.silenceMs, 800);
  assert.equal(created.maxMinutes, 240);
  assert.ok(!JSON.stringify(created).includes(grant.token) && !JSON.stringify(created).includes(grant.sessionId), "the grant never comes back");
  const stored = (await db.query("select sealed::text, options::text from voice_sessions where id = $1", [created.id])).rows[0];
  assert.ok(!stored.sealed.includes(grant.token) && !stored.options.includes(grant.token), "the token is sealed at rest");

  const connection = await until(() => fake.open()[0], "the connection");
  assert.deepEqual(connection.credentials, grant);
  assert.equal(a.voice.size, 1);
  connection.handlers.ready();
  await until(async () => (await a.voice.get("alice", created.id)).state === "live", "live");
  assert.ok((await a.voice.get("alice", created.id)).startedAt);
  // A reconnect is ready again: still one started event.
  connection.handlers.ready();
  await sleep(100);
  const started = await events("voice.session.started");
  assert.equal(started.length, 1);
  assert.deepEqual({ ...started[0].data }, { session: created.id, provider: "discord", guildId: grant.guildId, channelId: grant.channelId, botUserId: grant.userId, subject: "user-1", metadata: { bot: 7 } });
  await assert.rejects(a.voice.get("bob", created.id), (error: HttpError) => error.status === 404);
});

test("what a session may be created with is checked, one per bot and server, and up to the tenant's limit", async t => {
  const { node } = await voiceCluster(t, { perTenant: () => 2 });
  const a = await node("http://a");
  const refused = async (input: Record<string, unknown>, status: number, pattern: RegExp) =>
    assert.rejects(a.voice.create("alice", input), (error: HttpError) => error.status === status && pattern.test(error.message));
  await refused({ discord: discordGrant({ endpoint: "evil.example.com:443" }) }, 400, /not a Discord voice server/);
  await refused({ discord: discordGrant({ endpoint: "127.0.0.1" }) }, 400, /not a Discord voice server/);
  await refused({ discord: discordGrant({ guildId: "not-an-id" }) }, 400, /discord.guildId/);
  await refused({ discord: { ...discordGrant(), extra: 1 } }, 400, /discord.extra is not a field/);
  await refused({ discord: discordGrant(), deliver: { webhooks: false } }, 400, /somewhere/);
  await refused({ discord: discordGrant(), deliver: { agent: `client_${"b".repeat(40)}` } }, 404, /Unknown agent/);
  await refused({ discord: discordGrant(), silenceMs: 50 }, 400, /silenceMs/);
  await refused({ discord: discordGrant(), maxMinutes: 721 }, 400, /maxMinutes/);
  await refused({ discord: discordGrant(), provider: "zoom" }, 400, /provider/);
  await refused({}, 400, /discord is required/);

  const first = await a.voice.create("alice", { discord: discordGrant(), deliver: { agent: AGENT } });
  assert.deepEqual(first.deliver, { agent: AGENT, webhooks: true });
  await assert.rejects(a.voice.create("alice", { discord: discordGrant() }),
    (error: HttpError) => error.status === 409 && error.code === "VOICE_SESSION_EXISTS" && error.details?.session === first.id);
  // Another server is another session; a third live one is past the limit.
  await a.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000099" }) });
  await assert.rejects(a.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000098" }) }), (error: HttpError) => error.status === 429 && error.code === "VOICE_SESSION_LIMIT");
  // Another tenant has its own.
  await a.voice.create("bob", { discord: discordGrant() });
  // An ended session frees its place.
  await a.voice.end("alice", first.id);
  await a.voice.create("alice", { discord: discordGrant() });
});

test("a tenant that may not spend, or a runtime that cannot seal, makes no session", async t => {
  const { node, db } = await voiceCluster(t, { admit: async () => { throw new HttpError(402, "Out of credit", "SPEND_LIMIT"); } });
  const a = await node("http://a");
  await assert.rejects(a.voice.create("alice", { discord: discordGrant() }), (error: HttpError) => error.status === 402 && error.code === "SPEND_LIMIT");
  const rest = { node: "x", admit: async () => {}, agentOwned: async () => true, transcriber: fakeTranscriber().transcriber, canTranscribe: async () => true, record: () => {}, submit: async () => ({}) };
  const unsealed = new VoiceSessions({ db, accounts: { canStoreKeys: false } as any, transports: { discord: fakeTransport().transport }, ...rest });
  await assert.rejects(unsealed.create("alice", { discord: discordGrant() }), (error: HttpError) => error.status === 503);
  const none = new VoiceSessions({ db, accounts: { canStoreKeys: true } as any, transports: {}, ...rest });
  await assert.rejects(none.create("alice", { discord: discordGrant() }), (error: HttpError) => error.status === 404);
  assert.equal(Number((await db.query("select count(*) as count from voice_sessions")).rows[0].count), 0);
});

test("new credentials reach the owner, from whichever node took them; a null endpoint waits for the next", async t => {
  const { fake, node } = await voiceCluster(t);
  const a = await node("http://a"), b = await node("http://b");
  const created = await a.voice.create("alice", { discord: discordGrant() });
  const connection = await until(() => fake.open()[0], "the connection");

  // Discord moves the call: b gets the PATCH, a reconnects (on b's notification, or a's scan).
  await b.voice.update("alice", created.id, { discord: { endpoint: "c-test-2.discord.media:443", token: "token-moved" } });
  await a.voice.scan();
  assert.equal(connection.updates.length, 1);
  assert.equal(connection.credentials.endpoint, "c-test-2.discord.media:443");
  assert.equal(connection.credentials.token, "token-moved");
  assert.equal(fake.open().length, 1);

  // The voice server is going away: the connection closes and waits; the next one reconnects.
  await a.voice.update("alice", created.id, { discord: { endpoint: null } });
  assert.equal(fake.open().length, 0);
  await b.voice.update("alice", created.id, { discord: { endpoint: "c-test-3.discord.media", token: "token-3", channelId: "200000000000000099" } });
  a.voice.heard(`http://b ${created.id}`);
  const next = await until(() => fake.open()[0], "a new connection");
  assert.equal(next.credentials.endpoint, "c-test-3.discord.media");
  assert.equal(next.credentials.channelId, "200000000000000099");
  assert.equal((await a.voice.get("alice", created.id)).discord.channelId, "200000000000000099");
  await assert.rejects(a.voice.update("alice", created.id, { discord: { guildId: "1" } }), /discord.guildId is not a field/);
});

test("a session ended anywhere ends once: the owner lets go, and the app is told how to leave", async t => {
  const { fake, node, events, db } = await voiceCluster(t);
  const a = await node("http://a"), b = await node("http://b");
  const grant = discordGrant();
  const created = await a.voice.create("alice", { discord: grant });
  await until(() => fake.open()[0], "the connection");
  const ended = await b.voice.end("alice", created.id);
  assert.equal(ended.state, "ended");
  assert.equal(ended.endReason, "requested");
  assert.deepEqual(ended.leave, { op: 4, d: { guild_id: grant.guildId, channel_id: null, self_mute: false, self_deaf: false } });
  assert.equal((await db.query("select sealed from voice_sessions where id = $1", [created.id])).rows[0].sealed, null, "the grant is dropped");
  a.voice.heard(`http://b ${created.id}`);
  await until(() => !fake.open().length, "the owner to close");
  assert.equal(a.voice.size, 0);
  assert.equal((await db.query("select node from actor_owners where actor = $1", [`voice:${created.id}`])).rows[0].node, null, "released");
  // Again: the same answer, and still one event.
  assert.equal((await a.voice.end("alice", created.id)).endReason, "requested");
  const endedEvents = await events("voice.session.ended");
  assert.equal(endedEvents.length, 1);
  assert.equal(endedEvents[0].data.reason, "requested");
  await assert.rejects(a.voice.update("alice", created.id, { metadata: {} }), (error: HttpError) => error.status === 409 && error.code === "VOICE_SESSION_ENDED");
});

test("a node that retires hands its calls to a peer, which connects with the same credentials; never two at once", async t => {
  const { fake, node } = await voiceCluster(t);
  const a = await node("http://a"), b = await node("http://b");
  const grant = discordGrant();
  const created = await a.voice.create("alice", { discord: grant });
  const first = await until(() => fake.open()[0], "a's connection");
  first.handlers.ready();
  await until(async () => (await a.voice.get("alice", created.id)).state === "live", "live on a");
  // b scans while a holds it: nothing happens.
  await b.voice.scan();
  assert.equal(fake.connections.length, 1);

  await a.ownership.drain();
  await a.voice.release();
  assert.ok(first.closed);
  assert.equal(a.voice.size, 0);
  await a.voice.scan();
  assert.equal(a.voice.size, 0, "a draining node takes nothing back");
  await b.voice.scan();
  const second = await until(() => fake.open()[0], "b's connection");
  assert.notEqual(second, first);
  assert.deepEqual(second.credentials, grant);
  assert.equal(fake.open().length, 1);
  assert.equal(b.voice.size, 1);
  assert.equal((await b.voice.get("alice", created.id)).state, "reconnecting");
  second.handlers.ready();
  await until(async () => (await b.voice.get("alice", created.id)).state === "live", "live on b");
});

test("a fenced node closes its calls without letting go; a peer takes them once its heartbeat is gone", async t => {
  const { fake, node, db } = await voiceCluster(t, { ttlMs: 1_500 });
  const a = await node("http://a"), b = await node("http://b");
  const created = await a.voice.create("alice", { discord: discordGrant() });
  const first = await until(() => fake.open()[0], "a's connection");
  const owner = (await db.query("select session from actor_owners where actor = $1", [`voice:${created.id}`])).rows[0].session;
  a.ownership.fence("test");
  assert.ok(first.closed);
  assert.equal(a.voice.size, 0);
  assert.equal((await db.query("select session from actor_owners where actor = $1", [`voice:${created.id}`])).rows[0].session, owner, "not released: its claim is void, not given up");
  await b.voice.scan();
  assert.equal(fake.open().length, 0, "b waits for a's heartbeat to expire");
  await a.voice.stop();
  await until(async () => { await b.voice.scan(); return fake.open().length === 1; }, "b to take the call", 5_000);
  assert.equal(b.voice.size, 1);
});

test("sessions end past their limits: length, no speech, no one else in the call, and credentials that stopped working", async t => {
  const { fake, node, events } = await voiceCluster(t, { reconnectGraceMs: 1_000 });
  const a = await node("http://a");
  const start = async (input: Record<string, unknown>, guildId: string) => {
    const created = await a.voice.create("alice", { discord: discordGrant({ guildId }), ...input });
    const connection = await until(() => fake.open().find(open => open.credentials.guildId === guildId), "the connection");
    connection.handlers.ready();
    await until(async () => (await a.voice.get("alice", created.id)).state === "live", "live");
    return { id: created.id, connection };
  };
  const now = Date.now();
  const long = await start({ maxMinutes: 1, idleMinutes: 5 }, "100000000000000011");
  const quiet = await start({ maxMinutes: 10, idleMinutes: 2 }, "100000000000000012");
  const alone = await start({ emptySeconds: 30, ignoreUserIds: ["500000000000000005"] }, "100000000000000013");
  const lost = await start({}, "100000000000000014");
  // Others in each call; in `alone`'s only the bot itself and an ignored bot.
  for (const each of [long, quiet, lost]) each.connection.others = ["400000000000000004"];
  alone.connection.others = ["300000000000000003", "500000000000000005"];
  lost.connection.handlers.lost("kicked");
  assert.ok(lost.connection.closed);
  await until(async () => (await a.voice.get("alice", lost.id)).state === "reconnecting", "reconnecting");

  await a.voice.scan(now + 1_000);
  assert.equal((await a.voice.get("alice", alone.id)).state, "live", "empty, but not for long yet");
  assert.equal((await a.voice.get("alice", lost.id)).state, "reconnecting");
  await a.voice.scan(now + 31_000);
  assert.equal((await a.voice.get("alice", alone.id)).endReason, "empty");
  assert.equal((await a.voice.get("alice", lost.id)).endReason, "kicked");
  await a.voice.scan(now + 61_000);
  assert.equal((await a.voice.get("alice", long.id)).endReason, "max_duration");
  assert.equal((await a.voice.get("alice", quiet.id)).state, "live");
  await a.voice.scan(now + 121_000);
  assert.equal((await a.voice.get("alice", quiet.id)).endReason, "idle");
  assert.equal(fake.open().length, 0);
  assert.equal(a.voice.size, 0);
  assert.deepEqual((await events("voice.session.ended")).map(event => event.data.reason).sort(), ["empty", "idle", "kicked", "max_duration"]);
});

test("new credentials in time keep a lost session; a deleted one (its account gone) closes", async t => {
  const { fake, node, db } = await voiceCluster(t);
  const a = await node("http://a");
  const created = await a.voice.create("alice", { discord: discordGrant() });
  const first = await until(() => fake.open()[0], "the connection");
  first.handlers.lost("credentials");
  await a.voice.update("alice", created.id, { discord: { sessionId: "fresh", token: "fresh-token" } });
  const second = await until(() => fake.open()[0], "the reconnection");
  assert.equal(second.credentials.sessionId, "fresh");
  await a.voice.scan(Date.now() + 60_000);
  assert.equal((await a.voice.get("alice", created.id)).state, "reconnecting", "not ended: new credentials came");
  await db.query("delete from voice_sessions where tenant = 'alice'");
  await a.voice.scan();
  assert.equal(fake.open().length, 0);
  assert.equal(a.voice.size, 0);
});

test("sessions are listed newest first, a page at a time, live or ended", async t => {
  const { node } = await voiceCluster(t);
  const a = await node("http://a");
  const ids: string[] = [];
  for (let index = 0; index < 5; index++) ids.push((await a.voice.create("alice", { discord: discordGrant({ guildId: `10000000000000010${index}` }) })).id);
  await a.voice.end("alice", ids[0]);
  const first = await a.voice.list("alice", { limit: 2 });
  assert.deepEqual(first.sessions.map(session => session.id), [ids[4], ids[3]]);
  const second = await a.voice.list("alice", { limit: 2, after: first.next! });
  assert.deepEqual(second.sessions.map(session => session.id), [ids[2], ids[1]]);
  assert.deepEqual((await a.voice.list("alice", { state: "ended" })).sessions.map(session => session.id), [ids[0]]);
  assert.equal((await a.voice.list("alice", { state: "live" })).sessions.length, 4);
  assert.equal((await a.voice.list("bob")).sessions.length, 0);
  await assert.rejects(a.voice.list("alice", { after: "vs_nope" }), /after/);
});

test("a session taken by its request and by scans at once connects once; scans leave a session a live peer holds alone", async t => {
  const { fake, node, db } = await voiceCluster(t);
  const a = await node("http://a"), b = await node("http://b");
  const created = a.voice.create("alice", { discord: discordGrant() });
  await Promise.all([created, a.voice.scan(), a.voice.scan()]);
  await until(() => fake.open().length === 1, "the connection");
  await sleep(100);
  assert.equal(fake.connections.length, 1);
  const epoch = (await db.query("select epoch from actor_owners where actor = $1", [`voice:${(await created).id}`])).rows[0].epoch;
  for (let round = 0; round < 3; round++) await Promise.all([a.voice.scan(), b.voice.scan()]);
  assert.equal((await db.query("select epoch from actor_owners where actor = $1", [`voice:${(await created).id}`])).rows[0].epoch, epoch, "no node tried to take it again");
  assert.equal(fake.connections.length, 1);
});
