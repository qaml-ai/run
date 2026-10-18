import { test } from "node:test";
import assert from "node:assert/strict";
import { bakeoff } from "../scripts/voice-bakeoff.ts";
import { addNoise, CLIPS, mix, speechBounds, wavFile, wavPcm } from "../scripts/voice-bakeoff/clips.ts";
import { errorRate, normalize, numberWords, percentile } from "../scripts/voice-bakeoff/metrics.ts";

test("bake-off dry run: every provider's fake, through the real adapters, into one report", async () => {
  const lines: string[] = [];
  const { report, md } = await bakeoff(["--dry-run", "--only", "short-yes,noise-cafe,es,ja", "--pace", "10"], {}, line => lines.push(line));
  assert.equal(report.source, "fake");
  assert.equal(report.clips, 4);
  assert.deepEqual(report.stt.map(row => row.provider), ["deepgram/nova-3", "deepgram/flux-general-en", "soniox/stt-rt-v3", "assemblyai/universal-streaming-english", "assemblyai/universal-streaming-multilingual", "openai/gpt-live-transcribe", "openai-batch/gpt-transcribe"]);
  for (const row of report.stt) {
    assert.equal(row.failures, 0, `${row.provider}: ${lines.filter(line => line.includes(row.provider) && line.includes("error")).join("; ")}`);
    assert.equal(row.wer, 0, `${row.provider} heard its clips' words`);
    assert.ok(row.finalP50 !== undefined && row.endToEndP50! >= row.finalP50!);
  }
  const flux = report.stt.find(row => row.provider === "deepgram/flux-general-en")!;
  assert.equal(flux.skipped, 2, "Flux hears English only: es and ja are skipped, not failed");
  assert.equal(flux.endToEndP50, flux.finalP50, "Flux's own turn detection: no silence cut added");
  assert.deepEqual(report.tts.map(row => row.provider), ["elevenlabs/eleven_flash_v2_5", "cartesia/sonic-3", "deepgram/aura-2", "openai/gpt-4o-mini-tts"]);
  for (const row of report.tts) {
    assert.equal(row.failures, 0, row.provider);
    assert.ok(row.warmP50 !== undefined && row.coldP50 !== undefined);
    assert.equal(row.roundTripWer, 0, `${row.provider}: transcribed back as said`);
  }
  assert.match(md, /## Speech to text/);
  assert.match(md, /\| deepgram\/flux-general-en \|/);
  assert.match(md, /## Text to speech/);
});

test("bake-off without keys: every provider is skipped and says which variable it needs", async () => {
  const lines: string[] = [];
  const { report } = await bakeoff(["--stt", "none", "--tts", "elevenlabs,cartesia"], {}, line => lines.push(line));
  assert.deepEqual(report.tts, []);
  assert.ok(lines.includes("tts elevenlabs/eleven_flash_v2_5: skipped (no ELEVENLABS_API_KEY)"));
  assert.ok(lines.includes("tts cartesia/sonic-3: skipped (no CARTESIA_API_KEY)"));
  await assert.rejects(bakeoff(["--stt", "deepgram", "--tts", "none"], {}, () => {}), /set OPENAI_API_KEY, or pass --clips/);
});

test("scoring: normalization, numbers as words, fillers, CER for Japanese, percentiles", () => {
  assert.deepEqual(normalize("Book a table for 4 at 7:30, okay?"), ["book", "a", "table", "for", "four", "at", "seven", "thirty", "okay"]);
  assert.deepEqual(numberWords("4815162342"), ["four", "eight", "one", "five", "one", "six", "two", "three", "four", "two"]);
  assert.deepEqual(numberWords("1984"), ["nineteen", "eighty", "four"]);
  assert.deepEqual(numberWords("2026"), ["twenty", "twenty", "six"]);
  assert.deepEqual(numberWords("37"), ["thirty", "seven"]);
  assert.equal(errorRate("Um, so, I was, uh, thinking", "so I was thinking").rate, 0, "fillers left out on both sides");
  assert.equal(errorRate("the cat sat", "the hat sat").rate, 1 / 3);
  assert.equal(errorRate("¿Puedes llamar a mi madre?", "puedes llamar a mi madre", "es").rate, 0);
  const ja = errorRate("明日の午後三時", "明日の午後3時", "ja");
  assert.equal(ja.unit, "char");
  assert.equal(ja.errors, 1);
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
  assert.equal(percentile([], 50), undefined);
});

test("clips: the manifest is varied; speech bounds, mixing, noise and WAV round trips", () => {
  const categories = new Set(CLIPS.map(clip => clip.category));
  for (const category of ["short", "accent", "noise", "overlap", "non-english", "code-switch", "long"]) assert.ok(categories.has(category as never), category);
  assert.equal(new Set(CLIPS.map(clip => clip.id)).size, CLIPS.length);
  const tone = Buffer.alloc(24_000 * 2);
  for (let i = 0; i < tone.length; i += 2) tone.writeInt16LE(Math.round(8000 * Math.sin(i / 20)), i);
  const clip = Buffer.concat([Buffer.alloc(9_600), tone, Buffer.alloc(9_600)]);
  assert.deepEqual(speechBounds(clip), { speechStartMs: 200, speechEndMs: 1200 });
  assert.equal(mix(Buffer.alloc(4), Buffer.alloc(8, 1), 2).length, 10);
  const noisy = addNoise(clip, "white", 10);
  assert.equal(noisy.length, clip.length);
  assert.notDeepEqual(noisy, clip);
  const back = wavPcm(wavFile(clip));
  assert.deepEqual([back.rate, back.channels, back.pcm.length], [24_000, 1, clip.length]);
});
