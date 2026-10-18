/**
 * Voice bake-off: every speech-to-text and text-to-speech provider camelRun has (src/voice-providers/), on a fixed set
 * of clips, through the same adapters voice sessions use. It reports latency where a caller feels it (end of speech to
 * final transcript; request to first audio), accuracy (WER, CER for Japanese) and list price per minute.
 *
 *   npm run bakeoff:voice -- --dry-run                         fakes only, no keys (what CI runs)
 *   OPENAI_API_KEY=… DEEPGRAM_API_KEY=… npm run bakeoff:voice   the providers with keys; the rest are skipped
 *
 * Keys, from the environment: OPENAI_API_KEY (also makes the synthetic clips, and checks TTS by transcribing it back),
 * DEEPGRAM_API_KEY, SONIOX_API_KEY, ASSEMBLYAI_API_KEY, ELEVENLABS_API_KEY, CARTESIA_API_KEY with CARTESIA_VOICE_ID
 * (ELEVENLABS_VOICE_ID and DEEPGRAM_VOICE optional).
 *
 * Options:
 *   --stt a,b       speech-to-text providers (default: all; e.g. deepgram/flux,soniox,assemblyai/<speech_model>)
 *   --tts a,b       text-to-speech providers (default: all); --stt none or --tts none skips one side
 *   --clips <dir>   recorded clips (<id>.wav 24 kHz mono 16-bit, <id>.txt) instead of the synthetic set
 *   --only a,b      only these clip ids;  --repeat <n> rounds (default 1);  --silence-ms <n> (default 800)
 *   --cache <dir>   where synthetic clips are kept (default ~/.cache/camelrun-voice-bakeoff)
 *   --keyterms a,b  terms to listen for;  --out <file.json>, --md <file.md> to write the report
 *   --pace <n>      stream faster than real time (dry runs only: it skews latency)
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openaiSpeech } from "../src/speech.ts";
import { Outbound } from "../src/outbound.ts";
import { CLIPS, fakeClips, recordedClips, syntheticClips, type Clip } from "./voice-bakeoff/clips.ts";
import { fakeProviders } from "./voice-bakeoff/fakes.ts";
import { DEFAULT_STT, DEFAULT_TTS, markdown, runStt, runTts, sttSummary, ttsSummary, type BakeoffOptions } from "./voice-bakeoff/run.ts";

export async function bakeoff(argv: string[], env: Record<string, string | undefined> = process.env, log: (line: string) => void = line => console.error(line)) {
  const flag = (name: string) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : undefined; };
  const list = (name: string, fallback: string[]) => { const value = flag(name); return value === undefined ? fallback : value === "none" ? [] : value.split(",").map(item => item.trim()).filter(Boolean); };
  const dry = argv.includes("--dry-run");
  const only = list("only", []);
  const specs = only.length ? CLIPS.filter(spec => only.includes(spec.id)) : CLIPS;
  let current = "";
  const fakes = dry ? await fakeProviders(() => current) : undefined;
  try {
    const keys = dry ? fakes!.options.keys! : {
      openai: env.OPENAI_API_KEY, "openai-batch": env.OPENAI_API_KEY, deepgram: env.DEEPGRAM_API_KEY, soniox: env.SONIOX_API_KEY,
      assemblyai: env.ASSEMBLYAI_API_KEY, elevenlabs: env.ELEVENLABS_API_KEY, cartesia: env.CARTESIA_API_KEY,
    };
    const options: BakeoffOptions = {
      stt: list("stt", DEFAULT_STT), tts: list("tts", DEFAULT_TTS),
      keys: { ...keys, "openai-batch": keys.openai },
      voices: dry ? fakes!.options.voices : { ...(env.CARTESIA_VOICE_ID ? { cartesia: env.CARTESIA_VOICE_ID } : {}), ...(env.ELEVENLABS_VOICE_ID ? { elevenlabs: env.ELEVENLABS_VOICE_ID } : {}), ...(env.DEEPGRAM_VOICE ? { deepgram: env.DEEPGRAM_VOICE } : {}) },
      repeat: Number(flag("repeat") ?? 1), silenceMs: Number(flag("silence-ms") ?? 800), pace: Number(flag("pace") ?? (dry ? 4 : 1)),
      ...(flag("keyterms") ? { keyterms: list("keyterms", []) } : {}),
      ...(fakes ? { stt_endpoints: fakes.options.stt_endpoints!, tts_endpoints: fakes.options.tts_endpoints!, outbound: fakes.options.outbound! } : {}),
      log,
    };
    let clips: Clip[];
    if (dry) clips = fakeClips(specs);
    else if (flag("clips")) clips = recordedClips(flag("clips")!);
    else if (options.stt.length) {
      if (!env.OPENAI_API_KEY) throw new Error("The synthetic clips are made with OpenAI's text to speech: set OPENAI_API_KEY, or pass --clips <dir> of recorded ones");
      clips = await syntheticClips(specs, { provider: openaiSpeech({ outbound: new Outbound() }), credentials: { apiKey: env.OPENAI_API_KEY } }, flag("cache") ?? join(homedir(), ".cache", "camelrun-voice-bakeoff"));
    } else clips = [];
    // Each clip's words, for the fakes to answer with.
    const stt = await runStt(clips, { ...options, onClip: clip => { current = clip.text; } });
    const tts = await runTts({ ...options, onPrompt: prompt => { current = prompt.text; } });
    const source = dry ? "fake" : clips[0]?.source ?? "none";
    const report = { date: new Date().toISOString().slice(0, 10), source, clips: clips.length, repeat: options.repeat!, silenceMs: options.silenceMs!, stt: sttSummary(stt), tts: ttsSummary(tts), samples: { stt, tts } };
    const md = markdown(report.stt, report.tts, report);
    if (flag("out")) writeFileSync(flag("out")!, JSON.stringify(report, null, 2));
    if (flag("md")) writeFileSync(flag("md")!, md);
    return { report, md };
  } finally { await fakes?.close(); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  bakeoff(process.argv.slice(2)).then(({ md }) => { console.log(md); process.exit(0); }, error => { console.error(error); process.exit(1); });
}
