// How speech providers stream, and what the playback start rule (src/voice-audio.ts, `buffered`) makes of it: each
// provider is asked for a few sentences as a voice session asks (24 kHz mono PCM, streamed), every chunk's arrival is
// timed, and each timeline is replayed through `buffered` under the current rule and some variants, with a player that
// takes a 20 ms packet each 20 ms. Reported per provider and rule: from the first audio to the first packet out (what
// voice_turn_latency's ttsFirstAudio → firstPacket measures) and the silence heard after the start (underruns).
//
//   OPENAI_API_KEY=… ELEVENLABS_API_KEY=… [ELEVENLABS_VOICE=…] [CARTESIA_API_KEY=… CARTESIA_VOICE=…] \
//     node --experimental-strip-types scripts/voice-tts-trace.ts [--repeat 3] [--out timelines.json]
//   node --experimental-strip-types scripts/voice-tts-trace.ts --replay timelines.json     (no keys: replays a saved run)
//
// Nothing but timings and sizes is printed or saved (no audio, no keys).
import { readFileSync, writeFileSync } from "node:fs";
import { Outbound } from "../src/outbound.ts";
import { openaiSpeech, SPEECH_RATE, type SpeechProvider } from "../src/speech.ts";
import { cartesiaSpeech, elevenlabsSpeech } from "../src/voice-providers/tts.ts";
import { buffered, PLAYBACK_BUFFER } from "../src/voice-audio.ts";

type Timeline = { provider: string; text: string; ttfbMs: number; chunks: [atMs: number, bytes: number][] };

const SENTENCES = [
  "Sure, I can help with that.",
  "The meeting moved to Thursday at three, so you have a bit more time.",
  "Here is what I found: the build failed on the linter, and the tests never ran.",
  "Okay.",
  "Let me think about that for a second, because there are a few ways to read your question.",
];

const args = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const repeat = Number(flag("--repeat") ?? 3);

async function record(): Promise<Timeline[]> {
  const outbound = new Outbound();
  const providers: { name: string; provider: SpeechProvider; key: string; voice: string }[] = [];
  if (process.env.OPENAI_API_KEY) providers.push({ name: "openai", provider: openaiSpeech({ outbound }), key: process.env.OPENAI_API_KEY, voice: "alloy" });
  if (process.env.ELEVENLABS_API_KEY) providers.push({ name: "elevenlabs", provider: elevenlabsSpeech({ outbound }), key: process.env.ELEVENLABS_API_KEY, voice: process.env.ELEVENLABS_VOICE ?? "" });
  if (process.env.CARTESIA_API_KEY && process.env.CARTESIA_VOICE) providers.push({ name: "cartesia", provider: cartesiaSpeech({ outbound }), key: process.env.CARTESIA_API_KEY, voice: process.env.CARTESIA_VOICE });
  if (!providers.length) { console.error("Set OPENAI_API_KEY and/or ELEVENLABS_API_KEY (or --replay a saved run)"); process.exit(2); }
  const timelines: Timeline[] = [];
  for (const { name, provider, key, voice } of providers) {
    await provider.warm?.().catch(() => {});
    for (let round = 0; round < repeat; round++) for (const text of SENTENCES) {
      const asked = performance.now();
      const chunks: [number, number][] = [];
      for await (const chunk of provider.stream({ text, voice }, { apiKey: key }, AbortSignal.timeout(30_000))) chunks.push([performance.now() - asked, chunk.byteLength]);
      const timeline = { provider: name, text, ttfbMs: chunks[0]?.[0] ?? 0, chunks };
      timelines.push(timeline);
      const bytes = chunks.reduce((sum, [, size]) => sum + size, 0), audioMs = bytes / 2 / SPEECH_RATE * 1000, madeMs = (chunks.at(-1)?.[0] ?? 0) - timeline.ttfbMs;
      console.log(JSON.stringify({ type: "tts_stream", provider: name, chars: text.length, ttfbMs: Math.round(timeline.ttfbMs), chunks: chunks.length,
        firstChunkBytes: chunks[0]?.[1], audioMs: Math.round(audioMs), madeMs: Math.round(madeMs), rate: madeMs ? Math.round(audioMs / madeMs * 100) / 100 : null,
        first200ms: chunks.filter(([at]) => at - timeline.ttfbMs < 200).map(([at, size]) => [Math.round(at - timeline.ttfbMs), size]) }));
    }
  }
  return timelines;
}

/** A timeline replayed as 20 ms packets at the times its bytes came, through `buffered`, played a packet each 20 ms. */
async function replay(timeline: Timeline, options: Parameters<typeof buffered>[1]) {
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const PACKET = 960;
  async function* packets() {
    const begun = performance.now();
    let pending = 0;
    for (const [at, bytes] of timeline.chunks) {
      const wait = begun + (at - timeline.ttfbMs) - performance.now();
      if (wait > 0) await sleep(wait);
      pending += bytes;
      while (pending >= PACKET) { pending -= PACKET; yield 0; }
    }
    if (pending > 0) yield 0;
  }
  const firstIn = performance.now();
  let firstOut = 0, next = 0, silentMs = 0;
  for await (const _packet of buffered(packets(), options)) {
    const now = performance.now();
    if (!firstOut) { firstOut = now; next = now; }
    if (now > next + 5) silentMs += now - next;
    next = Math.max(next, now) + 20;
    const wait = next - performance.now();
    if (wait > 0) await sleep(wait);
  }
  return { startMs: firstOut - firstIn, silentMs };
}

const estimateMs = (text: string) => Math.max(1, Math.ceil(text.length / 14)) * 1000;
const exactMs = (timeline: Timeline) => timeline.chunks.reduce((sum, [, bytes]) => sum + bytes, 0) / 2 / SPEECH_RATE * 1000;
const RULES: Record<string, (timeline: Timeline) => Parameters<typeof buffered>[1]> = {
  "unknown length (before #253)": () => ({}),
  "current (#253)": timeline => ({ expectedMs: estimateMs(timeline.text) }),
  "exact length": timeline => ({ expectedMs: exactMs(timeline) }),
  "margin 0.95": timeline => ({ expectedMs: estimateMs(timeline.text), rateMargin: 0.95 }),
  "no margin": timeline => ({ expectedMs: estimateMs(timeline.text), rateMargin: 1 }),
};

const timelines = flag("--replay") ? JSON.parse(readFileSync(flag("--replay")!, "utf8")) as Timeline[] : await record();
if (flag("--out")) writeFileSync(flag("--out")!, JSON.stringify(timelines));
const percentile = (values: number[], p: number) => { const sorted = [...values].sort((x, y) => x - y); return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0); };
console.log(`\nPlayback start (ms from the first audio to the first packet) and silence after it, by provider and rule. Defaults: ${JSON.stringify(PLAYBACK_BUFFER)}\n`);
console.log("| provider | rule | start p50 | start p95 | silence p50 | silence p95 | speeches with silence |");
console.log("|---|---|---|---|---|---|---|");
for (const provider of [...new Set(timelines.map(timeline => timeline.provider))]) {
  for (const [rule, options] of Object.entries(RULES)) {
    const results = [];
    for (const timeline of timelines.filter(entry => entry.provider === provider)) results.push(await replay(timeline, options(timeline)));
    console.log(`| ${provider} | ${rule} | ${percentile(results.map(r => r.startMs), 0.5)} | ${percentile(results.map(r => r.startMs), 0.95)} | ${percentile(results.map(r => r.silentMs), 0.5)} | ${percentile(results.map(r => r.silentMs), 0.95)} | ${results.filter(r => r.silentMs > 40).length}/${results.length} |`);
  }
}
