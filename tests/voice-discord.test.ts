import { test } from "node:test";
import assert from "node:assert/strict";
import { discordVoice } from "../src/voice-discord.ts";
import type { VoiceCredentials, VoiceHandlers } from "../src/voice-sessions.ts";
import { fakeDiscordVoice } from "./fake-discord-voice.ts";
import { discordGrant, opusPacket, speechPacket, until, voiceCluster } from "./voice-fakes.ts";

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
