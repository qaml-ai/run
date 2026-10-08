import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkedAudio, openaiTranscription } from "../src/transcription.ts";
import { Outbound } from "../src/outbound.ts";

// One real transcription of the committed voice note (4 s of macOS `say`, Ogg Opus as Discord sends): about $0.0004.
// Runs only with OPENAI_API_KEY set.
const key = process.env.OPENAI_API_KEY;

test("OpenAI transcribes a voice note (Ogg Opus) with gpt-transcribe, and gives timestamps with whisper-1", { skip: !key && "OPENAI_API_KEY is not set" }, async () => {
  const bytes = readFileSync(new URL("./fixtures/audio/hello.ogg", import.meta.url));
  const provider = openaiTranscription({ outbound: new Outbound() });
  const audio = { bytes, header: checkedAudio(bytes) };
  const signal = AbortSignal.timeout(60_000);
  const plain = await provider.transcribe(audio, {}, { apiKey: key! }, signal);
  assert.match(plain.text, /hello from camel ?run.*short test of speech[ -]to[ -]text/i);
  assert.equal(plain.model, "gpt-transcribe");
  assert.equal(plain.language, "en");
  assert.ok(plain.seconds >= 4 && plain.seconds <= 6, `billed ${plain.seconds} s`);
  const timed = await provider.transcribe(audio, { timestamps: true, language: "en" }, { apiKey: key! }, signal);
  assert.equal(timed.model, "whisper-1");
  assert.ok(timed.segments?.length && timed.segments[0].end > timed.segments[0].start);
});
