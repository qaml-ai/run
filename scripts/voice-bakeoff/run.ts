import { Outbound } from "../../src/outbound.ts";
import { DEFAULT_PRICING, MICROS } from "../../src/pricing.ts";
import { openaiSpeech, type SpeechProvider } from "../../src/speech.ts";
import { checkedAudio, openaiTranscription, TRANSCRIPTION_MODEL } from "../../src/transcription.ts";
import type { LiveTranscriptionProvider, SttEvent } from "../../src/transcription-live.ts";
import { speechPrices, sttCost, ttsCost, type SpeechPrices } from "../../src/voice-providers/prices.ts";
import { liveProvider, sttReference, type SttEndpoints } from "../../src/voice-providers/stt.ts";
import { DEFAULT_VOICES, speechProvider, ttsReference, type TtsEndpoints } from "../../src/voice-providers/tts.ts";
import { BYTES_PER_MS, wavFile, type Clip } from "./clips.ts";
import { errorRate, percentile } from "./metrics.ts";

/**
 * The bake-off itself: every clip through every speech-to-text provider, every prompt through every text-to-speech
 * provider, as a voice session would use them (the same adapters, src/voice-providers/), measuring latency where a
 * caller feels it, accuracy and cost.
 *
 * Speech to text streams each clip in real time (20 ms frames, as a call sends them). At the end of speech it commits
 * at once, the best case of an external turn detector, and `finalMs` is from the end of speech to the final transcript.
 * A provider that detects turns itself (Flux) is not committed: it hears silence until it says the turn ended, so its
 * `finalMs` includes deciding that. `endToEndMs` adds `silenceMs` (the session's silence cut, 800 ms by default) to the
 * others, the honest comparison with Flux. The batch baseline (`openai-batch`, what sessions do without live
 * transcription) uploads the clip after its speech ends.
 *
 * Text to speech: time to the first audio byte (cold: a fresh connection; warm: after `warm()`), the whole time, the
 * audio's length and cost; with OpenAI's key, the audio is transcribed back (gpt-transcribe) for an intelligibility WER.
 */

/** The env var each provider's key comes from. */
export const KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY", "openai-batch": "OPENAI_API_KEY", deepgram: "DEEPGRAM_API_KEY", soniox: "SONIOX_API_KEY",
  assemblyai: "ASSEMBLYAI_API_KEY", elevenlabs: "ELEVENLABS_API_KEY", cartesia: "CARTESIA_API_KEY",
};

export const DEFAULT_STT = ["deepgram/nova-3", "deepgram/flux-general-en", "soniox/stt-rt-v3", "assemblyai/universal-streaming-english", "assemblyai/universal-streaming-multilingual", "openai/gpt-live-transcribe", "openai-batch/gpt-transcribe"];
export const DEFAULT_TTS = ["elevenlabs/eleven_flash_v2_5", "cartesia/sonic-3", "deepgram/aura-2", "openai/gpt-4o-mini-tts"];

/** What the text-to-speech bench says: short to long, numbers, a non-English line. */
export const PROMPTS: { id: string; text: string; language: string }[] = [
  { id: "ack", text: "Sure, one moment.", language: "en" },
  { id: "sentence", text: "I booked a table for four at seven thirty tomorrow night.", language: "en" },
  { id: "numbers", text: "Your order number is 4815162342, and the total is $37.50.", language: "en" },
  { id: "long", text: "Here is the plan for the quarter: we finish the voice work first, because people already use it every day, and then we look at the billing dashboard that so many customers asked for.", language: "en" },
  { id: "es", text: "Claro, te recuerdo mañana a las cinco de la tarde.", language: "es" },
];

export type BakeoffOptions = {
  stt: string[]; tts: string[];
  /** Each provider's key, by provider id; one without is skipped (and said so). */
  keys: Record<string, string | undefined>;
  /** Voices for text to speech, by provider (Cartesia has no default). */
  voices?: Record<string, string>;
  repeat?: number; silenceMs?: number;
  /** 1 is real time; more is faster than a call would send (dry runs). */
  pace?: number;
  keyterms?: string[];
  stt_endpoints?: SttEndpoints; tts_endpoints?: TtsEndpoints & { openaiBatch?: string };
  outbound?: Outbound; prices?: SpeechPrices;
  log?: (line: string) => void;
  /** Called before each clip is run (a dry run's fakes answer with its words). */
  onClip?: (clip: Clip) => void;
  /** Called before each text-to-speech prompt is run. */
  onPrompt?: (prompt: { text: string }) => void;
};

export type SttSample = { provider: string; clip: string; category: string; language: string; finalMs?: number; endToEndMs?: number; firstPartialMs?: number; text?: string; wer?: number; errors?: number; tokens?: number; error?: string; skipped?: string };
export type TtsSample = { provider: string; prompt: string; warm: boolean; ttfbMs?: number; totalMs?: number; audioSeconds?: number; costUsd?: number; roundTripWer?: number; error?: string };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const FRAME_MS = 20;

/** One clip through one streaming provider. */
async function liveOnce(provider: LiveTranscriptionProvider, apiKey: string, clip: Clip, options: BakeoffOptions): Promise<Omit<SttSample, "provider" | "clip" | "category" | "language">> {
  const pace = options.pace ?? 1;
  let speechStartAt = 0, firstPartialAt: number | undefined, endOfTurn: (() => void) | undefined;
  const ended = new Promise<void>(resolve => { endOfTurn = resolve; });
  const onEvent = (event: SttEvent) => {
    if (event.type === "partial" && firstPartialAt === undefined && speechStartAt && event.text) firstPartialAt = performance.now();
    if (event.type === "end_of_turn") endOfTurn?.();
  };
  const stream = provider.connect({ apiKey }, { language: clip.language, ...(options.keyterms ? { keyterms: options.keyterms } : {}), onEvent });
  if (!stream) return { skipped: `does not stream ${clip.language}` };
  const frame = FRAME_MS * BYTES_PER_MS;
  const speechEndFrame = Math.ceil(clip.speechEndMs / FRAME_MS);
  const started = performance.now();
  const at = (index: number) => started + index * FRAME_MS / pace;
  let index = 0, speechEndAt = 0, pumping = true;
  try {
    for (; index < speechEndFrame && index * frame < clip.pcm.length; index++) {
      await sleep(at(index) - performance.now());
      if (index === Math.floor(clip.speechStartMs / FRAME_MS)) speechStartAt = performance.now();
      stream.append(clip.pcm.subarray(index * frame, (index + 1) * frame));
    }
    speechEndAt = performance.now();
    // The rest of the clip, then silence, in real time while the transcript is awaited: as a call goes on.
    const pump = (async () => {
      for (let n = index; pumping && n < index + 10_000 / FRAME_MS; n++) {
        await sleep(at(n) - performance.now());
        if (!pumping) return;
        const chunk = n * frame < clip.pcm.length ? clip.pcm.subarray(n * frame, (n + 1) * frame) : Buffer.alloc(frame);
        stream.append(chunk.length === frame ? chunk : Buffer.concat([chunk, Buffer.alloc(frame - chunk.length)]));
      }
    })();
    if (provider.turnDetection) await Promise.race([ended, sleep(6_000 / pace)]);
    const transcript = await stream.commit();
    const doneAt = performance.now();
    pumping = false;
    await pump;
    const score = errorRate(clip.text, transcript.text, clip.language);
    const finalMs = Math.round((doneAt - speechEndAt) * pace);
    return {
      finalMs, endToEndMs: provider.turnDetection ? finalMs : finalMs + (options.silenceMs ?? 800),
      ...(firstPartialAt !== undefined ? { firstPartialMs: Math.round((firstPartialAt - speechStartAt) * pace) } : {}),
      text: transcript.text, wer: score.rate, errors: score.errors, tokens: score.tokens,
    };
  } finally {
    pumping = false;
    stream.close();
  }
}

/** One clip through batch transcription (the baseline): uploaded once its speech has ended. */
async function batchOnce(apiKey: string, clip: Clip, options: BakeoffOptions) {
  const pace = options.pace ?? 1;
  const outbound = options.outbound ?? new Outbound();
  const provider = openaiTranscription({ outbound, ...(options.tts_endpoints?.openaiBatch ? { baseUrl: options.tts_endpoints.openaiBatch } : {}) });
  // The clip plays out to the end of its speech first, as it would be spoken.
  await sleep(clip.speechEndMs / pace);
  const bytes = wavFile(clip.pcm.subarray(0, Math.min(clip.pcm.length, Math.ceil((clip.speechEndMs + 200) * BYTES_PER_MS) & ~1)));
  const started = performance.now();
  const transcript = await provider.transcribe({ bytes, header: checkedAudio(bytes) }, { language: clip.language.slice(0, 2) }, { apiKey }, AbortSignal.timeout(60_000));
  const finalMs = Math.round(performance.now() - started);
  const score = errorRate(clip.text, transcript.text, clip.language);
  return { finalMs, endToEndMs: finalMs + (options.silenceMs ?? 800), text: transcript.text, wer: score.rate, errors: score.errors, tokens: score.tokens };
}

/** Every clip through every provider named (`options.stt`), `repeat` times; providers run side by side per clip. */
export async function runStt(clips: Clip[], options: BakeoffOptions): Promise<SttSample[]> {
  const samples: SttSample[] = [];
  const log = options.log ?? (() => {});
  const runnable = options.stt.flatMap(given => {
    const batch = given.startsWith("openai-batch");
    const reference = batch ? `openai-batch/${given.split("/")[1] ?? TRANSCRIPTION_MODEL}` : sttReference(given);
    const id = reference.split("/")[0];
    const apiKey = options.keys[id];
    if (!apiKey) { log(`stt ${reference}: skipped (no ${KEY_ENV[id]})`); return []; }
    return [{ reference, apiKey, batch, provider: batch ? undefined : liveProvider(reference, options.stt_endpoints ?? {}) }];
  });
  for (let round = 0; round < (options.repeat ?? 1); round++) {
    for (const clip of clips) {
      options.onClip?.(clip);
      const results = await Promise.all(runnable.map(async ({ reference, apiKey, batch, provider }) => {
        const base = { provider: reference, clip: clip.id, category: clip.category, language: clip.language };
        try { return { ...base, ...batch ? await batchOnce(apiKey, clip, options) : await liveOnce(provider!, apiKey, clip, options) }; }
        catch (error) { return { ...base, error: (error as Error).message.slice(0, 200) }; }
      }));
      for (const sample of results) {
        samples.push(sample);
        log(`stt ${sample.provider} ${clip.id}: ${sample.error ? `error ${sample.error}` : sample.skipped ? `skipped (${sample.skipped})` : `${sample.finalMs} ms, wer ${(sample.wer! * 100).toFixed(0)}% "${sample.text}"`}`);
      }
    }
  }
  return samples;
}

/** Every prompt through every text-to-speech provider named, cold once then warm `repeat` times. */
export async function runTts(options: BakeoffOptions): Promise<TtsSample[]> {
  const outbound = options.outbound ?? new Outbound();
  const prices = options.prices ?? speechPrices();
  const log = options.log ?? (() => {});
  const samples: TtsSample[] = [];
  const checker = options.keys.openai ? openaiTranscription({ outbound, ...(options.tts_endpoints?.openaiBatch ? { baseUrl: options.tts_endpoints.openaiBatch } : {}) }) : undefined;
  for (const given of options.tts) {
    const reference = ttsReference(given);
    const id = reference.split("/")[0];
    const apiKey = options.keys[id];
    if (!apiKey) { log(`tts ${reference}: skipped (no ${KEY_ENV[id]})`); continue; }
    const voice = options.voices?.[id] ?? DEFAULT_VOICES[id] ?? "";
    if (!voice) { log(`tts ${reference}: skipped (no voice: set ${id.toUpperCase()}_VOICE_ID)`); continue; }
    const provider: SpeechProvider = id === "openai" ? openaiSpeech({ outbound, ...(options.tts_endpoints?.openai ? { baseUrl: options.tts_endpoints.openai } : {}) }) : speechProvider(reference, outbound, options.tts_endpoints ?? {});
    for (let round = 0; round <= (options.repeat ?? 1); round++) {
      const warm = round > 0;
      if (warm) await provider.warm?.().catch(() => {});
      for (const prompt of PROMPTS) {
        options.onPrompt?.(prompt);
        const sample: TtsSample = { provider: reference, prompt: prompt.id, warm };
        try {
          const started = performance.now();
          let first: number | undefined;
          const chunks: Buffer[] = [];
          for await (const chunk of provider.stream({ text: prompt.text, voice, language: prompt.language }, { apiKey }, AbortSignal.timeout(60_000))) {
            if (first === undefined && chunk.byteLength) first = performance.now();
            chunks.push(Buffer.from(chunk));
          }
          const pcm = Buffer.concat(chunks);
          sample.ttfbMs = first === undefined ? undefined : Math.round(first - started);
          sample.totalMs = Math.round(performance.now() - started);
          sample.audioSeconds = Math.round(pcm.length / (BYTES_PER_MS * 1000) * 100) / 100;
          sample.costUsd = reference.startsWith("openai/") ? Math.ceil(sample.audioSeconds) * DEFAULT_PRICING.speech / 60 / MICROS : ttsCost(prices, reference, { characters: prompt.text.length, seconds: sample.audioSeconds });
          // Round trip on the first warm pass: is the speech what it was asked to say?
          if (checker && round === 1 && pcm.length > 4_800) {
            const bytes = wavFile(pcm.subarray(0, pcm.length & ~1));
            const heard = await checker.transcribe({ bytes, header: checkedAudio(bytes) }, { language: prompt.language }, { apiKey: options.keys.openai! }, AbortSignal.timeout(60_000));
            sample.roundTripWer = errorRate(prompt.text, heard.text, prompt.language).rate;
          }
        } catch (error) { sample.error = (error as Error).message.slice(0, 200); }
        samples.push(sample);
        log(`tts ${reference} ${prompt.id}${warm ? "" : " (cold)"}: ${sample.error ? `error ${sample.error}` : `first audio ${sample.ttfbMs} ms, ${sample.audioSeconds} s`}`);
      }
    }
  }
  return samples;
}

/** STT samples by provider: latency percentiles, WER overall and by category, failures, list price per minute. */
export function sttSummary(samples: SttSample[], prices: SpeechPrices = speechPrices()) {
  const byProvider = Map.groupBy(samples, sample => sample.provider);
  return [...byProvider].map(([provider, rows]) => {
    const ok = rows.filter(row => row.finalMs !== undefined);
    const words = (subset: SttSample[]) => { const tokens = subset.reduce((sum, row) => sum + (row.tokens ?? 0), 0); return tokens ? subset.reduce((sum, row) => sum + (row.errors ?? 0), 0) / tokens : undefined; };
    const categories = Object.fromEntries([...Map.groupBy(ok, row => row.category)].map(([category, subset]) => [category, words(subset)]));
    const perMinute = provider.startsWith("openai-batch/") ? DEFAULT_PRICING.transcription / MICROS : provider.startsWith("openai/") ? DEFAULT_PRICING.liveTranscription / MICROS : sttCost(prices, provider, 60);
    return {
      provider, samples: rows.length, failures: rows.filter(row => row.error).length, skipped: rows.filter(row => row.skipped).length,
      finalP50: percentile(ok.map(row => row.finalMs!), 50), finalP95: percentile(ok.map(row => row.finalMs!), 95),
      endToEndP50: percentile(ok.map(row => row.endToEndMs!), 50), endToEndP95: percentile(ok.map(row => row.endToEndMs!), 95),
      firstPartialP50: percentile(ok.flatMap(row => row.firstPartialMs === undefined ? [] : [row.firstPartialMs]), 50),
      wer: words(ok), werEnglish: words(ok.filter(row => row.language.startsWith("en"))), werOther: words(ok.filter(row => !row.language.startsWith("en"))),
      categories, usdPerMinute: perMinute,
    };
  });
}

/** TTS samples by provider: first audio cold and warm (p50/p95), real-time factor, cost per minute of speech, round trip. */
export function ttsSummary(samples: TtsSample[]) {
  return [...Map.groupBy(samples, sample => sample.provider)].map(([provider, rows]) => {
    const ok = rows.filter(row => row.ttfbMs !== undefined);
    const warm = ok.filter(row => row.warm), cold = ok.filter(row => !row.warm);
    const seconds = ok.reduce((sum, row) => sum + (row.audioSeconds ?? 0), 0), usd = ok.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
    const roundTrips = ok.flatMap(row => row.roundTripWer === undefined ? [] : [row.roundTripWer]);
    return {
      provider, samples: rows.length, failures: rows.filter(row => row.error).length,
      coldP50: percentile(cold.map(row => row.ttfbMs!), 50), warmP50: percentile(warm.map(row => row.ttfbMs!), 50), warmP95: percentile(warm.map(row => row.ttfbMs!), 95),
      realTimeFactor: seconds ? ok.reduce((sum, row) => sum + (row.totalMs ?? 0), 0) / 1000 / seconds : undefined,
      usdPerMinute: seconds ? usd / seconds * 60 : undefined,
      roundTripWer: roundTrips.length ? roundTrips.reduce((a, b) => a + b, 0) / roundTrips.length : undefined,
    };
  });
}

const ms = (value: number | undefined) => value === undefined ? "–" : `${Math.round(value)}`;
const pct = (value: number | undefined) => value === undefined ? "–" : `${(value * 100).toFixed(1)}%`;
const usd = (value: number | undefined) => value === undefined ? "–" : `$${value.toFixed(4)}`;

/** The summaries as Markdown tables. */
export function markdown(stt: ReturnType<typeof sttSummary>, tts: ReturnType<typeof ttsSummary>, meta: { source: string; clips: number; repeat: number; silenceMs: number; date: string }) {
  const lines = [
    `# Voice bake-off (${meta.date})`, "",
    `Clips: ${meta.clips} (${meta.source}${meta.source === "synthetic" ? ": made with text to speech, cleaner than people; see scripts/voice-bakeoff/clips.ts" : ""}), ${meta.repeat} round(s). Latency in ms; end to end adds the ${meta.silenceMs} ms silence cut to providers that do not detect turns themselves.`, "",
    "## Speech to text", "",
    "| Provider | final p50 | final p95 | end to end p50 | end to end p95 | first partial p50 | WER | WER en | WER other | failures | $/min |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...stt.map(row => `| ${row.provider} | ${ms(row.finalP50)} | ${ms(row.finalP95)} | ${ms(row.endToEndP50)} | ${ms(row.endToEndP95)} | ${ms(row.firstPartialP50)} | ${pct(row.wer)} | ${pct(row.werEnglish)} | ${pct(row.werOther)} | ${row.failures}/${row.samples}${row.skipped ? ` (${row.skipped} skipped)` : ""} | ${usd(row.usdPerMinute)} |`),
    "", "WER by category:", "",
    `| Provider | ${[...new Set(stt.flatMap(row => Object.keys(row.categories)))].join(" | ")} |`,
    `| --- |${[...new Set(stt.flatMap(row => Object.keys(row.categories)))].map(() => " --- |").join("")}`,
    ...stt.map(row => `| ${row.provider} | ${[...new Set(stt.flatMap(each => Object.keys(each.categories)))].map(category => pct(row.categories[category])).join(" | ")} |`),
    "", "## Text to speech", "",
    "| Provider | first audio cold p50 | first audio warm p50 | warm p95 | real-time factor | $/min of speech | round-trip WER | failures |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...tts.map(row => `| ${row.provider} | ${ms(row.coldP50)} | ${ms(row.warmP50)} | ${ms(row.warmP95)} | ${row.realTimeFactor === undefined ? "–" : row.realTimeFactor.toFixed(2)} | ${usd(row.usdPerMinute)} | ${pct(row.roundTripWer)} | ${row.failures}/${row.samples} |`),
    "",
  ];
  return lines.join("\n");
}
