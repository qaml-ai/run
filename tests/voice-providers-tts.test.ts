import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { Outbound } from "../src/outbound.ts";
import { cartesiaSpeech, deepgramSpeech, DEFAULT_VOICES, elevenlabsSpeech, speechProvider, ttsReference } from "../src/voice-providers/tts.ts";
import { chainedSpeech, type Served, type SpeechMember } from "../src/voice-providers/tts-chain.ts";
import { openaiSpeech } from "../src/speech.ts";

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: any };

/** A fake of every provider's speech endpoint: what each was asked, and `respond` says how it answers. */
async function fakeSpeech(t: { after(fn: () => unknown): void }, respond: (seen: Seen, res: ServerResponse) => void | Promise<void> = (_seen, res) => pcm(res, [960, 960, 481])) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const entry = { method: req.method!, url: req.url!, headers: req.headers, body: text ? JSON.parse(text) : undefined };
    seen.push(entry);
    await respond(entry, res);
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { seen, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

async function pcm(res: ServerResponse, sizes: number[], gapMs = 5) {
  res.writeHead(200, { "Content-Type": "audio/pcm" });
  for (const size of sizes) { res.write(Buffer.alloc(size, 7)); await new Promise(resolve => setTimeout(resolve, gapMs)); }
  res.end();
}

const outbound = new Outbound({ allowHttp: true, allow: ["127.0.0.1/32"] });
async function collect(stream: AsyncIterable<Uint8Array>) {
  let bytes = 0, chunks = 0;
  for await (const chunk of stream) { bytes += chunk.byteLength; chunks++; }
  return { bytes, chunks };
}
const signal = () => AbortSignal.timeout(10_000);

test("elevenlabs: Flash v2.5 streamed as pcm_24000 with its key header, the voice in the path", async t => {
  const { seen, base } = await fakeSpeech(t);
  const made = await collect(elevenlabsSpeech({ outbound, baseUrl: base }).stream({ text: "Hello there.", voice: "voice123", language: "es-MX" }, { apiKey: "xi-key" }, signal()));
  assert.equal(made.bytes, 2401);
  assert.ok(made.chunks >= 2, "streamed, not buffered");
  assert.equal(seen[0].url, "/v1/text-to-speech/voice123/stream?output_format=pcm_24000");
  assert.equal(seen[0].headers["xi-api-key"], "xi-key");
  assert.deepEqual(seen[0].body, { text: "Hello there.", model_id: "eleven_flash_v2_5", language_code: "es" });
});

test("cartesia: Sonic-3 raw pcm_s16le at 24 kHz, its version header, a voice id required", async t => {
  const { seen, base } = await fakeSpeech(t);
  const provider = cartesiaSpeech({ outbound, baseUrl: base });
  await collect(provider.stream({ text: "Hi.", voice: "c-voice" }, { apiKey: "sk_car" }, signal()));
  assert.equal(seen[0].url, "/tts/bytes");
  assert.equal(seen[0].headers["x-api-key"], "sk_car");
  assert.equal(seen[0].headers["cartesia-version"], "2025-04-16");
  assert.deepEqual(seen[0].body, { model_id: "sonic-3", transcript: "Hi.", voice: { mode: "id", id: "c-voice" }, output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24_000 }, language: "en" });
  await assert.rejects(collect(provider.stream({ text: "Hi.", voice: "" }, { apiKey: "sk_car" }, signal())), /voices\.cartesia/);
});

test("deepgram aura-2: linear16 at 24 kHz without a container, the voice as its model", async t => {
  const { seen, base } = await fakeSpeech(t);
  await collect(deepgramSpeech({ outbound, baseUrl: base }).stream({ text: "Hi.", voice: "" }, { apiKey: "dg" }, signal()));
  assert.equal(seen[0].url, "/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=24000&container=none");
  assert.equal(seen[0].headers.authorization, "Token dg");
  assert.deepEqual(seen[0].body, { text: "Hi." });
});

test("provider errors: a bad key and a refused text say so; a key scope's own address is not dialled", async t => {
  const { base } = await fakeSpeech(t, (seen, res) => { res.writeHead(seen.body.text === "bad" ? 422 : 401).end("{\"detail\": \"nope\"}"); });
  const provider = elevenlabsSpeech({ outbound, baseUrl: base });
  await assert.rejects(collect(provider.stream({ text: "hi", voice: "v" }, { apiKey: "k" }, signal())), (error: any) => error.status === 502 && /rejected the API key \(HTTP 401\)/.test(error.message));
  await assert.rejects(collect(provider.stream({ text: "bad", voice: "v" }, { apiKey: "k" }, signal())), (error: any) => error.status === 400 && /HTTP 422/.test(error.message));
  await assert.rejects(collect(provider.stream({ text: "hi", voice: "v" }, { apiKey: "k", baseUrl: "https://gateway.example" }, signal())), /needs an ElevenLabs key/);
});

test("references and providers by name", () => {
  assert.equal(ttsReference("elevenlabs"), "elevenlabs/eleven_flash_v2_5");
  assert.equal(ttsReference("cartesia"), "cartesia/sonic-3");
  assert.equal(ttsReference("deepgram/aura-2"), "deepgram/aura-2");
  assert.equal(ttsReference("openai"), "openai/gpt-4o-mini-tts");
  assert.throws(() => ttsReference("polly"), /Unknown text-to-speech provider/);
  assert.equal(speechProvider("elevenlabs/eleven_turbo_v2_5", outbound).model, "eleven_turbo_v2_5");
});

const member = (provider: SpeechMember["provider"], apiKey: string | undefined, voice?: string, platform = false): SpeechMember => ({ provider, voice: voice ?? DEFAULT_VOICES[provider.id] ?? "", key: async () => apiKey ? { apiKey, platform } : undefined });

test("chain: a member without a key is skipped, one that fails before its first audio is passed over; who served is said first", async t => {
  const { seen, base } = await fakeSpeech(t, async (entry, res) => {
    if (entry.url.startsWith("/tts/bytes")) { res.writeHead(503).end(); return; }
    await pcm(res, [960, 960]);
  });
  const members = [
    member(deepgramSpeech({ outbound, baseUrl: base }), undefined),
    member(cartesiaSpeech({ outbound, baseUrl: base }), "car", "c-voice"),
    member(elevenlabsSpeech({ outbound, baseUrl: base }), "xi", undefined, true),
  ];
  const order: string[] = [];
  let who: Served | undefined;
  for await (const chunk of chainedSpeech(members, { text: "Hello." }, signal(), served => { who = served; order.push("served"); })) order.push(`chunk ${chunk.byteLength}`);
  assert.deepEqual(who, { provider: "elevenlabs", model: "eleven_flash_v2_5", voice: "21m00Tcm4TlvDq8ikWAM", platform: true });
  assert.deepEqual(order.slice(0, 2), ["served", "chunk 960"]);
  assert.deepEqual(seen.map(entry => entry.url.split("?")[0]), ["/tts/bytes", "/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/stream"]);
});

test("chain: one slower than firstAudioMs to start is passed over; a failure after audio is out ends the speech", async t => {
  const { base } = await fakeSpeech(t, async (entry, res) => {
    if (entry.url.startsWith("/v1/speak")) { await new Promise(resolve => setTimeout(resolve, 500)); await pcm(res, [960]); return; }
    if (entry.url.startsWith("/v1/text-to-speech")) { res.writeHead(200); res.write(Buffer.alloc(960)); setTimeout(() => res.destroy(), 20); return; }
    await pcm(res, [480, 480]);
  });
  const slow = [member(deepgramSpeech({ outbound, baseUrl: base }), "dg"), member(openaiSpeech({ outbound, baseUrl: `${base}/v1` }), "sk")];
  let who: Served | undefined;
  const started = Date.now();
  const made = await collect(chainedSpeech(slow, { text: "Hello." }, signal(), served => { who = served; }, { firstAudioMs: 100 }));
  assert.equal(who?.provider, "openai");
  assert.equal(made.bytes, 960);
  assert.ok(Date.now() - started < 450, "did not wait for the slow one");

  const broken = [member(elevenlabsSpeech({ outbound, baseUrl: base }), "xi"), member(openaiSpeech({ outbound, baseUrl: `${base}/v1` }), "sk")];
  let bytes = 0;
  await assert.rejects((async () => { for await (const chunk of chainedSpeech(broken, { text: "Hello." }, signal(), () => {})) bytes += chunk.byteLength; })());
  assert.equal(bytes, 960, "what was made before the failure was played; no other voice carried on");

  await assert.rejects(collect(chainedSpeech([member(elevenlabsSpeech({ outbound, baseUrl: base }), undefined)], { text: "Hi" }, signal(), () => {})), /No speech provider has a key/);
});
