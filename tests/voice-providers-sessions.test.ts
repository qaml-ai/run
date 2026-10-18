import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeConfig } from "../src/node-config.ts";
import { createNode, nodeDeps, type RuntimeNode } from "../src/node.ts";
import { Synthesizer } from "../src/speech.ts";
import { Transcriber } from "../src/transcription.ts";
import { speechPrices, ttsCost } from "../src/voice-providers/prices.ts";
import { onFreePort, sha, token } from "./cluster-helpers.ts";
import { testDatabase } from "./database.ts";
import { until } from "./runtime-server.ts";
import { fakeDeepgram, listening } from "./speech-provider-fakes.ts";
import { discordGrant, fakeTransport, speak } from "./voice-fakes.ts";

test("a session names its speech providers: Deepgram transcribes as people speak, ElevenLabs speaks in its voice, each billed as itself", async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-voice-providers-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: { alice: { tokenSha256: sha(token), apiKeys: { openrouter: "fixture-key", openai: "tenant-openai-key", deepgram: "tenant-deepgram-key", elevenlabs: "tenant-xi-key" } } } }));
  // Deepgram (streaming STT) and ElevenLabs (TTS) on one fake server; OpenAI's batch transcription must not be used.
  const spoken: { url: string; key: string; body: any }[] = [];
  let batch = 0;
  const { server, sockets, base: fakes } = await listening(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (req.url?.endsWith("/audio/transcriptions")) { batch++; res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text: "batch", usage: { type: "duration", seconds: 1 } })); return; }
    if (req.url?.startsWith("/v1/text-to-speech/")) {
      spoken.push({ url: req.url, key: String(req.headers["xi-api-key"]), body: JSON.parse(body) });
      res.writeHead(200, { "Content-Type": "audio/pcm" }).end(Buffer.alloc(24_000, 7));
      return;
    }
    res.writeHead(404).end();
  });
  const deepgram = fakeDeepgram(server, sockets, () => "Book the meeting with Miguel.");
  const { url: databaseUrl } = await testDatabase();
  const fake = fakeTransport();
  let node: RuntimeNode | undefined;
  t.after(async () => { await node?.close().catch(() => {}); });
  const base = await onFreePort(async port => {
    const config = nodeConfig({
      PORT: String(port), HOST: "127.0.0.1", AGENT_NODE_URL: `http://127.0.0.1:${port}`, AGENT_DATABASE_URL: databaseUrl,
      AGENT_DATA_DIR: join(root, "shared"), AGENT_STORAGE: "shared-file", AGENT_HOSTING: "inline", AGENT_LEASE_TTL_MS: "1500", AGENT_SCHEDULER_INTERVAL_MS: "200",
      AGENT_TENANTS_FILE: join(root, "tenants.json"), AGENT_SESSION_SECRET: "voice-api-session-secret-with-32-chars!!", AGENT_SECRETS_KEY: randomBytes(32).toString("hex"),
      AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_TRANSCRIPTION_URL: `${fakes}/v1`, AGENT_SPEECH_URL: `${fakes}/v1`,
      AGENT_DEEPGRAM_URL: fakes, AGENT_ELEVENLABS_URL: fakes,
    });
    const made = await createNode(config, { ...await nodeDeps(config), voiceTransports: { discord: fake.transport } });
    try { await made.start(); } catch (error) { await made.close().catch(() => {}); throw error; }
    node = made;
    return `http://127.0.0.1:${port}`;
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    });
    return { status: response.status, json: await response.json() as any };
  };

  const unknown = await call("POST", "/v1/voice/sessions", { discord: discordGrant(), transcription: { providers: ["whisperx"] } });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.error, /Unknown speech-to-text provider whisperx/);
  const notSpeaking = await call("POST", "/v1/voice/sessions", { discord: discordGrant(), speech: { providers: ["elevenlabs"] } });
  assert.equal(notSpeaking.status, 400, "speech is for a session that speaks");
  const badVoice = await call("POST", "/v1/voice/sessions", { discord: discordGrant(), speak: true, speech: { voices: { polly: "Joanna" } } });
  assert.equal(badVoice.status, 400);

  const created = await call("POST", "/v1/voice/sessions", {
    discord: discordGrant(), language: "en", silenceMs: 200, speak: true,
    transcription: { providers: ["deepgram"], keyterms: ["Miguel"] },
    speech: { providers: ["elevenlabs", "openai"], voices: { elevenlabs: "voice-x" } },
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.deepEqual(created.json.transcription, { providers: ["deepgram/nova-3"], keyterms: ["Miguel"] });
  assert.deepEqual(created.json.speech, { providers: ["elevenlabs/eleven_flash_v2_5", "openai/gpt-4o-mini-tts"], voices: { elevenlabs: "voice-x" } });
  const id = created.json.id;
  const connection = await until(() => fake.open()[0], "the connection");
  connection.handlers.ready();
  await until(async () => (await call("GET", `/v1/voice/sessions/${id}`)).json.state === "live", "live");

  // What they say streams to Deepgram, with its key and terms; the commit's words are the utterance.
  speak(connection, "400000000000000004", 0.6);
  await until(async () => (await call("GET", `/v1/voice/sessions/${id}`)).json.utterances === 1, "the utterance");
  assert.equal(batch, 0, "transcribed as spoken, not after");
  assert.equal(deepgram.auth[0], "Token tenant-deepgram-key");
  const listen = new URL(deepgram.urls[0], fakes);
  assert.equal(listen.searchParams.get("keyterm"), "Miguel");
  assert.equal(listen.searchParams.get("language"), "en");
  assert.ok(deepgram.audioMs[0] >= 500, `the utterance's audio went to Deepgram (${deepgram.audioMs[0]} ms)`);

  // Speech is made by ElevenLabs in the session's voice for it.
  const said = await call("POST", `/v1/voice/sessions/${id}/speak`, { text: "Booked for three." });
  assert.equal(said.status, 202, JSON.stringify(said.json));
  await until(() => spoken.length === 1 && connection.played.length >= 1 && !connection.playing, "the speech");
  assert.equal(spoken[0].url, "/v1/text-to-speech/voice-x/stream?output_format=pcm_24000");
  assert.equal(spoken[0].key, "tenant-xi-key");
  assert.deepEqual(spoken[0].body, { text: "Booked for three.", model_id: "eleven_flash_v2_5", language_code: "en" });

  // Usage names who served: Deepgram's transcription, ElevenLabs' speech.
  const usage = await until(async () => {
    const days = (await call("GET", "/v1/usage")).json.days as { model: string; kind: string }[];
    return days.some(day => day.kind === "speech") && days.some(day => day.kind === "transcription") ? days : undefined;
  }, "usage");
  assert.deepEqual(usage.filter(day => day.kind === "transcription").map(day => day.model), ["deepgram/nova-3"]);
  assert.deepEqual(usage.filter(day => day.kind === "speech").map(day => day.model), ["elevenlabs/eleven_flash_v2_5"]);
});

test("billing: a live transcript is priced by the provider that served it; speech by its provider's unit", async () => {
  const prices = speechPrices({});
  const transcriber = new Transcriber({
    provider: { id: "openai", model: "gpt-transcribe", transcribe: async () => { throw new Error("unused"); } },
    key: async () => undefined, price: () => 4_500,
    live: { order: ["soniox/stt-rt-v3", "openai/gpt-live-transcribe"], provider: () => { throw new Error("unused"); }, price: reference => reference.startsWith("openai/") ? 17_000 : prices.stt[reference]?.perMinute ?? 17_000 },
  });
  const soniox = transcriber.liveUsage({ text: "hi", seconds: 60, model: "stt-rt-v3", provider: "soniox", platform: true }, false);
  assert.deepEqual([soniox.provider, soniox.model, soniox.platform, soniox.usage.cost.total], ["soniox", "stt-rt-v3", true, 0.002]);
  const openai = transcriber.liveUsage({ text: "hi", seconds: 60, model: "gpt-live-transcribe", provider: "openai", platform: false }, true);
  assert.deepEqual([openai.provider, openai.usage.cost.total, openai.platform], ["openai", 0.017, false]);
  assert.equal(transcriber.cost(60, true), 0.017, "held at the dearest of the chain");
  assert.equal(transcriber.cost(60, true, ["soniox/stt-rt-v3"]), 0.002);
  assert.equal(transcriber.cost(60), 0.0045, "batch");

  const synthesizer = new Synthesizer({
    provider: { id: "openai", model: "gpt-4o-mini-tts", async *stream() {} },
    key: async () => undefined, price: () => 15_000,
    chain: { order: ["elevenlabs/eleven_flash_v2_5"], provider: () => { throw new Error("unused"); }, defaultVoice: () => undefined, price: (reference, made) => ttsCost(prices, reference, made) },
  });
  assert.equal(synthesizer.costOf("elevenlabs/eleven_flash_v2_5", { characters: 1000, seconds: 70 }), 0.05, "per character");
  assert.equal(synthesizer.costOf("openai/gpt-4o-mini-tts", { characters: 1000, seconds: 60 }), 0.015, "per second");
  assert.equal(synthesizer.costOf("cartesia/unpriced", { characters: 1000, seconds: 60 }), 0.015, "unpriced: as OpenAI's");
  assert.deepEqual(synthesizer.order(), ["elevenlabs/eleven_flash_v2_5"]);
  assert.ok(synthesizer.estimate("x".repeat(1400), ["elevenlabs/eleven_flash_v2_5", "openai/gpt-4o-mini-tts"]) >= 0.07, "held at the dearest");
});
