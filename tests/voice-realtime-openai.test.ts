import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { openaiRealtime, transcriptionLanguage, usageOf } from "../src/voice/realtime/openai.ts";
import type { RealtimeConfig, RealtimeEvents } from "../src/voice/realtime/provider.ts";
import { voiceCluster, discordGrant } from "./voice-fakes.ts";
import { setMetricSink } from "../src/metrics.ts";
import { sleep, testBrain, tone, until, utter } from "./voice-realtime-fakes.ts";

/** OpenAI's Realtime API as the brain speaks to it (src/voice/realtime/openai.ts), against a fake server. */

/**
 * As Azure's resource too: `refuse` answers the handshake with that HTTP status (a 429, a 404 for a deployment
 * missing), `sessionError` answers session.update with an error instead of session.updated.
 */
async function fakeOpenAI(t: { after(fn: () => unknown): void }, options: { refuse?: number; sessionError?: boolean } = {}) {
  const server = createServer();
  const seen = { urls: [] as string[], auth: [] as string[], apiKeys: [] as string[], refused: 0, events: [] as any[] };
  const sockets = new WebSocketServer({
    server,
    verifyClient: (_info: unknown, done: (ok: boolean, status?: number) => void) => { if (options.refuse) { seen.refused++; done(false, options.refuse); } else done(true); },
  });
  let socket!: WebSocket;
  const connected = new Promise<void>(resolve => {
    sockets.on("connection", (ws, req) => {
      socket = ws;
      seen.urls.push(req.url ?? "");
      seen.auth.push(String(req.headers.authorization ?? ""));
      seen.apiKeys.push(String(req.headers["api-key"] ?? ""));
      ws.on("message", data => {
        const event = JSON.parse(String(data));
        seen.events.push(event);
        if (event.type === "session.update" && options.sessionError) ws.send(JSON.stringify({ type: "error", error: { type: "invalid_request_error", code: "invalid_value", message: "The transcription deployment does not exist" } }));
        else if (event.type === "session.update") ws.send(JSON.stringify({ type: "session.updated", session: event.session }));
        if (event.type === "input_audio_buffer.commit") ws.send(JSON.stringify({ type: "input_audio_buffer.committed", item_id: `item_${seen.events.filter(e => e.type === "input_audio_buffer.commit").length}` }));
      });
      resolve();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const ws of sockets.clients) ws.terminate(); server.close(); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, base: `${origin}/v1`, seen, connected, send: (event: unknown) => socket.send(JSON.stringify(event)), close: () => socket.close(1011, "server going away") };
}

function recorder() {
  const got: { type: string; [key: string]: unknown }[] = [];
  const events: RealtimeEvents = {
    ready: () => got.push({ type: "ready" }),
    fallback: detail => got.push({ type: "fallback", detail }),
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

// The platform's Azure OpenAI deployment (azure-openai.ts): tried first on the platform's key, OpenAI the fallback.

const SESSION: RealtimeConfig = { model: "gpt-realtime-2.1", voice: "marin", instructions: "Be Mochi.", transcribe: true, language: "en", tools: [{ name: "stay_silent", description: "Say nothing", parameters: { type: "object", properties: {} } }] };
const onAzure = (origin: string, transcriptionDeployment: string | undefined = "transcribe-eastus2") => ({
  apiKey: "platform-openai-key", azure: { endpoint: origin, apiKey: "azure-key", deployment: "realtime-eastus2", ...(transcriptionDeployment ? { transcriptionDeployment } : {}) },
});

test("on the platform's key, Azure first: its GA endpoint with the deployment as model, the api-key header, its deployments in the same session", async t => {
  const azure = await fakeOpenAI(t);
  const openai = await fakeOpenAI(t);
  const { got, events } = recorder();
  const connection = openaiRealtime({ baseUrl: openai.base }).connect(SESSION, onAzure(azure.origin), events);
  await until(() => got.some(event => event.type === "ready"), "ready");
  assert.equal(connection.host, "azure");
  assert.deepEqual([azure.seen.urls, azure.seen.apiKeys, azure.seen.auth], [["/openai/v1/realtime?model=realtime-eastus2"], ["azure-key"], [""]], "no OpenAI key goes to Azure");
  const session = azure.seen.events[0].session;
  assert.equal(session.type, "realtime");
  assert.equal(session.model, "realtime-eastus2");
  assert.deepEqual(session.audio.input.transcription, { model: "transcribe-eastus2", language: "en" }, "Azure's transcription names a deployment");
  assert.deepEqual([session.audio.input.format, session.audio.input.turn_detection, session.audio.output], [{ type: "audio/pcm", rate: 24_000 }, null, { format: { type: "audio/pcm", rate: 24_000 }, voice: "marin" }]);
  assert.deepEqual(session.tools.map((tool: { name: string }) => tool.name), ["stay_silent"]);
  assert.equal(openai.seen.urls.length, 0);
  assert.ok(!got.some(event => event.type === "fallback"));
  // Audio under either family of event names Azure documents.
  azure.send({ type: "response.created", response: { id: "resp_1" } });
  azure.send({ type: "response.audio.delta", response_id: "resp_1", item_id: "item_a", delta: Buffer.from(tone(20)).toString("base64") });
  azure.send({ type: "response.output_audio.delta", response_id: "resp_1", item_id: "item_a", delta: Buffer.from(tone(20)).toString("base64") });
  await until(() => got.filter(event => event.type === "audio").length === 2, "both deltas");
  connection.close();
});

for (const [why, options] of [["refuses the handshake (429)", { refuse: 429 }], ["has no such deployment (404)", { refuse: 404 }], ["refuses the session", { sessionError: true }]] as const) {
  test(`Azure ${why} before the session is live: OpenAI on the platform's key, with everything sent so far`, async t => {
    const azure = await fakeOpenAI(t, options);
    const openai = await fakeOpenAI(t);
    const { got, events } = recorder();
    const connection = openaiRealtime({ baseUrl: openai.base }).connect(SESSION, onAzure(azure.origin), events);
    // What the brain sends at once (a briefing, the call's first audio), before either host is live.
    connection.note("[Earlier in this call]\nAna: hi");
    connection.append(tone(200));
    await until(() => got.some(event => event.type === "ready"), "ready on OpenAI");
    assert.equal(connection.host, "openai");
    assert.deepEqual(got.filter(event => event.type === "fallback").length, 1);
    assert.deepEqual([openai.seen.urls, openai.seen.auth, openai.seen.apiKeys], [["/v1/realtime?model=gpt-realtime-2.1"], ["Bearer platform-openai-key"], [""]]);
    await until(() => openai.seen.events.some(event => event.type === "input_audio_buffer.append"), "the audio");
    assert.deepEqual(openai.seen.events.map(event => event.type), ["session.update", "conversation.item.create", "input_audio_buffer.append"]);
    assert.equal(openai.seen.events[0].session.model, "gpt-realtime-2.1");
    assert.deepEqual(openai.seen.events[0].session.audio.input.transcription, { model: "gpt-transcribe", language: "en" });
    if ("refuse" in options) assert.equal(azure.seen.refused, 1);
    else assert.equal(azure.seen.events[0].type, "session.update");
    // Live on OpenAI: a commit is OpenAI's to answer.
    assert.equal(connection.commit("t1"), true);
    await until(() => openai.seen.events.some(event => event.type === "input_audio_buffer.commit"), "the commit");
    assert.ok(!got.some(event => event.type === "closed"));
    connection.close();
  });
}

test("Azure dropping once live is reported as a lost connection (the brain reconnects), never a silent fallback", async t => {
  const azure = await fakeOpenAI(t);
  const openai = await fakeOpenAI(t);
  const { got, events } = recorder();
  openaiRealtime({ baseUrl: openai.base }).connect(SESSION, onAzure(azure.origin), events);
  await until(() => got.some(event => event.type === "ready"), "ready");
  azure.close();
  await until(() => got.some(event => event.type === "closed"), "closed");
  assert.equal((got.find(event => event.type === "closed") as any).reason, "error");
  assert.ok(!got.some(event => event.type === "fallback"));
  assert.equal(openai.seen.urls.length, 0);
});

test("a tenant's own key (no Azure in its credentials), and a transcribed session with no transcription deployment, stay on OpenAI", async t => {
  const azure = await fakeOpenAI(t);
  const openai = await fakeOpenAI(t);
  for (const [credentials, config] of [[{ apiKey: "sk-tenant" }, SESSION], [onAzure(azure.origin, ""), SESSION]] as const) {
    const { got, events } = recorder();
    const connection = openaiRealtime({ baseUrl: openai.base }).connect(config, credentials, events);
    await until(() => got.some(event => event.type === "ready"), "ready");
    assert.equal(connection.host, "openai");
    connection.close();
  }
  assert.deepEqual(openai.seen.auth, ["Bearer sk-tenant", "Bearer platform-openai-key"]);
  assert.equal(azure.seen.urls.length, 0);
  // Untranscribed, the same session needs no transcription deployment: Azure.
  const { got, events } = recorder();
  const connection = openaiRealtime({ baseUrl: openai.base }).connect({ ...SESSION, transcribe: false }, onAzure(azure.origin, ""), events);
  await until(() => got.some(event => event.type === "ready"), "ready");
  assert.equal(connection.host, "azure");
  assert.equal(azure.seen.events[0].session.audio.input.transcription, undefined);
  connection.close();
});

test("the brain logs voice_realtime_azure_fallback and names the host it ran on in the voice_realtime metric (Host: azure | openai)", async t => {
  const lines: any[] = [];
  setMetricSink(line => lines.push(JSON.parse(line)));
  t.after(() => setMetricSink());
  const openai = await fakeOpenAI(t);
  const fallbacks: unknown[] = [];
  for (const options of [{}, { refuse: 503 }]) {
    const azure = await fakeOpenAI(t, options);
    const { brain, logs } = testBrain({ provider: openaiRealtime({ baseUrl: openai.base }), credentials: onAzure(azure.origin) });
    await until(() => logs.some(log => log.type === "voice_realtime_ready"), "ready");
    await utter(brain, "1", 200);
    brain.close();
    fallbacks.push(...logs.filter(log => log.type === "voice_realtime_azure_fallback").map(log => typeof log.fields?.reason));
    assert.equal(logs.find(log => log.type === "voice_realtime_ready")?.fields?.host, "refuse" in options ? "openai" : "azure");
  }
  assert.deepEqual(fallbacks, ["string"]);
  const metrics = lines.filter(line => line.type === "voice_realtime");
  assert.deepEqual(metrics.map(line => [line.Host, line.VoiceRealtimeAzureFallbacks]), [["azure", 0], ["openai", 1]]);
  assert.deepEqual(metrics[0]._aws.CloudWatchMetrics[0].Dimensions.map((names: string[]) => names.filter(name => name !== "ServiceName")), [[], ["Host"]]);
});

test("OpenAI transcription language normalizes BCP-47 to known ISO-639-1 codes", () => {
  for (const [input, expected] of [["es-ES", "es"], ["pt-BR", "pt"], ["en-US", "en"], ["en", "en"], ["ES", "es"], ["zh-Hant-TW", "zh"], ["fr-CA", "fr"], ["tl", "tl"], ["tl-PH", "tl"], ["bh", "bh"]]) {
    assert.equal(transcriptionLanguage(input), expected);
  }
  for (const input of [undefined, "", "zz", "zz-ZZ", "unknown", "en_US", "en-", "x-private", "und", "en-US-bogus!"]) {
    assert.equal(transcriptionLanguage(input), undefined, String(input));
  }
});

test("a session created with es-ES sends es to OpenAI transcription", async t => {
  const fake = await fakeOpenAI(t);
  const cluster = await voiceCluster(t, {
    realtime: { providers: { openai: openaiRealtime({ baseUrl: fake.base }) }, key: async () => ({ apiKey: "fixture-key", platform: false }) },
  });
  const a = await cluster.node("http://a");
  const created = await a.voice.create("alice", { discord: discordGrant(), language: "es-ES" });
  const connection = await until(() => cluster.fake.open()[0], "voice transport");
  connection.handlers.ready();
  await until(() => fake.seen.events.some(event => event.type === "session.update"), "provider session");
  assert.equal(fake.seen.events.find(event => event.type === "session.update").session.audio.input.transcription.language, "es");
  await a.voice.end("alice", created.id);
});

test("an unknown language is omitted from the OpenAI transcription session", async t => {
  const fake = await fakeOpenAI(t);
  const { got, events } = recorder();
  const connection = openaiRealtime({ baseUrl: fake.base }).connect({
    model: "gpt-realtime-2.1", voice: "marin", instructions: "", transcribe: true, language: "zz-ZZ", tools: [],
  }, { apiKey: "fixture-key" }, events);
  await until(() => got.some(event => event.type === "ready"), "provider ready");
  assert.equal(Object.hasOwn(fake.seen.events[0].session.audio.input.transcription, "language"), false);
  connection.close();
});
