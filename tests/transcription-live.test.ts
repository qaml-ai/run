import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkedAudio, openaiTranscription } from "../src/transcription.ts";
import { Outbound } from "../src/outbound.ts";

// One real transcription of the committed voice note (4 s of macOS `say`, Ogg Opus as Discord sends): about $0.0004.
// Runs only with OPENAI_API_KEY set.
const key = process.env.OPENAI_API_KEY;

test("OpenAI transcribes a voice note (Ogg Opus) with gpt-transcribe", { skip: !key && "OPENAI_API_KEY is not set" }, async () => {
  const bytes = readFileSync(new URL("./fixtures/audio/hello.ogg", import.meta.url));
  const provider = openaiTranscription({ outbound: new Outbound() });
  const audio = { bytes, header: checkedAudio(bytes) };
  const signal = AbortSignal.timeout(60_000);
  const plain = await provider.transcribe(audio, {}, { apiKey: key! }, signal);
  assert.match(plain.text, /hello from camel ?run.*short test of speech[ -]to[ -]text/i);
  assert.equal(plain.model, "gpt-transcribe");
  assert.equal(plain.language, "en");
  assert.ok(plain.seconds >= 4 && plain.seconds <= 6, `billed ${plain.seconds} s`);
});

// Speech made by OpenAI (gpt-4o-mini-tts, 24 kHz PCM) streamed to its Realtime transcription as a voice session does,
// 20 ms at a time in real time, then committed: about $0.002.
for (const model of ["gpt-live-transcribe", "gpt-realtime-whisper"]) {
  test(`OpenAI's Realtime transcription (${model}) transcribes speech streamed to it, soon after the commit`, { skip: !key && "OPENAI_API_KEY is not set" }, async () => {
    const { openaiSpeech } = await import("../src/speech.ts");
    const { openaiLiveTranscription } = await import("../src/transcription-live.ts");
    const chunks: Buffer[] = [];
    for await (const chunk of openaiSpeech({ outbound: new Outbound() }).stream({ text: "The quick brown fox jumps over the lazy dog.", voice: "alloy" }, { apiKey: key! }, AbortSignal.timeout(60_000))) chunks.push(Buffer.from(chunk));
    const pcm = Buffer.concat(chunks);
    const stream = openaiLiveTranscription({ model }).connect({ apiKey: key! }, { language: "en" })!;
    for (let at = 0; at < pcm.length; at += 960) {
      stream.append(pcm.subarray(at, at + 960));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const committed = Date.now();
    const transcript = await stream.commit();
    const ms = Date.now() - committed;
    stream.close();
    console.log(JSON.stringify({ model, ms, seconds: transcript.seconds, text: transcript.text }));
    assert.match(transcript.text.toLowerCase(), /quick brown fox/);
    assert.ok(ms < 3_000, `the transcript came ${ms} ms after the commit`);
  });
}
