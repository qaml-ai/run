import { test } from "node:test";
import assert from "node:assert/strict";
import type { Outbound } from "../src/outbound.ts";
import { HttpError } from "../src/http.ts";
import { Synthesizer, type SpeechProvider } from "../src/speech.ts";
import { discordGrant, sleep, until, voiceCluster } from "./voice-fakes.ts";

/** What a bot's code has a voice session say (POST …/say, …/prompt) and play (…/audio), through VoiceSessions. */

const ANA = "400000000000000001";

/** Text to speech that makes 50 ms of audio per word, recording what it was asked. */
function fakeSpeech() {
  const asked: { text: string; voice: string }[] = [];
  const provider: SpeechProvider = {
    id: "openai", model: "gpt-4o-mini-tts",
    async *stream(input) {
      asked.push({ text: input.text, voice: input.voice });
      for (const _word of input.text.split(/\s+/)) { yield Buffer.alloc(2_400, 0x22); await sleep(1); }
    },
  };
  // $0.015 a minute, billed per second made.
  const synthesizer = new Synthesizer({ provider, key: async () => ({ apiKey: "fixture-key", platform: true }), price: () => 15_000 });
  return { asked, synthesizer };
}

/** A WAV file of `seconds` at 24 kHz mono. */
function wav(seconds: number) {
  const data = Buffer.alloc(Math.round(seconds * 24_000) * 2, 0x10);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24); header.writeUInt32LE(48_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  return new Uint8Array(Buffer.concat([header, data]));
}

/** An outbound guard that serves `files` by URL (and refuses anything not https). */
function fakeOutbound(files: Record<string, Uint8Array>) {
  const fetched: string[] = [];
  const outbound = {
    check: (url: string | URL) => {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") throw new Error(`Only https:// URLs are allowed, not ${parsed.protocol}//`);
      return parsed;
    },
    fetch: async (url: string | URL) => {
      fetched.push(String(url));
      const file = files[String(url)];
      return file ? new Response(new Uint8Array(file), { status: 200 }) : new Response("gone", { status: 404 });
    },
  } as unknown as Outbound;
  return { outbound, fetched };
}

async function liveSession(t: Parameters<typeof voiceCluster>[0], extra: Parameters<typeof voiceCluster>[1] = {}, input: Record<string, unknown> = {}) {
  const speech = fakeSpeech();
  const files = fakeOutbound({ "https://cdn.example.com/song.wav": wav(0.4) });
  const cluster = await voiceCluster(t, { speech: { synthesizer: speech.synthesizer, admit: async () => {}, record: () => {} }, audioOutbound: files.outbound, ...extra });
  // Its usage goes where the cluster's does.
  const a = await cluster.node("http://a");
  await cluster.db.query("insert into webhook_endpoints (id, tenant, url, events, secret, created_at) values ('we_audio', 'alice', 'https://example.test/audio', $1, '{}', 0)", [["voice.audio.started", "voice.audio.ended"]]);
  const grant = discordGrant();
  const created = await a.voice.create("alice", { discord: grant, voice: "coral", subject: "user_1", ...input });
  const connection = await until(() => cluster.fake.open().find(open => open.credentials.sessionId === grant.sessionId), "the connection");
  connection.others = [ANA];
  connection.handlers.ready();
  await until(async () => (await a.voice.get("alice", created.id)).state === "live", "live");
  return { cluster, a, created, connection, speech, files };
}

test("say: the words play in the call's voice by text to speech, billed as speech to the session's subject, and told as voice.speech.*", async t => {
  const usage: { tenant: string; kind: string; model: string; cost: number; subject?: string }[] = [];
  const { cluster, a, created, connection, speech } = await liveSession(t);
  // POST /v1/speech's record hook is the session's: re-wire it to see the speech's usage.
  (a.voice as unknown as { options: { speech: { record: (tenant: string, record: any) => void } } }).options.speech.record = (tenant, record) => {
    usage.push({ tenant, kind: record.kind, model: record.model, cost: record.usage.cost.total, subject: record.identity?.subject });
  };
  const queued = await a.voice.say("alice", created.id, { text: "Welcome to the stream everyone" });
  assert.equal(queued.queued, 0);
  await until(() => connection.played.length === 1 && !connection.playing, "the words played");
  assert.deepEqual(speech.asked, [{ text: "Welcome to the stream everyone", voice: "coral" }], "in the call's voice");
  assert.equal(cluster.realtime.connections[0].responses, 0, "the model made none of it");
  const ended = await until(async () => (await cluster.events("voice.speech.ended"))[0], "voice.speech.ended");
  assert.equal(ended.data.source, "say");
  assert.equal(ended.data.speechId, queued.id);
  assert.equal(ended.data.reason, "done");
  await until(() => usage.length === 1, "the speech billed");
  assert.deepEqual({ ...usage[0], cost: undefined }, { tenant: "alice", kind: "speech", model: "gpt-4o-mini-tts", cost: undefined, subject: "user_1" });
  assert.ok(usage[0].cost > 0);
  await until(async () => (await a.voice.get("alice", created.id)).costUsd > 0, "its cost on the session");
  // The model hears that the bot said it.
  const notes = cluster.realtime.connections[0].of("note").map(note => note.text);
  assert.ok(notes.some(note => note.endsWith("Welcome to the stream everyone")));
  // prompt: the model is asked to speak up.
  await a.voice.prompt("alice", created.id, { instructions: "Say hi to Ana." });
  await until(() => cluster.realtime.connections[0].responses === 1, "the model asked");
  assert.match(cluster.realtime.connections[0].of("respond")[0].instructions!, /Say hi to Ana\.$/);
  await assert.rejects(a.voice.say("alice", created.id, { text: "  " }), (error: HttpError) => error.status === 400);
  await assert.rejects(a.voice.say("alice", created.id, { text: "x".repeat(4_001) }), (error: HttpError) => error.status === 400);
});

test("audio: an upload and a URL play in turn as voice.audio.* events; state, controls; the session counts what played", async t => {
  const { cluster, a, created, connection, files } = await liveSession(t);
  const upload = await a.voice.play("alice", created.id, { bytes: wav(0.3), title: "Intro" });
  assert.equal(upload.position, 0);
  const remote = await a.voice.play("alice", created.id, { url: "https://cdn.example.com/song.wav" });
  assert.equal(remote.position, 1);
  const state = await a.voice.audio("alice", created.id);
  assert.equal(state.playing?.id, upload.track.id);
  assert.deepEqual(state.queue.map(track => track.id), [remote.track.id]);
  await until(async () => (await cluster.events("voice.audio.ended")).length === 2, "both played", 8_000);
  assert.deepEqual(files.fetched, ["https://cdn.example.com/song.wav"]);
  const ended = await cluster.events("voice.audio.ended");
  assert.deepEqual(ended.map(event => [event.data.trackId, event.data.reason]), [[upload.track.id, "done"], [remote.track.id, "done"]]);
  assert.equal(ended[0].data.title, "Intro");
  assert.equal(connection.played.length, 2);
  const view = await until(async () => { const session = await a.voice.get("alice", created.id); return session.tracks === 2 ? session : undefined; }, "counted");
  assert.ok(view.playedSeconds > 0.4, `${view.playedSeconds}`);
  // A URL that is gone: it ends with why.
  await a.voice.play("alice", created.id, { url: "https://cdn.example.com/gone.mp3" });
  const error = await until(async () => (await cluster.events("voice.audio.ended")).find(event => event.data.reason === "error"), "the error");
  assert.match(error.data.error, /HTTP 404/);
  // Controls.
  await a.voice.play("alice", created.id, { bytes: wav(5) });
  await a.voice.play("alice", created.id, { bytes: wav(5) });
  const paused = await a.voice.controlAudio("alice", created.id, { action: "pause", volume: 0.2 });
  assert.equal(paused.paused, true);
  assert.equal(paused.volume, 0.2);
  const stopped = await a.voice.controlAudio("alice", created.id, { action: "stop" });
  assert.equal(stopped.playing, null);
  assert.deepEqual(stopped.queue, []);
  await assert.rejects(a.voice.play("alice", created.id, { url: "http://cdn.example.com/plain.mp3" }), (error: HttpError) => error.status === 400 && /https/.test(error.message));
  await assert.rejects(a.voice.play("alice", created.id, {}), (error: HttpError) => error.status === 400);
});

test("a listening session can't say or play; an ended one says it ended; another tenant's is not found", async t => {
  const { a, created } = await liveSession(t);
  await assert.rejects(a.voice.say("bob", created.id, { text: "hi" }), (error: HttpError) => error.status === 404);
  await a.voice.end("alice", created.id);
  await assert.rejects(a.voice.say("alice", created.id, { text: "hi" }), (error: HttpError) => error.status === 409 && error.code === "VOICE_SESSION_ENDED");
  const listening = await a.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000055" }), brain: "listen" });
  for (const call of [() => a.voice.say("alice", listening.id, { text: "hi" }), () => a.voice.prompt("alice", listening.id, { instructions: "hi" }), () => a.voice.play("alice", listening.id, { bytes: wav(0.1) }), () => a.voice.audio("alice", listening.id)]) {
    await assert.rejects(call(), (error: HttpError) => error.status === 409 && error.code === "VOICE_SPEAK_DISABLED");
  }
});
