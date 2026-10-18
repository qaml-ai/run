import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import type { SttEvent } from "../src/transcription-live.ts";
import { deepgramFlux, deepgramLiveTranscription } from "../src/voice-providers/stt-deepgram.ts";
import { sonioxLiveTranscription } from "../src/voice-providers/stt-soniox.ts";
import { assemblyaiLiveTranscription } from "../src/voice-providers/stt-assemblyai.ts";
import { chainedLive, liveProvider, sttReference, type ChainMember } from "../src/voice-providers/stt.ts";
import { speechPrices, sttCost, ttsCost } from "../src/voice-providers/prices.ts";
import { fakeAssemblyAI, fakeDeepgram, fakeFlux, fakeSoniox, listening, silence, speech } from "./speech-provider-fakes.ts";

const words = (n: number) => ["Hello there.", "Second one.", "Third utterance.", "Fourth."][n - 1] ?? `utterance ${n}`;

test("deepgram nova-3: streams linear16 with its key, Finalize at each commit answers that commit's words", async t => {
  const { server, sockets, base } = await listening(t);
  const seen = fakeDeepgram(server, sockets, words);
  const events: SttEvent[] = [];
  const stream = deepgramLiveTranscription({ baseUrl: base }).connect({ apiKey: "dg-key" }, { language: "en", keyterms: ["camelRun"], onEvent: event => events.push(event) })!;
  stream.append(speech(1000));
  const first = stream.commit();
  stream.append(speech(500));
  stream.clear();
  stream.append(speech(2000));
  const second = stream.commit();
  assert.deepEqual(await first, { text: "Hello there.", seconds: 1, model: "nova-3", provider: "deepgram" });
  // The fake lays "Second one." across the cleared 0.5 s and what followed: "Second" was in the cleared audio.
  assert.deepEqual(await second, { text: "one.", seconds: 2, model: "nova-3", provider: "deepgram" });
  const url = new URL(seen.urls[0], base);
  assert.equal(url.pathname, "/v1/listen");
  assert.equal(seen.auth[0], "Token dg-key");
  for (const [name, value] of Object.entries({ model: "nova-3", encoding: "linear16", sample_rate: "24000", language: "en", endpointing: "false", interim_results: "true", keyterm: "camelRun" })) assert.equal(url.searchParams.get(name), value, name);
  assert.ok(events.some(event => event.type === "partial"), "interim results are partials");
  stream.close();
  await sleep(20);
  assert.deepEqual(seen.text.at(-1), { type: "CloseStream" });
});

test("deepgram nova-3: without a language it streams multilingual, priced so; a key scope's gateway does not stream", async t => {
  const { server, sockets, base } = await listening(t);
  const seen = fakeDeepgram(server, sockets, words);
  const provider = deepgramLiveTranscription({ baseUrl: base });
  assert.equal(provider.connect({ apiKey: "k", baseUrl: "https://gateway.example" }, {}), undefined);
  const stream = provider.connect({ apiKey: "k" }, {})!;
  stream.append(speech(500));
  const transcript = await stream.commit();
  assert.equal(transcript.model, "nova-3-multilingual");
  assert.equal(new URL(seen.urls[0], base).searchParams.get("language"), "multi");
  assert.equal(sttCost(speechPrices({}), "deepgram/nova-3-multilingual", 60), 0.0092);
  stream.close();
});

test("deepgram flux: turn events reach onEvent (start, eager end, resumed, end), and a commit after EndOfTurn answers at once", async t => {
  const { server, sockets, base } = await listening(t);
  const seen = fakeFlux(server, sockets, words);
  const events: SttEvent[] = [];
  const provider = deepgramFlux({ baseUrl: base, flux: { eotThreshold: 0.8, eagerEotThreshold: 0.5, eotTimeoutMs: 3000 } });
  assert.equal(provider.turnDetection, true);
  assert.equal(provider.connect({ apiKey: "k" }, { language: "fr" }), undefined, "Flux hears English only");
  const ended = Promise.withResolvers<void>();
  const stream = provider.connect({ apiKey: "dg-key" }, { onEvent: event => { events.push(event); if (event.type === "end_of_turn") ended.resolve(); } })!;
  // Speech, a pause long enough to be eagerly over, more speech (resumed), then a pause that ends the turn.
  stream.append(speech(600));
  stream.append(silence(240));
  stream.append(speech(300));
  stream.append(silence(500));
  await ended.promise;
  const started = Date.now();
  const transcript = await stream.commit();
  assert.ok(Date.now() - started < 100, "answered from the ended turn, not a wait");
  assert.deepEqual(transcript, { text: "Hello there.", seconds: 2, model: "flux-general-en", provider: "deepgram" });
  assert.deepEqual(events.filter(event => event.type !== "partial").map(event => event.type), ["speech_started", "eager_end_of_turn", "turn_resumed", "eager_end_of_turn", "end_of_turn"]);
  const end = events.find(event => event.type === "end_of_turn") as Extract<SttEvent, { type: "end_of_turn" }>;
  assert.equal(end.confidence, 0.85);
  const url = new URL(seen.urls[0], base);
  assert.equal(url.pathname, "/v2/listen");
  assert.equal(url.searchParams.get("eot_threshold"), "0.8");
  assert.equal(url.searchParams.get("eager_eot_threshold"), "0.5");
  assert.equal(url.searchParams.get("eot_timeout_ms"), "3000");
  stream.close();
});

test("deepgram flux: a commit while a turn is open waits a moment for its end, then takes its words so far", async t => {
  const { server, sockets, base } = await listening(t);
  fakeFlux(server, sockets, words);
  const stream = deepgramFlux({ baseUrl: base }).connect({ apiKey: "k" }, {})!;
  stream.append(speech(600));
  await sleep(50);
  const transcript = await stream.commit();
  assert.equal(transcript.text, "words so far");
  stream.close();
});

test("soniox: config with its key first, tokens joined as they come, finalize answered by <fin>", async t => {
  const { server, sockets, base } = await listening(t);
  const seen = fakeSoniox(server, sockets, words);
  const url = base.replace(/^http/, "ws");
  const events: SttEvent[] = [];
  const stream = sonioxLiveTranscription({ url }).connect({ apiKey: "soniox-key" }, { language: "pt-BR", prompt: "A call about camelRun", keyterms: ["camelRun"], onEvent: event => events.push(event) })!;
  stream.append(speech(1000));
  const one = stream.commit();
  stream.append(speech(1200));
  const two = stream.commit();
  assert.deepEqual(await one, { text: "Hello there.", language: "en", seconds: 1, model: "stt-rt-v3", provider: "soniox" });
  assert.equal((await two).text, "Second one.");
  assert.deepEqual(seen.text[0], {
    api_key: "soniox-key", model: "stt-rt-v3", audio_format: "pcm_s16le", sample_rate: 24_000, num_channels: 1,
    language_hints: ["pt"], enable_language_identification: true, context: { text: "A call about camelRun", terms: ["camelRun"] },
  });
  assert.ok(events.some(event => event.type === "partial" && event.text === "hear"));
  stream.close();
});

test("soniox: a key it refuses fails the commit", async t => {
  const { server, sockets, base } = await listening(t);
  fakeSoniox(server, sockets, words);
  const stream = sonioxLiveTranscription({ url: base.replace(/^http/, "ws") }).connect({ apiKey: "wrong" }, {})!;
  stream.append(speech(200));
  await assert.rejects(stream.commit(), /Soniox live transcription failed \(401\)|closed/);
});

test("assemblyai: streams with its key, ForceEndpoint at a commit, and the formatted turn is the transcript", async t => {
  const { server, sockets, base } = await listening(t);
  const seen = fakeAssemblyAI(server, sockets, words);
  const stream = assemblyaiLiveTranscription({ baseUrl: base }).connect({ apiKey: "aai-key" }, { keyterms: ["camelRun"] })!;
  stream.append(speech(800));
  const first = await stream.commit();
  assert.deepEqual(first, { text: "Hello there.", seconds: 1, model: "universal-streaming-english", provider: "assemblyai" });
  stream.append(speech(700));
  assert.equal((await stream.commit()).text, "Second one.");
  const url = new URL(seen.urls[0], base);
  assert.equal(url.pathname, "/v3/ws");
  assert.equal(seen.auth[0], "aai-key");
  assert.equal(url.searchParams.get("format_turns"), "true");
  assert.equal(url.searchParams.get("keyterms_prompt"), JSON.stringify(["camelRun"]));
  // Nothing said since: answered without waiting on a turn that will not come.
  const started = Date.now();
  assert.equal((await stream.commit()).text, "");
  assert.ok(Date.now() - started < 1_000);
  stream.close();
  await sleep(20);
  assert.deepEqual(seen.text.at(-1), { type: "Terminate" });
});

test("references: provider names, default models and aliases", () => {
  assert.equal(sttReference("deepgram"), "deepgram/nova-3");
  assert.equal(sttReference("deepgram/flux"), "deepgram/flux-general-en");
  assert.equal(sttReference("soniox"), "soniox/stt-rt-v3");
  assert.equal(sttReference("openai"), "openai/gpt-live-transcribe");
  assert.throws(() => sttReference("whisperx/large"), /Unknown speech-to-text provider/);
  assert.equal(liveProvider("deepgram/flux").turnDetection, true);
  assert.equal(liveProvider("assemblyai").id, "assemblyai");
});

const member = (provider: ChainMember["provider"], apiKey: string | undefined, platform = false): ChainMember => ({ provider, key: async () => apiKey ? { apiKey, platform } : undefined });

test("chain: the first provider with a key serves; its transcripts say who served and whose key", async t => {
  const { server, sockets, base } = await listening(t);
  const deepgram = fakeDeepgram(server, sockets, words);
  const stream = chainedLive([member(sonioxLiveTranscription({ url: "ws://127.0.0.1:9" }), undefined), member(deepgramLiveTranscription({ baseUrl: base }), "dg", true)], { language: "en" });
  stream.append(speech(900));
  const transcript = await stream.commit();
  assert.deepEqual(transcript, { text: "Hello there.", seconds: 1, model: "nova-3", provider: "deepgram", platform: true });
  assert.equal(deepgram.connections, 1);
  stream.close();
});

test("chain: a provider that drops mid-turn fails over; the next gets the utterance's audio whole", async t => {
  const { server, sockets, base } = await listening(t);
  // The first Deepgram connection is dropped as soon as it opens; Soniox (the second) answers.
  fakeDeepgram(server, sockets, words, { dropOnConnection: 0 });
  const soniox = await listening(t);
  const sonioxSeen = fakeSoniox(soniox.server, soniox.sockets, words);
  const stream = chainedLive([member(deepgramLiveTranscription({ baseUrl: base }), "dg"), member(sonioxLiveTranscription({ url: soniox.base.replace(/^http/, "ws") }), "soniox-key", true)], { language: "en" });
  stream.append(speech(500));
  await sleep(50);
  stream.append(speech(700));
  const transcript = await stream.commit();
  assert.deepEqual(transcript, { text: "Hello there.", language: "en", seconds: 2, model: "stt-rt-v3", provider: "soniox", platform: true });
  assert.equal(sonioxSeen.audioMs[0], 1200, "all 1.2 s of the utterance, including what went to the provider that failed");
  stream.close();
});

test("chain: a provider that does not answer a commit in failoverMs fails over; after all fail, commits reject", async t => {
  const { server, sockets, base } = await listening(t);
  fakeDeepgram(server, sockets, words, { finalizeDelayMs: 2_000 });
  const second = await listening(t);
  fakeAssemblyAI(second.server, second.sockets, words);
  const stream = chainedLive([member(deepgramLiveTranscription({ baseUrl: base }), "dg"), member(assemblyaiLiveTranscription({ baseUrl: second.base }), "aai")], { failoverMs: 200 });
  stream.append(speech(600));
  const started = Date.now();
  const transcript = await stream.commit();
  assert.equal(transcript.provider, "assemblyai");
  assert.equal(transcript.text, "Hello there.");
  assert.ok(Date.now() - started < 1_500, `answered ${Date.now() - started} ms after the commit`);
  stream.close();

  const none = chainedLive([member(deepgramLiveTranscription({ baseUrl: base }), undefined)]);
  none.append(speech(100));
  await assert.rejects(none.commit(), /No provider/);
  assert.equal(none.closed, true);
});

test("prices: per provider and model, overridable; text to speech by characters or seconds", () => {
  const prices = speechPrices({ AGENT_SPEECH_PRICES: JSON.stringify({ stt: { "soniox/stt-rt-v3": 0.003 }, tts: { "cartesia/sonic-3": { perThousandChars: 0.03 }, "openai/gpt-4o-mini-tts": { perMinute: 0.015 } } }) });
  assert.equal(sttCost(prices, "soniox/stt-rt-v3", 59.2), 0.003);
  assert.equal(sttCost(prices, "deepgram/flux-general-en", 30), 0.00385);
  assert.equal(sttCost(prices, "nobody/none", 30), undefined);
  assert.equal(ttsCost(prices, "cartesia/sonic-3", { characters: 2000, seconds: 120 }), 0.06);
  assert.equal(ttsCost(prices, "openai/gpt-4o-mini-tts", { characters: 2000, seconds: 120 }), 0.03);
  assert.throws(() => speechPrices({ AGENT_SPEECH_PRICES: "{\"stt\": {\"x\": 1}}" }), /<provider>\/<model>/);
  assert.throws(() => speechPrices({ AGENT_SPEECH_PRICES: "{\"stt\": {\"a/b\": -1}}" }), /non-negative/);
});
