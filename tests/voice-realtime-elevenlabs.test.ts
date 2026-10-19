import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { elevenlabsAgents, ELEVENLABS_AGENTS } from "../src/voice/realtime/elevenlabs.ts";
import { ASK_AGENT, STAY_SILENT } from "../src/voice/realtime/brain.ts";
import { NO_USAGE, realtimeCost, realtimePrice, realtimeVoice, type RealtimeEvents } from "../src/voice/realtime/provider.ts";
import { sleep, testBrain, tone, until, utter } from "./voice-realtime-fakes.ts";

// Synthetic rates only; real rates are supplied privately at runtime.
process.env.AGENT_PRICE_ELEVENLABS_AGENTS_MINUTE_USD = "1";
process.env.AGENT_PRICE_ELEVENLABS_LLM_MINUTE_USD = "2";

async function fakeElevenLabs(t: { after(fn: () => unknown): void }, options: { existing?: boolean; fail?: boolean } = {}) {
  const seen = { requests: [] as { url: string; key: string; body: any }[], events: [] as any[], urls: [] as string[] };
  const connections: WebSocket[] = [];
  let base: string;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    seen.requests.push({ url: req.url!, key: String(req.headers["xi-api-key"]), body });
    res.setHeader("Content-Type", "application/json");
    if (options.fail) { res.writeHead(401).end('{"detail":"never logged"}'); return; }
    if (req.url?.startsWith("/v1/convai/agents?")) res.end(JSON.stringify({ agents: options.existing ? [{ name: ELEVENLABS_AGENTS.name, agent_id: "agent_test" }] : [], has_more: false }));
    else if (req.url === "/v1/convai/agents/create") res.end('{"agent_id":"agent_test"}');
    else res.end(JSON.stringify({ signed_url: `${base.replace(/^http/, "ws")}/v1/convai/conversation?agent_id=agent_test&conversation_signature=private` }));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (ws, req) => {
    connections.push(ws);
    seen.urls.push(req.url!);
    ws.on("message", data => {
      const event = JSON.parse(String(data));
      seen.events.push(event);
      if (event.type === "conversation_initiation_client_data") ws.send(JSON.stringify({ type: "conversation_initiation_metadata", conversation_initiation_metadata_event: {
        conversation_id: "conv_test", user_input_audio_format: "pcm_16000", agent_output_audio_format: "pcm_24000",
      } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => { for (const ws of sockets.clients) ws.terminate(); server.closeAllConnections(); server.close(); });
  return { base, seen, connections, send: (event: unknown) => connections.at(-1)!.send(JSON.stringify(event)) };
}
function recorder() {
  const got: { type: string; [key: string]: any }[] = [];
  const events: RealtimeEvents = {
    ready: () => got.push({ type: "ready" }), responseStarted: id => got.push({ type: "started", id }),
    audio: (id, pcm) => got.push({ type: "audio", id, pcm }), said: (id, text) => got.push({ type: "said", id, text }),
    toolCall: call => got.push({ type: "tool", ...call }), responseDone: (id, outcome) => got.push({ type: "done", id, ...outcome }),
    heard: (tag, text, seconds) => got.push({ type: "heard", tag, text, seconds }), interrupted: () => got.push({ type: "interrupted" }),
    warning: (code, message) => got.push({ type: "warning", code, message }), closed: (reason, detail) => got.push({ type: "closed", reason, detail }),
  };
  return { got, events };
}
const config = { model: ELEVENLABS_AGENTS.defaultModel, voice: "character_voice", instructions: "Be Mochi.", transcribe: true, tools: [ASK_AGENT, STAY_SILENT], language: "ja" };
const transcript = (text: string) => ({ type: "user_transcript", user_transcription_event: { user_transcript: text } });
const tool = (id: string, name = "ask_agent") => ({ type: "client_tool_call", client_tool_call: { tool_call_id: id, tool_name: name, parameters: name === "ask_agent" ? { request: "Check the server" } : {} } });
const audio = () => ({ type: "audio", audio_event: { audio_base_64: tone(80).toString("base64"), event_id: 1 } });

test("ElevenLabs provisions once per credential, authenticates with signed URLs, and overrides each session", async t => {
  const fake = await fakeElevenLabs(t);
  const provider = elevenlabsAgents({ baseUrl: fake.base });
  const a = recorder(), b = recorder();
  const first = provider.connect(config, { apiKey: "tenant-key" }, a.events);
  const second = provider.connect({ ...config, voice: "another_voice" }, { apiKey: "tenant-key" }, b.events);
  t.after(() => { first.close(); second.close(); });
  await until(() => a.got.some(e => e.type === "ready") && b.got.some(e => e.type === "ready"), "both ready");
  const creates = fake.seen.requests.filter(r => r.url.endsWith("agents/create"));
  assert.equal(creates.length, 1);
  const body = creates[0].body;
  assert.equal(body.name, ELEVENLABS_AGENTS.name);
  assert.equal(body.conversation_config.agent.prompt.llm, ELEVENLABS_AGENTS.defaultModel);
  assert.deepEqual(body.conversation_config.agent.prompt.tools.map(({ name, description, parameters, type, expects_response }: any) => ({ name, description, parameters, type, expects_response })),
    [ASK_AGENT, STAY_SILENT].map(tool => ({ ...tool, type: "client", expects_response: true })));
  assert.deepEqual(body.platform_settings.overrides.conversation_config_override, { agent: { prompt: { prompt: true }, first_message: true, language: true }, tts: { voice_id: true } });
  assert.equal(body.platform_settings.auth.enable_auth, true);
  assert.equal(body.conversation_config.tts.agent_output_audio_format, "pcm_24000");
  assert.equal(fake.seen.requests.filter(r => r.url.includes("get-signed-url?agent_id=agent_test")).length, 2);
  assert.ok(fake.seen.requests.every(r => r.key === "tenant-key"));
  assert.ok(fake.seen.urls.every(url => !url.includes("tenant-key")));
  const overrides = fake.seen.events.filter(e => e.type === "conversation_initiation_client_data").map(e => e.conversation_config_override);
  assert.deepEqual(overrides[0], { agent: { prompt: { prompt: "Be Mochi." }, first_message: "", language: "ja" }, tts: { voice_id: "character_voice" } });
  assert.equal(overrides[1].tts.voice_id, "another_voice");
  assert.equal(realtimeVoice(provider, "coral"), ELEVENLABS_AGENTS.voice);
  assert.equal(realtimeVoice(provider, "cartoon_voice_id"), "cartoon_voice_id");
});

test("ElevenLabs reuses an existing named agent; PCM both ways, contextual labels, transcripts, ping and completion", async t => {
  const fake = await fakeElevenLabs(t, { existing: true });
  const { got, events } = recorder();
  const connection = elevenlabsAgents({ baseUrl: fake.base }).connect(config, { apiKey: "key" }, events);
  t.after(() => connection.close());
  await until(() => got.some(e => e.type === "ready"), "ready");
  assert.equal(fake.seen.requests.filter(r => r.url.endsWith("agents/create")).length, 0);
  connection.note("[Ana and Ben, at once]");
  connection.append(tone(20));
  assert.equal(connection.commit("unused"), false);
  await until(() => fake.seen.events.some(e => e.user_audio_chunk), "input");
  assert.equal(Buffer.from(fake.seen.events.find(e => e.user_audio_chunk).user_audio_chunk, "base64").length, 640);
  assert.ok(fake.seen.events.some(e => e.type === "contextual_update" && e.text === "[Ana and Ben, at once]"));
  fake.send({ type: "ping", ping_event: { event_id: 123 } });
  fake.send(transcript("Mochi, hello"));
  fake.send({ type: "agent_response", agent_response_event: { agent_response: "Hello" } });
  fake.send(audio());
  fake.send({ type: "agent_response_complete", agent_response_complete_event: { event_id: 1 } });
  await until(() => got.some(e => e.type === "done") && fake.seen.events.some(e => e.type === "pong"), "response and pong");
  assert.deepEqual(got.find(e => e.type === "heard"), { type: "heard", tag: "", text: "Mochi, hello", seconds: 0.02 });
  assert.deepEqual(got.find(e => e.type === "audio")!.pcm, tone(80));
  assert.equal(got.find(e => e.type === "done")!.status, "completed");
  assert.equal(fake.seen.events.find(e => e.type === "pong").event_id, 123);
  await until(() => fake.seen.events.filter(e => e.user_audio_chunk).length >= 3, "silence keeps VAD running");
});

for (const late of [false, true]) test(`ElevenLabs brain: ask_agent ${late ? "late" : "fast"} reply, no local commits or speculative responses`, async t => {
  const fake = await fakeElevenLabs(t);
  let resolve!: (reply: string) => void;
  const reply = new Promise<string>(r => { resolve = r; });
  const state = testBrain({ provider: elevenlabsAgents({ baseUrl: fake.base }), reference: "elevenlabs/gemini-2.5-flash-lite", ownsTurns: true, speculative: true,
    limits: { askAgentMs: late ? 20 : 5_000 }, askAgent: async () => reply });
  t.after(() => state.brain.close());
  await until(() => state.logs.some(e => e.type === "voice_realtime_ready"), "brain ready");
  await utter(state.brain, "1", 200);
  state.brain.turnEvent({ type: "likely_end", speaker: "1", at: Date.now(), silenceMs: 200 } as any);
  assert.equal(state.brain.stats.responses, 0);
  fake.send(transcript("Mochi, check the server"));
  fake.send(tool("call_1"));
  if (late) await until(() => fake.seen.events.some(e => e.type === "client_tool_result"), "pending result");
  resolve("All done");
  await until(() => state.logs.some(e => e.fields?.tool === "ask_agent"), "agent completed");
  await until(() => fake.seen.events.some(e => e.type === (late ? "user_message" : "client_tool_result")), "reply sent");
  const results = fake.seen.events.filter(e => e.type === "client_tool_result");
  assert.equal(results.length, 1);
  assert.equal(results[0].tool_call_id, "call_1");
  assert.equal(results[0].is_error, false);
  if (late) {
    assert.ok(JSON.parse(results[0].result).pending);
    assert.ok(fake.seen.events.some(e => e.type === "contextual_update" && e.text.includes("All done")));
    assert.equal(state.brain.stats.askAgentLate, 1);
  } else assert.deepEqual(JSON.parse(results[0].result), { reply: "All done" });
  fake.send(audio());
  fake.send({ type: "agent_response_complete", agent_response_complete_event: { event_id: 1 } });
  await until(() => state.playback.plays.some(p => p.started), "spoken reply");
  assert.equal(state.heard[0].speaker, "1");
  assert.equal(state.heard[0].costUsd, 0, "no OpenAI transcription charge");
  assert.equal(state.brain.stats.speculative, 0);
});

test("ElevenLabs brain: stay_silent returns a client result, interruption stops buffered playback and drops stale audio", async t => {
  const fake = await fakeElevenLabs(t);
  const state = testBrain({ provider: elevenlabsAgents({ baseUrl: fake.base }), reference: "elevenlabs/gemini-2.5-flash-lite", ownsTurns: true });
  t.after(() => state.brain.close());
  await until(() => state.logs.some(e => e.type === "voice_realtime_ready"), "ready");
  await utter(state.brain, "1", 200);
  fake.send(transcript("That was for Ben"));
  fake.send(tool("silent", "stay_silent"));
  await until(() => fake.seen.events.some(e => e.type === "client_tool_result"), "silence acknowledged");
  assert.equal(state.playback.plays.length, 0);
  assert.equal(state.brain.stats.staySilent, 1);
  fake.send(transcript("Mochi, hello"));
  fake.send(audio());
  await until(() => state.playback.plays.some(p => p.started), "playing");
  fake.send({ type: "interruption", interruption_event: { event_id: 2 } });
  fake.send(audio());
  await until(() => state.playback.plays[0].stopped, "playback stopped");
  await sleep(20);
  assert.equal(state.playback.plays.length, 1);
});

test("ElevenLabs close and protocol errors carry redacted reasons; provisioning failure is reported safely", async t => {
  const fake = await fakeElevenLabs(t);
  const a = recorder();
  elevenlabsAgents({ baseUrl: fake.base }).connect(config, { apiKey: "key" }, a.events);
  await until(() => a.got.some(e => e.type === "ready"), "ready");
  fake.connections[0].close(1008, "Invalid sk_fake_elevenlabs_key and sk-openaiFakeKey123");
  await until(() => a.got.some(e => e.type === "closed"), "closed");
  assert.equal(a.got.find(e => e.type === "closed")!.detail, "The realtime connection closed (1008: Invalid [redacted] and [redacted])");
  const b = recorder();
  elevenlabsAgents({ baseUrl: fake.base }).connect(config, { apiKey: "key" }, b.events);
  await until(() => b.got.some(e => e.type === "ready"), "second ready");
  fake.send({ type: "client_error", error_event: { code: 400, message: "bad voice sk_fake_elevenlabs_key" } });
  await until(() => b.got.some(e => e.type === "closed"), "protocol error");
  assert.match(b.got.find(e => e.type === "closed")!.detail, /400: bad voice \[redacted\]/);
  const failed = await fakeElevenLabs(t, { fail: true });
  const c = recorder();
  elevenlabsAgents({ baseUrl: failed.base }).connect(config, { apiKey: "key" }, c.events);
  await until(() => c.got.some(e => e.type === "closed"), "provision failure");
  assert.equal(c.got[0].reason, "error");
  assert.equal(c.got[0].detail, "ElevenLabs Agents provisioning or authentication failed");
});


test("ElevenLabs pricing requires both runtime rates and includes the separately billed LLM", () => {
  const reference = "elevenlabs/gemini-2.5-flash-lite";
  assert.equal(realtimePrice(reference, {}), undefined);
  assert.equal(realtimePrice(reference, { AGENT_PRICE_ELEVENLABS_AGENTS_MINUTE_USD: "1" }), undefined);
  assert.equal(realtimePrice(reference, { AGENT_PRICE_ELEVENLABS_LLM_MINUTE_USD: "2" }), undefined);
  assert.equal(realtimeCost(reference, NO_USAGE, 60), 3);
  assert.equal(realtimeCost(reference, NO_USAGE, 30, 20), 1.5, "context updates are not billable text-only calls");
  for (const value of ["0", "-1", "NaN", "Infinity", "invalid"]) {
    for (const name of ["AGENT_PRICE_ELEVENLABS_AGENTS_MINUTE_USD", "AGENT_PRICE_ELEVENLABS_LLM_MINUTE_USD"]) {
      assert.throws(() => realtimePrice(reference, { ...process.env, [name]: value }), /must be a positive number/);
    }
  }
});

test("ElevenLabs meters wall time once, including silence, interruption and the final close interval", async t => {
  const fake = await fakeElevenLabs(t);
  const { got, events } = recorder();
  let now = 0;
  const metered: number[] = [];
  events.meter = (seconds, texts) => { metered.push(seconds); assert.equal(texts, 0); };
  const provider = elevenlabsAgents({ baseUrl: fake.base, now: () => now });
  const connection = provider.connect(config, { apiKey: "fixture" }, events);
  await until(() => got.some(event => event.type === "ready"), "ready");
  connection.append(tone(100));
  now = 1_000;
  await until(() => metered.length > 0, "silent time billed");
  fake.send(audio());
  fake.send({ type: "interruption" });
  await until(() => got.some(event => event.type === "interrupted"), "interrupted");
  now = 1_500;
  connection.close();
  connection.close();
  await sleep(30);
  assert.equal(metered.reduce((sum, seconds) => sum + seconds, 0), 1.5);
});

test("ElevenLabs bills final connection time through a rolling hold and releases no extra response holds", async t => {
  const fake = await fakeElevenLabs(t);
  let now = 0, holds = 0;
  const settlements: number[] = [];
  const state = testBrain({
    reference: "elevenlabs/gemini-2.5-flash-lite", ownsTurns: true,
    provider: elevenlabsAgents({ baseUrl: fake.base, now: () => now }),
    hold: async () => {
      holds++;
      return { settle: async cost => { settlements.push(cost); }, release: async () => {} };
    },
  });
  t.after(() => state.brain.close());
  await until(() => fake.seen.events.some(event => event.type === "conversation_initiation_client_data"), "connection after hold");
  fake.send(audio());
  await until(() => state.brain.stats.responses === 1, "provider response");
  assert.equal(holds, 1);
  now = 100;
  state.brain.close();
  await until(() => settlements.length === 1, "final hold settled");
  const expected = realtimeCost("elevenlabs/gemini-2.5-flash-lite", NO_USAGE, now / 1_000);
  assert.equal(settlements[0], expected);
  assert.equal(state.usage.reduce((sum, usage) => sum + usage.costUsd, 0), expected);
  assert.equal(state.brain.stats.costUsd, expected);
});


test("ElevenLabs lost connections settle once and reconnect behind a renewed hold", async t => {
  const fake = await fakeElevenLabs(t);
  let now = 0, holds = 0;
  const settlements: number[] = [];
  const state = testBrain({
    reference: "elevenlabs/gemini-2.5-flash-lite", ownsTurns: true,
    provider: elevenlabsAgents({ baseUrl: fake.base, now: () => now }),
    hold: async () => {
      holds++;
      return { settle: async cost => { settlements.push(cost); }, release: async () => {} };
    },
  });
  t.after(() => state.brain.close());
  await until(() => state.logs.some(log => log.type === "voice_realtime_ready"), "first connection");
  now = 100;
  fake.connections[0].close();
  await until(() => fake.connections.length === 2, "replacement connection");
  await until(() => state.logs.filter(log => log.type === "voice_realtime_ready").length === 2, "replacement ready");
  assert.equal(holds, 2);
  assert.equal(settlements.length, 1);
  now = 200;
  state.brain.close();
  await until(() => settlements.length === 2, "replacement settled");
  assert.equal(settlements.reduce((sum, cost) => sum + cost, 0), realtimeCost("elevenlabs/gemini-2.5-flash-lite", NO_USAGE, 0.2));
});
