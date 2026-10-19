import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { grokRealtime, GROK_REALTIME } from "../src/voice/realtime/grok.ts";
import { realtimeVoice } from "../src/voice/realtime/provider.ts";
import { ASK_AGENT, STAY_SILENT } from "../src/voice/realtime/brain.ts";
import { providerInfo } from "../src/catalog.ts";
import type { RealtimeEvents } from "../src/voice/realtime/provider.ts";
import { sleep, tone, until } from "./voice-realtime-fakes.ts";

/** Grok's Realtime API as the brain speaks to it (src/voice/realtime/openai.ts), against a fake server. */

async function fakeGrok(t: { after(fn: () => unknown): void }) {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const seen = { urls: [] as string[], auth: [] as string[], events: [] as any[] };
  let socket!: WebSocket;
  const connected = new Promise<void>(resolve => {
    sockets.on("connection", (ws, req) => {
      socket = ws;
      seen.urls.push(req.url ?? "");
      seen.auth.push(String(req.headers.authorization ?? ""));
      ws.on("message", data => {
        const event = JSON.parse(String(data));
        seen.events.push(event);
        if (event.type === "session.update") ws.send(JSON.stringify({ type: "session.updated", session: event.session }));
        if (event.type === "input_audio_buffer.commit") ws.send(JSON.stringify({ type: "input_audio_buffer.committed", item_id: `item_${seen.events.filter(e => e.type === "input_audio_buffer.commit").length}` }));
      });
      resolve();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const ws of sockets.clients) ws.terminate(); server.close(); });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, connected, send: (event: unknown) => socket.send(JSON.stringify(event)), close: () => socket.close(1011, "server going away xai-fixture-secret") };
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

test("a session as Grok takes it: our turns (no turn detection), transcription, its voice, our tools, the tenant's key", async t => {
  const fake = await fakeGrok(t);
  const { got, events } = recorder();
  const connection = grokRealtime({ baseUrl: fake.base }).connect({
    model: "grok-voice-latest", voice: "ara", instructions: "Be Mochi.", transcribe: true, language: "en", prompt: "Mochi",
    tools: [ASK_AGENT, STAY_SILENT],
  }, { apiKey: "xai-fixture-key" }, events);
  await fake.connected;
  await until(() => got.some(event => event.type === "ready"), "ready");
  assert.equal(fake.seen.urls[0], "/v1/realtime?model=grok-voice-latest");
  assert.equal(fake.seen.auth[0], "Bearer xai-fixture-key");
  const session = fake.seen.events[0].session;
  assert.equal(session.type, undefined);
  assert.equal(session.model, undefined);
  assert.deepEqual(session.turn_detection, { type: null });
  assert.equal(session.audio.input.turn_detection, undefined);
  assert.deepEqual(session.audio.input.format, { type: "audio/pcm", rate: 24_000 });
  assert.deepEqual(session.audio.input.transcription, { language_hint: "en" });
  assert.equal(session.voice, "ara");
  assert.deepEqual(session.audio.output, { format: { type: "audio/pcm", rate: 24_000 } });
  assert.equal(session.output_modalities, undefined);
  assert.deepEqual(session.tools.map((tool: { type: string; name: string }) => [tool.type, tool.name]), [["function", "ask_agent"], ["function", "stay_silent"]]);
  connection.close();
});

test("audio in: appended as base64, committed by tag (too little is cleared), and each item's transcript comes back by its tag", async t => {
  const fake = await fakeGrok(t);
  const { got, events } = recorder();
  const connection = grokRealtime({ baseUrl: fake.base }).connect({ model: "grok-voice-latest", voice: "sal", instructions: "x", transcribe: true, tools: [] }, { apiKey: "k" }, events);
  await fake.connected;
  connection.note("[Ana]");
  connection.append(tone(60));
  assert.equal(connection.pendingMs, 60);
  assert.equal(connection.commit("t1"), false, "under 100 ms: dropped");
  connection.append(tone(300));
  assert.equal(connection.commit("t2"), true);
  connection.respond({ instructions: "Unless named, call stay_silent." });
  await until(() => fake.seen.events.some(event => event.type === "response.create"), "the response asked");
  const types = fake.seen.events.slice(1).map(event => event.type);
  assert.deepEqual(types, ["conversation.item.create", "input_audio_buffer.append", "input_audio_buffer.clear", "input_audio_buffer.append", "input_audio_buffer.commit", "response.create"]);
  assert.equal(Buffer.from(fake.seen.events[4].audio, "base64").length, 300 * 48);
  assert.deepEqual(fake.seen.events[1].item, { type: "message", role: "user", content: [{ type: "input_text", text: "[Ana]" }] });
  // Instructions for one response are the session's and the hint.
  assert.equal(fake.seen.events[6].response.instructions, "x\n\nUnless named, call stay_silent.");
  await sleep(20);
  fake.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", content_index: 0, transcript: " Hi Mochi ", usage: { type: "duration", seconds: 0.3 } });
  await until(() => got.some(event => event.type === "heard"), "the transcript");
  assert.deepEqual(got.find(event => event.type === "heard"), { type: "heard", tag: "t2", text: "Hi Mochi", seconds: 0 });
  connection.close();
});

test("barge-in and a response: audio, its transcript, a tool call, and its usage; a cancel before it began is sent as it begins; truncate and delete", async t => {
  const fake = await fakeGrok(t);
  const { got, events } = recorder();
  const connection = grokRealtime({ baseUrl: fake.base }).connect({ model: "grok-voice-latest", voice: "sal", instructions: "x", transcribe: false, tools: [] }, { apiKey: "k" }, events);
  await fake.connected;
  connection.respond();
  connection.cancel();
  await until(() => fake.seen.events.some(event => event.type === "response.create"), "asked");
  assert.ok(!fake.seen.events.some(event => event.type === "response.cancel"), "not yet: nothing to cancel");
  fake.send({ type: "response.created", response: { id: "resp_1" } });
  await until(() => fake.seen.events.some(event => event.type === "response.cancel"), "the cancel, once it began");
  fake.send({ type: "response.done", response: { id: "resp_1", status: "cancelled", usage: { input_token_details: { audio_tokens: 12, text_tokens: 300, cached_tokens_details: { text_tokens: 256 } }, output_token_details: { audio_tokens: 4 } } } });
  connection.respond();
  fake.send({ type: "response.created", response: { id: "resp_2" } });
  fake.send({ type: "response.output_item.added", response_id: "resp_2", item: { id: "item_a", type: "message", role: "assistant" } });
  fake.send({ type: "response.audio.delta", response_id: "resp_2", item_id: "item_a", delta: Buffer.from(tone(20)).toString("base64") });
  fake.send({ type: "response.audio_transcript.delta", response_id: "resp_2", item_id: "item_a", delta: "Let me" });
  fake.send({ type: "response.function_call_arguments.done", response_id: "resp_2", call_id: "call_1", name: "ask_agent", arguments: "{\"request\":\"weather\"}" });
  fake.send({ type: "response.done", response: { id: "resp_2", status: "completed", usage: { input_token_details: { audio_tokens: 30 }, output_token_details: { audio_tokens: 20, text_tokens: 7 } } } });
  fake.send({ type: "error", error: { type: "invalid_request_error", code: "response_cancel_not_active", message: "no active response" } });
  fake.send({ type: "error", error: { type: "invalid_request_error", code: "invalid_value", message: "bad voice xai-fixture-secret" } });
  await until(() => got.filter(event => event.type === "done").length === 2 && got.some(event => event.type === "warning"), "both done");
  assert.deepEqual(got.filter(event => event.type !== "ready").map(event => event.type), ["started", "done", "started", "audio", "said", "tool", "done", "warning"]);
  assert.deepEqual((got.find(event => event.type === "done") as any).usage, { inputText: 300, inputAudio: 12, cachedText: 256, cachedAudio: 0, outputText: 0, outputAudio: 4 });
  assert.equal((got.find(event => event.type === "done") as any).status, "cancelled");
  assert.deepEqual(got.find(event => event.type === "tool"), { type: "tool", response: "resp_2", id: "call_1", name: "ask_agent", args: { request: "weather" } });
  assert.deepEqual(got.filter(event => event.type === "warning"), [{ type: "warning", code: "invalid_value", message: "bad voice [redacted]" }], "a lost race is not a warning");
  connection.truncate("resp_2", 1_234);
  connection.truncate("resp_1", 500);
  connection.truncate("resp_2", 0);
  connection.toolResult("call_1", "{\"reply\":\"sunny\"}");
  await until(() => fake.seen.events.some(event => event.type === "conversation.item.create" && event.item.type === "function_call_output"), "the result");
  const tail = fake.seen.events.slice(-3);
  assert.deepEqual(tail[0], { type: "conversation.item.truncate", item_id: "item_a", content_index: 0, audio_end_ms: 1_234 });
  assert.deepEqual(tail[1], { type: "conversation.item.delete", item_id: "item_a" });
  assert.deepEqual(tail[2].item, { type: "function_call_output", call_id: "call_1", output: "{\"reply\":\"sunny\"}" });
  connection.close();
  assert.deepEqual(got.at(-1), { type: "closed", reason: "requested" });
});

test("the provider closing the connection is reported (the brain reconnects); usage reads what is there", async t => {
  const fake = await fakeGrok(t);
  const { got, events } = recorder();
  grokRealtime({ baseUrl: fake.base }).connect({ model: "grok-voice-latest", voice: "sal", instructions: "x", transcribe: false, tools: [] }, { apiKey: "k" }, events);
  await fake.connected;
  await until(() => got.some(event => event.type === "ready"), "ready");
  fake.close();
  await until(() => got.some(event => event.type === "closed"), "closed");
  assert.equal((got.find(event => event.type === "closed") as any).reason, "error");
  assert.equal(got.find(event => event.type === "closed")?.detail, "The realtime connection closed (1011: server going away [redacted])");
});

test("Grok voices map from session voices, and xai is an existing tenant-key provider", () => {
  const provider = grokRealtime();
  assert.equal(provider.key, "xai");
  assert.equal(providerInfo("xai")?.apiKey, true);
  assert.equal(realtimeVoice(provider, "alloy"), "sal");
  assert.equal(realtimeVoice(provider, "coral"), "ara");
  assert.equal(realtimeVoice(provider, "onyx"), "leo");
  for (const voice of GROK_REALTIME.voices) assert.equal(realtimeVoice(provider, voice), voice);
});

test("Grok accepts GA audio events too; no tools means an explicit empty list", async t => {
  const fake = await fakeGrok(t);
  const { got, events } = recorder();
  const connection = grokRealtime({ baseUrl: fake.base }).connect({ model: GROK_REALTIME.defaultModel, voice: "eve", instructions: "x", transcribe: false, tools: [] }, { apiKey: "fixture" }, events);
  await until(() => got.some(event => event.type === "ready"), "ready");
  assert.deepEqual(fake.seen.events[0].session.tools, []);
  assert.equal(fake.seen.events[0].session.audio.input.transcription, undefined);
  fake.send({ type: "response.output_audio.delta", response_id: "r1", item_id: "a1", delta: Buffer.from(tone(20)).toString("base64") });
  fake.send({ type: "response.output_audio_transcript.delta", response_id: "r1", delta: "Hello" });
  await until(() => got.some(event => event.type === "said"), "GA events");
  assert.deepEqual(got.filter(event => event.type === "audio"), [{ type: "audio", id: "r1", bytes: 960 }]);
  connection.close();
});

test("native transcripts are suppressed when disabled, and failed response details redact xai keys", async t => {
  const fake = await fakeGrok(t);
  const { got, events } = recorder();
  const connection = grokRealtime({ baseUrl: fake.base }).connect({ model: GROK_REALTIME.defaultModel, voice: "ara", instructions: "x", transcribe: false, tools: [] }, { apiKey: "fixture" }, events);
  await until(() => got.some(event => event.type === "ready"), "ready");
  connection.append(tone(200));
  connection.commit("t1");
  await until(() => fake.seen.events.some(event => event.type === "input_audio_buffer.commit"), "committed");
  fake.send({ type: "conversation.item.input_audio_transcription.completed", item_id: "item_1", transcript: "Hello" });
  fake.send({ type: "response.done", response: { id: "r1", status: "failed", status_details: { error: { message: "invalid key xai-fixture-secret" } } } });
  await until(() => got.some(event => event.type === "done"), "failed response");
  assert.equal(got.some(event => event.type === "heard"), false);
  assert.equal(got.find(event => event.type === "done")?.error, "invalid key [redacted]");
  connection.close();
});


test("Grok meters only transmitted audio and text items, excluding tool results and response requests", async t => {
  const fake = await fakeGrok(t);
  const { got, events } = recorder();
  const metered: { seconds: number; texts: number }[] = [];
  events.meter = (seconds, texts) => { metered.push({ seconds, texts }); };
  const connection = grokRealtime({ baseUrl: fake.base }).connect({ model: GROK_REALTIME.defaultModel, voice: "ara", instructions: "x", transcribe: true, tools: [] }, { apiKey: "fixture" }, events);
  connection.append(tone(200));
  connection.note("[Ana]");
  assert.deepEqual(metered, [], "queued events are not charged before the socket opens");
  await until(() => got.some(event => event.type === "ready"), "ready");
  assert.deepEqual(metered, [{ seconds: 0.2, texts: 0 }, { seconds: 0, texts: 1 }]);
  connection.discard();
  connection.toolResult("call_1", "result");
  connection.respond();
  fake.send({ type: "response.audio.delta", response_id: "r1", delta: Buffer.from(tone(400)).toString("base64") });
  await until(() => metered.length === 3, "output metered");
  assert.deepEqual(metered[2], { seconds: 0.4, texts: 0 });
  connection.close();
  connection.append(tone(200));
  connection.note("not sent");
  assert.equal(metered.length, 3, "closed connections do not charge unsent events");
});
