import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { audioHeader } from "../src/audio-header.ts";
import { checkedAudio, openaiTranscription, Transcriber, type TranscriptionProvider } from "../src/transcription.ts";
import { describeFile, sniffContentType, type FileRef } from "../src/files.ts";
import { Outbound } from "../src/outbound.ts";
import { DEFAULT_PRICING, micros, pricingFromEnvironment } from "../src/pricing.ts";
import { usageEvent } from "../src/webhooks.ts";
import { listen } from "./runtime-server.ts";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/audio/${name}`, import.meta.url));

/** A WAV header with `bytesPerSecond` and `dataBytes` of silence after it. */
function wav(seconds: number, bytesPerSecond = 8_000) {
  const data = Math.round(seconds * bytesPerSecond);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(bytesPerSecond, 24); header.writeUInt32LE(bytesPerSecond, 28); header.writeUInt16LE(1, 32); header.writeUInt16LE(8, 34);
  header.write("data", 36); header.writeUInt32LE(data, 40);
  return Buffer.concat([header, Buffer.alloc(data, 0x80)]);
}

test("an audio file's format and length come from its container, for every format transcription takes", () => {
  // MP3's count includes the encoder's padding frames: within a quarter second.
  const near = (actual: number | undefined, expected: number, name: string) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 0.25, `${name}: ${actual} s, not about ${expected}`);
  for (const [name, format] of [["tone.ogg", "ogg"], ["tone.webm", "webm"], ["tone.flac", "flac"], ["tone.m4a", "mp4"], ["tone.mp3", "mp3"], ["tone.wav", "wav"]] as const) {
    const header = audioHeader(fixture(name));
    assert.equal(header?.format, format, name);
    near(header?.seconds, 2, name);
  }
  near(audioHeader(fixture("hello.ogg"))?.seconds, 4.04, "a voice note (Ogg Opus, as Discord sends)");
  near(audioHeader(wav(3))?.seconds, 3, "a WAV built here");
  assert.equal(audioHeader(fixture("tone.webm"))?.contentType, "audio/webm");
  assert.equal(audioHeader(fixture("tone.m4a"))?.contentType, "audio/mp4");
});

test("audio whose length cannot be read, and bytes that are not audio transcription takes, are told apart", () => {
  const ogg = fixture("tone.ogg");
  assert.deepEqual(audioHeader(ogg.subarray(0, ogg.length - 5)), { format: "ogg", contentType: "audio/ogg" }, "an Ogg stream cut short has no length");
  assert.equal(audioHeader(Buffer.from("FORM\0\0\0\x10AIFFCOMM")), undefined, "AIFF is not taken");
  assert.equal(audioHeader(Buffer.from("%PDF-1.7 not audio")), undefined);
  assert.equal(audioHeader(Buffer.alloc(0)), undefined);
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.alloc(12)]);
  assert.deepEqual(audioHeader(heic), { format: "mp4", contentType: "audio/mp4" }, "an MP4-family file without a movie header has no length");
  // Bounds: every truncation of every fixture parses without throwing.
  for (const name of ["tone.ogg", "tone.webm", "tone.flac", "tone.m4a", "tone.mp3", "tone.wav"]) {
    const bytes = fixture(name);
    for (let cut = 0; cut < bytes.length; cut += 97) audioHeader(bytes.subarray(0, cut));
  }
});

test("audio is checked before it is sent: its size, format and length", () => {
  assert.equal(checkedAudio(fixture("hello.ogg")).format, "ogg");
  assert.throws(() => checkedAudio(new Uint8Array(25_000_001)), (error: any) => error.status === 413 && error.code === "AUDIO_TOO_LARGE");
  assert.throws(() => checkedAudio(Buffer.from("not audio at all")), (error: any) => error.status === 415 && /ogg, webm, wav, flac, mp4, mp3/.test(error.message));
  const ogg = fixture("tone.ogg");
  assert.throws(() => checkedAudio(ogg.subarray(0, ogg.length - 5)), (error: any) => error.status === 415 && /does not say how long/.test(error.message));
  assert.throws(() => checkedAudio(wav(1_801, 1)), (error: any) => error.status === 413 && error.code === "AUDIO_TOO_LONG");
  assert.equal(checkedAudio(wav(1_799, 1)).seconds, 1_799);
});

test("files sniffed as audio are audio; a transcribed file reads to the model as its transcript", () => {
  assert.equal(sniffContentType(fixture("tone.ogg"), "voice"), "audio/ogg");
  assert.equal(sniffContentType(fixture("tone.flac"), "x"), "audio/flac");
  assert.equal(sniffContentType(wav(1), "x"), "audio/wav");
  assert.equal(sniffContentType(Buffer.alloc(4), "note.m4a"), "audio/mp4");
  const ref: FileRef = { type: "file", path: "/workspace/uploads/r1/voice.ogg", volume: "v", version: 1, size: 12_538, contentType: "audio/ogg", chunks: [] };
  assert.equal(describeFile({ ...ref, transcript: { text: "Hello there.", language: "en", seconds: 65, model: "gpt-transcribe" } }),
    "[Audio /workspace/uploads/r1/voice.ogg (audio/ogg, 1:05, en), transcript:\nHello there.\n]");
  assert.match(describeFile({ ...ref, transcript: { text: "", seconds: 3, model: "gpt-transcribe" } }), /0:03\), transcript:\n\(no speech\)/);
  assert.equal(describeFile({ ...ref, untranscribed: "no OpenAI key" }), "[File /workspace/uploads/r1/voice.ogg (audio/ogg, 13 KB): not transcribed (no OpenAI key)]");
});

/** OpenAI's transcription endpoint, as far as the runtime uses it, recording each request's form. */
async function fakeOpenAI(t: Parameters<typeof listen>[0], answer: (form: FormData) => { status?: number; body: unknown }) {
  const requests: { authorization?: string; form: FormData }[] = [];
  const base = await listen(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const form = await new Request("http://x", { method: "POST", headers: { "Content-Type": req.headers["content-type"]! }, body: Buffer.concat(chunks) }).formData();
    requests.push({ authorization: req.headers.authorization, form });
    const { status = 200, body } = answer(form);
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
  return { base, requests };
}

test("OpenAI's provider sends the audio named by its format, on the key given, and reads the transcript and billed seconds", async t => {
  const openai = await fakeOpenAI(t, form => form.get("language") === "xx" ? { status: 400, body: { error: { message: "Invalid language 'xx'" } } }
    : form.get("prompt") === "denied" ? { status: 401, body: { error: { message: "bad key" } } }
    : { body: { text: "Hello from camelRun.", languages: [{ code: "en" }], usage: { type: "duration", seconds: 5 } } });
  const provider = openaiTranscription({ outbound: new Outbound({ allowHttp: true, allow: ["127.0.0.1/32"] }), baseUrl: openai.base });
  const audio = { bytes: fixture("hello.ogg"), header: checkedAudio(fixture("hello.ogg")) };
  const signal = new AbortController().signal;
  assert.deepEqual(await provider.transcribe(audio, { language: "en" }, { apiKey: "sk-test" }, signal), { text: "Hello from camelRun.", language: "en", seconds: 5, model: "gpt-transcribe" });
  const sent = openai.requests[0];
  assert.equal(sent.authorization, "Bearer sk-test");
  assert.equal(sent.form.get("model"), "gpt-transcribe");
  assert.equal(sent.form.get("language"), "en");
  assert.equal((sent.form.get("file") as File).name, "audio.ogg", "OpenAI reads the format from the name");
  assert.equal((sent.form.get("file") as File).size, audio.bytes.length);

  assert.equal(sent.form.get("response_format"), null, "plain json, the one format gpt-transcribe answers in");

  await assert.rejects(provider.transcribe(audio, { language: "xx" }, { apiKey: "sk-test" }, signal), (error: any) => error.status === 400 && /Invalid language 'xx'/.test(error.message));
  await assert.rejects(provider.transcribe(audio, { prompt: "denied" }, { apiKey: "sk-bad" }, signal), (error: any) => error.status === 502 && error.code === "TRANSCRIPTION_FAILED" && /rejected the API key/.test(error.message) && !error.message.includes("sk-bad"));
  // A key scope's own address wins.
  const other = await fakeOpenAI(t, () => ({ body: { text: "via gateway", usage: { type: "duration", seconds: 2 } } }));
  assert.equal((await provider.transcribe(audio, {}, { apiKey: "sk-scope", baseUrl: other.base, headers: { "x-gateway": "1" } }, signal)).text, "via gateway");
});

test("a transcription is priced per second of audio, refused when its estimate passes the budget, and needs a key", async () => {
  const seen: { tenant: string; keyScope?: string }[] = [];
  const provider: TranscriptionProvider = {
    id: "openai", model: "gpt-transcribe",
    transcribe: async () => ({ text: "hi", seconds: 61, model: "gpt-transcribe" }),
  };
  const transcriber = new Transcriber({
    provider, price: () => DEFAULT_PRICING.transcription,
    key: async (tenant, keyScope) => { seen.push({ tenant, ...(keyScope ? { keyScope } : {}) }); return tenant === "nokey" ? undefined : { apiKey: "k", platform: tenant === "payg" }; },
  });
  const audio = { bytes: fixture("tone.ogg"), header: checkedAudio(fixture("tone.ogg")) };
  const signal = new AbortController().signal;
  const done = await transcriber.transcribe({ tenant: "payg", keyScope: "org_1" }, audio, {}, signal);
  assert.deepEqual(done.usage, { provider: "openai", model: "gpt-transcribe", usage: { cost: { total: 61 * micros(0.0045) / 60 / 1e6 } }, platform: true, kind: "transcription", transcriptions: 1, audioSeconds: 61, timestamp: done.usage.timestamp });
  assert.deepEqual(seen.at(-1), { tenant: "payg", keyScope: "org_1" });
  assert.equal((await transcriber.transcribe({ tenant: "own" }, audio, {}, signal)).usage.platform, false, "on the tenant's own key");
  assert.equal(transcriber.cost(1.2), 2 * micros(0.0045) / 60 / 1e6, "whole seconds, as OpenAI bills");
  await assert.rejects(transcriber.transcribe({ tenant: "payg", budget: 0.0001 }, audio, {}, signal), (error: any) => error.status === 402 && error.code === "SPEND_LIMIT");
  await assert.rejects(transcriber.transcribe({ tenant: "nokey" }, audio, {}, signal), (error: any) => error.status === 400 && /PUT \/v1\/providers\/openai\/key/.test(error.message));
});

test("the transcription price is the runtime's, per minute, set by the operator", () => {
  assert.equal(DEFAULT_PRICING.transcription, micros(0.0045));
  assert.equal(pricingFromEnvironment({ AGENT_PRICE_TRANSCRIPTION_USD: "0.01" }).transcription, micros(0.01));
  assert.throws(() => pricingFromEnvironment({ AGENT_PRICE_TRANSCRIPTION_USD: "-1" }));
});

test("a transcription's usage.recorded event says so: its seconds, no tokens, and no agent when none made it", () => {
  const usage = { provider: "openai", model: "gpt-transcribe", usage: { cost: { total: 0.0045 } }, platform: true, kind: "transcription" as const, transcriptions: 1, audioSeconds: 60, timestamp: 1 };
  const alone = usageEvent("acme", "", { ...usage, identity: { subject: "user_1", context: { org: "o1" } }, actor: "user_2" })!;
  assert.deepEqual(alone.data, {
    agentId: null, requestId: null, subject: "user_1", actor: "user_2", context: { org: "o1" }, keyScope: null, provider: "openai", model: "gpt-transcribe", kind: "transcription",
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, audioSeconds: 60, cost: { usd: 0.0045, source: "catalog" }, at: 1,
  });
  assert.equal(alone.legacy, undefined, "the older usage webhook carries model responses only");
  const inRun = usageEvent("acme", "agent_1", { ...usage, requestId: "r1", keyScope: "org_1" })!;
  assert.deepEqual([inRun.data.agentId, inRun.data.subject, inRun.data.requestId, inRun.data.keyScope], ["agent_1", "agent_1", "r1", "org_1"]);
});
