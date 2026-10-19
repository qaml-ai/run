import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import pg from "pg";
import { Accounts } from "../../src/accounts.ts";
import { Outbound } from "../../src/outbound.ts";
import { Ownership } from "../../src/ownership.ts";
import { openaiSpeech, Synthesizer, type SpeechProvider } from "../../src/speech.ts";
import { Tenants } from "../../src/tenants.ts";
import { openaiTranscription, Transcriber, type TranscriptionProvider } from "../../src/transcription.ts";
import { buffered } from "../../src/voice-audio.ts";
import type { Playback } from "../../src/voice-speech.ts";
import { VoiceSessions, type VoiceHandlers, type VoiceTransport } from "../../src/voice-sessions.ts";
import { Webhooks } from "../../src/webhooks.ts";
import { testDatabase } from "../database.ts";
import { FRAME_MS, framesOf, oggPackets, Origins, seeded, SILENCE_FRAME, SpeakerAudio } from "./audio.ts";
import { BOT, type Scenario, type Speaker, type Turn } from "./scenarios.ts";

/**
 * The voice eval: scripted calls (scenarios.ts) played in real time into camelRun's voice sessions, as Discord would
 * deliver them, and the bot's answers heard back. What runs is the real pipeline from the packets in to the packets
 * out: VoiceSessions, the Segmenter, the transcription and speech queues, barge-in, SpokenReply, the webhook outbox and
 * its sender, the playback jitter buffer. What is faked is around it: Discord's transport (packets handed straight to
 * the session; played packets timed at 20 ms each, as Discord's player sends them), the providers (latency profiles,
 * or OpenAI's real ones with VOICE_EVAL_PROVIDERS=openai), the model writing the bot's answers (a profile), and the app
 * on the other side of the webhooks (a model of camel-bots: its bot code answers what names it, `BOT.addressed`).
 *
 * Every packet a speaker sends is remembered with the turn and frame it carries, so each utterance's transcript (fake)
 * is exactly the words its frames hold, and each answer is tagged with the utterance it answers. score.ts turns the
 * timeline into the scoreboard.
 */

export type Profile = {
  name: string;
  /** Transcription after the cut: a fixed time plus a time per second of audio. */
  sttBaseMs: number; sttPerSecondMs: number;
  /** Speech: time to its first audio, then how many times faster than real time it comes. */
  ttsFirstByteMs: number; ttsSpeed: number;
  /** The model writing the bot's answer: time to its first token, then characters a second. */
  llmFirstTokenMs: number; llmCharsPerSecond: number;
  /** The app's own time between a webhook in and its call out (camel-bots: inbox, the bot's code in v8-exec, REST). */
  appMs: number;
  /** Each wait varies by up to this fraction, seeded. */
  jitter: number;
};

/**
 * Provider timings the fake mode assumes (not measured here: VOICE_EVAL_PROVIDERS=openai measures the real ones).
 * Rough public figures for OpenAI's gpt-4o-mini-transcribe, gpt-4o-mini-tts and a fast chat model, and camel-bots'
 * own path from its webhook to camelRun.
 */
export const PROFILES: Record<string, Profile> = {
  realistic: { name: "realistic", sttBaseMs: 450, sttPerSecondMs: 30, ttsFirstByteMs: 350, ttsSpeed: 4, llmFirstTokenMs: 600, llmCharsPerSecond: 250, appMs: 150, jitter: 0.25 },
  /** Providers that take no time: what is left is the pipeline's own (cuts, queues, buffers, the outbox). */
  instant: { name: "instant", sttBaseMs: 0, sttPerSecondMs: 0, ttsFirstByteMs: 0, ttsSpeed: 50, llmFirstTokenMs: 0, llmCharsPerSecond: 50_000, appMs: 0, jitter: 0 },
};

/**
 * How the bot's answers are made:
 * - `bots-say`: camel-bots' bot code today: `voice.utterance` webhook -> the bot's speech handler -> ctx.ai (the whole
 *   answer) -> ctx.reply, spoken with POST /speak.
 * - `bots-agent`: camel-bots' bot answering with its agent: webhook -> agent prompt with `speak: {session}` -> camelRun
 *   speaks the run's reply sentence by sentence as it is written.
 * - `run-agent`: camelRun alone: `deliver.agent` with `speak: {agentReplies: true}` (no webhook hop; the agent answers
 *   only what names the bot, as the bot code does).
 */
export type Pipeline = {
  name: string; description: string; path: "bots-say" | "bots-agent" | "run-agent";
  /** How often the webhook sender runs (the runtime's AGENT_SCHEDULER_INTERVAL_MS, 5,000 by default). */
  webhookIntervalMs: number;
  /** Session settings on top of the eval's (silenceMs, bargeIn…). */
  session?: Record<string, unknown>;
  /** false: voice events wait for the sender's next run, as before the outbox was kicked for them (#230). */
  kick?: boolean;
};

export const PIPELINES: Pipeline[] = [
  { name: "bots-say", path: "bots-say", webhookIntervalMs: 5_000, description: "camel-bots bot code: webhook, ctx.ai, ctx.reply spoken" },
  { name: "bots-agent", path: "bots-agent", webhookIntervalMs: 5_000, description: "camel-bots bot agent: webhook, prompt with speak (streamed)" },
  { name: "run-agent", path: "run-agent", webhookIntervalMs: 5_000, description: "camelRun deliver.agent + agentReplies (no app hop)" },
  { name: "bots-agent@poll", path: "bots-agent", webhookIntervalMs: 5_000, kick: false, description: "before #230: bots-agent with voice webhooks waiting for the 5 s sender" },
];

const TENANT = "alice";
const AGENT = `client_${"e".repeat(40)}`;
const BOT_USER = "300000000000000003";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
/** How long a speaker's client keeps sending after speech stops (its voice activity hangover), and its silence frames. */
const HANGOVER_FRAMES = 10, SILENCE_FRAMES = 5;
/** A pause up to this long keeps the client sending (quiet frames); a longer one stops it. */
const HELD_PAUSE_MS = 300;
/** How long a speaking rate: ms per word, when the audio is made up. */
const WORD_MS = 330;
/** How long the eval waits for the bot to answer a turn before going on. */
export const ANSWER_WAIT_MS = 8_000;

/** One 20 ms step of a speaker's audio: speech of a turn's frame, quiet (room tone), Discord's silence frame, or nothing. */
type Step = { kind: "speech"; packet: Uint8Array; frame: number } | { kind: "quiet"; packet: Uint8Array } | { kind: "silence" } | { kind: "none" };

/** A turn's audio, made before the run: its steps, and where each word's frames are (for the fake transcriber). */
type TurnAudio = { steps: Step[]; words: { word: string; first: number; last: number }[]; speechFrames: number };

export type TurnRun = {
  id: number; scenario: string; index: number; turn: Turn;
  /** When its first and last speech frames went out, and each run of speech in it. */
  startAt?: number; endAt?: number; segments: [number, number][];
};
export type UtteranceRun = {
  id: string; scenario: string; session: string; speaker: string;
  /** The frames of each turn it holds. */
  frames: Map<number, number[]>;
  calledAt: number; doneAt?: number; text?: string; language?: string;
  /** Stages of its answer, if it got one. */
  deliveredAt?: number; addressed?: boolean; llmFirstTokenAt?: number; ttsRequestedAt?: number; ttsFirstAudioAt?: number;
};
/** One speech played: asked to play, its first and last packets out, when it ended, and when it was stopped (if it was). */
export type PlaybackRun = { tag?: string; scenario: string; askedAt: number; firstAt?: number; lastAt?: number; endedAt?: number; packets: number; stopped: boolean; stoppedAt?: number };
export type SpeechEnded = { scenario: string; reason: string; by?: string; seconds: number; at: number };
export type ScenarioRun = {
  scenario: Scenario; session: string; startedAt: number; endedAt: number;
  turns: TurnRun[]; utterances: UtteranceRun[]; playbacks: PlaybackRun[]; speechEnded: SpeechEnded[]; errors: string[];
};
export type PipelineRun = { pipeline: Pipeline; profile: Profile; providers: "fake" | "openai"; scenarios: ScenarioRun[]; logs: Record<string, number> };

/**
 * The JSON lines the pipeline logs, counted by type into each running pipeline's `logs`: a line naming one of its
 * sessions goes to it, a line naming none to every pipeline running. Shown only with VOICE_EVAL_VERBOSE.
 */
const counters = new Set<{ logs: Record<string, number>; sessions: () => string[] }>();
const { log: realLog, error: realError } = console;
function countLogs(logs: Record<string, number>, sessions: () => string[]) {
  const counter = { logs, sessions };
  counters.add(counter);
  if (counters.size === 1) {
    const count = (line: unknown) => {
      const type = typeof line === "string" && line.startsWith("{") ? /"type":"([^"]+)"/.exec(line)?.[1] : undefined;
      if (!type) return false;
      const session = /"session":"(vs_[a-f0-9]+)"/.exec(line as string)?.[1];
      for (const entry of counters) if (!session || entry.sessions().includes(session)) entry.logs[type] = (entry.logs[type] ?? 0) + 1;
      return true;
    };
    console.log = (...args: unknown[]) => { if (!count(args[0]) || process.env.VOICE_EVAL_VERBOSE) realLog(...args); };
    console.error = (...args: unknown[]) => { if (!count(args[0]) || process.env.VOICE_EVAL_VERBOSE) realError(...args); };
  }
  return () => {
    counters.delete(counter);
    if (!counters.size) { console.log = realLog; console.error = realError; }
  };
}

/** Audio for every turn, made once a process (it is the same for each pipeline). */
const audioCache = new Map<string, TurnAudio>();
export const origins = new Origins();
let nextTurnId = 1;
const turnIds = new Map<string, number>();
const turnId = (scenario: string, index: number) => {
  const key = `${scenario}:${index}`;
  if (!turnIds.has(key)) turnIds.set(key, nextTurnId++);
  return turnIds.get(key)!;
};
const turnsById = new Map<number, { scenario: Scenario; index: number; audio: TurnAudio }>();

const words = (text: string) => text.replace(/\|/g, " ").split(/\s+/).filter(Boolean);

/** Real speech for a turn's pieces from OpenAI's speech API, cached on disk (VOICE_EVAL_PROVIDERS=openai). */
async function spokenPcm(text: string, voice: string, apiKey: string): Promise<Uint8Array> {
  const dir = join(import.meta.dirname, ".cache");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${createHash("sha256").update(`${voice}:${text}`).digest("hex").slice(0, 24)}.pcm`);
  if (existsSync(file)) return readFileSync(file);
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", input: text, voice, response_format: "pcm" }),
  });
  if (!response.ok) throw new Error(`speech for the eval's speakers: HTTP ${response.status}`);
  const pcm = new Uint8Array(await response.arrayBuffer());
  writeFileSync(file, pcm);
  return pcm;
}

/** A turn's audio: speech frames (made up, or a speech provider's), its pauses, then the client's hangover and silence. */
async function turnAudio(scenario: Scenario, index: number, real?: { apiKey: string }): Promise<TurnAudio> {
  const key = `${real ? "real" : "fake"}:${scenario.name}:${index}`;
  const cached = audioCache.get(key);
  if (cached) return cached;
  const turn = scenario.turns[index]!;
  const speaker = scenario.speakers.find(entry => entry.id === turn.speaker)!;
  const id = turnId(scenario.name, index);
  const audio = new SpeakerAudio(id * 7919, speaker.noiseDb);
  const steps: Step[] = [];
  const wordSpans: TurnAudio["words"] = [];
  let frame = 0;
  const pieces = turn.text.split("|").map(piece => piece.trim());
  for (const [p, piece] of pieces.entries()) {
    const pieceWords = words(piece);
    let pcmFrames: Int16Array[] | undefined;
    if (real) {
      pcmFrames = framesOf(await spokenPcm(piece, speaker.voice ?? "alloy", real.apiKey));
      // The provider's own quiet before and after the words is not the turn's speech.
      const level = (pcm: Int16Array) => { let sum = 0; for (const s of pcm) sum += s * s; return 20 * Math.log10(Math.sqrt(sum / pcm.length) / 32_768 || 1e-9); };
      while (pcmFrames.length && level(pcmFrames[0]!) < -45) pcmFrames.shift();
      while (pcmFrames.length && level(pcmFrames.at(-1)!) < -45) pcmFrames.pop();
    }
    const count = pcmFrames?.length ?? Math.max(20, Math.round(pieceWords.length * WORD_MS / FRAME_MS));
    const first = frame;
    for (let i = 0; i < count; i++) {
      const packet = audio.frame("speech", pcmFrames ? { pcm: pcmFrames[i] } : {});
      origins.add(packet, { turn: id, frame });
      steps.push({ kind: "speech", packet, frame: frame++ });
    }
    pieceWords.forEach((word, w) => wordSpans.push({ word, first: first + Math.floor(w * count / pieceWords.length), last: first + Math.floor((w + 1) * count / pieceWords.length) - 1 }));
    const pause = p < pieces.length - 1 ? turn.pausesMs?.[p] ?? 500 : undefined;
    if (pause === undefined) continue;
    const pauseFrames = Math.round(pause / FRAME_MS);
    if (pause <= HELD_PAUSE_MS || speaker.openMic) for (let i = 0; i < pauseFrames; i++) steps.push({ kind: "quiet", packet: audio.frame("quiet") });
    else {
      for (let i = 0; i < HANGOVER_FRAMES; i++) steps.push({ kind: "quiet", packet: audio.frame("quiet") });
      for (let i = 0; i < SILENCE_FRAMES; i++) steps.push({ kind: "silence" });
      for (let i = HANGOVER_FRAMES + SILENCE_FRAMES; i < pauseFrames; i++) steps.push({ kind: "none" });
    }
  }
  if (!speaker.openMic) {
    for (let i = 0; i < HANGOVER_FRAMES; i++) steps.push({ kind: "quiet", packet: audio.frame("quiet") });
    for (let i = 0; i < SILENCE_FRAMES; i++) steps.push({ kind: "silence" });
  }
  audio.close();
  const made = { steps, words: wordSpans, speechFrames: frame };
  audioCache.set(key, made);
  turnsById.set(id, { scenario, index, audio: made });
  return made;
}

/** An open mic's idle audio (room tone and its noise), a pool cycled through. */
const idleCache = new Map<string, Uint8Array[]>();
function idleAudio(speaker: Speaker): Uint8Array[] {
  const key = `${speaker.id}:${speaker.noiseDb}`;
  let pool = idleCache.get(key);
  if (!pool) {
    const audio = new SpeakerAudio(Number(speaker.id.slice(-4)), speaker.noiseDb);
    pool = Array.from({ length: 150 }, () => audio.frame("quiet"));
    audio.close();
    idleCache.set(key, pool);
  }
  return pool;
}

/** The words an utterance's frames hold, in the order spoken (the fake transcriber's answer). */
function heardText(frames: Map<number, number[]>): string {
  const out: string[] = [];
  for (const [id, heard] of [...frames.entries()].sort((a, b) => a[0] - b[0])) {
    const turn = turnsById.get(id);
    if (!turn) continue;
    const min = Math.min(...heard), max = Math.max(...heard);
    for (const word of turn.audio.words) {
      const middle = (word.first + word.last) / 2;
      if (middle >= min && middle <= max) out.push(word.word);
    }
  }
  return out.join(" ");
}

/** An utterance's answer, tagged so its speech can be told apart: each sentence starts with ⟦tag⟧ (stripped before speech). */
const tagged = (text: string, tag: string) => text.split(/(?<=[.!?])\s+/).map(sentence => `⟦${tag}⟧ ${sentence}`).join(" ");
const TAG = /⟦([^⟧]+)⟧\s*/g;

/** Discord, as far as the session sees it: connections by server, packets handed in, speech played at 20 ms a packet. */
class EvalTransport {
  readonly calls = new Map<string, { handlers: VoiceHandlers; others: string[]; playbacks: PlaybackRun[]; scenario: string }>();
  /** The tag of the speech made last (the synthesizer is asked, then the player plays it, at once). */
  lastTag?: string;
  scenarioOf = new Map<string, string>();
  readonly transport: VoiceTransport = {
    speaks: true,
    connect: (credentials, handlers) => {
      const call = { handlers, others: [] as string[], playbacks: [] as PlaybackRun[], scenario: this.scenarioOf.get(credentials.guildId) ?? "?" };
      this.calls.set(credentials.guildId, call);
      let closed = false;
      return {
        update: () => {},
        others: () => call.others,
        close: () => { closed = true; },
        play: (packets: AsyncIterable<Uint8Array>, started: () => void, expectedMs?: number): Playback => {
          const run: PlaybackRun = { tag: this.lastTag, scenario: call.scenario, askedAt: Date.now(), packets: 0, stopped: false };
          this.lastTag = undefined;
          call.playbacks.push(run);
          let stopped = false;
          const done = (async () => {
            let next = 0;
            try {
              for await (const packet of buffered(packets, expectedMs !== undefined ? { expectedMs } : {})) {
                void packet;
                if (stopped || closed) break;
                const now = performance.now();
                if (next > now) await sleep(next - now);
                if (stopped || closed) break;
                next = Math.max(next, performance.now()) + FRAME_MS;
                if (!run.packets) { run.firstAt = Date.now(); started(); }
                run.packets++;
                run.lastAt = Date.now();
              }
              return stopped ? "stopped" as const : "done" as const;
            } catch { return stopped ? "stopped" as const : "error" as const; }
            finally { run.endedAt = Date.now(); }
          })();
          return { done, stop: () => { if (stopped) return; stopped = true; run.stopped = true; run.stoppedAt = Date.now(); } };
        },
      };
    },
  };
}

/** The model writing the bot's answer: its first token after a while, then a few characters at a time. */
async function* written(text: string, profile: Profile, random: () => number, first: () => void): AsyncGenerator<string> {
  const vary = (ms: number) => ms * (1 + profile.jitter * (random() * 2 - 1));
  await sleep(vary(profile.llmFirstTokenMs));
  first();
  for (let at = 0; at < text.length; at += 4) {
    yield text.slice(at, at + 4);
    await sleep(vary(4_000 / profile.llmCharsPerSecond));
  }
}

export type EvalOptions = {
  pipeline: Pipeline; scenarios: Scenario[]; profile: Profile;
  /** Real providers (OpenAI) for transcription and speech; the model writing answers stays a profile. */
  providers?: "fake" | "openai";
  seed?: number;
};

/** Run every scenario at once, each its own session (its own server), through one pipeline on one node. */
export async function runPipeline(options: EvalOptions): Promise<PipelineRun> {
  const { pipeline, profile } = options;
  const providers = options.providers ?? "fake";
  const apiKey = process.env.OPENAI_API_KEY;
  if (providers === "openai" && !apiKey) throw new Error("VOICE_EVAL_PROVIDERS=openai needs OPENAI_API_KEY");
  const random = seeded(options.seed ?? 42);
  const vary = (ms: number) => ms * (1 + profile.jitter * (random() * 2 - 1));
  for (const scenario of options.scenarios) for (const index of scenario.turns.keys()) await turnAudio(scenario, index, providers === "openai" ? { apiKey: apiKey! } : undefined);

  const { url } = await testDatabase();
  const db = new pg.Pool({ connectionString: url, max: 20 });
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db, secretsKey: randomBytes(32).toString("hex") });
  const ownership = new Ownership(db, { node: "http://eval", ttlMs: 90_000 });
  await ownership.start();
  const outbound = new Outbound({ allowHttp: true, allow: ["127.0.0.1/32"] });
  const webhooks = new Webhooks({ db, accounts, outbound, retryBaseMs: 200 });
  const transport = new EvalTransport();
  const runs = new Map<string, ScenarioRun>();
  const utterances: UtteranceRun[] = [];
  const logs: Record<string, number> = {};
  let voice!: VoiceSessions;

  // What the pipeline logs, counted (failures show up here: voice_utterance_failed, voice_speech_error…).
  const stopCounting = countLogs(logs, () => [...runs.keys()]);

  /** The utterance a delivered transcript is: the first of its session and speaker with that text not yet delivered. */
  const utteranceOf = (session: string, speaker: string, text: string) =>
    utterances.find(entry => entry.session === session && entry.speaker === speaker && entry.text === text && entry.deliveredAt === undefined);

  // Answers being written, by run, for the speech that follows them (followStreaming).
  const answers = new Map<string, AsyncIterable<string>>();
  const answer = (u: UtteranceRun): string | undefined => {
    // The turn it holds most of is what it answers.
    const [id] = [...u.frames.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? [];
    const turn = id === undefined ? undefined : turnsById.get(id);
    return turn?.scenario.turns[turn.index]?.reply ?? "Sorry, I didn't catch that.";
  };

  // Transcription: the frames the utterance holds, and their words (fake), or OpenAI's (real), timed.
  const realStt = providers === "openai" ? openaiTranscription({ outbound: new Outbound() }) : undefined;
  const stt: TranscriptionProvider = {
    id: "openai", model: realStt?.model ?? "eval-transcribe",
    async transcribe(audio, sttOptions, credentials, signal) {
      const frames = new Map<number, number[]>();
      for (const packet of oggPackets(audio.bytes)) {
        const origin = origins.of(packet);
        if (origin) (frames.get(origin.turn) ?? frames.set(origin.turn, []).get(origin.turn)!).push(origin.frame);
      }
      const ids = [...frames.keys()];
      const first = ids.length ? turnsById.get(Math.min(...ids)) : undefined;
      const scenario = first?.scenario.name ?? "?";
      const turn = first?.scenario.turns[first.index];
      const run = [...runs.values()].find(entry => entry.scenario.name === scenario);
      const u: UtteranceRun = { id: `u${utterances.length + 1}`, scenario, session: run?.session ?? "?", speaker: turn?.speaker ?? "?", frames, calledAt: Date.now() };
      utterances.push(u);
      let text: string, language: string | undefined;
      if (realStt) {
        const transcript = await realStt.transcribe(audio, sttOptions, credentials, signal);
        text = transcript.text;
        language = transcript.language;
      } else {
        await sleep(vary(profile.sttBaseMs + profile.sttPerSecondMs * (audio.header.seconds ?? 0)));
        text = heardText(frames);
        language = turn?.language ?? "en";
      }
      u.doneAt = Date.now();
      u.text = text;
      u.language = language;
      return { text, seconds: Math.ceil(audio.header.seconds ?? 0), model: this.model, ...(language ? { language } : {}) };
    },
  };
  const transcriber = new Transcriber({ provider: stt, key: async () => ({ apiKey: apiKey ?? "eval-key", platform: true }), price: () => 3_000 });

  // Speech: the tag read off and remembered for the player, timed to its first audio.
  const realTts = providers === "openai" ? openaiSpeech({ outbound: new Outbound() }) : undefined;
  const tts: SpeechProvider = {
    id: "openai", model: "gpt-4o-mini-tts",
    warm: realTts?.warm ? () => realTts.warm!() : undefined,
    stream(input, credentials, signal) {
      const tag = [...input.text.matchAll(TAG)][0]?.[1];
      const text = input.text.replace(TAG, "");
      transport.lastTag = tag;
      const u = tag ? utterances.find(entry => entry.id === tag) : undefined;
      if (u) u.ttsRequestedAt ??= Date.now();
      const firstAudio = () => { if (u) u.ttsFirstAudioAt ??= Date.now(); };
      if (realTts) {
        return (async function* () {
          let first = true;
          for await (const chunk of realTts.stream({ ...input, text }, credentials, signal)) {
            if (first) { first = false; firstAudio(); }
            yield chunk;
          }
        })();
      }
      return (async function* () {
        await sleep(vary(profile.ttsFirstByteMs));
        const total = Math.round(Math.max(0.5, text.length / 14) * 24_000);
        for (let at = 0; at < total; at += 2_400) {
          if (signal.aborted) throw signal.reason;
          const chunk = Buffer.alloc(Math.min(2_400, total - at) * 2);
          for (let i = 0; i < chunk.length / 2; i++) chunk.writeInt16LE(Math.round(6_000 * Math.sin(2 * Math.PI * 180 * (at + i) / 24_000)), i * 2);
          if (at === 0) firstAudio();
          yield chunk;
          await sleep(100 / profile.ttsSpeed);
        }
      })();
    },
  };
  const synthesizer = new Synthesizer({ provider: tts, key: async () => ({ apiKey: apiKey ?? "eval-key", platform: true }), price: () => 15_000 });

  // The app behind the webhooks: camel-bots, as a model. Its bot code answers what names the bot.
  const app: Server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      response.writeHead(204).end();
      const event = JSON.parse(body) as { type: string; data: Record<string, any> };
      const run = runs.get(event.data.session);
      if (!run) return;
      if (event.type === "voice.speech.ended") run.speechEnded.push({ scenario: run.scenario.name, reason: event.data.reason, by: event.data.by, seconds: event.data.seconds, at: Date.now() });
      if (event.type !== "voice.utterance" || pipeline.path === "run-agent") return;
      const u = utteranceOf(event.data.session, event.data.speakerId, event.data.text);
      if (!u) { run.errors.push(`webhook for an utterance not transcribed here: ${String(event.data.text).slice(0, 40)}`); return; }
      u.deliveredAt = Date.now();
      u.addressed = BOT.addressed.test(u.text ?? "");
      if (!u.addressed) return;
      void (async () => {
        await sleep(vary(profile.appMs));
        const reply = tagged(answer(u)!, u.id);
        if (pipeline.path === "bots-say") {
          let whole = "";
          for await (const piece of written(reply, profile, random, () => { u.llmFirstTokenAt ??= Date.now(); })) whole += piece;
          await voice.speak(TENANT, run.session, { text: whole });
        } else {
          const requestId = `req_${u.id}`;
          answers.set(requestId, written(reply, profile, random, () => { u.llmFirstTokenAt ??= Date.now(); }));
          await voice.speakRun(TENANT, { session: run.session }, { agent: AGENT, requestId });
        }
      // An answer to what was cut as the session ended (the call over) has nowhere to go: as for an app, not an error.
      })().catch(failure => { if ((failure as { code?: string }).code !== "VOICE_SESSION_ENDED") run.errors.push(`app: ${(failure as Error).message}`); });
    });
  });
  app.listen(0, "127.0.0.1");
  await new Promise(resolve => app.once("listening", resolve));
  await webhooks.create(TENANT, { url: `http://127.0.0.1:${(app.address() as { port: number }).port}/hook`, events: ["voice.utterance", "voice.speech.started", "voice.speech.ended", "voice.session.ended"] });
  webhooks.start(pipeline.webhookIntervalMs);

  voice = new VoiceSessions({
    db, accounts, node: "http://eval", ownership, transports: { discord: transport.transport },
    admit: async () => {}, agentOwned: async agent => agent === AGENT, transcriber, synthesizer, canTranscribe: async () => true,
    record: () => {}, submit: async () => ({}), perTenant: () => 1_000, perNode: 1_000,
    // As src/node.ts: a voice event committed sends the outbox at once (a pipeline with kick: false waits for the sender).
    ...(pipeline.kick === false ? {} : { kickWebhooks: () => webhooks.kick() }),
    // camelRun's agent (run-agent): it answers what names the bot, as the bot code would.
    async *submitStreaming(_agent, _tenant, request) {
      const params = request.params as { text: string; from: { id: string }; metadata: { voiceSession: string } };
      const u = utteranceOf(params.metadata.voiceSession, params.from.id, params.text);
      if (!u) return;
      u.deliveredAt = Date.now();
      u.addressed = BOT.addressed.test(params.text);
      if (!u.addressed) return;
      yield* written(tagged(answer(u)!, u.id), profile, random, () => { u.llmFirstTokenAt ??= Date.now(); });
    },
    async *followStreaming(_agent, _tenant, requestId) {
      const stream = answers.get(requestId);
      answers.delete(requestId);
      if (stream) yield* stream;
    },
  });

  try {
    await Promise.all(options.scenarios.map((scenario, index) => runScenario(scenario, index)));
  } finally {
    webhooks.stop();
    await voice.stop(2_000).catch(() => {});
    await ownership.close().catch(() => {});
    await new Promise(resolve => app.close(resolve));
    await db.end().catch(() => {});
    stopCounting();
  }
  return { pipeline, profile, providers, scenarios: options.scenarios.map(scenario => [...runs.values()].find(run => run.scenario === scenario)!), logs };

  async function runScenario(scenario: Scenario, index: number) {
    const guild = `1000000000000${String(index).padStart(5, "0")}`;
    transport.scenarioOf.set(guild, scenario.name);
    const agentReplies = pipeline.path === "run-agent";
    const created = await voice.create(TENANT, {
      discord: { guildId: guild, channelId: "200000000000000002", userId: BOT_USER, sessionId: `eval${index}`, endpoint: "c-eval-1.discord.media:443", token: `token-${index}` },
      speak: agentReplies ? { agentReplies: true } : true, voice: "coral",
      ...(agentReplies ? { deliver: { agent: AGENT, webhooks: true } } : {}),
      ...(scenario.language ? { language: scenario.language } : {}),
      ...pipeline.session,
    });
    const run: ScenarioRun = { scenario, session: created.id, startedAt: 0, endedAt: 0, turns: [], utterances: [], playbacks: [], speechEnded: [], errors: [] };
    runs.set(created.id, run);
    for (let waited = 0; !transport.calls.has(guild); waited += 20) {
      if (waited > 10_000) throw new Error(`${scenario.name}: no connection`);
      await sleep(20);
    }
    const call = transport.calls.get(guild)!;
    call.others = scenario.speakers.map(speaker => speaker.id);
    call.handlers.ready();
    run.playbacks = call.playbacks;

    // Each speaker's audio: what its turns queued, else its open mic's room tone, else nothing; one step every 20 ms.
    const queues = new Map(scenario.speakers.map(speaker => [speaker.id, [] as { step: Step; turn: TurnRun }[]]));
    let ticking = true, tick = 0;
    run.startedAt = Date.now();
    const origin = performance.now();
    const ticker = (async () => {
      while (ticking) {
        for (const speaker of scenario.speakers) {
          const next = queues.get(speaker.id)!.shift();
          const now = Date.now();
          if (next) {
            const { step, turn } = next;
            if (step.kind === "speech") {
              turn.startAt ??= now;
              const last = turn.segments.at(-1);
              if (last && now - last[1] <= FRAME_MS * 2) last[1] = now; else turn.segments.push([now, now]);
              turn.endAt = now;
            }
            if (step.kind === "speech" || step.kind === "quiet") call.handlers.packet(speaker.id, step.packet);
            else if (step.kind === "silence") call.handlers.packet(speaker.id, SILENCE_FRAME);
          } else if (speaker.openMic) {
            const pool = idleAudio(speaker);
            call.handlers.packet(speaker.id, pool[tick % pool.length]!);
          }
        }
        tick++;
        const due = origin + tick * FRAME_MS - performance.now();
        await sleep(due);
      }
    })();

    /** The bot's first answer to start after `since`, waited for up to ANSWER_WAIT_MS. */
    const answerAfter = async (since: number) => {
      for (const deadline = Date.now() + ANSWER_WAIT_MS; Date.now() < deadline; await sleep(20)) {
        const playback = call.playbacks.find(entry => entry.firstAt !== undefined && entry.firstAt > since);
        if (playback) return playback;
      }
      return undefined;
    };
    /** Until the bot has been quiet for 400 ms. */
    const botQuiet = async () => {
      for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(20)) {
        const playing = call.playbacks.some(entry => entry.firstAt !== undefined && !entry.stopped && (entry.lastAt ?? 0) > Date.now() - 400);
        const asked = call.playbacks.some(entry => entry.firstAt === undefined && !entry.stopped && entry.askedAt > Date.now() - 3_000);
        if (!playing && !asked) return;
      }
    };
    const spoken = async (turn: TurnRun) => { while (!turn.endAt || queues.get(turn.turn.speaker)!.some(entry => entry.turn === turn && entry.step.kind === "speech")) await sleep(20); };

    let previous: TurnRun | undefined;
    let previousEnd = Date.now();
    for (const [i, turn] of scenario.turns.entries()) {
      const start = turn.start;
      if ("at" in start) await sleep(run.startedAt + start.at - Date.now());
      else if ("gap" in start) await sleep(previousEnd + start.gap - Date.now());
      else if (previous) {
        await spoken(previous);
        const reply = await answerAfter(previous.endAt!);
        if ("intoBot" in start) await sleep((reply?.firstAt ?? Date.now()) + start.intoBot - Date.now());
        else {
          if (reply) await botQuiet();
          await sleep(start.afterBot);
        }
      }
      const audio = await turnAudio(scenario, i, providers === "openai" ? { apiKey: apiKey! } : undefined);
      const turnRun: TurnRun = { id: turnId(scenario.name, i), scenario: scenario.name, index: i, turn, segments: [] };
      run.turns.push(turnRun);
      const queue = queues.get(turn.speaker)!;
      for (const step of audio.steps) queue.push({ step, turn: turnRun });
      // When its speech will end, for a turn timed from it.
      const lastSpeech = audio.steps.findLastIndex(step => step.kind === "speech");
      previousEnd = Date.now() + (queue.length - (audio.steps.length - lastSpeech)) * FRAME_MS;
      previous = turnRun;
    }
    // The last turn said, its answer (if any) heard out.
    await spoken(previous!);
    await answerAfter(previous!.endAt!);
    await botQuiet();
    await sleep(1_000);
    ticking = false;
    await ticker;
    run.endedAt = Date.now();
    await voice.end(TENANT, created.id).catch(() => {});
    // The last events out of the outbox.
    await sleep(Math.min(pipeline.webhookIntervalMs, 5_000) + 300);
    run.utterances = utterances.filter(entry => entry.session === created.id);
  }
}
