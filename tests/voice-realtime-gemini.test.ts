import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { geminiLive, usageOf } from "../src/voice/realtime/gemini.ts";
import { realtimeCost, realtimeVoice, type RealtimeEvents } from "../src/voice/realtime/provider.ts";
import { NOT_ADDRESSED_HINT } from "../src/voice/realtime/brain.ts";
import { sleep, testBrain, tone, until, utter } from "./voice-realtime-fakes.ts";

/** Gemini Live as the brain speaks to it (src/voice/realtime/gemini.ts), against a fake server. */

async function fakeGemini(t: { after(fn: () => unknown): void }) {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const seen = { urls: [] as string[], keys: [] as string[], events: [] as any[] };
  let socket!: WebSocket;
  const connected = new Promise<void>(resolve => {
    sockets.on("connection", (ws, req) => {
      socket = ws;
      seen.urls.push(req.url ?? "");
      seen.keys.push(String(req.headers["x-goog-api-key"] ?? ""));
      ws.on("message", data => {
        const event = JSON.parse(String(data));
        seen.events.push(event);
        if (event.setup) ws.send(JSON.stringify({ setupComplete: {} }));
      });
      resolve();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const ws of sockets.clients) ws.terminate(); server.close(); });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, connected, send: (event: unknown) => socket.send(JSON.stringify(event)) };
}

function recorder() {
  const got: { type: string; [key: string]: unknown }[] = [];
  const events: RealtimeEvents = {
    ready: () => got.push({ type: "ready" }),
    responseStarted: id => got.push({ type: "started", id }),
    audio: (id, pcm) => got.push({ type: "audio", id, bytes: pcm.byteLength }),
    said: (id, text) => got.push({ type: "said", id, text }),
    toolCall: call => got.push({ type: "tool", ...call }),
    responseDone: (id, outcome) => got.push({ type: "done", id, ...outcome }),
    heard: (tag, text, seconds) => got.push({ type: "heard", tag, text, seconds }),
    warning: (code, message) => got.push({ type: "warning", code, message }),
    closed: (reason, detail) => got.push({ type: "closed", reason, ...(detail ? { detail } : {}) }),
  };
  return { got, events };
}
const kinds = (events: any[]) => events.map(event => event.setup ? "setup" : event.clientContent ? `note:${event.clientContent.turns[0]?.parts[0]?.text}:${event.clientContent.turnComplete}`
  : event.toolResponse ? "toolResponse" : event.realtimeInput?.audio ? "audio" : event.realtimeInput?.activityStart ? "activityStart" : event.realtimeInput?.activityEnd ? "activityEnd" : "?")
  .filter((kind, index, all) => !(kind === "audio" && all[index - 1] === "audio"));

test("Gemini's setup: our turns (manual activity), the voice, transcription, our tools, the key in a header; voices mapped", async t => {
  const fake = await fakeGemini(t);
  const { got, events } = recorder();
  const provider = geminiLive({ baseUrl: fake.base });
  const connection = provider.connect({
    model: "gemini-3.8-live", voice: "Kore", instructions: "Be Mochi.", transcribe: true,
    tools: [{ name: "stay_silent", description: "Say nothing", parameters: { type: "object", properties: {} } }],
  }, { apiKey: "gemini-tenant-key" }, events);
  await fake.connected;
  await until(() => got.some(event => event.type === "ready"), "ready");
  assert.equal(fake.seen.urls[0], "/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent", "no key in the URL");
  assert.equal(fake.seen.keys[0], "gemini-tenant-key");
  const setup = fake.seen.events[0].setup;
  assert.equal(setup.model, "models/gemini-3.8-live");
  assert.deepEqual(setup.realtimeInputConfig, { automaticActivityDetection: { disabled: true } });
  assert.equal(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Kore");
  assert.deepEqual(setup.systemInstruction, { parts: [{ text: "Be Mochi." }] });
  assert.deepEqual(setup.inputAudioTranscription, {});
  assert.deepEqual(setup.tools[0].functionDeclarations.map((tool: { name: string }) => tool.name), ["stay_silent"]);
  assert.deepEqual(setup.contextWindowCompression, { slidingWindow: {} });
  assert.equal(realtimeVoice(provider, "coral"), "Kore");
  assert.equal(realtimeVoice(provider, "onyx"), "Charon");
  assert.equal(realtimeVoice(provider, "Puck"), "Puck");
  connection.close();
});

test("a turn: speakers' notes inside one activity, the answer at activityEnd, its transcript to the turn's first item, audio, and usage", async t => {
  const fake = await fakeGemini(t);
  const { got, events } = recorder();
  const connection = geminiLive({ baseUrl: fake.base }).connect({ model: "gemini-3.8-live", voice: "Kore", instructions: "x", transcribe: true, tools: [] }, { apiKey: "k" }, events);
  await fake.connected;
  connection.note("[Ana]");
  connection.append(tone(300));
  assert.equal(connection.commit("t1"), true);
  connection.note("[Ben]");
  connection.append(tone(200));
  connection.commit("t2");
  connection.respond({ instructions: "Unless named, call stay_silent." });
  await until(() => fake.seen.events.some(event => event.realtimeInput?.activityEnd), "activityEnd");
  assert.deepEqual(kinds(fake.seen.events), ["setup", "note:[Ana]:false", "activityStart", "audio", "note:[Ben]:false", "audio", "note:[Unless named, call stay_silent.]:false", "activityEnd"]);
  assert.equal(fake.seen.events.find(event => event.realtimeInput?.audio).realtimeInput.audio.mimeType, "audio/pcm;rate=24000");
  assert.deepEqual(got.filter(event => event.type === "started"), [{ type: "started", id: "gemini_1" }]);
  fake.send({ serverContent: { inputTranscription: { text: "Mochi, book it. Yes please." } } });
  fake.send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.from(tone(40)).toString("base64") } }] }, outputTranscription: { text: "Sure" } } });
  fake.send({ serverContent: { generationComplete: true } });
  fake.send({ serverContent: { turnComplete: true }, usageMetadata: { promptTokenCount: 700, responseTokenCount: 130, promptTokensDetails: [{ modality: "TEXT", tokenCount: 400 }, { modality: "AUDIO", tokenCount: 300 }], responseTokensDetails: [{ modality: "AUDIO", tokenCount: 130 }], thoughtsTokenCount: 90 } });
  await until(() => got.some(event => event.type === "done"), "done");
  assert.deepEqual(got.filter(event => event.type === "heard"), [
    { type: "heard", tag: "t1", text: "Mochi, book it. Yes please.", seconds: 0.3 },
    { type: "heard", tag: "t2", text: "", seconds: 0.2 },
  ]);
  assert.deepEqual(got.filter(event => ["audio", "said"].includes(event.type)).map(event => event.type), ["said", "audio"]);
  const done = got.find(event => event.type === "done") as any;
  assert.equal(done.id, "gemini_1");
  assert.deepEqual(done.usage, { inputAudio: 300, inputText: 400, cachedText: 0, cachedAudio: 0, outputAudio: 130, outputText: 90 });
  assert.ok(Math.abs(realtimeCost("gemini/gemini-3.8-live", done.usage) - (300 * 3 + 400 * 0.75 + 130 * 12 + 90 * 4.5) / 1e6) < 1e-12);
  assert.deepEqual(usageOf(undefined), { inputText: 0, inputAudio: 0, cachedText: 0, cachedAudio: 0, outputText: 0, outputAudio: 0 });
  connection.close();
});

test("tools: a call ends its response, its result lets the turn go on without asking again; stay_silent is left unanswered", async t => {
  const fake = await fakeGemini(t);
  const { got, events } = recorder();
  const connection = geminiLive({ baseUrl: fake.base }).connect({ model: "gemini-3.8-live", voice: "Kore", instructions: "x", transcribe: false, tools: [] }, { apiKey: "k" }, events);
  await fake.connected;
  connection.append(tone(200));
  connection.commit("t1");
  connection.respond();
  await until(() => fake.seen.events.some(event => event.realtimeInput?.activityEnd), "asked");
  fake.send({ toolCall: { functionCalls: [{ id: "call_1", name: "ask_agent", args: { request: "weather" } }] } });
  await until(() => got.some(event => event.type === "done"), "the response that called it ended");
  assert.deepEqual(got.filter(event => event.type === "tool"), [{ type: "tool", response: "gemini_1", id: "call_1", name: "ask_agent", args: { request: "weather" } }]);
  connection.toolResult("call_1", JSON.stringify({ reply: "Sunny" }));
  const before = fake.seen.events.length;
  connection.respond();
  await until(() => fake.seen.events.length > before, "the tool response");
  await sleep(30);
  assert.deepEqual(kinds(fake.seen.events.slice(before)), ["toolResponse"], "the turn goes on by itself: nothing more is sent");
  assert.deepEqual(fake.seen.events.at(-1).toolResponse, { functionResponses: [{ id: "call_1", name: "ask_agent", response: { reply: "Sunny" } }] });
  assert.equal(got.filter(event => event.type === "started").at(-1)!.id, "gemini_2");
  fake.send({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.from(tone(20)).toString("base64") } }] } } });
  fake.send({ serverContent: { turnComplete: true }, usageMetadata: { promptTokenCount: 10 } });
  await until(() => got.filter(event => event.type === "done").length === 2, "the answer done");
  assert.equal((got.filter(event => event.type === "audio").at(-1) as any).id, "gemini_2");
  // stay_silent: no toolResponse, and the next turn is asked for afresh.
  connection.append(tone(200));
  connection.commit("t2");
  connection.respond();
  fake.send({ toolCall: { functionCalls: [{ id: "call_2", name: "stay_silent", args: {} }] } });
  await until(() => got.filter(event => event.type === "tool").length === 2, "stay_silent");
  const sent = fake.seen.events.length;
  connection.toolResult("call_2", "{\"ok\":true}");
  connection.append(tone(200));
  connection.commit("t3");
  connection.respond();
  await until(() => fake.seen.events.slice(sent).some(event => event.realtimeInput?.activityEnd), "the next turn asked");
  assert.ok(!fake.seen.events.slice(sent).some(event => event.toolResponse));
  connection.close();
});

test("cancel and truncate: a new activity interrupts the answer; what was heard is told as a note", async t => {
  const fake = await fakeGemini(t);
  const { got, events } = recorder();
  const connection = geminiLive({ baseUrl: fake.base }).connect({ model: "gemini-3.8-live", voice: "Kore", instructions: "x", transcribe: false, tools: [] }, { apiKey: "k" }, events);
  await fake.connected;
  connection.append(tone(200));
  connection.commit("t1");
  connection.respond();
  connection.cancel();
  connection.truncate("gemini_1", 2_400);
  await until(() => fake.seen.events.length >= 6, "sent");
  assert.deepEqual(kinds(fake.seen.events).slice(-3), ["activityEnd", "activityStart", "note:[You were cut off: they heard only the first 2 s of that answer.]:false"]);
  fake.send({ serverContent: { interrupted: true } });
  await until(() => got.some(event => event.type === "done"), "cancelled");
  assert.equal((got.find(event => event.type === "done") as any).status, "cancelled");
  connection.close();
});

test("the brain with a provider that transcribes only once asked to answer: answered at once with the hint, taken back if its words don't name the bot", async () => {
  const { brain, connection } = testBrain({ humans: 3, addressing: { mode: "addressed", names: ["mochi"] }, wordsAfterAnswer: true });
  await utter(brain, "2", 300);
  const c = connection();
  assert.equal(c.responses, 1, "asked at once");
  assert.equal(c.of("respond")[0].instructions, NOT_ADDRESSED_HINT);
  c.events.responseStarted("r1");
  c.events.heard(c.of("commit")[0].tag, "what's for lunch", 1);
  await until(() => c.of("cancel").length === 1, "taken back");
  assert.equal(brain.stats.unaddressed, 1);
  c.events.responseDone("r1", { status: "cancelled", usage: { inputText: 0, inputAudio: 0, cachedText: 0, cachedAudio: 0, outputText: 0, outputAudio: 0 } });
  // Named: kept.
  await utter(brain, "1", 300);
  assert.equal(c.responses, 2);
  c.events.responseStarted("r2");
  c.events.heard(c.of("commit")[1].tag, "Mochi, what should we order?", 1);
  await sleep(30);
  assert.equal(c.of("cancel").length, 1, "not taken back");
  brain.close();
});
