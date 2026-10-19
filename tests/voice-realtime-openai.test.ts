import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { openaiRealtime, usageOf } from "../src/voice/realtime/openai.ts";
import type { RealtimeEvents } from "../src/voice/realtime/provider.ts";
import { sleep, tone, until } from "./voice-realtime-fakes.ts";

/** OpenAI's Realtime API as the brain speaks to it (src/voice/realtime/openai.ts), against a fake server. */

async function fakeOpenAI(t: { after(fn: () => unknown): void }) {
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
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen, connected, send: (event: unknown) => socket.send(JSON.stringify(event)), close: () => socket.close(1011, "server going away") };
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

test("a session as OpenAI takes it: our turns (no turn detection), transcription, its voice, our tools, the tenant's key", async t => {
  const fake = await fakeOpenAI(t);
  const { got, events } = recorder();
  const connection = openaiRealtime({ baseUrl: fake.base }).connect({
    model: "gpt-realtime-2.1", voice: "marin", instructions: "Be Mochi.", transcribe: true, language: "en", prompt: "Mochi",
    tools: [{ name: "stay_silent", description: "Say nothing", parameters: { type: "object", properties: {} } }],
  }, { apiKey: "sk-tenant" }, events);
  await fake.connected;
  await until(() => got.some(event => event.type === "ready"), "ready");
  assert.equal(fake.seen.urls[0], "/v1/realtime?model=gpt-realtime-2.1");
  assert.equal(fake.seen.auth[0], "Bearer sk-tenant");
  const session = fake.seen.events[0].session;
  assert.equal(session.type, "realtime");
  assert.equal(session.audio.input.turn_detection, null);
  assert.deepEqual(session.audio.input.format, { type: "audio/pcm", rate: 24_000 });
  assert.deepEqual(session.audio.input.transcription, { model: "gpt-transcribe", language: "en", prompt: "Mochi" });
  assert.equal(session.audio.output.voice, "marin");
  assert.deepEqual(session.output_modalities, ["audio"]);
  assert.deepEqual(session.tools.map((tool: { type: string; name: string }) => [tool.type, tool.name]), [["function", "stay_silent"]]);
  connection.close();
});

test("audio in: appended as base64, committed by tag (too little is cleared), and each item's transcript comes back by its tag", async t => {
  const fake = await fakeOpenAI(t);
  const { got, events } = recorder();
  const connection = openaiRealtime({ baseUrl: fake.base }).connect({ model: "gpt-realtime-2.1", voice: "alloy", instructions: "x", transcribe: true, tools: [] }, { apiKey: "k" }, events);
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
  assert.deepEqual(got.find(event => event.type === "heard"), { type: "heard", tag: "t2", text: "Hi Mochi", seconds: 0.3 });
  connection.close();
});

test("a response: audio, its transcript, a tool call, and its usage; a cancel before it began is sent as it begins; truncate and delete", async t => {
  const fake = await fakeOpenAI(t);
  const { got, events } = recorder();
  const connection = openaiRealtime({ baseUrl: fake.base }).connect({ model: "gpt-realtime-2.1", voice: "alloy", instructions: "x", transcribe: false, tools: [] }, { apiKey: "k" }, events);
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
  fake.send({ type: "response.output_audio.delta", response_id: "resp_2", item_id: "item_a", delta: Buffer.from(tone(20)).toString("base64") });
  fake.send({ type: "response.output_audio_transcript.delta", response_id: "resp_2", item_id: "item_a", delta: "Let me" });
  fake.send({ type: "response.function_call_arguments.done", response_id: "resp_2", call_id: "call_1", name: "ask_agent", arguments: "{\"request\":\"weather\"}" });
  fake.send({ type: "response.done", response: { id: "resp_2", status: "completed", usage: { input_token_details: { audio_tokens: 30 }, output_token_details: { audio_tokens: 20, text_tokens: 7 } } } });
  fake.send({ type: "error", error: { type: "invalid_request_error", code: "response_cancel_not_active", message: "no active response" } });
  fake.send({ type: "error", error: { type: "invalid_request_error", code: "invalid_value", message: "bad voice" } });
  await until(() => got.filter(event => event.type === "done").length === 2 && got.some(event => event.type === "warning"), "both done");
  assert.deepEqual(got.filter(event => event.type !== "ready").map(event => event.type), ["started", "done", "started", "audio", "said", "tool", "done", "warning"]);
  assert.deepEqual((got.find(event => event.type === "done") as any).usage, { inputText: 300, inputAudio: 12, cachedText: 256, cachedAudio: 0, outputText: 0, outputAudio: 4 });
  assert.equal((got.find(event => event.type === "done") as any).status, "cancelled");
  assert.deepEqual(got.find(event => event.type === "tool"), { type: "tool", response: "resp_2", id: "call_1", name: "ask_agent", args: { request: "weather" } });
  assert.deepEqual(got.filter(event => event.type === "warning"), [{ type: "warning", code: "invalid_value", message: "bad voice" }], "a lost race is not a warning");
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
  const fake = await fakeOpenAI(t);
  const { got, events } = recorder();
  openaiRealtime({ baseUrl: fake.base }).connect({ model: "gpt-realtime-2.1", voice: "alloy", instructions: "x", transcribe: false, tools: [] }, { apiKey: "k" }, events);
  await fake.connected;
  await until(() => got.some(event => event.type === "ready"), "ready");
  fake.close();
  await until(() => got.some(event => event.type === "closed"), "closed");
  assert.equal((got.find(event => event.type === "closed") as any).reason, "error");
  assert.deepEqual(usageOf(undefined), { inputText: 0, inputAudio: 0, cachedText: 0, cachedAudio: 0, outputText: 0, outputAudio: 0 });
});
