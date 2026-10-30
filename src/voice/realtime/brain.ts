import { clock as nodeClock, type Clock } from "../../node-context.ts";
import { HttpError } from "../../http.ts";
import { metricLine, safeError, writeMetricLine } from "../../metrics.ts";
import type { Playback, Player } from "../../voice-speech.ts";
import type { Cut } from "../../voice-audio.ts";
import { BargeInGuard, type BargeInOutcome, type BargeInPolicy } from "../echo-guard.ts";
import { TurnClock } from "../latency.ts";
import type { Addressed, Floor } from "../turns/floor.ts";
import type { TurnEvent } from "../turns/turn-taker.ts";
import { Mixer } from "./mixer.ts";
import { NO_USAGE, realtimePrice, realtimeCost, realtimeTranscriptionCost, type RealtimeConnection, type RealtimeEvents, type RealtimeTool, type RealtimeUsage } from "./provider.ts";

/**
 * A voice session's realtime brain: a speech-to-speech model hears the call and answers aloud, behind the session's
 * media plane, turn-taking, addressing and echo guard.
 *
 * - **Audio in.** Each speaker's PCM (the media's live stream) is mixed into one (Mixer). Whenever who speaks changes,
 *   the input so far is committed as its own item and a note names who speaks next ("[Ana]"), so the model knows who
 *   said what. Echo the guard rejected, and sounds too short to be turns, are dropped rather than committed.
 * - **Turns are ours** unless the provider declares ownsTurns (ElevenLabs): then cuts count activity, the provider
 *   starts responses, and speculative commits are disabled. Otherwise the provider's turn detection is off. A turn ends when the session's segmenter cuts it (Smart
 *   Turn at a pause, or silence); the brain commits and asks for a response. With smart turns it asks at `likely_end`
 *   already (speculative), and holds the audio until the turn ends: a `resume` cancels it, unheard. While someone else
 *   is mid-turn the response waits for them (one floor).
 * - **Addressing** (#261's rules): a turn from someone alone with the bot, or in a conversation with it, is answered.
 *   Otherwise, with names, its transcript decides (named: answered; not: the model only listens); without names or a
 *   transcript, the model is told it was likely not addressed and may call `stay_silent`.
 * - **Audio out** plays on the session's connection, one response at a time. A person talking over it pauses it, and
 *   the echo guard decides: their own speech stops it, the response is cancelled, and its item is truncated at what was
 *   heard (`truncate`), so the model's history matches what people heard. Echo resumes it.
 * - **The bot's code** may have it say given words (`say`: text to speech in the call's voice, else the model reads them
 *   out), or speak up unprompted (`prompt`). Both wait their turn: behind what the bot is saying and answers people are
 *   waiting for, and for nobody to be mid-turn (unless `interrupt`). Barge-in stops them as it stops an answer, and the
 *   model hears what was said, as context. While the bot speaks, music it plays holds (`speaking`).
 * - **Tools.** `ask_agent(request)` runs the bot's agent (its tools, memory and system prompt), and the model speaks
 *   its answer; the model fills the wait itself ("let me check"). `stay_silent()` answers nothing.
 * - **Money.** Tokens, or audio duration and text items, are priced and recorded (`usage`), with end-user credit
 *   held for responses or renewed as metered audio flows. A refusal ends the session (`budget`).
 *
 * Nothing the people or the model say is logged: logs carry counts, timings and lengths.
 */

/** An ask_agent call with no request: answered to the model, never sent to the agent nor counted as its failure. */
const EMPTY_REQUEST = new Error("empty request");

export const REALTIME_LIMITS = Object.freeze({
  /** How long ask_agent waits for the agent's reply before the model is told it is still working. */
  askAgentMs: 45_000,
  /** How long a reply is waited for in all: one that comes after askAgentMs is said then (a late answer). */
  askAgentLateMs: 5 * 60_000,
  /** The most of the agent's reply the model is given. */
  agentReplyChars: 4_000,
  /** How long an unaddressed turn waits for its transcript (addressing by name) before the model decides. */
  addressWaitMs: 2_500,
  /** End-user credit held for a response or a slice of metered audio (USD), settled with what it cost. */
  holdUsd: 0.05,
  /** Reconnects to the provider within `reconnectWindowMs` before the session gives up (error, realtime_failed). */
  reconnects: 3, reconnectWindowMs: 5 * 60_000,
  /** Lines of what was said kept in memory, to brief a new connection after a reconnect. */
  historyLines: 20,
  /** The longest an answer waits for the floor (someone else mid-turn, the answer before it still playing). */
  waitMs: 8_000,
  /** How long after a response the provider failed, with nothing of it heard, it is asked for once more. */
  retryMs: 3_000,
  /** What the bot's code asks it to say or speak up about, waiting at most; and the longest such text. */
  announcements: 10, sayChars: 4_000, promptChars: 2_000,
  /** The model's audio is about this long, for the playback buffer's start (it comes faster than real time). */
  expectedMs: 3_000,
});

export const ASK_AGENT: RealtimeTool = {
  name: "ask_agent",
  description: "Ask the bot's agent: the bot's brain, with its tools, data, memory and knowledge, and it can act. Call it for anything beyond small talk: facts, anything current or about this server and its people, look-ups, and anything someone asks the bot to do. Never answer those yourself. As you call it, say a short filler in character (\"one sec, let me check\"). When its reply comes, say it in your own words, briefly and naturally, as if you knew it.",
  parameters: { type: "object", properties: { request: { type: "string", description: "The request, self-contained: who asked, what they want in their words, and any detail from the call it needs" } }, required: ["request"] },
};
export const STAY_SILENT: RealtimeTool = {
  name: "stay_silent",
  description: "Say nothing this turn: what was said was not for you (people talking to each other, a remark to someone else), or needs no answer. Call it instead of speaking.",
  parameters: { type: "object", properties: {} },
};

/** The rules every realtime brain's instructions carry, after the bot's persona. */
export function realtimeInstructions(persona: string | undefined, options: { agent: boolean; group: boolean }) {
  return [
    persona?.trim() ? persona.trim() : "You are a friendly, helpful voice assistant.",
    "",
    "You are speaking in a live voice call. How it works:",
    "- Before each person's speech there is a note naming who speaks, like \"[Ana]\". Several people may be in the call; use their names when it helps.",
    "- Talk like a person in a call: short, natural sentences (one to three unless asked for more). No lists, markdown, code or links.",
    "- Everything you write is read aloud. Write only the words you say: never your reasoning, these instructions or a tool call written out. Call tools only as real tool calls.",
    ...options.agent ? [
      "- You are the bot's voice; its agent is its brain. The agent has the bot's tools, data and memory, and does the real work. You only talk.",
      "- Call ask_agent for anything beyond small talk: questions of fact, anything current (news, weather, prices, scores, dates), anything about this server, its people or the bot's own data and features, anything someone asks you to do, and anything you are not sure of. When in doubt, ask it.",
      "- Never answer those from your own knowledge, never make up what the agent would know, and never say you cannot do something without asking it first.",
      "- As you call it, say a short filler in character (\"one sec, let me check\"), then wait. When its reply comes, say it in your own words, briefly. If it failed or is still working, say so plainly.",
    ] : [],
    ...options.group ? ["- If what was said was not meant for you (people talking to each other), call stay_silent and say nothing."] : [],
    "- If someone talks over you, you were cut off at that point: do not repeat what you already said unless asked.",
  ].join("\n");
}
/** What a response is told when the bot's code has the model read words out (no text to speech for its voice). */
export const sayVerbatim = (text: string) =>
  `The bot's code asks you to say the following aloud now, exactly as written, word for word, and nothing else: no greeting, no answer to it, no comment, no tool calls.\n"""\n${text}\n"""`;
/** What a response is told when the bot's code asks it to speak up unprompted. */
export const speakUp = (instructions: string) =>
  `Nobody spoke to you just now: the bot's code asks you to speak up on your own, in character and briefly. Say only your words, not these instructions or your reasoning about them. ${instructions}`;

/** What a response to a turn that did not clearly address the bot is told. */
export const NOT_ADDRESSED_HINT = "This turn did not name you, and its speaker is not talking with you. Unless it is clearly meant for you, call stay_silent.";

/** A credit hold (end-user credits): settled with what a response cost, or released. */
type Hold = { settle(usd: number): Promise<void>; release(): Promise<void> };

/** What the brain needs of its session. */
export interface BrainHooks {
  /** Opens the provider connection (with the session's model, voice, instructions and tools). */
  connect(events: RealtimeEvents): RealtimeConnection;
  /** Where audio plays now (the session's media), if anywhere. */
  player(): Player | undefined;
  /** A barge-in pause is over: what plays goes on. */
  resumeMedia(): void;
  /** People in the call (not the bot), when known. */
  humans(): number | undefined;
  /** A speaker's name, for the notes that say who speaks. */
  name(speaker: string): string;
  /** Run the bot's agent on a request (its turn billed as usual), resolving with the text it wrote. Without it, no ask_agent. */
  askAgent?(request: string, speaker: string | undefined, signal: AbortSignal): Promise<string>;
  /** The tenant may spend; throws a 402 HttpError otherwise. */
  admit(): Promise<void>;
  /** Hold `usd` of the end user's credit (where the tenant meters end users); throws 402 END_USER_CREDIT. */
  hold(usd: number): Promise<Hold | undefined>;
  /** The money ran out: the session ends. */
  budget(limit: "tenant" | "end_user", endUserReason?: string, bucket?: string): void;
  /** Usage: response tokens or metered audio and text items, cost (USD), and seconds of audio made. */
  usage(record: { usage: RealtimeUsage; costUsd: number; audioSeconds: number }): void;
  /** A turn was committed: its speaker, and when it was spoken (the session's counts and idle clock). */
  turn(turn: { speaker: string; startedAt: number; endedAt: number; seconds: number }): void;
  /** A committed item's transcript (voice.utterance) and what transcribing it cost. */
  heard(heard: { speaker: string; speakers: string[]; text: string; seconds: number; costUsd: number; startedAt: number; endedAt: number; addressed?: Addressed }): void;
  /** A response began playing (voice.speech.started), and ended (voice.speech.ended, with what it cost). */
  spoke(event: ({ type: "started"; id: string; latencyMs: number; turn?: TurnClock } | { type: "ended"; id: string; reason: "done" | "interrupted" | "error"; by?: string; seconds: number; costUsd: number }) & { /** Words the bot's code had it say (`say`), made by text to speech. */ say?: true }): void;
  /** The provider cannot be reached any more: the session ends. */
  failed(detail: string, error?: string): void;
  /**
   * Text to speech in the call's voice, for what the bot's code has it say: its PCM (24 kHz mono 16-bit) as it is
   * made, and `settled` with what it cost once made. Without it, or when it fails before any audio, the model reads
   * the words out itself.
   */
  synthesize?(text: string, signal: AbortSignal, settled: (costUsd: number) => void): Promise<AsyncIterable<Uint8Array>>;
  /** The bot began speaking (true), or stopped with nothing more to say for now (false): music it plays holds meanwhile. */
  speaking?(on: boolean): void;
  /** Structured log lines: never words. */
  log(type: string, fields?: Record<string, unknown>): void;
}

/** What the bot's code asked for: words said (`say`) or the model speaking up (`prompt`). */
type Announcement = { kind: "say" | "prompt"; id: string; text: string; /** Said over people mid-turn too. */ urgent?: boolean };

export type BrainOptions = {
  session: string; tenant: string;
  /** `<provider>/<model>`, for prices and logs. */
  reference: string;
  floor: Floor;
  /** Barge-in: off, or the echo guard's policy (confirmMs 0: stop at once). */
  bargeIn?: BargeInPolicy;
  /** Respond at likely_end, held until the turn ends. */
  speculative: boolean;
  /** Inputs are transcribed (the provider's `heard`), so names can address the bot. */
  transcribed: boolean;
  /**
   * The provider transcribes a turn only once it is asked to answer (Gemini): a turn only its words could address is
   * answered at once, told it may not be for the bot, and taken back before it is heard if its words say it was not.
   */
  wordsAfterAnswer?: boolean;
  /** Server VAD owns turns; local cuts only count activity. */
  ownsTurns?: boolean;
  clock?: Clock;
  /** How long before a failed response is asked for again (REALTIME_LIMITS.retryMs): tests shorten it. */
  retryMs?: number;
  /** ask_agent's waits (tests). */
  limits?: { askAgentMs?: number; askAgentLateMs?: number };
};

/** A stretch of input between commits: whose audio it holds, from when. */
type Segment = { tag: string; speakers: Set<string>; first: string; startedAt: number; endedAt: number; turn?: Turn };
/** A speaker's turn, from its first committed audio to its cut. */
type Turn = {
  speaker: string; tags: string[]; addressed?: Addressed; heard: Map<string, string>; waiters: (() => void)[];
  /** Its addressing waits for its words: what is heard of it goes out (voice.utterance) once that is decided. */
  deciding?: boolean; unsent?: Parameters<BrainHooks["heard"]>[0][];
};

/** PCM given to a playback as it comes. */
class PcmQueue implements AsyncIterable<Uint8Array> {
  private readonly chunks: Uint8Array[] = [];
  private ended = false;
  private wake?: () => void;
  bytes = 0;
  push(pcm: Uint8Array) { if (this.ended) return; this.chunks.push(pcm); this.bytes += pcm.byteLength; this.wake?.(); }
  end() { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.chunks.length) { yield this.chunks.shift()!; continue; }
      if (this.ended) return;
      await new Promise<void>(resolve => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

/** A response asked for: its turn, its audio, and how it plays. */
type Response = {
  key: number; id?: string; turn?: TurnClock; speaker?: string;
  /** Held: its audio waits (speculative, until its turn ends; or someone else is mid-turn). */
  held: boolean; speculative: boolean;
  audio: PcmQueue; said: string;
  playback?: Playback; playedAt?: number; heardMs?: number;
  done: boolean; played: boolean; cancelled?: "barge_in" | "resume" | "superseded" | "budget" | "close" | "requested";
  tool?: boolean; silent?: boolean; costUsd: number;
  hold?: Promise<Hold | undefined>;
  askedAt: number;
  /** What it was asked with: instructions for this response alone, and whether this is already the second try. */
  instructions?: string; retried: boolean;
  /** Words the bot's code had it say, made by text to speech (not the model's): its id, and how to stop making it. */
  clip?: { id: string; abort: AbortController };
};

export class RealtimeBrain {
  private readonly options: BrainOptions;
  private readonly hooks: BrainHooks;
  private readonly clock: Clock;
  private readonly mixer: Mixer;
  private connection?: RealtimeConnection;
  private closed = false;
  private meteredHold?: Promise<Hold | undefined>;
  private meteredSeconds = 0;
  private meteredTextInputs = 0;
  private meterTimer?: ReturnType<Clock["setInterval"]>;
  private reconnects: number[] = [];
  /** A failed response waiting to be asked for again. */
  private pendingRetry?: { timer: ReturnType<Clock["setTimeout"]>; turn?: TurnClock };
  private generation = 0;
  private segment?: Segment;
  private segments = new Map<string, Segment>();
  private tags = 0;
  private lastLabel?: string;
  /** Speakers mid-turn (speech started, not yet cut), and their turns so far. */
  private readonly speaking = new Set<string>();
  private readonly turns = new Map<string, Turn>();
  /** Speakers whose current utterance the echo guard said was the bot's own voice: dropped, not committed. */
  private readonly echoed = new Set<string>();
  /** Speakers who paused the bot, while the echo guard decides. */
  private readonly candidates = new Set<string>();
  /** The response being made or played, the one before it still playing, and a response waiting for the floor. */
  private current?: Response;
  private playing?: Response;
  private waitingRespond?: { speaker?: string; turn?: TurnClock; instructions?: string; at?: number };
  private keys = 0;
  /** Committed input since the last response: a turn with nothing new is not answered. */
  private fresh = false;
  private readonly agentCalls = new Set<AbortController>();
  private guard?: BargeInGuard;
  private readonly history: { who: string; text: string }[] = [];
  /** What the bot's code asked it to say or speak up about, in order, waiting for the floor. */
  private readonly announcements: Announcement[] = [];
  private announced = 0;
  readonly stats = {
    says: 0, prompts: 0,
    turns: 0, responses: 0, retried: 0, spoken: 0, speculative: 0, speculativeDiscarded: 0, superseded: 0, askAgent: 0, askAgentFailed: 0, askAgentLate: 0,
    staySilent: 0, unaddressed: 0, bargeIns: 0, echoRejected: 0, reconnects: 0, azureFallbacks: 0, costUsd: 0, inputSeconds: 0, outputSeconds: 0,
  };
  /** Where the model runs (the live connection's host: azure or openai for OpenAI's models), for the metrics. */
  private host?: string;
  /** voice_realtime_language_omitted was logged. */
  private languageOmitted = false;

  constructor(options: BrainOptions, hooks: BrainHooks) {
    this.options = options;
    this.hooks = hooks;
    this.clock = options.clock ?? nodeClock();
    this.mixer = new Mixer((pcm, speakers) => this.input(pcm, speakers), { clock: this.clock });
    if (!realtimePrice(options.reference)) throw new Error(`Realtime model ${options.reference} has no price configured`);
    this.open();
    if (this.metered) {
      // Flush quiet calls too, and replace their holds before the credit service expires them.
      this.meterTimer = this.clock.setInterval(() => this.flushMeter(), 60_000);
      this.meterTimer.unref?.();
    }
  }

  private get metered() { return "perMinute" in realtimePrice(this.options.reference)!; }

  /** Who makes a turn's audio, as voice_turn_latency names it: the provider and its model. */
  private ttsInfo() {
    const [ttsProvider, ...model] = this.options.reference.split("/");
    return { ttsProvider, ttsModel: model.join("/") };
  }

  // The call's audio -----------------------------------------------------------------

  /** A speaker started talking. */
  speechStart(speaker: string) {
    if (this.closed) return;
    this.speaking.add(speaker);
    this.echoed.delete(speaker);
    // Someone talks before the answer is heard: it waits for them (their turn may change what it should be).
    const current = this.current;
    if (!this.options.ownsTurns && current && !current.played && !current.done && !current.tool) current.held = true;
  }

  /** A speaker's audio as they speak (24 kHz mono PCM). */
  pcm(speaker: string, pcm: Uint8Array) { if (!this.closed) this.mixer.push(speaker, pcm); }

  /** A speaker's utterance was too short to keep (a cough): its audio is dropped, and what it held goes on. */
  drop(speaker: string) {
    if (this.closed) return;
    this.resumed(speaker);
    this.speaking.delete(speaker);
    this.mixer.flush();
    this.mixer.quiet(speaker);
    if (this.segment && this.segment.speakers.size === 1 && this.segment.speakers.has(speaker)) {
      this.connection?.discard();
      this.segment = undefined;
    }
    if (!this.turns.get(speaker)?.tags.length) this.turns.delete(speaker);
    this.release();
  }

  /** Turn-taking's events (smart end of turn). */
  turnEvent(event: TurnEvent) {
    if (this.closed || this.options.ownsTurns) return;
    if (event.type === "turn_end") this.guard?.ended(event.speaker, event.speechMs);
    if (event.type === "likely_end") this.likelyEnd(event.speaker, event.at - event.silenceMs);
    if (event.type === "resume") this.resumed(event.speaker);
  }

  /** A speaker's turn ended (the segmenter cut it). */
  cut(cut: Cut) {
    if (this.closed) return;
    const speaker = cut.speaker;
    this.speaking.delete(speaker);
    this.mixer.flush();
    this.mixer.quiet(speaker);
    if (cut.ended === "handoff" || cut.ended === "end") return;
    if (this.options.ownsTurns) {
      this.stats.turns++;
      this.turnDone(speaker, cut);
      return;
    }
    const echoed = this.echoed.delete(speaker);
    if (echoed) {
      // The bot's own voice through someone's speakers: not a turn.
      if (this.segment?.speakers.size === 1 && this.segment.speakers.has(speaker)) { this.connection?.discard(); this.segment = undefined; }
      this.turns.delete(speaker);
      this.release();
      return;
    }
    this.stats.turns++;
    const current = this.current;
    // Its response began at likely_end: the turn is over, so it may be heard.
    if (current?.speculative && current.speaker === speaker && !current.cancelled) {
      this.commitSegment();
      current.speculative = false;
      current.turn?.mark("turnCommit");
      this.turnDone(speaker, cut);
      this.release();
      return;
    }
    this.commitSegment();
    this.turnDone(speaker, cut);
    const turnSoFar = this.turns.get(speaker);
    // Said over the bot while it plays (a backchannel, or with barge-in off): kept as context, not answered.
    if (this.playing && !this.playing.cancelled) { this.turns.delete(speaker); return; }
    if (!this.fresh) { this.turns.delete(speaker); return; }
    const turn = new TurnClock(cut.endedAt, { session: this.options.session, tenant: this.options.tenant, ...this.ttsInfo(), speculative: false }).via("realtime").mark("turnCommit");
    // A response held for this speaker's turn is replaced by one that hears it.
    if (current && !current.played && !current.tool && !current.cancelled && !current.clip) this.supersede(current);
    void this.decide(speaker, turnSoFar, turn);
  }

  /** A person talked over the bot for minMs: the media paused (or stopped) what plays. */
  bargeIn(speaker: string, speechMs: number, startedAt?: number) {
    if (this.closed) return;
    const policy = this.options.bargeIn;
    if (!policy) return;
    const guard = this.guardOf();
    if (!guard) {
      if (this.playing) this.interrupt({ type: "confirmed", why: "immediate", pausedMs: 0, speechMs });
      return;
    }
    // In a group whose turns the floor sorts, only someone the bot is talking with stops it: people talking among
    // themselves (turns it would ignore) don't cut it off mid-word, with nothing said after.
    if (!this.options.floor.standing(speaker, this.hooks.humans())) {
      this.hooks.log("voice_barge_in_ignored", { brain: "realtime", why: "not_addressed", speechMs });
      this.hooks.resumeMedia();
      return;
    }
    if (guard.candidate(speaker, speechMs, startedAt)) this.candidates.add(speaker);
    else this.hooks.resumeMedia();
  }

  /** More speech from a speaker who paused the bot. */
  speechProgress(speaker: string, speechMs: number) { this.guard?.progress(speaker, speechMs); }

  /** Whether the bot is saying something now. */
  get speakingNow() { return !!this.playing && !this.playing.cancelled; }

  /** Stop what the bot is saying, and what it was about to (DELETE …/speak): answers how many responses stopped. */
  stopSpeaking() {
    let stopped = 0;
    for (const response of new Set([this.playing, this.current])) {
      if (!response || response.cancelled || (response.done && !response.audio.bytes)) continue;
      const heardMs = response.playedAt === undefined ? 0 : Math.min(response.audio.bytes / 48, this.clock.now() - response.playedAt);
      this.cancel(response, "requested", heardMs);
      stopped++;
    }
    this.waitingRespond?.turn?.end("interrupted");
    this.waitingRespond = undefined;
    stopped += this.announcements.splice(0).length;
    return stopped;
  }

  /**
   * Say `text` (the bot's code): made by text to speech in the call's voice (`synthesize`), else read out by the model.
   * It waits behind what the bot is saying and answers people wait for, and for nobody to be mid-turn; `interrupt`
   * cuts off what the bot is saying (and what waits) and says it now. Answers its id and how many are ahead of it.
   */
  say(text: string, options: { interrupt?: boolean } = {}) {
    return this.announce({ kind: "say", text: text.slice(0, REALTIME_LIMITS.sayChars) }, options.interrupt);
  }

  /** Speak up unprompted (the bot's code): the model answers `instructions` once the floor is free, as `say` waits. */
  prompt(instructions: string, options: { interrupt?: boolean } = {}) {
    return this.announce({ kind: "prompt", text: instructions.slice(0, REALTIME_LIMITS.promptChars) }, options.interrupt);
  }

  private announce(request: Omit<Announcement, "id">, interrupt?: boolean) {
    if (this.closed) throw new HttpError(409, "The voice session ended");
    if (interrupt) this.stopSpeaking();
    if (this.announcements.length >= REALTIME_LIMITS.announcements) throw new HttpError(429, `At most ${REALTIME_LIMITS.announcements} things wait to be said: wait, or interrupt`, "VOICE_SAY_QUEUE_FULL");
    const id = `say_${this.options.session.slice(3, 11)}_${++this.announced}`;
    const queued = this.announcements.length + (this.current && !this.current.cancelled ? 1 : 0) + (this.waitingRespond ? 1 : 0);
    this.announcements.push({ ...request, id, ...(interrupt ? { urgent: true } : {}) });
    this.next();
    return { id, queued };
  }

  /** The first of what the bot's code asked for, if the floor is free: said, or the model asked. */
  private next() {
    if (this.closed || !this.announcements.length) return;
    // A response being made, held or played goes first, and an answer waiting for the floor.
    if (this.current || (this.playing && !this.playing.cancelled) || this.waitingRespond) return;
    if (!this.announcements[0].urgent && this.speaking.size) return;
    const item = this.announcements.shift()!;
    this.hooks.log("voice_realtime_announcement", { kind: item.kind, chars: item.text.length, tts: item.kind === "say" && !!this.hooks.synthesize });
    if (item.kind === "prompt") { this.stats.prompts++; this.respondNow({ instructions: speakUp(item.text) }); return; }
    this.stats.says++;
    if (!this.hooks.synthesize) { this.respondNow({ instructions: sayVerbatim(item.text) }); return; }
    this.clip(item);
  }

  /** Ask the model now (the floor is free), however the provider takes turns. */
  private respondNow(request: { instructions: string }) {
    if (this.options.ownsTurns) { this.connection?.respond(request); return; }
    this.ask({ ...request, held: false, speculative: false });
  }

  /** Words made by text to speech, played as a response is: barge-in, stopSpeaking and the queue treat it as one. */
  private clip(item: Announcement) {
    const response = this.response({});
    const abort = new AbortController();
    response.clip = { id: item.id, abort };
    response.said = item.text;
    this.current = response;
    void (async () => {
      let heard = false;
      try {
        const pcm = await this.hooks.synthesize!(item.text, abort.signal, costUsd => { response.costUsd = costUsd; this.stats.costUsd += costUsd; });
        for await (const chunk of pcm) {
          if (response.cancelled || this.closed) break;
          heard = true;
          response.audio.push(chunk);
          this.play(response);
        }
      } catch (error) {
        if (!response.cancelled && !this.closed) this.hooks.log("voice_realtime_say_failed", { error: safeError(error), audio: heard });
        // Nothing made: the model reads the words out instead.
        if (!heard && !response.cancelled && !this.closed) {
          response.done = true;
          if (this.current === response) this.current = undefined;
          this.respondNow({ instructions: sayVerbatim(item.text) });
          return;
        }
      }
      response.done = true;
      response.audio.end();
      if (this.current === response && (response.cancelled || !response.audio.bytes)) this.current = undefined;
      this.release();
    })();
  }

  /** The session ended or moved: nothing more is said, the agent's runs are let go, the stats are logged. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.clock.clearInterval(this.meterTimer);
    this.mixer.close();
    this.guard?.close();
    for (const call of this.agentCalls) call.abort();
    this.announcements.splice(0);
    this.dropRetry("interrupted");
    for (const response of [this.current, this.playing]) {
      if (!response) continue;
      response.clip?.abort.abort();
      response.cancelled ??= "close";
      response.audio.end();
      response.playback?.stop();
      if (!response.done) void response.hold?.then(hold => hold?.release()).catch(() => {});
      response.turn?.end("interrupted");
    }
    for (const turn of this.turns.values()) for (const wake of turn.waiters) wake();
    this.connection?.close();
    this.generation++;
    if (this.metered) this.flushMeter();
    const { costUsd, ...counts } = this.stats;
    this.hooks.log("voice_realtime_stats", { ...counts, costUsd: Math.round(costUsd * 1_000_000) / 1_000_000 });
    // Host: where the last live connection ran (azure or openai for OpenAI's models, else the provider), so the split shows.
    writeMetricLine(metricLine("voice_realtime", {
      dimensions: { Host: this.host ?? this.ttsInfo().ttsProvider }, rollups: [[], ["Host"]],
      metrics: {
        VoiceRealtimeTurns: this.stats.turns, VoiceRealtimeResponses: this.stats.responses, VoiceRealtimeAskAgent: this.stats.askAgent,
        VoiceRealtimeStaySilent: this.stats.staySilent, VoiceRealtimeBargeIns: this.stats.bargeIns, VoiceRealtimeSpeculativeDiscarded: this.stats.speculativeDiscarded,
        VoiceRealtimeAzureFallbacks: this.stats.azureFallbacks,
      },
      properties: { session: this.options.session, tenant: this.options.tenant, reference: this.options.reference },
    }));
  }

  // The provider ---------------------------------------------------------------------

  private open() {
    const connect = () => {
      if (this.closed) return;
      this.connection = this.hooks.connect(this.events());
      // A new connection after a reconnect: what was said before, as context.
      if (this.history.length) this.connection.note(`[Earlier in this call]\n${this.history.map(line => `${line.who}: ${line.text}`).join("\n")}`);
      this.segment = undefined;
      this.lastLabel = undefined;
      this.lastSpeaker = undefined;
      this.providerTurn = undefined;
      this.providerAnswered = undefined;
    };
    if (this.metered) {
      this.meteredHold ??= this.creditHold();
      void this.meteredHold.then(() => {
        try { connect(); } catch (error) { this.hooks.failed("realtime_failed", safeError(error)); }
      }).catch(() => {});
    } else connect();
  }

  private async creditHold() {
    try {
      await this.hooks.admit();
      return await this.hooks.hold(REALTIME_LIMITS.holdUsd);
    } catch (error) {
      const refused = error as HttpError;
      if (refused.status === 402) {
        const endUser = refused.code === "END_USER_CREDIT";
        this.hooks.budget(endUser ? "end_user" : "tenant", endUser ? refused.details?.reason as string : undefined, endUser ? refused.details?.bucket as string : undefined);
      } else this.hooks.failed("realtime_credit_failed");
      throw error;
    }
  }

  /** Manual-turn providers meter all audio on the wire, even discarded input and cancelled output. */
  private meter(seconds: number, textInputs: number) {
    this.meteredSeconds += seconds;
    this.meteredTextInputs += textInputs;
    if (realtimeCost(this.options.reference, NO_USAGE, this.meteredSeconds, this.meteredTextInputs) >= REALTIME_LIMITS.holdUsd / 2) this.flushMeter();
  }

  private flushMeter(usage: RealtimeUsage = NO_USAGE, audioSeconds = 0) {
    const costUsd = realtimeCost(this.options.reference, usage, this.meteredSeconds, this.meteredTextInputs);
    this.meteredSeconds = 0;
    this.meteredTextInputs = 0;
    this.stats.costUsd += costUsd;
    if (costUsd || usage !== NO_USAGE) this.hooks.usage({ usage, costUsd, audioSeconds });
    const hold = this.meteredHold;
    const closing = this.closed;
    this.meteredHold = (async () => {
      const credit = await hold;
      if (costUsd > 0) await credit?.settle(costUsd);
      else await credit?.release();
      return closing ? undefined : this.creditHold();
    })();
    void this.meteredHold.catch(error => {
      if ((error as HttpError)?.status === 402) return;
      this.hooks.log("voice_realtime_credit_failed", { error: safeError(error) });
      if (!this.closed) this.hooks.failed("realtime_credit_failed");
    });
    return costUsd;
  }

  private events(): RealtimeEvents {
    // A connection replaced (reconnected) says nothing more to this brain.
    const generation = ++this.generation;
    const live = () => !this.closed && generation === this.generation;
    return {
      ready: () => {
        if (!live()) return;
        this.host = this.connection?.host ?? this.ttsInfo().ttsProvider;
        this.hooks.log("voice_realtime_ready", { host: this.host });
      },
      // Azure refused or failed before the connection was live: it goes on on OpenAI (voice/realtime/openai.ts).
      fallback: detail => {
        if (!live()) return;
        this.stats.azureFallbacks++;
        this.hooks.log("voice_realtime_azure_fallback", { reason: detail.slice(0, 300) });
      },
      // Once a session: a reconnect leaves it out again, saying so again.
      language: detail => {
        if (!live() || this.languageOmitted) return;
        this.languageOmitted = true;
        this.hooks.log("voice_realtime_language_omitted", { reason: detail.slice(0, 300) });
      },
      // close() may report its final billable interval after playback has stopped.
      meter: (seconds, textInputs) => { if (generation === this.generation && this.metered) this.meter(seconds, textInputs); },
      // Responses are asked for one at a time (each after the one before is done): this is the one asked for last.
      responseStarted: id => {
        if (!live()) return;
        if (this.options.ownsTurns) {
          const speaker = this.segment?.first ?? this.lastSpeaker;
          const segment = this.segment !== this.providerAnswered ? this.segment : undefined;
          const turn = this.providerTurn ?? (segment ? new TurnClock(segment.endedAt, { session: this.options.session, tenant: this.options.tenant, ...this.ttsInfo(), speculative: false }).via("realtime") : undefined);
          this.providerTurn = undefined;
          this.providerAnswered = this.segment;
          const response = this.response({ speaker, turn: turn && !turn.ended ? turn : undefined });
          response.id = id;
          this.current = response;
          this.stats.responses++;
          this.reserve(response);
        } else if (this.current && !this.current.id && !this.current.clip) this.current.id = id;
      },
      interrupted: () => {
        // With barge-in off, people talking over the bot never stop it.
        if (!live() || !this.options.bargeIn) return;
        this.interrupt({ type: "confirmed", why: "immediate", pausedMs: 0, speechMs: 0 });
        this.stopSpeaking();
      },
      audio: (id, pcm) => {
        if (!live()) return;
        const response = this.byId(id);
        if (!response || response.cancelled) return;
        if (!response.audio.bytes) response.turn?.mark("ttsFirstAudio");
        response.audio.push(pcm);
        this.play(response);
      },
      said: (id, text) => {
        const response = this.byId(id);
        if (response) response.said += text;
      },
      toolCall: call => { if (live()) this.tool(call); },
      responseDone: (id, outcome) => { if (live()) this.responseDone(id, outcome); },
      heard: (tag, text, seconds) => {
        if (!live()) return;
        if (this.options.ownsTurns) {
          const segment = this.segment;
          this.segment = undefined;
          if (!segment) return;
          this.lastSpeaker = segment.first;
          if (segment !== this.providerAnswered) {
            this.providerTurn?.end("no_reply");
            this.providerTurn = new TurnClock(segment.endedAt, { session: this.options.session, tenant: this.options.tenant, ...this.ttsInfo(), speculative: false }).via("realtime").mark("turnCommit");
          }
          this.providerAnswered = undefined;
          this.stats.inputSeconds += seconds;
          this.remember(this.hooks.name(segment.first), text);
          if (this.options.transcribed) this.hooks.heard({ speaker: segment.first, speakers: [...segment.speakers], text, seconds, costUsd: 0, startedAt: segment.startedAt, endedAt: segment.endedAt });
        } else this.heardItem(tag, text, seconds);
      },
      // The provider's own words about what it refused (no audio or transcript in them).
      warning: (code, detail) => { if (live()) this.hooks.log("voice_realtime_warning", { errorCode: code, detail: detail.slice(0, 200) }); },
      closed: (reason, detail, options) => { if (reason !== "requested" && live()) this.lost(detail ?? "closed", options?.retryable); },
    };
  }

  /** The connection dropped: reconnect (a new conversation, briefed with what was said), a few times at most. */
  private lost(detail: string, retryable = true) {
    if (this.metered) { this.generation++; this.connection = undefined; this.flushMeter(); }
    const now = this.clock.now();
    this.reconnects = [...this.reconnects.filter(at => now - at < REALTIME_LIMITS.reconnectWindowMs), now];
    const retrying = retryable && this.reconnects.length <= REALTIME_LIMITS.reconnects;
    this.hooks.log("voice_realtime_lost", { detail: safeError(detail), attempt: this.reconnects.length, retrying });
    for (const response of [this.current, this.playing]) {
      if (!response || response.done) continue;
      response.done = true;
      response.audio.end();
      if (!response.played) { response.turn?.end("error"); this.settle(response, 0); }
    }
    this.current = undefined;
    if (!retrying) { this.hooks.failed("realtime_failed", safeError(detail)); return; }
    this.stats.reconnects++;
    this.open();
  }

  private byId(id: string) {
    if (this.current?.id === id) return this.current;
    if (this.playing?.id === id) return this.playing;
    return undefined;
  }

  // Input ----------------------------------------------------------------------------

  private lastSpeaker?: string;
  private providerTurn?: TurnClock;
  private providerAnswered?: Segment;

  /** Mixed audio: manual providers commit speaker changes; server VAD gets labels around one stream. */
  private input(pcm: Uint8Array, speakers: string[]) {
    const connection = this.connection;
    if (!connection) return;
    const now = this.clock.now();
    const segment = this.segment;
    if (!segment || speakers.some(speaker => !segment.speakers.has(speaker))) {
      if (segment && !this.options.ownsTurns) this.commitSegment();
      this.segment = this.options.ownsTurns && segment ? { ...segment, speakers: new Set([...segment.speakers, ...speakers]) } : { tag: `t${++this.tags}`, speakers: new Set(speakers), first: speakers[0], startedAt: now, endedAt: now };
    }
    if (this.options.ownsTurns || this.segment !== segment) {
      const label = speakers.length === 1 ? `[${this.hooks.name(speakers[0])}]` : `[${speakers.map(speaker => this.hooks.name(speaker)).join(" and ")}, at once]`;
      if (label !== this.lastLabel) { connection.note(label); this.lastLabel = label; }
    }
    this.segment!.endedAt = now;
    connection.append(pcm);
  }

  /** Keep the input so far as an item, for the turns of the speakers in it. */
  private commitSegment() {
    const segment = this.segment;
    this.segment = undefined;
    if (!segment || !this.connection) return false;
    const seconds = this.connection.pendingMs / 1_000;
    if (!this.connection.commit(segment.tag)) return false;
    this.fresh = true;
    this.stats.inputSeconds += seconds;
    this.segments.set(segment.tag, segment);
    for (const speaker of segment.speakers) {
      const turn: Turn = this.turns.get(speaker) ?? { speaker, tags: [], heard: new Map(), waiters: [] };
      turn.tags.push(segment.tag);
      this.turns.set(speaker, turn);
      if (speaker === segment.first) segment.turn = turn;
    }
    // Old segments whose transcripts never came are forgotten.
    while (this.segments.size > 50) this.segments.delete(this.segments.keys().next().value!);
    return true;
  }

  /** A speaker's turn is over: counted (the session's idle clock), and forgotten once its words are in. */
  private turnDone(speaker: string, cut: Cut) {
    this.hooks.turn({ speaker, startedAt: cut.startedAt, endedAt: cut.endedAt, seconds: cut.seconds });
  }

  private heardItem(tag: string, text: string, seconds: number) {
    const segment = this.segments.get(tag);
    if (!segment) return;
    this.segments.delete(tag);
    const costUsd = seconds > 0 && !this.metered ? realtimeTranscriptionCost(seconds) : 0;
    this.stats.costUsd += costUsd;
    const turn = segment.turn;
    if (turn) { turn.heard.set(tag, text); for (const wake of turn.waiters.splice(0)) wake(); }
    if (text) this.remember(this.hooks.name(segment.first), text);
    const heard = { speaker: segment.first, speakers: [...segment.speakers], text, seconds, costUsd, startedAt: segment.startedAt, endedAt: segment.endedAt };
    if (turn?.deciding && !turn.addressed) { (turn.unsent ??= []).push(heard); return; }
    this.hooks.heard({ ...heard, addressed: turn?.addressed ?? this.standing(segment.first) });
  }

  /** Whether a speaker's turn is the bot's, as far as it is known without its words. */
  private standing(speaker: string): Addressed {
    const reason = this.options.floor.standing(speaker, this.hooks.humans());
    return { addressed: !!reason, reason: reason ?? "not_addressed" };
  }

  private remember(who: string, text: string) {
    this.history.push({ who, text: text.slice(0, 300) });
    while (this.history.length > REALTIME_LIMITS.historyLines) this.history.shift();
  }

  // Turns and responses ----------------------------------------------------------------

  /** Likely done: with speculation on, the response begins now, held until the turn ends. */
  private likelyEnd(speaker: string, speechEnd: number) {
    if (!this.options.speculative || this.current || this.playing || this.waitingRespond) return;
    if ([...this.speaking].some(other => other !== speaker)) return;
    if (!this.options.floor.standing(speaker, this.hooks.humans())) return;
    this.mixer.flush();
    if (!this.commitSegment() && !this.fresh) return;
    const turn = new TurnClock(speechEnd, { session: this.options.session, tenant: this.options.tenant, ...this.ttsInfo(), speculative: true }).via("realtime");
    this.stats.speculative++;
    this.ask({ speaker, turn, held: true, speculative: true });
  }

  /** They went on talking: a response begun at likely_end is taken back, unheard. */
  private resumed(speaker: string) {
    const current = this.current;
    if (!current?.speculative || current.speaker !== speaker || current.played) return;
    this.stats.speculativeDiscarded++;
    this.cancel(current, "resume", 0);
  }

  /** Whether `speaker`'s turn is the bot's, then answered (or only listened to). */
  private async decide(speaker: string, turn: Turn | undefined, clock: TurnClock) {
    const floor = this.options.floor;
    const humans = this.hooks.humans();
    const standing = floor.standing(speaker, humans);
    let addressed: Addressed | undefined;
    if (standing) addressed = floor.decide(speaker, "", humans);
    else if (this.options.transcribed && floor.policy.names.length && turn && this.options.wordsAfterAnswer) {
      this.respond({ speaker, turn: clock, instructions: NOT_ADDRESSED_HINT });
      turn.deciding = true;
      const text = await this.words(turn);
      if (this.closed) return;
      turn.addressed = text === undefined ? this.standing(speaker) : floor.decide(speaker, text, humans);
      for (const heard of turn.unsent?.splice(0) ?? []) this.hooks.heard({ ...heard, addressed: turn.addressed });
      this.turns.delete(speaker);
      if (text === undefined || turn.addressed.addressed) return;
      // Not the bot's: its answer is taken back, unheard (or not asked for, if it was still waiting).
      this.stats.unaddressed++;
      if (this.waitingRespond?.turn === clock) { this.waitingRespond = undefined; clock.end("no_reply"); }
      const current = this.current;
      if (current?.turn === clock && !current.played && !current.cancelled) this.cancel(current, "superseded", 0);
      return;
    }
    else if (this.options.transcribed && floor.policy.names.length && turn) {
      // Only its words can say: wait (briefly) for its transcript.
      turn.deciding = true;
      const text = await this.words(turn);
      if (this.closed) return;
      if (text !== undefined) addressed = floor.decide(speaker, text, humans);
    }
    if (turn) {
      turn.addressed = addressed ?? this.standing(speaker);
      for (const heard of turn.unsent?.splice(0) ?? []) this.hooks.heard({ ...heard, addressed: turn.addressed });
    }
    this.turns.delete(speaker);
    if (addressed && !addressed.addressed) {
      this.stats.unaddressed++;
      clock.end("no_reply");
      return;
    }
    this.respond({ speaker, turn: clock, ...(addressed ? {} : { instructions: NOT_ADDRESSED_HINT }) });
  }

  /** A turn's words, once all its items are transcribed, or undefined after addressWaitMs. */
  private async words(turn: Turn): Promise<string | undefined> {
    const deadline = this.clock.now() + REALTIME_LIMITS.addressWaitMs;
    while (!this.closed && turn.tags.some(tag => !turn.heard.has(tag))) {
      const left = deadline - this.clock.now();
      if (left <= 0) return undefined;
      await new Promise<void>(resolve => {
        const timer = this.clock.setTimeout(resolve, left);
        turn.waiters.push(() => { this.clock.clearTimeout(timer); resolve(); });
      });
    }
    return turn.tags.map(tag => turn.heard.get(tag) ?? "").join(" ").trim();
  }

  /** Answer: now, or once the floor is free and the response before has finished. */
  private respond(request: { speaker?: string; turn?: TurnClock; instructions?: string; retried?: boolean }) {
    if (this.closed) return;
    if (this.options.ownsTurns) { this.connection?.respond(request.instructions ? { instructions: request.instructions } : {}); return; }
    const busy = (this.current && !this.current.done) || [...this.speaking].length > 0;
    if (busy) {
      // One waits at most: a newer turn's replaces it (the model hears both).
      this.waitingRespond?.turn?.end("no_reply");
      this.waitingRespond = { ...request, at: this.clock.now() };
      return;
    }
    // One waiting is answered by this one too: the model hears everything so far.
    if (this.waitingRespond) { this.waitingRespond.turn?.end("no_reply"); this.waitingRespond = undefined; }
    this.ask({ ...request, held: false, speculative: false });
  }

  private ask(request: { speaker?: string; turn?: TurnClock; instructions?: string; held: boolean; speculative: boolean; retried?: boolean }) {
    const connection = this.connection;
    if (!connection) { request.turn?.end("error"); return; }
    // Any new answer hears everything so far, what the failed one was to answer too.
    this.dropRetry("no_reply");
    const response = this.response(request);
    this.current = response;
    this.fresh = false;
    this.lastLabel = undefined;
    this.stats.responses++;
    connection.respond(request.instructions ? { instructions: request.instructions } : {});
    this.reserve(response);
  }

  private reserve(response: Response) {
    if (this.metered) return;
    // The money is checked alongside, not before: a refusal cancels it (nothing is heard), and ends the session.
    response.hold = (async () => {
      await this.hooks.admit();
      return this.hooks.hold(REALTIME_LIMITS.holdUsd);
    })();
    response.hold.catch((refused: HttpError) => {
      if (refused?.status !== 402) { this.hooks.log("voice_realtime_hold_failed", { error: safeError(refused) }); return; }
      this.cancel(response, "budget", 0);
      const endUser = refused.code === "END_USER_CREDIT";
      const reason = refused.details?.reason;
      const bucket = refused.details?.bucket;
      this.hooks.budget(endUser ? "end_user" : "tenant", endUser && typeof reason === "string" ? reason : undefined, endUser && typeof bucket === "string" ? bucket : undefined);
    });
  }

  private response(request: { speaker?: string; turn?: TurnClock; instructions?: string; held?: boolean; speculative?: boolean; retried?: boolean }): Response {
    return {
      key: ++this.keys, ...(request.turn ? { turn: request.turn } : {}), ...(request.speaker ? { speaker: request.speaker } : {}),
      held: !!request.held, speculative: !!request.speculative, audio: new PcmQueue(), said: "", done: false, played: false, costUsd: 0, askedAt: this.clock.now(),
      ...(request.instructions ? { instructions: request.instructions } : {}), retried: !!request.retried,
    };
  }

  /** The floor may be free: a held response plays, or a waiting one is asked for. */
  private release() {
    if (this.closed || this.speaking.size) return;
    const current = this.current;
    if (current && current.held && !current.speculative && !current.cancelled) {
      current.held = false;
      if (current.audio.bytes) this.play(current);
    }
    if (this.waitingRespond && !(this.current && !this.current.done)) {
      const { at, ...request } = this.waitingRespond;
      this.waitingRespond = undefined;
      // An answer that waited too long would answer what is no longer being talked about: the next turn will be.
      if (at !== undefined && this.clock.now() - at > REALTIME_LIMITS.waitMs) request.turn?.end("no_reply");
      else this.ask({ ...request, held: false, speculative: false });
    }
    // Then what the bot's code asked it to say.
    this.next();
  }

  /** A response not yet heard that a newer turn replaces. */
  private supersede(response: Response) {
    this.stats.superseded++;
    if (response.speculative) this.stats.speculativeDiscarded++;
    this.cancel(response, "superseded", 0);
  }

  /** Stop a response: the provider's cancelled (if it is still making it), and its item cut at what was heard. */
  private cancel(response: Response, why: NonNullable<Response["cancelled"]>, heardMs: number) {
    if (response.cancelled) return;
    response.cancelled = why;
    response.heardMs = heardMs;
    response.audio.end();
    response.playback?.stop();
    if (response.clip) {
      response.clip.abort.abort();
      response.done = true;
    } else if (!response.done) this.connection?.cancel();
    if (response.id && (response.audio.bytes || response.played)) this.connection?.truncate(response.id, heardMs);
    if (!response.played) response.turn?.end(why === "resume" || why === "superseded" ? "interrupted" : why === "budget" ? "error" : "interrupted");
    if (this.current === response && response.done) this.current = undefined;
  }

  /** Play a response's audio: once it is not held, after the response before has finished playing. */
  private play(response: Response) {
    if (response.held || response.cancelled || response.playback || this.closed) return;
    if (this.playing && this.playing !== response) return;
    const player = this.hooks.player();
    if (!player) return;
    this.playing = response;
    this.hooks.speaking?.(true);
    const id = response.clip?.id ?? `rt_${this.options.session.slice(3, 11)}_${response.key}`;
    response.playback = player.play(response.audio, () => {
      response.played = true;
      response.playedAt = this.clock.now();
      const turn = response.turn && !response.turn.ended ? response.turn : undefined;
      turn?.mark("firstPacket").end("spoken");
      this.stats.spoken++;
      if (response.speaker) this.options.floor.answered(response.speaker);
      this.hooks.spoke({ type: "started", id, latencyMs: Math.round(this.clock.now() - response.askedAt), ...(turn ? { turn } : {}), ...(response.clip ? { say: true as const } : {}) });
    }, REALTIME_LIMITS.expectedMs);
    void response.playback.done.then(result => {
      if (this.playing === response) this.playing = undefined;
      if (this.current === response && response.done) this.current = undefined;
      const seconds = Math.round(response.audio.bytes / 48 / 10) / 100;
      this.stats.outputSeconds += seconds;
      if (response.said) this.remember("You", response.cancelled ? `${spokenPart(response)}… (cut off)` : response.said);
      // Words the model didn't make: it hears that the bot said them (what was heard of them).
      if (response.clip && response.played && response.said) {
        this.connection?.note(`[You said this aloud just now, as the bot's code had you say it${response.cancelled ? ", and were cut off" : ""}] ${response.cancelled ? spokenPart(response) : response.said}`);
      }
      const by = response.cancelled === "resume" ? "superseded" : response.cancelled === "close" ? "end" : response.cancelled;
      if (response.played) this.hooks.spoke({ type: "ended", id, reason: response.cancelled ? "interrupted" : result === "error" ? "error" : "done", ...(by ? { by } : {}), seconds, costUsd: response.costUsd, ...(response.clip ? { say: true as const } : {}) });
      // The next response's audio may be waiting for this one to end.
      if (this.current && this.current !== response) this.play(this.current);
      this.release();
      if (!this.playing) this.hooks.speaking?.(false);
    });
  }

  private responseDone(id: string, outcome: { status: string; usage: RealtimeUsage; error?: string }) {
    const response = this.byId(id) ?? (this.current && !this.current.id && !this.current.clip ? this.current : undefined);
    const costUsd = this.metered ? this.flushMeter(outcome.usage, (response?.audio.bytes ?? 0) / 48_000) : realtimeCost(this.options.reference, outcome.usage);
    if (!this.metered) {
      this.stats.costUsd += costUsd;
      this.hooks.usage({ usage: outcome.usage, costUsd, audioSeconds: outcome.usage.outputAudio / 20 });
    }
    if (outcome.status === "failed") this.hooks.log("voice_realtime_response_failed", { ...(outcome.error ? { error: outcome.error } : {}) });
    if (!response) return;
    response.done = true;
    response.costUsd = costUsd;
    response.audio.end();
    this.settle(response, costUsd);
    if (!response.audio.bytes && outcome.status === "failed" && this.retries(response)) this.retry(response);
    else if (!response.audio.bytes) response.turn?.end(response.silent ? "silent" : response.cancelled ? "interrupted" : outcome.status === "failed" ? "error" : "no_reply");
    // Done making: one with audio left to play stays current until it has played (or is held, until it may).
    if (this.current === response && (response.cancelled || !response.audio.bytes)) this.current = undefined;
    this.release();
  }

  /**
   * A failed response no one heard is asked for once more, or the person hears nothing and has to ask again: Azure
   * refuses some for a moment ("too many tokens", docs/operations/voice-pipeline.md). A speculative one needs no second
   * try, as its turn's end asks anyway, and an answer that has waited too long would answer what has moved on.
   */
  private retries(response: Response) {
    return !response.retried && !response.cancelled && !response.silent && !response.tool && !response.speculative && !response.clip && !this.options.ownsTurns
      && this.clock.now() - response.askedAt <= REALTIME_LIMITS.waitMs;
  }

  private retry(response: Response) {
    this.stats.retried++;
    const { speaker, turn, instructions } = response;
    const timer = this.clock.setTimeout(() => {
      this.pendingRetry = undefined;
      this.respond({ ...(speaker ? { speaker } : {}), ...(turn ? { turn } : {}), ...(instructions ? { instructions } : {}), retried: true });
    }, this.options.retryMs ?? REALTIME_LIMITS.retryMs);
    this.pendingRetry = { timer, ...(turn ? { turn } : {}) };
  }

  /** A retry not yet asked for is not needed after all. */
  private dropRetry(outcome: "no_reply" | "interrupted") {
    if (!this.pendingRetry) return;
    this.clock.clearTimeout(this.pendingRetry.timer);
    this.pendingRetry.turn?.end(outcome);
    this.pendingRetry = undefined;
  }

  private settle(response: Response, usd: number) {
    void response.hold?.then(hold => hold && (usd > 0 ? hold.settle(usd) : hold.release()))
      .catch(error => { if ((error as HttpError)?.status !== 402) this.hooks.log("voice_realtime_credit_failed", { error: safeError(error) }); });
  }

  // Tools ------------------------------------------------------------------------------

  private tool(call: { response: string; id: string; name: string; args: Record<string, unknown> }) {
    const response = this.byId(call.response);
    const connection = this.connection;
    if (!connection) return;
    if (call.name === STAY_SILENT.name) {
      this.stats.staySilent++;
      if (response) response.silent = true;
      connection.toolResult(call.id, JSON.stringify({ ok: true }));
      this.hooks.log("voice_realtime_tool", { tool: "stay_silent" });
      return;
    }
    if (call.name !== ASK_AGENT.name || !this.hooks.askAgent) {
      connection.toolResult(call.id, JSON.stringify({ error: `No tool named ${call.name}` }));
      // Its answer: the model says it could not.
      if (response) response.tool = true;
      this.respond({});
      return;
    }
    this.stats.askAgent++;
    if (response) {
      response.tool = true;
      if (response.turn) response.turn.info.askAgent = true;
    }
    const request = typeof call.args.request === "string" ? call.args.request.slice(0, 4_000) : "";
    const speaker = response?.speaker;
    const abort = new AbortController();
    this.agentCalls.add(abort);
    const limits = { ...REALTIME_LIMITS, ...this.options.limits };
    const started = this.clock.now();
    // Past askAgentMs the model is told the agent is still working (and says so); its reply is said when it comes.
    let late = false;
    const waiting = this.clock.setTimeout(() => {
      if (this.closed || this.connection !== connection) return;
      late = true;
      connection.toolResult(call.id, JSON.stringify({ pending: "The agent is still working on it. Say it is taking a moment and you will tell them when it is done." }));
      this.respond({ ...(speaker ? { speaker } : {}) });
    }, limits.askAgentMs);
    const timer = this.clock.setTimeout(() => abort.abort(new Error("timeout")), limits.askAgentLateMs);
    void (async () => {
      let reply: string | undefined, outcome: "ok" | "late" | "timeout" | "error" | "empty";
      try {
        // A call without a request (the model's slip, not the agent's failure): the model is told to say what to ask.
        if (!request.trim()) throw EMPTY_REQUEST;
        reply = (await this.hooks.askAgent!(request, speaker, abort.signal)).trim().slice(0, REALTIME_LIMITS.agentReplyChars);
        outcome = late ? "late" : "ok";
      } catch (error) {
        const timedOut = abort.signal.aborted && !this.closed;
        outcome = error === EMPTY_REQUEST ? "empty" : timedOut ? "timeout" : "error";
        if (outcome !== "empty") this.stats.askAgentFailed++;
        if (outcome === "error" && !this.closed) this.hooks.log("voice_realtime_ask_agent_failed", { error: safeError(error) });
      } finally {
        this.clock.clearTimeout(waiting);
        this.clock.clearTimeout(timer);
        this.agentCalls.delete(abort);
      }
      if (outcome === "late") this.stats.askAgentLate++;
      const ms = Math.round(this.clock.now() - started);
      this.hooks.log("voice_realtime_tool", { tool: "ask_agent", outcome, ms, requestChars: request.length, ...(reply !== undefined ? { replyChars: reply.length } : {}) });
      writeMetricLine(metricLine("voice_realtime_ask_agent", {
        dimensions: { Provider: this.ttsInfo().ttsProvider, Outcome: outcome }, rollups: [[], ["Provider"], ["Outcome"]], metrics: { VoiceAskAgentMs: [ms, "Milliseconds"] },
        properties: { session: this.options.session, tenant: this.options.tenant },
      }));
      if (this.closed || this.connection !== connection) return;
      const said = reply || "(The agent did this, and wrote nothing back.)";
      if (!late) {
        connection.toolResult(call.id, JSON.stringify(reply !== undefined ? { reply: said } : { error: outcome === "empty" ? "ask_agent needs a request: call it again with what to ask the agent." : "The agent could not do it just now." }));
        this.respond({ ...(speaker ? { speaker } : {}) });
        return;
      }
      // The call was answered already ("still working"): the reply comes as a note, and is said now.
      if (outcome === "timeout") return;
      connection.note(reply !== undefined
        ? `[The agent's late reply to "${request.slice(0, 300)}"]\n${said}`
        : `[The agent could not finish "${request.slice(0, 300)}"]`);
      this.respond({ ...(speaker ? { speaker } : {}), instructions: reply !== undefined ? "The agent's reply to an earlier request just came in (the last note): tell them now, briefly, in your own words." : "The agent could not finish an earlier request (the last note): say so briefly." });
    })();
  }

  // Barge-in ---------------------------------------------------------------------------

  private guardOf(): BargeInGuard | undefined {
    const policy = this.options.bargeIn;
    if (!policy || policy.confirmMs <= 0) return undefined;
    this.guard ??= new BargeInGuard(policy, {
      speaking: () => this.speakingNow,
      spoken: () => [this.playing?.said ?? "", ...this.history.filter(line => line.who === "You").slice(-2).map(line => line.text)].filter(Boolean),
      stop: outcome => this.interrupt(outcome),
      resume: outcome => {
        this.stats.echoRejected++;
        this.hooks.log("voice_barge_in_echo_rejected", { ...withoutType(outcome), brain: "realtime" });
        // What they said was the bot's own voice (or nothing): it is not committed as theirs.
        if (outcome.why === "echo" || outcome.why === "no_words" || outcome.why === "timeout") for (const speaker of this.candidates) this.echoed.add(speaker);
        this.candidates.clear();
        this.hooks.resumeMedia();
      },
    }, this.clock);
    return this.guard;
  }

  /** Someone took the turn while the bot spoke: it stops, and the model's history keeps only what was heard. */
  private interrupt(outcome: Extract<BargeInOutcome, { type: "confirmed" }>) {
    const response = this.playing;
    if (!response || response.cancelled) return;
    const generatedMs = response.audio.bytes / 48;
    const heardMs = response.playedAt === undefined ? 0 : Math.max(0, Math.min(generatedMs, this.clock.now() - response.playedAt - outcome.pausedMs));
    this.stats.bargeIns++;
    this.candidates.clear();
    this.hooks.log("voice_barge_in_confirmed", { ...withoutType(outcome), brain: "realtime", heardMs: Math.round(heardMs), generatedMs: Math.round(generatedMs) });
    this.cancel(response, "barge_in", heardMs);
    // What it was about to say next (an answer being made after this one) waits for their turn too.
    const next = this.current;
    if (next && next !== response && !next.played && !next.cancelled) this.cancel(next, "barge_in", 0);
    this.hooks.resumeMedia();
  }
}

/** About what of a response was heard, by the share of its audio played (its transcript has no times). */
function spokenPart(response: Response) {
  const total = response.audio.bytes / 48;
  if (!total || response.heardMs === undefined) return response.said;
  const share = Math.min(1, response.heardMs / total);
  return response.said.slice(0, Math.round(response.said.length * share)).replace(/\s+\S*$/, "");
}

function withoutType(outcome: BargeInOutcome) {
  const { type: _type, ...fields } = outcome;
  return fields;
}
