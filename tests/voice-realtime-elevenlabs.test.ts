import { z } from "zod";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { elevenlabsAgents, ELEVENLABS_AGENTS } from "../src/voice/realtime/elevenlabs.ts";
import { ASK_AGENT, STAY_SILENT } from "../src/voice/realtime/brain.ts";
import { NO_USAGE, realtimeCost, realtimePrice, realtimeVoice, type RealtimeEvents } from "../src/voice/realtime/provider.ts";
import { sleep, testBrain, tone, until, utter } from "./voice-realtime-fakes.ts";
import { testDatabase } from "./database.ts";

// Synthetic rates only; real rates are supplied privately at runtime.
process.env.AGENT_PRICE_ELEVENLABS_AGENTS_MINUTE_USD = "1";
process.env.AGENT_PRICE_ELEVENLABS_LLM_MINUTE_USD = "2";

// Emitted subset of https://elevenlabs.io/docs/api-reference/agents/create and
// https://api.elevenlabs.io/openapi.json (2026-10-19). Strict objects catch misspelled fields.
const parameters = z.object({
  type: z.literal("object"), required: z.array(z.string()).optional(),
  properties: z.record(z.string(), z.object({ type: z.literal("string"), description: z.string() }).strict()),
}).strict();
const createAgentSchema = z.object({
  name: z.string(),
  conversation_config: z.object({
    agent: z.object({ first_message: z.string(), language: z.string(), prompt: z.object({
      prompt: z.string(), llm: z.literal("gemini-2.5-flash-lite"), temperature: z.number().min(0).max(1),
      tools: z.array(z.object({ type: z.literal("client"), name: z.string(), description: z.string(), parameters,
        expects_response: z.boolean(), response_timeout_secs: z.number().int().min(1).max(120),
        interruption_mode: z.enum(["allow", "disable_during_tool", "disable_during_tool_and_turn"]),
        pre_tool_speech: z.enum(["auto", "force", "off"]),
      }).strict()),
    }).strict() }).strict(),
    asr: z.object({ user_input_audio_format: z.literal("pcm_16000") }).strict(),
    tts: z.object({ voice_id: z.string(), model_id: z.literal("eleven_v4_turbo"), agent_output_audio_format: z.literal("pcm_24000") }).strict(),
    turn: z.object({ turn_eagerness: z.enum(["patient", "normal", "eager"]), turn_timeout: z.number(), silence_end_call_timeout: z.number() }).strict(),
    conversation: z.object({ client_events: z.array(z.enum(["conversation_initiation_metadata", "ping", "audio", "interruption", "user_transcript", "agent_response", "client_tool_call", "agent_response_complete", "client_error"])) }).strict(),
  }).strict(),
  platform_settings: z.object({
    auth: z.object({ enable_auth: z.boolean() }).strict(), privacy: z.object({ record_voice: z.boolean() }).strict(),
    overrides: z.object({ conversation_config_override: z.object({
      agent: z.object({ prompt: z.object({ prompt: z.boolean() }).strict(), first_message: z.boolean(), language: z.boolean() }).strict(),
      tts: z.object({ voice_id: z.boolean() }).strict(),
    }).strict() }).strict(),
  }).strict(),
}).strict();

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
    else if (req.url?.startsWith("/v2/voices?")) res.end(JSON.stringify({ voices: [ELEVENLABS_AGENTS.voice, "character_voice", "another_voice", "marin"].map(voice_id => ({ voice_id })), has_more: false }));
    else if (req.url === "/v1/user/subscription") res.end('{"voice_slots_used":0,"voice_limit":10}');
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
  createAgentSchema.parse(body);
  assert.equal(body.name, ELEVENLABS_AGENTS.name);
  assert.equal(body.conversation_config.tts.voice_id, config.voice, "creation uses the requested voice, without depending on Jessica access");
  assert.equal(body.conversation_config.agent.prompt.llm, ELEVENLABS_AGENTS.defaultModel);
  assert.deepEqual(body.conversation_config.agent.prompt.tools.map(({ name, description, parameters, type, expects_response }: any) => ({ name, description, parameters, type, expects_response })),
    [ASK_AGENT, STAY_SILENT].map(tool => ({ ...tool, type: "client", expects_response: true })));
  assert.deepEqual(body.platform_settings.overrides.conversation_config_override, { agent: { prompt: { prompt: true }, first_message: true, language: true }, tts: { voice_id: true } });
  assert.equal(body.platform_settings.auth.enable_auth, true);
  assert.equal(body.conversation_config.tts.agent_output_audio_format, "pcm_24000");
  assert.equal(fake.seen.requests.filter(r => r.url.includes("get-signed-url?agent_id=agent_test")).length, 2);
  assert.ok(fake.seen.requests.every(r => r.key === "tenant-key"));
  assert.ok(fake.seen.urls.every(url => !url.includes("tenant-key")));
  const overrides = fake.seen.events.filter(e => e.type === "conversation_initiation_client_data").map(e => e.conversation_config_override)
    .sort((a, b) => b.tts.voice_id.localeCompare(a.tts.voice_id));
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
  assert.equal(a.got.find(e => e.type === "closed")!.detail, "ElevenLabs Agents session: The realtime connection closed (1008: Invalid [redacted] and [redacted])");
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
  assert.equal(c.got[0].detail, "ElevenLabs Agents list agents (HTTP 401): never logged");
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

for (const stage of ["list agents", "create agent", "signed URL"]) {
  for (const status of [400, 401, 403, 422, 429, 500, 503]) test(`ElevenLabs ${stage} HTTP ${status}: diagnostics and retry policy reach the brain`, async t => {
    let attempts = 0;
    const fake = await fakeElevenLabs(t);
    const provider = elevenlabsAgents({ baseUrl: fake.base, fetch: async (url, init) => {
      const path = String(url);
      const fail = stage === "list agents" ? path.includes("/agents?") : stage === "create agent" ? path.endsWith("agents/create") : path.includes("get-signed-url?");
      if (!fail) return fetch(url, init);
      attempts++;
      return Response.json({ detail: status === 422
        ? [{ loc: ["body", "conversation_config", "agent", "prompt", "tools", 0, "parameters"], msg: "Invalid tool schema" }]
        : { status: "invalid_configuration", message: "Cannot start: sk_fixture_secret123 https://example.com?s=short " + "x".repeat(40) + " " + "fixture" } }, { status });
    } });
    const state = testBrain({ provider, reference: "elevenlabs/gemini-2.5-flash-lite", ownsTurns: true });
    t.after(() => state.brain.close());
    await until(() => state.logs.some(log => log.type === "voice_realtime_lost" && log.fields?.retrying === false), "gave up");
    const lost = state.logs.filter(log => log.type === "voice_realtime_lost");
    assert.equal(attempts, status >= 500 ? 4 : 1);
    assert.equal(lost.length, attempts);
    for (const log of lost) {
      const detail = String(log.fields?.detail);
      assert.ok(detail.startsWith(`ElevenLabs Agents ${stage} (HTTP ${status}):`));
      assert.ok(detail.length <= 300);
      if (status === 422) assert.match(detail, /body.conversation_config.agent.prompt.tools.0.parameters: Invalid tool schema/);
      else {
        assert.match(detail, /invalid_configuration: Cannot start:/);
        assert.doesNotMatch(detail, /sk_fixture|example.com|x{40}|fixture/);
      }
    }
  });
}

test("ElevenLabs retries network failures and preserves their stage", async t => {
  let attempts = 0;
  const provider = elevenlabsAgents({ fetch: async () => { attempts++; throw new TypeError("fetch failed"); } });
  const state = testBrain({ provider, reference: "elevenlabs/gemini-2.5-flash-lite", ownsTurns: true });
  t.after(() => state.brain.close());
  await until(() => state.logs.filter(log => log.type === "voice_realtime_lost").length === 4, "network retries");
  assert.equal(attempts, 4);
  assert.match(String(state.logs.find(log => log.type === "voice_realtime_lost")!.fields?.detail), /list agents: fetch failed/);
});

test("ElevenLabs resolves library IDs independently of name search, uses returned IDs, and reuses account copies after restart", async t => {
  const { db } = await testDatabase();
  const fake = await fakeElevenLabs(t);
  const owned: { voice_id: string; sharing: { original_voice_id: string } }[] = [];
  const adds: string[] = [];
  const request: typeof fetch = async (url, init) => {
    const path = new URL(String(url));
    if (path.pathname === "/v2/voices") return Response.json({ voices: owned, has_more: false });
    if (path.pathname === "/v1/shared-voices") throw new Error("ID must not be used as library search text");
    if (path.pathname === `/v1/voices/${config.voice}`) {
      assert.equal(path.search, "");
      return Response.json({ voice_id: config.voice, sharing: { public_owner_id: "public_owner" }, name: "Shared voice" });
    }
    if (path.pathname.startsWith("/v1/voices/add/")) {
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), { new_name: "Shared voice" });
      const original = path.pathname.split("/").at(-1)!;
      adds.push(original);
      const voice_id = `account_${original}`;
      owned.push({ voice_id, sharing: { original_voice_id: original } });
      return Response.json({ voice_id });
    }
    return fetch(url, init);
  };
  for (let restart = 0; restart < 2; restart++) {
    const provider = elevenlabsAgents({ db, baseUrl: fake.base, fetch: request });
    const sessions = [recorder(), recorder()];
    const connections = sessions.map(session => provider.connect(config, { apiKey: "tenant-key" }, session.events));
    t.after(() => connections.forEach(connection => connection.close()));
    await until(() => sessions.every(session => session.got.some(event => event.type === "ready")), "shared voices ready");
  }
  assert.deepEqual(adds, [config.voice]);
  assert.ok(fake.seen.requests.filter(request => request.url.endsWith("agents/create")).every(request => request.body.conversation_config.tts.voice_id === `account_${config.voice}`));
  assert.ok(fake.seen.events.filter(event => event.type === "conversation_initiation_client_data").every(event => event.conversation_config_override.tts.voice_id === `account_${config.voice}`));
});

test("ElevenLabs websocket open and init failures retain stage and redact signed URLs", async t => {
  for (const stage of ["websocket open", "init"]) {
    const fake = await fakeElevenLabs(t, { existing: true });
    const { got, events } = recorder();
    let ws: any;
    const provider = elevenlabsAgents({ baseUrl: fake.base, socket: () => {
      ws = { readyState: 0, send() {}, close() {} };
      return ws;
    } });
    const connection = provider.connect(config, { apiKey: "tenant-key" }, events);
    t.after(() => connection.close());
    await until(() => !!ws?.onopen, "socket handlers");
    if (stage === "init") ws.onopen();
    ws.onclose({ code: 1008, reason: "invalid tenant-key wss://example.com?signature=short" });
    const closed = got.find(event => event.type === "closed")!;
    assert.match(closed.detail, new RegExp(`ElevenLabs Agents ${stage}:`));
    assert.doesNotMatch(closed.detail, /tenant-key|example.com|signature=short/);
  }
});

test("ElevenLabs malformed error bodies keep HTTP status and diagnostics are capped at 300 characters", async t => {
  for (const body of ["not json", JSON.stringify({ detail: [null] }), JSON.stringify({ detail: { status: "invalid_configuration", message: "bad value ".repeat(100) } })]) {
    const { got, events } = recorder();
    const connection = elevenlabsAgents({ fetch: async () => new Response(body, { status: 422 }) }).connect(config, { apiKey: "tenant-key" }, events);
    t.after(() => connection.close());
    await until(() => got.some(event => event.type === "closed"), "failure");
    const detail = got.find(event => event.type === "closed")!.detail;
    assert.match(detail, /list agents \(HTTP 422\):/);
    assert.ok(detail.length <= 300);
    if (body === "not json") assert.match(detail, /request failed$/);
    else if (body.includes("invalid_configuration")) assert.equal(detail.length, 300);
    else assert.match(detail, /validation: invalid value$/);
  }
});


test("ElevenLabs imports a known public owner directly and verifies account access after an add race", async t => {
  for (const race of [false, true]) {
    const { db } = await testDatabase();
    const fake = await fakeElevenLabs(t, { existing: true });
    const { got, events } = recorder();
    let added = false;
    let lists = 0;
    const provider = elevenlabsAgents({ db, baseUrl: fake.base, fetch: async (url, init) => {
      const path = new URL(String(url));
      if (path.pathname === "/v2/voices") {
        lists++;
        if (added && path.searchParams.has("next_page_token")) return Response.json({ voices: [{ voice_id: "account_copy", sharing: { original_voice_id: config.voice } }], has_more: false });
        return Response.json({ voices: [], has_more: added, ...(added ? { next_page_token: "second" } : {}) });
      }
      if (path.pathname === `/v1/voices/add/known_owner/${config.voice}`) {
        assert.equal(init?.method, "POST");
        assert.deepEqual(JSON.parse(String(init?.body)), { new_name: config.voice });
        added = true;
        return race ? Response.json({ detail: { status: "voice_already_added" } }, { status: 400 }) : Response.json({ voice_id: "account_copy" });
      }
      assert.ok(!path.pathname.startsWith("/v1/voices/") && path.pathname !== "/v1/shared-voices", "known owner needs no discovery");
      return fetch(url, init);
    } });
    const connection = provider.connect({ ...config, publicOwnerId: "known_owner" }, { apiKey: "tenant-key" }, events);
    t.after(() => connection.close());
    await until(() => got.some(event => event.type === "ready"), "known owner ready");
    assert.equal(fake.seen.events[0].conversation_config_override.tts.voice_id, "account_copy");
    assert.equal(lists, race ? 3 : 1);
    assert.deepEqual((await db.query("select voice_id from elevenlabs_voices")).rows, race ? [] : [{ voice_id: "account_copy" }], "an add failure never adopts a voice another caller added");
  }
});

test("ElevenLabs refuses failed shared additions without verified account access", async t => {
  const { db } = await testDatabase();
  const fake = await fakeElevenLabs(t, { existing: true });
  const { got, events } = recorder();
  const provider = elevenlabsAgents({ db, baseUrl: fake.base, fetch: async (url, init) => {
    const path = new URL(String(url));
    if (path.pathname === "/v2/voices") return Response.json({ voices: [], has_more: false });
    if (path.pathname.startsWith("/v1/voices/add/")) return Response.json({ detail: { status: "voice_limit_reached" } }, { status: 400 });
    return fetch(url, init);
  } });
  const connection = provider.connect({ ...config, publicOwnerId: "known_owner" }, { apiKey: "tenant-key" }, events);
  t.after(() => connection.close());
  await until(() => got.some(event => event.type === "closed"), "add rejected");
  assert.match(got.find(event => event.type === "closed")!.detail, /add shared voice.*voice_limit_reached/);
  assert.equal(fake.seen.urls.length, 0);
});

for (const race of [false, true]) test(`ElevenLabs voice slots: ${race ? "a slot consumed after preflight" : "at limit"} evicts only the tracked LRU and records the replacement`, async t => {
  const { db } = await testDatabase();
  const keyHash = createHash("sha256").update("tenant-key").digest("hex");
  await db.query(`insert into elevenlabs_voices values
    ($1, 'old', 1, 10), ($1, 'recent', 2, 20), ('another-key-hash', 'other-account', 0, 0)`, [keyHash]);
  const fake = await fakeElevenLabs(t, { existing: true });
  const voices = new Set(["manual", "premade", "old", "recent"]);
  const deleted: string[] = [], added: string[] = [];
  const logs: { type: string; fields: unknown }[] = [];
  let checks = 0;
  const request: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v2/voices") return Response.json({ voices: [...voices].map(voice_id => ({ voice_id })), has_more: false });
    if (path === "/v1/user/subscription") return Response.json({ voice_slots_used: race && checks++ === 0 ? 3 : voices.size, voice_limit: 4 });
    if (init?.method === "DELETE") {
      const id = path.split("/").at(-1)!;
      assert.equal(voices.delete(id), true);
      deleted.push(id);
      return new Response(null, { status: 204 });
    }
    if (path.startsWith("/v1/voices/add/")) {
      added.push(path);
      if (voices.size >= 4) return Response.json({ detail: { status: "slot_failure" } }, { status: 400 });
      voices.add(config.voice);
      return Response.json({ voice_id: config.voice });
    }
    return fetch(url, init);
  };
  const provider = () => elevenlabsAgents({ db, baseUrl: fake.base, fetch: request, log: (type, fields) => logs.push({ type, fields }) });
  // Separate provider instances share no in-memory single-flight cache: the database serializes both nodes.
  const sessions = [recorder(), recorder()];
  const connections = sessions.map(session => provider().connect({ ...config, publicOwnerId: "known_owner" }, { apiKey: "tenant-key" }, session.events));
  t.after(() => connections.forEach(connection => connection.close()));
  await until(() => sessions.every(session => session.got.some(event => event.type === "ready")), "both nodes ready");
  assert.deepEqual(deleted, ["old"]);
  assert.equal(added.length, race ? 2 : 1);
  assert.deepEqual(logs, [{ type: "voice_slot_evicted", fields: { voice: "old", lastUsedAt: 10 } }]);
  assert.ok(voices.has("manual") && voices.has("premade") && voices.has("recent"));
  const rows = (await db.query("select * from elevenlabs_voices order by voice_id")).rows;
  assert.deepEqual(rows.map(row => row.voice_id), [config.voice, "other-account", "recent"]);
  const replacement = rows[0];
  assert.equal(replacement.key_hash, keyHash);
  assert.ok(replacement.added_at > 20 && replacement.last_used_at >= replacement.added_at);
  // A later session updates use time without changing ownership or insertion time.
  await db.query("update elevenlabs_voices set last_used_at = 1 where voice_id = $1", [config.voice]);
  const later = recorder();
  const connection = provider().connect(config, { apiKey: "tenant-key" }, later.events);
  t.after(() => connection.close());
  await until(() => later.got.some(event => event.type === "ready"), "later session ready");
  const used = (await db.query("select * from elevenlabs_voices where voice_id = $1", [config.voice])).rows[0];
  assert.equal(used.added_at, replacement.added_at);
  assert.ok(used.last_used_at >= replacement.last_used_at);
  assert.equal(deleted.length, 1);
});

test("ElevenLabs at limit with only manual/premade or other-key voices fails clearly without deleting or adding", async t => {
  const { db } = await testDatabase();
  await db.query("insert into elevenlabs_voices values ('other-key', 'other-account', 1, 1)");
  const fake = await fakeElevenLabs(t, { existing: true });
  const { got, events } = recorder();
  const provider = elevenlabsAgents({ db, baseUrl: fake.base, fetch: async (url, init) => {
    const path = new URL(String(url)).pathname;
    assert.notEqual(init?.method, "DELETE");
    assert.ok(!path.startsWith("/v1/voices/add/"));
    if (path === "/v2/voices") return Response.json({ voices: [{ voice_id: "manual" }, { voice_id: "premade" }], has_more: false });
    if (path === "/v1/user/subscription") return Response.json({ voice_slots_used: 2, voice_limit: 2 });
    return fetch(url, init);
  } });
  const connection = provider.connect({ ...config, publicOwnerId: "known_owner" }, { apiKey: "tenant-key" }, events);
  t.after(() => connection.close());
  await until(() => got.some(event => event.type === "closed"), "no managed slots");
  assert.match(got.find(event => event.type === "closed")!.detail, /at its voice limit; no camelRun-added voice/);
  assert.equal(fake.seen.urls.length, 0);
  assert.equal((await db.query("select count(*) from elevenlabs_voices")).rows[0].count, 1);
});

test("ElevenLabs failed replacement keeps the eviction durable and never evicts twice", async t => {
  const { db } = await testDatabase();
  const keyHash = createHash("sha256").update("tenant-key").digest("hex");
  await db.query("insert into elevenlabs_voices values ($1, 'old', 1, 1), ($1, 'recent', 2, 2)", [keyHash]);
  const fake = await fakeElevenLabs(t, { existing: true });
  const { got, events } = recorder();
  let deletes = 0, adds = 0;
  const provider = elevenlabsAgents({ db, baseUrl: fake.base, log: () => {}, fetch: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v2/voices") return Response.json({ voices: [], has_more: false });
    if (path === "/v1/user/subscription") return Response.json({ voice_slots_used: 2, voice_limit: 2 });
    if (init?.method === "DELETE") { deletes++; return Response.json({ status: "ok" }); }
    if (path.startsWith("/v1/voices/add/")) { adds++; return Response.json({ detail: "replacement refused" }, { status: 400 }); }
    return fetch(url, init);
  } });
  const connection = provider.connect({ ...config, publicOwnerId: "known_owner" }, { apiKey: "tenant-key" }, events);
  t.after(() => connection.close());
  await until(() => got.some(event => event.type === "closed"), "replacement failed");
  assert.match(got.find(event => event.type === "closed")!.detail, /replacement refused/);
  assert.equal(deletes, 1);
  assert.equal(adds, 1);
  assert.deepEqual((await db.query("select voice_id from elevenlabs_voices")).rows, [{ voice_id: "recent" }]);
});


test("ElevenLabs using an existing account voice never adopts it for eviction", async t => {
  const { db } = await testDatabase();
  const fake = await fakeElevenLabs(t, { existing: true });
  const { got, events } = recorder();
  const connection = elevenlabsAgents({ db, baseUrl: fake.base }).connect(config, { apiKey: "tenant-key" }, events);
  t.after(() => connection.close());
  await until(() => got.some(event => event.type === "ready"), "existing voice ready");
  assert.deepEqual((await db.query("select * from elevenlabs_voices")).rows, []);
  assert.ok(!fake.seen.requests.some(request => request.url === "/v1/user/subscription" || request.url.startsWith("/v1/voices/add/")));
});
