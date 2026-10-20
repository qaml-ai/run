import { test } from "node:test";
import assert from "node:assert/strict";
import { EndUserCredits } from "../src/end-user-credits.ts";
import type { VoiceCredit } from "../src/voice-sessions.ts";
import type { HttpError } from "../src/http.ts";
import { AGENT, discordGrant, sleep, speak, until, voiceCluster } from "./voice-fakes.ts";
import { fakeRealtimeProvider } from "./voice-realtime-fakes.ts";

/** A voice session's realtime brain (src/voice/realtime), end to end through VoiceSessions with a fake provider. */

const ANA = "400000000000000001", BEN = "400000000000000002";

async function realtimeCluster(t: Parameters<typeof voiceCluster>[0], extra: Parameters<typeof voiceCluster>[1] = {}) {
  const asked: { agent: string; request: { id: string; params: Record<string, unknown> } }[] = [];
  const cluster = await voiceCluster(t, {
    playEveryMs: 2,
    submitStreaming: async function* (agent, _tenant, request) {
      asked.push({ agent, request });
      await sleep(20);
      yield "It is sunny, ";
      yield "18 degrees.";
    },
    ...extra,
  });
  return { ...cluster, asked };
}

test("validation: sessions need the runtime's realtime providers; brain is only realtime; the brain's settings are checked", async t => {
  const plain = await voiceCluster(t, { realtime: undefined });
  const p = await plain.node("http://plain");
  await assert.rejects(p.voice.create("alice", { discord: discordGrant() }), (error: HttpError) => error.status === 404 && /AGENT_VOICE_REALTIME/.test(error.message));
  const cluster = await realtimeCluster(t);
  const a = await cluster.node("http://a");
  for (const removed of [{ transcription: { providers: ["deepgram"] } }, { speech: { providers: ["elevenlabs"] } }, { bargeIn: { backchannels: ["bet"] } }]) {
    await assert.rejects(a.voice.create("alice", { discord: discordGrant(), ...removed }), (error: HttpError) => error.status === 400 && /is not a field/.test(error.message), JSON.stringify(removed));
  }
  // speak: every session speaks; true (from before) is taken, anything else refused.
  for (const speak of [false, { agentReplies: true }]) {
    await assert.rejects(a.voice.create("alice", { discord: discordGrant(), speak }), (error: HttpError) => error.status === 400 && /speak can only be true/.test(error.message), JSON.stringify(speak));
  }
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), brain: "cascade" }), (error: HttpError) => error.status === 400 && /brain must be realtime/.test(error.message));
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), brain: "telepathy" }), (error: HttpError) => error.status === 400);
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), realtime: { voice: "nova" } }), (error: HttpError) => error.status === 400 && /marin/.test(error.message));
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), realtime: { model: "gpt-4o" } }), (error: HttpError) => error.status === 400);
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), realtime: { provider: "gemini" } }), (error: HttpError) => error.status === 400 && /one of this runtime's: openai/.test(error.message));
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), speakers: { nope: "x" } }), (error: HttpError) => error.status === 400);
  // No brain given: the runtime's first provider, with its defaults; "realtime" is still taken.
  const plainSession = await a.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000009" }) });
  assert.deepEqual(plainSession.realtime, { provider: "openai", model: "gpt-realtime-2.1", voice: "alloy", transcribe: true, speculative: true });
  const named = await a.voice.create("alice", { discord: discordGrant({ guildId: "100000000000000010" }), brain: "realtime", speak: true });
  assert.equal(named.realtime?.provider, "openai");
  // A tenant without a key for the provider is told which.
  const keyless = await realtimeCluster(t, { realtime: { providers: { openai: cluster.realtime.provider }, key: async () => undefined } });
  const k = await keyless.node("http://k");
  await assert.rejects(k.voice.create("alice", { discord: discordGrant() }), (error: HttpError) => error.status === 400 && error.code === "REALTIME_UNAVAILABLE");
});

test("a session stored before realtime brains (no realtime settings) ends when taken: its pipeline is gone", async t => {
  const cluster = await realtimeCluster(t);
  const a = await cluster.node("http://a");
  const created = await a.voice.create("alice", { discord: discordGrant() });
  await until(() => cluster.fake.open()[0], "the connection");
  // As a peer finds it after this node let go: its options as the removed pipeline stored them.
  await a.voice.release();
  await cluster.db.query(`update voice_sessions set options = (options - 'realtime') || '{"brain": "cascade", "speak": true, "agentReplies": true}'::jsonb where id = $1`, [created.id]);
  const b = await cluster.node("http://b");
  await b.voice.scan();
  const ended = await until(async () => { const view = await b.voice.get("alice", created.id); return view.state === "ended" ? view : undefined; }, "ended");
  assert.equal(ended.endReason, "error");
  assert.equal(b.voice.size, 0);
  assert.equal(cluster.realtime.connections.length, 1, "no brain was made for it");
  assert.equal((await cluster.events("voice.session.ended")).at(-1)?.data.reason, "error");
});

test("a realtime session: the call's audio reaches the model with who speaks, its answer plays, and each is billed and sent as events", async t => {
  const cluster = await realtimeCluster(t);
  const a = await cluster.node("http://a");
  const grant = discordGrant();
  const created = await a.voice.create("alice", {
    discord: grant, deliver: { agent: AGENT }, voice: "nova", silenceMs: 200, subject: "user_1",
    realtime: { instructions: "You are Mochi, a cheerful cat." }, speakers: { [ANA]: "Ana" },
  });
  assert.deepEqual(created.realtime, { provider: "openai", model: "gpt-realtime-2.1", voice: "marin", instructions: "You are Mochi, a cheerful cat.", transcribe: true, speculative: true });
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
  const view = await until(async () => { const v = await a.voice.get("alice", created.id); return v.speeches === 1 && v.utterances === 1 ? v : undefined; }, "the counts");
  assert.ok(view.costUsd > 0);
  assert.ok(view.lastSpeechAt !== null, "a turn keeps the session from idling");
  // DELETE …/speak stops the brain's answer: nothing is playing now.
  assert.deepEqual(await a.voice.stopSpeaking("alice", created.id), { stopped: 0 });
  await a.voice.end("alice", created.id);
  await until(() => model.of("close").length === 1, "the model's connection closed");
});

test("ask_agent in a session: the agent's run is prompted (from the speaker), and its reply goes back for the model to speak", async t => {
  const cluster = await realtimeCluster(t);
  const a = await cluster.node("http://a");
  const grant = discordGrant();
  const created = await a.voice.create("alice", { discord: grant, deliver: { agent: AGENT }, silenceMs: 200 });
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
  const created = await a.voice.create("alice", { discord: grant, silenceMs: 200, addressing: { mode: "always" } });
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
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), realtime: { provider: "gemini", voice: "marin" } }), (error: HttpError) => error.status === 400 && /Kore/.test(error.message));
  const created = await a.voice.create("alice", { discord: discordGrant(), voice: "coral", realtime: { provider: "gemini" } });
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


test("a provider's supported but unpriced model is refused before opening a session", async t => {
  const realtime = fakeRealtimeProvider();
  const cluster = await realtimeCluster(t, { realtime: {
    providers: { openai: { ...realtime.provider, models: ["unpriced"], defaultModel: "unpriced" } },
    key: async () => ({ apiKey: "fixture", platform: true }),
  } });
  const a = await cluster.node("http://a");
  for (const model of [undefined, "unpriced"]) {
    await assert.rejects(a.voice.create("alice", { discord: discordGrant(), brain: "realtime", realtime: { model } }),
      (error: HttpError) => error.status === 400 && error.code === "REALTIME_UNPRICED" && /openai\/unpriced.*no price/.test(error.message));
  }
  assert.equal(realtime.connections.length, 0);
  assert.equal(Number((await cluster.db.query("select count(*) as count from voice_sessions")).rows[0].count), 0);
});

test("Grok speech usage settles the end user's real credit ledger and releases its connection hold", async t => {
  const realtime = fakeRealtimeProvider();
  const { grokRealtime } = await import("../src/voice/realtime/grok.ts");
  let credits: EndUserCredits;
  const credit: VoiceCredit = { refusal: (...args) => credits.refusal(...args), hold: (...args) => credits.hold(...args) };
  const cluster = await voiceCluster(t, { credit, realtime: {
    providers: { grok: { ...grokRealtime(), connect: realtime.provider.connect } },
    key: async () => ({ apiKey: "fixture", platform: true }),
  } });
  credits = new EndUserCredits(cluster.db);
  await credits.setSettings("alice", { enabled: true, allowances: { "*": 0 } });
  await credits.post("alice", "ada", { kind: "grant", amount: 1_000_000, key: "fixture-grant" });
  const a = await cluster.node("http://a");
  const grant = discordGrant();
  const created = await a.voice.create("alice", { discord: grant, brain: "realtime", realtime: { provider: "grok" }, subject: "ada", bucket: "bot:7", silenceMs: 200 });
  const media = await until(() => cluster.fake.open().find(open => open.credentials.sessionId === grant.sessionId), "media");
  media.others = [ANA];
  media.handlers.ready();
  const model = await until(() => realtime.connections[0], "model after credit hold");
  assert.equal(Number((await cluster.db.query("select count(*) as count from end_user_holds")).rows[0].count), 1);
  speak(media, ANA, 0.6);
  await until(() => model.responses === 1, "response");
  await model.answer("grok_1", { ms: 400, usage: { inputAudio: 500_000 } });
  const expected = Math.round((model.of("append").reduce((sum, item) => sum + item.bytes, 0) / 48_000 / 60 * 0.08 + 0.4 / 60 * 0.08 + 0.004) * 1e6);
  await until(async () => (await credits.ledger("alice", "ada")).entries.some(entry => entry.kind === "usage"), "ledger settlement");
  const speech = cluster.usage.find(entry => entry.usage.kind === "speech")!.usage;
  assert.equal(speech.provider, "grok");
  assert.equal(speech.model, "grok-voice-latest");
  assert.equal(speech.platform, true);
  assert.equal(speech.identity?.subject, "ada");
  assert.equal(Math.round(speech.usage.cost.total * 1e6), expected);
  await a.voice.end("alice", created.id);
  await until(async () => Number((await cluster.db.query("select count(*) as count from end_user_holds")).rows[0].count) === 0, "all holds settled or released");
  const entries = (await credits.ledger("alice", "ada")).entries.filter(entry => entry.kind === "usage");
  assert.equal(entries.reduce((sum, entry) => sum + entry.raw, 0), expected);
  assert.ok(entries.every(entry => entry.bucket === "bot:7"));
  await until(async () => Math.round((await a.voice.get("alice", created.id)).costUsd * 1e6) === expected, "session cost");
});

test("an ElevenLabs session accepts library voice ids, maps OpenAI names, disables speculation, and resolves the elevenlabs key", async t => {
  const names = ["AGENT_PRICE_ELEVENLABS_AGENTS_MINUTE_USD", "AGENT_PRICE_ELEVENLABS_LLM_MINUTE_USD"];
  for (const name of names) {
    const previous = process.env[name];
    process.env[name] = "1"; // Synthetic fixture rate.
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const realtime = fakeRealtimeProvider();
  const keys: string[] = [];
  const { elevenlabsAgents, ELEVENLABS_AGENTS } = await import("../src/voice/realtime/elevenlabs.ts");
  const elevenlabs = elevenlabsAgents();
  const cluster = await voiceCluster(t, {
    realtime: {
      providers: { elevenlabs: { ...elevenlabs, connect: realtime.provider.connect } },
      key: async (_tenant, _scope, provider) => { keys.push(provider); return { apiKey: "fixture", platform: false }; },
    },
  });
  const a = await cluster.node("http://a");
  const created = await a.voice.create("alice", { discord: discordGrant(), brain: "realtime", realtime: { provider: "elevenlabs", voice: "cartoon_voice_id", publicOwnerId: "library_owner" } });
  assert.deepEqual(created.realtime, { provider: "elevenlabs", model: ELEVENLABS_AGENTS.defaultModel, voice: "cartoon_voice_id", publicOwnerId: "library_owner", transcribe: true, speculative: false });
  assert.ok(keys.includes("elevenlabs"));
  const connected = await until(() => realtime.connections[0], "ElevenLabs config");
  assert.equal(connected.config.publicOwnerId, "library_owner");
  for (const publicOwnerId of ["", "invalid owner", 42]) await assert.rejects(a.voice.create("alice", { discord: discordGrant(), realtime: { provider: "elevenlabs", publicOwnerId } }), (error: HttpError) => error.status === 400);
  await a.voice.end("alice", created.id);
  const mapped = await a.voice.create("alice", { discord: discordGrant(), brain: "realtime", realtime: { provider: "elevenlabs", voice: "coral" } });
  assert.equal(mapped.realtime?.voice, ELEVENLABS_AGENTS.voice);
  await a.voice.end("alice", mapped.id);
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), brain: "realtime", realtime: { voice: "invalid voice" } }), (error: HttpError) => error.status === 400);
});


test("ElevenLabs refuses sessions without both pricing components, before credentials or media", async t => {
  const { elevenlabsAgents } = await import("../src/voice/realtime/elevenlabs.ts");
  const realtime = fakeRealtimeProvider();
  let keys = 0;
  const cluster = await voiceCluster(t, { realtime: {
    providers: { elevenlabs: { ...elevenlabsAgents(), connect: realtime.provider.connect } },
    key: async () => { keys++; return { apiKey: "fixture", platform: true }; },
  } });
  const a = await cluster.node("http://a");
  const name = "AGENT_PRICE_ELEVENLABS_LLM_MINUTE_USD";
  const previous = process.env[name];
  delete process.env[name];
  t.after(() => { if (previous !== undefined) process.env[name] = previous; });
  await assert.rejects(a.voice.create("alice", { discord: discordGrant(), brain: "realtime", realtime: { provider: "elevenlabs" } }),
    (error: HttpError) => error.code === "REALTIME_UNPRICED");
  assert.equal(keys, 0);
  assert.equal(realtime.connections.length, 0);
});


test("ElevenLabs connection minutes settle speech usage and the end-user ledger on close", async t => {
  const { elevenlabsAgents } = await import("../src/voice/realtime/elevenlabs.ts");
  const { NO_USAGE, realtimeCost } = await import("../src/voice/realtime/provider.ts");
  for (const name of ["AGENT_PRICE_ELEVENLABS_AGENTS_MINUTE_USD", "AGENT_PRICE_ELEVENLABS_LLM_MINUTE_USD"]) {
    const previous = process.env[name];
    process.env[name] = "1"; // Synthetic fixture rate.
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const realtime = fakeRealtimeProvider();
  let credits: EndUserCredits;
  const credit: VoiceCredit = { refusal: (...args) => credits.refusal(...args), hold: (...args) => credits.hold(...args) };
  const cluster = await voiceCluster(t, { credit, realtime: {
    providers: { elevenlabs: { ...elevenlabsAgents(), connect: realtime.provider.connect } },
    key: async () => ({ apiKey: "fixture", platform: true }),
  } });
  credits = new EndUserCredits(cluster.db);
  await credits.setSettings("alice", { enabled: true, allowances: { "*": 0 } });
  await credits.post("alice", "ada", { kind: "grant", amount: 1_000_000, key: "fixture-grant" });
  const a = await cluster.node("http://a");
  const grant = discordGrant();
  const created = await a.voice.create("alice", { discord: grant, brain: "realtime", realtime: { provider: "elevenlabs" }, subject: "ada", bucket: "bot:7" });
  const media = await until(() => cluster.fake.open().find(open => open.credentials.sessionId === grant.sessionId), "media");
  media.handlers.ready();
  const model = await until(() => realtime.connections[0], "model after hold");
  assert.equal(Number((await cluster.db.query("select count(*) as count from end_user_holds")).rows[0].count), 1);
  model.events.meter?.(0.1, 0);
  await model.answer("elevenlabs_1", { ms: 80 });
  model.events.meter?.(0.05, 0);
  await a.voice.end("alice", created.id);
  await until(async () => Number((await cluster.db.query("select count(*) as count from end_user_holds")).rows[0].count) === 0, "holds released");
  const expected = Math.round(realtimeCost("elevenlabs/gemini-2.5-flash-lite", NO_USAGE, 0.15) * 1e6);
  const speech = cluster.usage.filter(entry => entry.usage.kind === "speech").map(entry => entry.usage);
  assert.ok(speech.length > 0);
  assert.ok(speech.every(entry => entry.provider === "elevenlabs" && entry.model === "gemini-2.5-flash-lite" && entry.platform && entry.identity?.subject === "ada"));
  assert.equal(Math.round(speech.reduce((sum, entry) => sum + entry.usage.cost.total, 0) * 1e6), expected);
  // A hold can briefly be absent between metering slices; wait for the final durable settlement.
  const entries = await until(async () => {
    const usage = (await credits.ledger("alice", "ada")).entries.filter(entry => entry.kind === "usage");
    return usage.reduce((sum, entry) => sum + entry.raw, 0) === expected && usage;
  }, "all ElevenLabs connection usage settled");
  assert.equal(entries.reduce((sum, entry) => sum + entry.raw, 0), expected);
  assert.ok(entries.every(entry => entry.bucket === "bot:7"));
  await until(async () => Math.round((await a.voice.get("alice", created.id)).costUsd * 1e6) === expected, "session cost");
});
