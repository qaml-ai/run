/**
 * The realtime brain end to end (docs/guides/voice-calls.md, "Realtime brain"): our RealtimeBrain, the real provider,
 * and the session's playback path (Opus encoding and the jitter buffer), on synthetic clips, timed from the end of
 * speech to the first packet out, as voice_turn_latency times a turn. No database, Discord or camelRun node:
 * only what sits between the media plane and the model.
 *
 *   OPENAI_API_KEY=… node --experimental-strip-types scripts/voice-realtime-e2e.ts [--provider openai|gemini] [--speakers 1|2|3] [--overlap]
 *        [--commit-ms 580] [--speculative] [--agent] [--model gpt-realtime-2.1] [--repeat 2] [--only id,id] [--out report.json]
 *        [--clips <dir>]
 *
 * The clips are said by OpenAI's gpt-4o-mini-tts the first time (OPENAI_API_KEY), and kept in
 * ~/.cache/camelrun-voice-realtime-e2e as `<id>.pcm` (24 kHz mono 16-bit). `--clips <dir>` reads `<id>.pcm` files from
 * there instead (recorded speech, say).
 *
 * Gemini Live (`--provider gemini`) takes GEMINI_API_KEY. Without the key, `--fake <ms>` stands in for the provider: its first audio comes <ms> after each response is
 * asked for, then audio at twice real time. That measures our own part only (mixing, commits, playback start).
 *
 * - Turns end as our Smart Turn ends them: the cut comes `--commit-ms` after the clip's last loud frame (580: the
 *   median measured on 920 turns, docs/guides/voice-calls.md). `--speculative` also sends likely_end 200 ms after it
 *   (Smart Turn's check), so the response begins then and plays at the cut.
 * - `--speakers 2|3`: the clips are said by different people in turn, each named ("[Ana]"); `--overlap` starts each
 *   one 400 ms before the one before has ended, so their audio is mixed.
 * - `--agent`: the bot's agent answers ask_agent after 400 ms (a stand-in), and the model is told to use it.
 * - Cost per minute: what the responses' tokens cost at list price, over the minutes of the run (people and bot).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RealtimeBrain, ASK_AGENT, STAY_SILENT, realtimeInstructions, type BrainHooks } from "../src/voice/realtime/brain.ts";
import { openaiRealtime } from "../src/voice/realtime/openai.ts";
import { geminiLive } from "../src/voice/realtime/gemini.ts";
import { NO_USAGE, type RealtimeConnection, type RealtimeEvents, type RealtimeProvider } from "../src/voice/realtime/provider.ts";
import { Floor } from "../src/voice/turns/floor.ts";
import { buffered, opusFromPcm } from "../src/voice-audio.ts";
import { openaiSpeech } from "../src/speech.ts";
import { outboundOfProcess } from "../src/outbound.ts";
import type { Playback, Player } from "../src/voice-speech.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string, fallback?: string) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback; };
const speakers = Number(value("speakers", "1"));
const commitMs = Number(value("commit-ms", "580"));
const repeat = Number(value("repeat", "2"));
const providerId = value("provider", "openai") as "openai" | "gemini";
const model = value("model", providerId === "gemini" ? process.env.GEMINI_LIVE_MODEL ?? "gemini-3.8-live" : process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1")!;
const fakeMs = value("fake") === undefined ? undefined : Number(value("fake"));
const only = (value("only") ?? "").split(",").filter(Boolean);
const keyName = providerId === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY";
const key = process.env[keyName];
if (!key && fakeMs === undefined) { console.error(`${keyName} is not set: pass --fake <ms> to time our own part with a stand-in provider`); process.exit(2); }

const BYTES_PER_MS = 48;
const NAMES = ["Ana", "Ben", "Cy"];
/** What each clip says, and how (OpenAI's voice and instructions). */
const CLIPS: Record<string, { text: string; voice: string; instructions?: string }> = {
  "cmd-book": { text: "Book a table for four at seven thirty tomorrow night.", voice: "sage" },
  "names": { text: "Can you ask Miguel and Illiana to review the camelRun pull request before Friday?", voice: "ballad" },
  "accent-spanish": { text: "Sorry, can you repeat the last part? I did not understand the price.", voice: "nova", instructions: "Speak English with a heavy Spanish accent." },
  "noise-cafe": { text: "Could you remind me to call the dentist at three?", voice: "coral" },
  "es": { text: "¿Puedes recordarme llamar a mi madre mañana a las cinco?", voice: "nova" },
  "fr": { text: "Est-ce que tu peux mettre la réunion à jeudi après-midi ?", voice: "shimmer" },
  "pt-br": { text: "Você pode me mandar o link da reunião de amanhã?", voice: "coral", instructions: "Brazilian Portuguese." },
  "code-switch": { text: "Okay so the meeting es mañana a las diez, right?", voice: "nova", instructions: "A bilingual speaker switching between English and Spanish naturally." },
  "disfluent": { text: "Um, so, I was, uh, thinking we could maybe move it to Friday?", voice: "ballad", instructions: "Hesitant, with natural pauses and fillers." },
  "cmd-volume": { text: "Turn the music up a bit.", voice: "verse" },
};
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type Clip = { id: string; pcm: Buffer; speechEndMs: number };
/** Each clip's PCM: from `--clips`, else the cache, else said by OpenAI once and cached. */
async function loadClips(): Promise<Clip[]> {
  const dir = value("clips") ?? join(homedir(), ".cache", "camelrun-voice-realtime-e2e");
  const ids = (only.length ? only : Object.keys(CLIPS)).filter(id => existsSync(join(dir, `${id}.pcm`)) || (!value("clips") && CLIPS[id]));
  const missing = ids.filter(id => !existsSync(join(dir, `${id}.pcm`)));
  if (missing.length) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) { console.error(`No clips in ${dir}: OPENAI_API_KEY makes them once (or pass --clips <dir>)`); process.exit(2); }
    mkdirSync(dir, { recursive: true });
    const tts = openaiSpeech({ outbound: outboundOfProcess() });
    for (const id of missing) {
      const { text, voice, instructions } = CLIPS[id];
      const chunks: Buffer[] = [];
      for await (const chunk of tts.stream({ text, voice, ...(instructions ? { instructions } : {}) }, { apiKey }, AbortSignal.timeout(60_000))) chunks.push(Buffer.from(chunk));
      writeFileSync(join(dir, `${id}.pcm`), Buffer.concat(chunks));
    }
  }
  return ids.map(id => {
    const pcm = Buffer.concat([Buffer.alloc(200 * BYTES_PER_MS), readFileSync(join(dir, `${id}.pcm`))]);
    let last = 0;
    for (let at = 0; at + 960 <= pcm.length; at += 960) {
      let sum = 0;
      for (let i = at; i < at + 960; i += 2) { const s = pcm.readInt16LE(i); sum += s * s; }
      if (Math.sqrt(sum / 480) > 32_768 * 10 ** (-45 / 20)) last = at + 960;
    }
    return { id, pcm: pcm.subarray(0, last), speechEndMs: last / BYTES_PER_MS };
  });
}

/** A stand-in provider: first audio `ms` after each response, then 2x real-time audio for about 1.5 s. */
function fakeProvider(ms: number): RealtimeProvider {
  return {
    id: "openai", key: "openai", models: [model], defaultModel: model, voices: ["marin"],
    connect(_config, _credentials, events: RealtimeEvents): RealtimeConnection {
      let bytes = 0, n = 0;
      const timers = new Set<ReturnType<typeof setTimeout>>();
      queueMicrotask(() => events.ready());
      return {
        get pendingMs() { return bytes / BYTES_PER_MS; },
        append: pcm => { bytes += pcm.byteLength; },
        commit: () => { const kept = bytes >= 100 * BYTES_PER_MS; bytes = 0; return kept; },
        discard: () => { bytes = 0; }, note: () => {}, cancel: () => {}, truncate: () => {}, toolResult: () => {},
        respond: () => {
          const id = `fake_${++n}`;
          events.responseStarted(id);
          let sent = 0;
          const tick = () => {
            if (sent >= 1_500) { events.responseDone(id, { status: "completed", usage: { ...NO_USAGE, inputAudio: 100, outputAudio: 30 } }); return; }
            events.audio(id, Buffer.alloc(40 * BYTES_PER_MS));
            sent += 40;
            const timer = setTimeout(tick, 20); timers.add(timer);
          };
          const timer = setTimeout(tick, ms); timers.add(timer);
        },
        close: () => { for (const timer of timers) clearTimeout(timer); events.closed("requested"); },
      };
    },
  };
}

/** The session's playback path without Discord: Opus at 48 kHz, the jitter buffer, one packet each 20 ms. */
const player: Player = {
  play(pcm, started, expectedMs): Playback {
    let stopped = false;
    const done = (async () => {
      let first = true, next = performance.now();
      for await (const _packet of buffered(opusFromPcm(pcm), expectedMs !== undefined ? { expectedMs } : {})) {
        if (stopped) return "stopped" as const;
        if (first) { first = false; started(); }
        next += 20;
        const wait = next - performance.now();
        if (wait > 0) await sleep(wait);
      }
      return "done" as const;
    })();
    return { done, stop: () => { stopped = true; } };
  },
};

type Sample = { clip: string; speaker: string; firstPacketMs?: number; afterCommitMs?: number; outcome: string; askAgent?: boolean; speculative?: boolean };

async function run() {
  const clips = await loadClips();
  if (!clips.length) { console.error("No clips: --only names none, or --clips has no <id>.pcm"); process.exit(2); }
  const provider = fakeMs !== undefined ? fakeProvider(fakeMs) : providerId === "gemini" ? geminiLive() : openaiRealtime();
  let costUsd = 0, talkMs = 0, botMs = 0;
  const started = performance.now();
  const turns = new Map<string, Sample>();
  const hooks: BrainHooks = {
    connect: events => provider.connect({
      model, voice: providerId === "gemini" ? "Aoede" : "marin", transcribe: flag("transcribe"),
      instructions: realtimeInstructions(`You are a friendly assistant in a voice call. Answer in one or two short sentences.${flag("agent") ? " For bookings, reminders or facts, always ask the agent first." : ""}`, { agent: flag("agent"), group: speakers > 1 }),
      tools: [...flag("agent") ? [ASK_AGENT] : [], STAY_SILENT],
    }, { apiKey: key ?? "fake" }, events),
    player: () => player, resumeMedia: () => {}, humans: () => speakers, name: speaker => speaker,
    ...(flag("agent") ? { askAgent: async () => { await sleep(400); return "Done: it is booked and you will get a confirmation."; } } : {}),
    admit: async () => {}, hold: async () => undefined, budget: () => {},
    usage: record => { costUsd += record.costUsd; botMs += record.audioSeconds * 1_000; },
    turn: () => {}, heard: () => {},
    spoke: event => {
      if (event.type !== "started" || !event.turn) return;
      // The answer is to the latest turn (an earlier one it was not to stays unanswered).
      const sample = [...turns.values()].at(-1);
      if (!sample || sample.firstPacketMs !== undefined) return;
      const stages = event.turn.stages();
      sample.firstPacketMs = stages.firstPacket;
      if (stages.ttsFirstAudio !== undefined && stages.turnCommit !== undefined) sample.afterCommitMs = stages.ttsFirstAudio - stages.turnCommit;
      sample.outcome = "spoken";
      if (event.turn.info.askAgent) sample.askAgent = true;
    },
    failed: detail => console.error(`provider failed: ${detail}`),
    log: (type, fields) => { if (type.includes("failed") || type.includes("warning") || type.includes("lost")) console.error(type, JSON.stringify(fields ?? {})); },
  };
  const brain = new RealtimeBrain({
    session: "vs_e2e00000000000000000000", tenant: "e2e", reference: `${providerId}/${model}`, floor: new Floor({ mode: "always" }), ...(provider.wordsAfterAnswer ? { wordsAfterAnswer: true } : {}),
    speculative: flag("speculative"), transcribed: false, bargeIn: { minMs: 300, confirmMs: 1_000, resumeMs: 3_000 },
  }, hooks);
  await sleep(1_500);
  /** One person says a clip in real time; their turn ends as Smart Turn would end it. */
  const say = async (clip: Clip, speaker: string, sample: Sample) => {
    brain.speechStart(speaker);
    const startedAt = Date.now();
    let next = performance.now();
    for (let at = 0; at < clip.pcm.length; at += 960) {
      brain.pcm(speaker, clip.pcm.subarray(at, Math.min(clip.pcm.length, at + 960)));
      next += 20;
      const wait = next - performance.now();
      if (wait > 0) await sleep(wait);
    }
    talkMs += clip.speechEndMs;
    const speechEnd = Date.now();
    if (flag("speculative")) {
      await sleep(200);
      brain.turnEvent({ type: "likely_end", speaker, at: Date.now(), probability: 0.9, silenceMs: 200 });
      await sleep(Math.max(0, commitMs - 200));
    } else await sleep(commitMs);
    brain.cut({ speaker, packets: [], seconds: clip.speechEndMs / 1_000, startedAt, endedAt: speechEnd, ended: "silence", live: true });
    void sample;
  };
  /** Wait for the answer to be heard out before anyone speaks again. */
  const heardOut = async (sample: Sample) => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && (sample.firstPacketMs === undefined || brain.speakingNow)) await sleep(50);
    await sleep(300);
  };
  let index = 0;
  const overlap = flag("overlap") && speakers > 1;
  for (let round = 0; round < repeat; round++) {
    for (let i = 0; i < clips.length; i += overlap ? 2 : 1) {
      const clip = clips[i];
      const speaker = NAMES[index++ % speakers];
      const sample: Sample = { clip: clip.id, speaker, outcome: "no_reply", ...(flag("speculative") ? { speculative: true } : {}) };
      const second = overlap ? clips[i + 1] : undefined;
      if (!second) {
        turns.set(`${round}:${clip.id}`, sample);
        await say(clip, speaker, sample);
        await heardOut(sample);
        continue;
      }
      // Two at once: the second starts 400 ms before the first stops; one answer, to both, timed from the last.
      const other = NAMES[index++ % speakers];
      const last: Sample = { clip: `${clip.id}+${second.id}`, speaker: `${speaker}+${other}`, outcome: "no_reply" };
      turns.set(`${round}:${last.clip}`, last);
      await Promise.all([say(clip, speaker, last), sleep(Math.max(0, clip.speechEndMs - 400)).then(() => say(second, other, last))]);
      await heardOut(last);
    }
  }
  await sleep(3_000);
  brain.close();
  const minutes = (performance.now() - started) / 60_000;
  const spoken = [...turns.values()];
  const pct = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : undefined; };
  const firsts = spoken.map(sample => sample.firstPacketMs).filter((v): v is number => v !== undefined);
  const afters = spoken.map(sample => sample.afterCommitMs).filter((v): v is number => v !== undefined);
  const report = {
    provider: fakeMs !== undefined ? `fake(${fakeMs} ms)` : `${providerId}/${model}`, speakers, overlap: flag("overlap"), speculative: flag("speculative"), agent: flag("agent"), commitMs,
    turns: spoken.length, spoken: firsts.length,
    firstPacketMs: { p50: pct(firsts, 0.5), p90: pct(firsts, 0.9) },
    firstAudioAfterCommitMs: { p50: pct(afters, 0.5), p90: pct(afters, 0.9) },
    stats: brain.stats, costUsd: Math.round(costUsd * 10_000) / 10_000, minutes: Math.round(minutes * 100) / 100,
    costPerMinute: Math.round(costUsd / minutes * 10_000) / 10_000, talkSeconds: Math.round(talkMs / 1_000), botSeconds: Math.round(botMs / 1_000),
    samples: spoken,
  };
  console.log(JSON.stringify({ ...report, samples: undefined }, null, 2));
  const out = value("out");
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
}

await run();
