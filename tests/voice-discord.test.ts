import { test } from "node:test";
import assert from "node:assert/strict";
import { DiscordVoice, discordVoice, EARLY_PACKETS, EARLY_SSRCS, RosterGuard } from "../src/voice-discord.ts";
import type { VoiceCredentials, VoiceHandlers } from "../src/voice-sessions.ts";
import { fakeDiscordVoice } from "./fake-discord-voice.ts";
import { discordGrant, opusPacket, sleep, speechPacket, until, voiceCluster } from "./voice-fakes.ts";

/** A Discord voice connection to the fake server, recording what it reports. */
function connect(credentials: VoiceCredentials) {
  const seen = { ready: 0, packets: [] as { speaker: string; packet: Uint8Array }[], broken: [] as string[], lost: [] as { reason: string; detail?: string }[], diagnostics: [] as { event: string; fields: Record<string, unknown> }[] };
  const handlers: VoiceHandlers = {
    ready: () => { seen.ready++; },
    packet: (speaker, packet) => seen.packets.push({ speaker, packet }),
    broken: speaker => seen.broken.push(speaker),
    lost: (reason, detail) => seen.lost.push({ reason, ...(detail ? { detail } : {}) }),
    diagnostic: (event, fields) => seen.diagnostics.push({ event, fields }),
  };
  const connection = discordVoice().connect(credentials, handlers);
  return { connection, seen };
}

test("a connection made from forwarded credentials identifies with them, and hears each speaker's packets decrypted", async t => {
  const voice = await fakeDiscordVoice(t);
  const grant = discordGrant({ endpoint: voice.endpoint });
  voice.members(["400000000000000004", grant.userId]);
  const { connection, seen } = connect(grant);
  t.after(() => connection.close());
  await until(() => seen.ready === 1, "ready");
  assert.deepEqual(voice.identifies[0], { server_id: grant.guildId, user_id: grant.userId, session_id: grant.sessionId, token: grant.token, max_dave_protocol_version: 1 });
  assert.deepEqual(seen.diagnostics.find(entry => entry.event === "ready")?.fields, { dave: 0 });
  assert.ok(!JSON.stringify(seen.diagnostics).includes(grant.token), "diagnostics never carry the token");
  await until(() => connection.others()?.length === 2, "the members");
  assert.deepEqual(connection.others()!.sort(), ["300000000000000003", "400000000000000004"]);

  const sent = Array.from({ length: 30 }, (_, index) => opusPacket(index));
  await voice.speak("400000000000000004", 5_001, sent);
  await until(() => seen.packets.length === 30, "the packets");
  assert.ok(seen.packets.every(entry => entry.speaker === "400000000000000004"));
  assert.deepEqual(seen.packets.map(entry => [...entry.packet]), sent.map(packet => [...packet]));
  voice.leave("400000000000000004");
  await until(() => connection.others()?.length === 1, "the member who left");
  assert.equal(seen.lost.length, 0);
});

test("a dropped voice socket is resumed with the same credentials; a kick or refused credentials are reported, and new credentials reconnect", async t => {
  const voice = await fakeDiscordVoice(t);
  const grant = discordGrant({ endpoint: voice.endpoint });
  const { connection, seen } = connect(grant);
  t.after(() => connection.close());
  await until(() => seen.ready === 1, "ready");

  // A voice server restarting (4015): resumed on a new socket, nothing reported.
  voice.close(4015);
  await until(() => voice.resumes.length === 1 && seen.ready === 2, "the resume");
  assert.equal(voice.identifies.length, 1);
  assert.equal(seen.lost.length, 0);

  // A close that cannot be resumed but is no verdict on the credentials: identified again with the same ones.
  voice.close(4020);
  await until(() => voice.identifies.length === 2 && seen.ready === 3, "the rejoin");
  assert.equal(voice.identifies[1].token, grant.token);
  assert.equal(seen.lost.length, 0);
  // The new UDP socket's audio is heard too, its first packets ahead of Speaking among it.
  await voice.speak("400000000000000004", 5_003, Array.from({ length: 5 }, (_, index) => opusPacket(index)), 2, { speakingAfter: 2 });
  await until(() => seen.packets.length === 5, "the packets after the rejoin");

  // Kicked from the channel (4014): reported, and not rejoined on its own.
  voice.close(4014);
  await until(() => seen.lost.length === 1, "the kick");
  assert.deepEqual(seen.lost[0], { reason: "kicked", detail: "close 4014" });
  const identified = voice.identifies.length;

  // New credentials (a PATCH): a new identify with them, and ready again.
  connection.update({ ...grant, sessionId: "moved", token: "moved-token" });
  await until(() => seen.ready === 4 && voice.identifies.length === identified + 1, "ready again");
  assert.equal(voice.identifies.at(-1)!.token, "moved-token");

  // Credentials Discord no longer takes (4004 at identify, or 4006): reported as such.
  voice.refuse("refused-token");
  connection.update({ ...grant, token: "refused-token" });
  await until(() => seen.lost.length === 2, "the refusal");
  assert.equal(seen.lost[1].reason, "credentials");
});

test("a session on the Discord transport: the call's speech becomes utterances", async t => {
  const voice = await fakeDiscordVoice(t);
  const { node, events } = await voiceCluster(t, { transports: { discord: discordVoice() }, endpoints: /^127\.0\.0\.1$/ });
  const a = await node("http://a");
  const grant = discordGrant({ endpoint: voice.endpoint });
  voice.members(["400000000000000004", grant.userId]);
  const created = await a.voice.create("alice", { discord: grant, silenceMs: 300 });
  await until(async () => (await a.voice.get("alice", created.id)).state === "live", "live");
  await voice.speak("400000000000000004", 5_002, Array.from({ length: 50 }, (_, index) => speechPacket(index)));
  const [utterance] = await until(async () => { const found = await events("voice.utterance"); return found.length && found; }, "the utterance");
  assert.equal(utterance.data.speakerId, "400000000000000004");
  assert.equal(utterance.data.text, "heard 1.0 seconds");
  const ended = await a.voice.end("alice", created.id);
  assert.equal(ended.state, "ended");
  await until(() => !voice.connected(), "the socket to close");
});

test("the DAVE roster guard: a member the voice gateway never named, past the grace, is a stranger; one named in time is not", async () => {
  let members: string[] | undefined = ["self", "ada"];
  let named = new Set(["ada"]);
  const found: string[][] = [];
  const guard = new RosterGuard({ self: "self", graceMs: 100, members: () => members, named: () => named, stranger: strangers => found.push(strangers) });
  guard.check();
  assert.deepEqual(found, [], "everyone is named");
  // A member the gateway names late (Clients Connect trailing the Welcome): pending, then cleared.
  members = ["self", "ada", "bob"];
  guard.check();
  await sleep(40);
  named = new Set(["ada", "bob"]);
  guard.check();
  await sleep(150);
  assert.deepEqual(found, []);
  // One never named: a stranger once the grace passes, found by the guard's own recheck.
  members = ["self", "ada", "bob", "eve"];
  guard.check();
  await sleep(150);
  assert.deepEqual(found, [["eve"]]);
  // No group (no DAVE, or not joined yet): nothing to check.
  members = undefined;
  guard.check();
  await sleep(150);
  assert.equal(found.length, 1);
  guard.close();
});

test("a stranger in the DAVE group drops the connection, which joins again; one that keeps coming back ends it", async t => {
  const voice = await fakeDiscordVoice(t);
  const grant = discordGrant({ endpoint: voice.endpoint });
  voice.members(["400000000000000004"]);
  const lost: string[] = [], diagnostics: { event: string; fields: Record<string, unknown> }[] = [];
  let ready = 0;
  // The group as davey would report it: the bot, the named member, and someone the gateway never named.
  const connection = discordVoice({ roster: { graceMs: 50, members: () => [grant.userId, "400000000000000004", "666000000000000666"] } }).connect(grant, {
    ready: () => { ready++; }, packet: () => {}, broken: () => {}, lost: (reason, detail) => lost.push(`${reason}:${detail}`),
    diagnostic: (event, fields) => diagnostics.push({ event, fields }),
  });
  t.after(() => connection.close());
  await until(() => lost.length === 1, "the connection to give up", 15_000);
  assert.deepEqual(lost, ["error:dave_roster"]);
  const drops = diagnostics.filter(entry => entry.event === "dave_roster");
  assert.equal(drops.length, 4, "three drops and joins again, then the fourth gives up");
  assert.deepEqual(drops[0].fields, { strangers: 1, drops: 1 });
  assert.equal(voice.identifies.length, 4, "each drop joined again with a new voice socket");
  assert.ok(ready >= 4);
});

test("no packet at the start of an utterance is lost: not those before Discord tells whose SSRC it is, across utterances and speakers", async t => {
  const voice = await fakeDiscordVoice(t);
  const grant = discordGrant({ endpoint: voice.endpoint });
  const ada = "400000000000000004", bob = "500000000000000005";
  voice.members([ada, bob, grant.userId]);
  const { connection, seen } = connect(grant);
  t.after(() => connection.close());
  await until(() => seen.ready === 1, "ready");
  const heard = (speaker: string) => seen.packets.filter(entry => entry.speaker === speaker).map(entry => [...entry.packet]);
  const sent = new Map<string, number[][]>([[ada, []], [bob, []]]);
  // Three utterances each, apart by more than the receiver's speaking timeout (100 ms). Speaking (op 5) is sent once
  // per SSRC and trails each speaker's first packets, as it can from Discord: UDP outruns the WebSocket.
  for (let round = 0; round < 3; round++) {
    for (const [speaker, ssrc] of [[ada, 6_001], [bob, 6_002]] as const) {
      const packets = Array.from({ length: 10 }, (_, index) => opusPacket(round * 20 + index + (speaker === bob ? 10 : 0)));
      sent.get(speaker)!.push(...packets.map(packet => [...packet]));
      await voice.speak(speaker, ssrc, packets, 2, { speakingAfter: round === 0 ? 3 : undefined });
    }
    await sleep(150);
  }
  await until(() => heard(ada).length >= sent.get(ada)!.length && heard(bob).length >= sent.get(bob)!.length, "the packets").catch(() => {});
  assert.deepEqual([heard(ada).length, heard(bob).length], [30, 30], "as many packets heard as sent");
  assert.deepEqual(heard(ada), sent.get(ada), "every packet of ada's, the first of each utterance too, in order");
  assert.deepEqual(heard(bob), sent.get(bob), "every packet of bob's");
  assert.equal(seen.broken.length, 0);
  assert.ok(connection instanceof DiscordVoice);
  assert.deepEqual(connection.audio(), { streams: [ada, bob], held: 0, heldSsrcs: 0 }, "one stream per speaker, kept across their utterances");
});

test("a packet that will not decrypt breaks the speaker's stream, which their next packet reopens", async t => {
  const voice = await fakeDiscordVoice(t);
  const grant = discordGrant({ endpoint: voice.endpoint });
  voice.members(["400000000000000004", grant.userId]);
  const { connection, seen } = connect(grant);
  t.after(() => connection.close());
  await until(() => seen.ready === 1, "ready");
  const sent = Array.from({ length: 20 }, (_, index) => opusPacket(index));
  // Sent without a pause (no new speaking start): the packets after the bad one are heard all the same.
  await voice.speak("400000000000000004", 5_004, sent, 5, { garbled: 5 });
  await until(() => seen.packets.length >= 19, "the packets around the bad one").catch(() => {});
  assert.deepEqual(seen.broken, ["400000000000000004"]);
  assert.deepEqual(seen.packets.map(entry => [...entry.packet]), sent.filter((_, index) => index !== 5).map(packet => [...packet]));
});

test("what a connection keeps per speaker is bounded, and goes when they leave or the session ends", async t => {
  const voice = await fakeDiscordVoice(t);
  const grant = discordGrant({ endpoint: voice.endpoint });
  const ada = "400000000000000004", bob = "500000000000000005";
  voice.members([ada, bob, grant.userId]);
  const { connection, seen } = connect(grant);
  t.after(() => connection.close());
  assert.ok(connection instanceof DiscordVoice);
  await until(() => seen.ready === 1, "ready");
  await voice.speak(ada, 7_001, Array.from({ length: 5 }, (_, index) => opusPacket(index)));
  await voice.speak(bob, 7_002, Array.from({ length: 5 }, (_, index) => opusPacket(index)));
  await until(() => seen.packets.length === 10, "both speakers");
  assert.deepEqual(connection.audio().streams, [ada, bob]);

  // Ada leaves: her stream closes; Bob's stays.
  voice.leave(ada);
  await until(() => connection.audio().streams.length === 1, "ada's stream to close");
  assert.deepEqual(connection.audio().streams, [bob]);
  assert.equal(seen.broken.length, 0, "leaving is not a broken stream");

  // An SSRC Speaking never maps: only its latest packets are held, and only for a few SSRCs.
  await voice.speak(ada, 7_003, Array.from({ length: EARLY_PACKETS + 20 }, (_, index) => opusPacket(index)), 1, { speakingAfter: Infinity });
  await until(() => connection.audio().held === EARLY_PACKETS, "the held packets");
  for (let ssrc = 7_100; ssrc < 7_100 + EARLY_SSRCS + 4; ssrc++) await voice.speak(ada, ssrc, [opusPacket(1), opusPacket(2)], 1, { speakingAfter: Infinity });
  await until(() => connection.audio().heldSsrcs === EARLY_SSRCS && connection.audio().held === EARLY_SSRCS * 2, "the oldest SSRCs dropped");
  assert.equal(seen.packets.length, 10, "nothing from an unmapped SSRC is heard");

  connection.close();
  assert.deepEqual(connection.audio(), { streams: [bob], held: 0, heldSsrcs: 0 });
  await until(() => connection.audio().streams.length === 0, "every stream closed");
});

test("a session on the Discord transport: each utterance has all its packets, its first too, for each speaker", async t => {
  const voice = await fakeDiscordVoice(t);
  const { node, events } = await voiceCluster(t, { transports: { discord: discordVoice() }, endpoints: /^127\.0\.0\.1$/ });
  const a = await node("http://a");
  const grant = discordGrant({ endpoint: voice.endpoint });
  const ada = "400000000000000004", bob = "500000000000000005";
  voice.members([ada, bob, grant.userId]);
  const created = await a.voice.create("alice", { discord: grant, silenceMs: 300 });
  await until(async () => (await a.voice.get("alice", created.id)).state === "live", "live");
  // Two utterances each, of 50 packets (1.00 s); each speaker's Speaking trails their first 3 packets.
  for (let round = 0; round < 2; round++) {
    await Promise.all([
      voice.speak(ada, 8_001, Array.from({ length: 50 }, (_, index) => speechPacket(index)), 2, { speakingAfter: round === 0 ? 3 : undefined }),
      voice.speak(bob, 8_002, Array.from({ length: 50 }, (_, index) => speechPacket(index)), 2, { speakingAfter: round === 0 ? 3 : undefined }),
    ]);
    await sleep(600);
  }
  const utterances = await until(async () => { const found = await events("voice.utterance"); return found.length === 4 && found; }, "the utterances");
  for (const speaker of [ada, bob]) {
    const theirs = utterances.filter(utterance => utterance.data.speakerId === speaker);
    assert.deepEqual(theirs.map(utterance => [utterance.data.seconds, utterance.data.text, utterance.data.ended]), [[1, "heard 1.0 seconds", "silence"], [1, "heard 1.0 seconds", "silence"]]);
  }
  await a.voice.end("alice", created.id);
});
