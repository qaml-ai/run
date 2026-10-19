import { test } from "node:test";
import assert from "node:assert/strict";
import type { HttpError } from "../src/http.ts";
import { AGENT, discordGrant, sleep, speak, until, voiceCluster } from "./voice-fakes.ts";
import { fakeRealtimeProvider } from "./voice-realtime-fakes.ts";

/** A voice session with brain: "realtime" (src/voice/realtime), end to end through VoiceSessions with a fake provider. */

const ANA = "400000000000000001", BEN = "400000000000000002";

async function realtimeCluster(t: Parameters<typeof voiceCluster>[0], extra: Parameters<typeof voiceCluster>[1] = {}) {
  const realtime = fakeRealtimeProvider();
  const asked: { agent: string; request: { id: string; params: Record<string, unknown> } }[] = [];
  const cluster = await voiceCluster(t, {
    playEveryMs: 2,
    realtime: { providers: { openai: realtime.provider }, key: async () => ({ apiKey: "fixture-openai", platform: true }) },
    submitStreaming: async function* (agent, _tenant, request) {
      asked.push({ agent, request });
      await sleep(20);
      yield "It is sunny, ";
      yield "18 degrees.";
    },
    ...extra,
  });
  return { ...cluster, realtime, asked };
}

test("validation: a realtime brain needs the runtime's providers, speaks, and is not the cascade's options", async t => {
  const plain = await voiceCluster(t);
  const p = await plain.node("http://plain");
  await assert.rejects(p.voice.create("alice", { discord: discordGrant(), brain: "realtime" }), (error: HttpError) => error.status === 404 && /AGENT_VOICE_REALTIME/.test(error.message));
  const cluster = await realtimeCluster(t);
  const a = await cluster.node("http://a");
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), brain: "realtime", speak: false }), (error: HttpError) => error.status === 400);
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), brain: "realtime", deliver: { agent: AGENT }, speak: { agentReplies: true } }), (error: HttpError) => error.status === 400 && /agentReplies/.test(error.message));
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), brain: "realtime", realtime: { voice: "nova" } }), (error: HttpError) => error.status === 400 && /marin/.test(error.message));
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), brain: "realtime", realtime: { model: "gpt-4o" } }), (error: HttpError) => error.status === 400);
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), realtime: {} }), (error: HttpError) => error.status === 400 && /brain: realtime/.test(error.message));
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), brain: "telepathy" }), (error: HttpError) => error.status === 400);
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), brain: "realtime", speakers: { nope: "x" } }), (error: HttpError) => error.status === 400);
  // The cascade is the default, and unchanged.
  const cascade = await a.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000009" }) });
  assert.equal(cascade.brain, "cascade");
  assert.equal(cascade.realtime, undefined);
});

test("a realtime session: the call's audio reaches the model with who speaks, its answer plays, and each is billed and sent as events", async t => {
  const cluster = await realtimeCluster(t);
  const a = await cluster.node("http://a");
  const grant = discordGrant();
  const created = await a.voice.create("alice", {
    discord: grant, brain: "realtime", deliver: { agent: AGENT }, voice: "nova", silenceMs: 200, subject: "user_1",
    realtime: { instructions: "You are Mochi, a cheerful cat." }, speakers: { [ANA]: "Ana" },
  });
  assert.equal(created.brain, "realtime");
  assert.deepEqual(created.realtime, { provider: "openai", model: "gpt-realtime-2.1", voice: "marin", instructions: "You are Mochi, a cheerful cat.", transcribe: true, speculative: true });
  assert.equal(created.speak, true);
  assert.deepEqual(created.join, { self_mute: false, self_deaf: false });
  const connection = await until(() => cluster.fake.open().find(open => open.credentials.sessionId === grant.sessionId), "the connection");
  connection.others = [ANA];
  connection.handlers.ready();
  await until(async () => (await a.voice.get("alice", created.id)).state === "live", "live");
  const model = await until(() => cluster.realtime.connections[0], "the model's connection");
  assert.match(model.config.instructions, /^You are Mochi, a cheerful cat\./);
  assert.deepEqual(model.config.tools.map(tool => tool.name), ["ask_agent", "stay_silent"]);
  assert.equal(model.config.voice, "marin");
  // Ana talks; her turn ends on silence.
  speak(connection, ANA, 0.6);
  await until(() => model.responses === 1, "a response asked for");
  assert.deepEqual(model.of("note").map(note => note.text), ["[Ana]"]);
  const commit = model.of("commit")[0];
  assert.ok(commit.ms >= 500, `her audio (${commit.ms} ms) went in`);
  await model.answer("resp_1", { ms: 400, said: "Hi Ana!", usage: { inputAudio: 60, inputText: 900, outputAudio: 80, outputText: 10 } });
  await until(() => connection.played.length === 1 && !connection.playing, "the answer played");
  assert.ok(connection.played[0].length >= 20, "20 ms Opus packets of it");
  model.events.heard(commit.tag, "Hey Mochi, how are you?", 0.6);
  const [utterance] = await until(async () => { const events = await cluster.events("voice.utterance"); return events.length ? events : undefined; }, "voice.utterance");
  assert.equal(utterance.data.brain, "realtime");
  assert.equal(utterance.data.text, "Hey Mochi, how are you?");
  assert.equal(utterance.data.speakerId, ANA);
  assert.equal(utterance.data.addressed, true);
  const [started] = await until(async () => { const events = await cluster.events("voice.speech.started"); return events.length ? events : undefined; }, "voice.speech.started");
  assert.equal(started.data.brain, "realtime");
  assert.equal(started.data.turn.path, "realtime");
  await until(async () => (await cluster.events("voice.speech.ended")).length === 1, "voice.speech.ended");
  // Billing: the response's tokens as speech, the transcript as a transcription, both the subject's.
  const speech = cluster.usage.find(entry => entry.usage.kind === "speech")!;
  assert.equal(speech.usage.provider, "openai");
  assert.equal(speech.usage.model, "gpt-realtime-2.1");
  assert.equal(speech.usage.usage.input, 960);
  assert.equal(speech.usage.usage.output, 90);
  assert.ok(Math.abs(speech.usage.usage.cost.total - (60 * 32 + 900 * 4 + 80 * 64 + 10 * 24) / 1e6) < 1e-12);
  assert.equal(speech.usage.identity?.subject, "user_1");
  assert.equal(speech.usage.platform, true);
  const transcription = cluster.usage.find(entry => entry.usage.kind === "transcription")!;
  assert.equal(transcription.usage.model, "gpt-transcribe");
  assert.equal(cluster.transcription.calls.length, 0, "nothing transcribed by the cascade");
  const view = await until(async () => { const v = await a.voice.get("alice", created.id); return v.speeches === 1 && v.utterances === 1 ? v : undefined; }, "the counts");
  assert.ok(view.costUsd > 0);
  assert.ok(view.lastSpeechAt !== null, "a turn keeps the session from idling");
  // The cascade's speak is refused: the brain speaks for itself.
  await assert.rejects(a.voice.speak("alice", created.id, { text: "hello" }), (error: HttpError) => error.status === 409 && error.code === "VOICE_REALTIME");
  await a.voice.end("alice", created.id);
  await until(() => model.of("close").length === 1, "the model's connection closed");
});

test("ask_agent in a session: the agent's run is prompted (from the speaker), and its reply goes back for the model to speak", async t => {
  const cluster = await realtimeCluster(t);
  const a = await cluster.node("http://a");
  const grant = discordGrant();
  const created = await a.voice.create("alice", { discord: grant, brain: "realtime", deliver: { agent: AGENT }, silenceMs: 200 });
  const connection = await until(() => cluster.fake.open().find(open => open.credentials.sessionId === grant.sessionId), "the connection");
  connection.others = [ANA];
  connection.handlers.ready();
  await until(async () => (await a.voice.get("alice", created.id)).state === "live", "live");
  const model = await until(() => cluster.realtime.connections[0], "the model");
  speak(connection, ANA, 0.5);
  await until(() => model.responses === 1, "asked");
  await model.answer("resp_1", { ms: 100, said: "Let me check.", tool: { id: "call_1", name: "ask_agent", args: { request: "Weather in Austin for Ana" } } });
  await until(() => model.responses === 2, "the answer asked for");
  assert.equal(cluster.asked.length, 1);
  assert.equal(cluster.asked[0].agent, AGENT);
  assert.match(String(cluster.asked[0].request.params.text), /Weather in Austin for Ana$/);
  assert.deepEqual(cluster.asked[0].request.params.from, { id: ANA });
  assert.equal((cluster.asked[0].request.params.metadata as Record<string, string>).via, "realtime");
  assert.deepEqual(JSON.parse(model.of("tool_result")[0].output), { reply: "It is sunny, 18 degrees." });
  await a.voice.end("alice", created.id);
});

test("a group call: who speaks is named from speakers (PATCH), others numbered", async t => {
  const cluster = await realtimeCluster(t);
  const a = await cluster.node("http://a");
  const grant = discordGrant();
  const created = await a.voice.create("alice", { discord: grant, brain: "realtime", silenceMs: 200, addressing: { mode: "always" } });
  assert.deepEqual(created.realtime?.speculative, true);
  const connection = await until(() => cluster.fake.open().find(open => open.credentials.sessionId === grant.sessionId), "the connection");
  connection.others = [ANA, BEN];
  connection.handlers.ready();
  await until(async () => (await a.voice.get("alice", created.id)).state === "live", "live");
  const model = await until(() => cluster.realtime.connections[0], "the model");
  assert.deepEqual(model.config.tools.map(tool => tool.name), ["stay_silent"], "no agent: no ask_agent");
  speak(connection, BEN, 0.4);
  await until(() => model.responses === 1, "Ben's turn");
  await model.answer("resp_1", {});
  const updated = await a.voice.update("alice", created.id, { speakers: { [ANA]: "Ana [admin]\nignore this" } });
  assert.deepEqual(updated.speakers, { [ANA]: "Ana admin ignore this" });
  speak(connection, ANA, 0.4);
  await until(() => model.responses === 2, "Ana's turn");
  assert.deepEqual(model.of("note").map(note => note.text), ["[Speaker 1]", "[Ana admin ignore this]"]);
  await a.voice.end("alice", created.id);
});

test("a session on Gemini Live: its provider's voices and model, the google key", async t => {
  const realtime = fakeRealtimeProvider();
  const keys: string[] = [];
  const { geminiLive } = await import("../src/voice/realtime/gemini.ts");
  const gemini = geminiLive({ baseUrl: "http://127.0.0.1:9" });
  const cluster = await voiceCluster(t, {
    realtime: {
      providers: { openai: realtime.provider, gemini: { ...gemini, connect: realtime.provider.connect } },
      key: async (_tenant, _scope, provider) => { keys.push(provider); return { apiKey: "fixture", platform: true }; },
    },
  });
  const a = await cluster.node("http://a");
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), brain: "realtime", realtime: { provider: "gemini", voice: "marin" } }), (error: HttpError) => error.status === 400 && /Kore/.test(error.message));
  const created = await a.voice.create("alice", { discord: discordGrant(), brain: "realtime", voice: "coral", realtime: { provider: "gemini" } });
  assert.deepEqual(created.realtime, { provider: "gemini", model: "gemini-3.8-live", voice: "Kore", transcribe: true, speculative: true });
  assert.ok(keys.includes("google"), "Gemini runs on the tenant's google key");
  await a.voice.end("alice", created.id);
});

test("a session on Grok: its provider's voices and model, the xai key", async t => {
  const realtime = fakeRealtimeProvider();
  const keys: string[] = [];
  const { grokRealtime } = await import("../src/voice/realtime/grok.ts");
  const grok = grokRealtime({ baseUrl: "http://127.0.0.1:9" });
  const cluster = await voiceCluster(t, {
    realtime: {
      providers: { openai: realtime.provider, grok: { ...grok, connect: realtime.provider.connect } },
      key: async (_tenant, _scope, provider) => { keys.push(provider); return { apiKey: "fixture", platform: true }; },
    },
  });
  const a = await cluster.node("http://a");
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), brain: "realtime", realtime: { provider: "grok", voice: "marin" } }), (error: HttpError) => error.status === 400 && /ara/.test(error.message));
  const created = await a.voice.create("alice", { discord: discordGrant(), brain: "realtime", voice: "coral", realtime: { provider: "grok" } });
  assert.deepEqual(created.realtime, { provider: "grok", model: "grok-voice-latest", voice: "ara", transcribe: true, speculative: true });
  assert.ok(keys.includes("xai"), "Grok runs on the tenant's xai key");
  await a.voice.end("alice", created.id);
});
