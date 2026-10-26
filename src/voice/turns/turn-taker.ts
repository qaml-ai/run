import { TurnModelsUnavailable, type TurnModels } from "./inference.ts";

/**
 * Turn-taking for a voice session: each speaker's 16 kHz audio in (20 ms frames, as the pipeline decodes them), events
 * out: when they start talking, when they have likely finished, and when their turn has ended.
 *
 * - Speech is Silero VAD's (inference.ts), per 32 ms chunk, with hysteresis: a chunk at `vad.threshold` or above is
 *   speech, one under `vad.threshold - 0.15` is not, and `vad.minSpeechMs` of speech starts a turn (`speech_start`).
 * - Silence is timed by the clock, not by frames: a Discord client stops sending when its user stops talking, so a
 *   speaker without frames for a while is silent.
 * - At `endOfTurn.checkMs` of silence, Smart Turn (inference.ts) judges the turn's audio so far (the last 8 s). A turn
 *   it calls complete (`endOfTurn.threshold` or above) is `likely_end` at once, and `turn_end` at `endOfTurn.commitMs`
 *   of silence, unless they talk again first (`resume`). One it calls incomplete waits for them, up to
 *   `endOfTurn.maxSilenceMs`, then ends (`timeout`). `likely_end` is for speculative work (an agent's reply started
 *   early), which `resume` cancels.
 * - Without the models (their worker gone, busy or late), it falls back to a level-based VAD and silence alone
 *   (`endOfTurn.silenceMs`), as the energy segmenter did; `mode: "silence"` asks for that always.
 *
 * Nothing here reads a database, the network or audio beyond what it is given; it runs in whatever thread holds the
 * call, with its models in their own worker threads.
 */

export type TurnPolicy = {
  vad: { threshold: number; minSpeechMs: number };
  endOfTurn: {
    /** smart: Smart Turn decides at a pause; silence: only silence ends a turn. */
    mode: "smart" | "silence";
    checkMs: number; commitMs: number; threshold: number; maxSilenceMs: number;
    /** Silence that ends a turn in silence mode, or when the models are unavailable. */
    silenceMs: number;
  };
  /** A turn longer than this ends (`max`), and the speech goes on in the next. */
  maxTurnMs: number;
};

export const DEFAULT_TURN_POLICY: TurnPolicy = Object.freeze({
  vad: Object.freeze({ threshold: 0.5, minSpeechMs: 64 }),
  endOfTurn: Object.freeze({ mode: "smart", checkMs: 200, commitMs: 500, threshold: 0.5, maxSilenceMs: 1_400, silenceMs: 800 }),
  maxTurnMs: 30_000,
}) as TurnPolicy;

export type TurnEvent =
  | { type: "speech_start"; speaker: string; at: number }
  | { type: "likely_end"; speaker: string; at: number; probability: number; silenceMs: number }
  | { type: "resume"; speaker: string; at: number }
  | {
    type: "turn_end"; speaker: string; at: number;
    /** complete: Smart Turn said so; timeout: it did not, and they stayed silent; silence: silence alone ended it; max: too long. */
    reason: "complete" | "timeout" | "silence" | "max" | "flush";
    probability?: number; startedAt: number; speechMs: number; silenceMs: number;
  };

export type TurnClock = { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
const REAL_CLOCK: TurnClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; },
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export const TURN_LIMITS = Object.freeze({
  rate: 16_000,
  chunk: 512,
  context: 64,
  /** Smart Turn's window: a speaker's last 8 s are kept (their earlier turns are its context). */
  windowMs: 8_000,
  /** Silence after the last speech that Smart Turn hears (what it was trained on: ~200 ms after the speech). */
  trailingMs: 200,
  /** Silent this long, a speaker's audio and state are let go: the next turn starts with no context. */
  contextMs: 3_000,
  /** Without a frame for this long, a speaker is silent from their last speech. */
  gapMs: 60,
  /** After this long without frames, the next frame starts a new stream: the VAD's state starts over. */
  resetMs: 1_000,
  /** Chunks a speaker may have waiting for the VAD; past it they are judged by level (the models are behind). */
  vadBacklog: 8,
  /** A turn with less speech than this is not asked about (a click, a cough, noise starting): it ends as complete, and is too short to keep. */
  shortMs: 250,
  /** A chunk louder than this (dBFS) is speech when judged by level. */
  quietDb: -45,
});

type Speaker = {
  id: string;
  /** VAD input: samples not yet in a chunk, the last 64 of the previous chunk, the LSTM state. */
  pending: Float32Array; pendingLength: number; context: Float32Array; state: Float32Array;
  /** Chunks waiting for the VAD (one at a time per speaker: each needs the state the last left). */
  chunks: { input: Float32Array; endAt: number }[]; inFlight: boolean;
  lastFrameAt: number;
  /** The speaker's last 8 s (16-bit, oldest first), and how many samples it holds. */
  audio: Int16Array; audioLength: number; head: number;
  speaking: boolean; speechRunMs: number;
  turn?: { startedAt: number; speechMs: number; lastSpeechAt: number; silentSince?: number; probability?: number; likely?: boolean; checking?: boolean; timers: unknown[] };
  gapTimer?: unknown; idleTimer?: unknown;
};

export class TurnTaker {
  readonly policy: TurnPolicy;
  private readonly models?: TurnModels;
  private readonly clock: TurnClock;
  private readonly speakers = new Map<string, Speaker>();
  private readonly listeners = new Set<(event: TurnEvent) => void>();
  private closed = false;
  /** What happened, for metrics: VAD chunks by the model and by level, Smart Turn checks, fallbacks. */
  readonly stats = { vadChunks: 0, levelChunks: 0, checks: 0, checkFailures: 0, likelyEnds: 0, resumes: 0, turns: 0 };

  /** Called with each speech chunk of an open turn: its speech so far (barge-in measures talking over the bot by it). */
  private readonly onSpeech?: (speaker: string, speechMs: number) => void;

  constructor(policy: Partial<TurnPolicy> = {}, options: { models?: TurnModels; clock?: TurnClock; speech?(speaker: string, speechMs: number): void } = {}) {
    this.onSpeech = options.speech;
    this.policy = { ...DEFAULT_TURN_POLICY, ...policy, vad: { ...DEFAULT_TURN_POLICY.vad, ...policy.vad }, endOfTurn: { ...DEFAULT_TURN_POLICY.endOfTurn, ...policy.endOfTurn } };
    this.models = options.models;
    this.clock = options.clock ?? REAL_CLOCK;
  }

  on(listener: (event: TurnEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** One frame of a speaker's audio (16 kHz mono; 20 ms as the pipeline gives it), at `atMs` (when its end was heard). */
  frame(speaker: string, pcm: Int16Array, atMs = this.clock.now(), _info?: { concealed?: boolean }) {
    if (this.closed || !pcm.length) return;
    let s = this.speakers.get(speaker);
    if (!s) this.speakers.set(speaker, s = this.speaker(speaker, atMs));
    else if (atMs - s.lastFrameAt > TURN_LIMITS.resetMs) { s.context.fill(0); s.state.fill(0); s.pendingLength = 0; }
    this.keep(s, pcm, atMs);
    s.lastFrameAt = atMs;
    // Into 512-sample chunks, each stamped with when its last sample was heard, in whole ms: a frame need not be a
    // multiple of 16 samples (a 2.5 ms Opus frame is 40), and a turn's times end up in bigint columns (voice_sessions).
    const frameMs = pcm.length / (TURN_LIMITS.rate / 1_000);
    for (let i = 0; i < pcm.length;) {
      const take = Math.min(pcm.length - i, TURN_LIMITS.chunk - s.pendingLength);
      for (let j = 0; j < take; j++) s.pending[s.pendingLength + j] = pcm[i + j] / 32_768;
      s.pendingLength += take;
      i += take;
      if (s.pendingLength === TURN_LIMITS.chunk) {
        const input = new Float32Array(TURN_LIMITS.context + TURN_LIMITS.chunk);
        input.set(s.context);
        input.set(s.pending, TURN_LIMITS.context);
        s.context = input.slice(input.length - TURN_LIMITS.context);
        s.pendingLength = 0;
        s.chunks.push({ input, endAt: Math.round(atMs - frameMs * (pcm.length - i) / pcm.length) });
      }
    }
    this.pump(s);
    // No frame for a while: silent from the last speech.
    this.clock.clearTimeout(s.gapTimer);
    s.gapTimer = this.clock.setTimeout(() => this.gap(s!), TURN_LIMITS.gapMs);
    // Silent for long, and not in a turn: forgotten (its audio and VAD state), until it speaks again.
    this.clock.clearTimeout(s.idleTimer);
    s.idleTimer = this.clock.setTimeout(() => { if (!s!.turn && this.speakers.get(speaker) === s) this.forget(s!); }, TURN_LIMITS.contextMs);
  }

  private forget(s: Speaker) {
    this.speakers.delete(s.id);
    this.clock.clearTimeout(s.gapTimer);
    this.clock.clearTimeout(s.idleTimer);
  }

  /** The speaker left (or their stream broke): a turn they were in ends now. */
  leave(speaker: string) {
    const s = this.speakers.get(speaker);
    if (!s) return;
    this.forget(s);
    if (s.turn) this.end(s, "flush");
  }

  /** End every open turn (`flush`) and stop. */
  close() {
    for (const speaker of [...this.speakers.keys()]) this.leave(speaker);
    this.closed = true;
    this.listeners.clear();
  }

  /** Speakers it tracks, and VAD chunks waiting: for memory reports. */
  sizes() {
    let chunks = 0;
    for (const s of this.speakers.values()) chunks += s.chunks.length;
    return { turnSpeakers: this.speakers.size, vadChunks: chunks };
  }

  /** Speakers with a turn open now. */
  get open() { let count = 0; for (const s of this.speakers.values()) if (s.turn) count++; return count; }

  private speaker(id: string, at: number): Speaker {
    return {
      id, pending: new Float32Array(TURN_LIMITS.chunk), pendingLength: 0, context: new Float32Array(TURN_LIMITS.context), state: new Float32Array(256),
      chunks: [], inFlight: false, lastFrameAt: at, audio: new Int16Array(0), audioLength: 0, head: 0, speaking: false, speechRunMs: 0,
    };
  }

  private emit(event: TurnEvent) {
    for (const listener of this.listeners) {
      try { listener(event); } catch (error) { console.error(JSON.stringify({ type: "voice_turn_listener_failed", event: event.type, error: String((error as Error)?.message ?? error) })); }
    }
  }

  // Audio kept for Smart Turn -------------------------------------------------------

  private get windowSamples() { return TURN_LIMITS.windowMs * TURN_LIMITS.rate / 1_000; }

  /**
   * Keep a frame in the speaker's last 8 s, after the silence since the frame before (no frames come while a Discord
   * user is silent): Smart Turn hears their recent turns too, as context, unless they were silent for `contextMs`.
   */
  private keep(s: Speaker, pcm: Int16Array, atMs: number) {
    if (!s.audio.length) s.audio = new Int16Array(this.windowSamples);
    const gapMs = atMs - pcm.length / (TURN_LIMITS.rate / 1_000) - s.lastFrameAt;
    if (s.audioLength && gapMs > TURN_LIMITS.contextMs) s.audioLength = 0;
    else if (s.audioLength && gapMs >= 10) this.silence(s, Math.round(gapMs * TURN_LIMITS.rate / 1_000));
    this.append(s, pcm);
  }

  /** The ring: `head` is where the next sample goes; the `audioLength` before it are kept. */
  private append(s: Speaker, pcm: Int16Array) {
    const ring = s.audio, size = ring.length;
    const from = Math.max(0, pcm.length - size);
    for (let i = from; i < pcm.length;) {
      const run = Math.min(pcm.length - i, size - s.head);
      ring.set(pcm.subarray(i, i + run), s.head);
      s.head = (s.head + run) % size;
      i += run;
    }
    s.audioLength = Math.min(size, s.audioLength + pcm.length - from);
  }

  private silence(s: Speaker, samples: number) {
    const ring = s.audio, size = ring.length;
    for (let left = Math.min(samples, size); left > 0;) {
      const run = Math.min(left, size - s.head);
      ring.fill(0, s.head, s.head + run);
      s.head = (s.head + run) % size;
      left -= run;
    }
    s.audioLength = Math.min(size, s.audioLength + samples);
  }

  /**
   * What Smart Turn judges: the speaker's audio up to `trailingMs` after their last speech (silence after their last
   * frame), so its answer does not depend on when it was asked.
   */
  private checkAudio(s: Speaker, lastSpeechAt: number): Int16Array {
    const perMs = TURN_LIMITS.rate / 1_000, size = s.audio.length;
    const until = lastSpeechAt + TURN_LIMITS.trailingMs;
    // Samples from the end of what is kept, dropped (after `until`) or added (silence up to it).
    const cut = Math.min(s.audioLength, Math.max(0, Math.round((s.lastFrameAt - until) * perMs)));
    const padding = Math.max(0, Math.round((until - s.lastFrameAt) * perMs));
    const kept = Math.min(s.audioLength - cut, this.windowSamples - Math.min(padding, this.windowSamples));
    const out = new Int16Array(kept + Math.min(padding, this.windowSamples));
    const start = ((s.head - cut - kept) % size + size) % size;
    for (let i = 0; i < kept; i++) out[i] = s.audio[(start + i) % size];
    return out;
  }

  // VAD ----------------------------------------------------------------------------

  private pump(s: Speaker) {
    if (s.inFlight || !s.chunks.length || this.closed) return;
    // Behind (the models stalled): judged by level, so turns still start and end.
    while (s.chunks.length > TURN_LIMITS.vadBacklog) { const chunk = s.chunks.shift()!; this.stats.levelChunks++; this.judged(s, levelProbability(chunk.input), chunk.endAt); }
    const chunk = s.chunks.shift();
    if (!chunk) return;
    if (!this.models) { this.stats.levelChunks++; this.judged(s, levelProbability(chunk.input), chunk.endAt); this.pump(s); return; }
    s.inFlight = true;
    this.models.vad(chunk.input, s.state).then(({ probability, state }) => {
      s.state = state;
      this.stats.vadChunks++;
      return probability;
    }, () => { this.stats.levelChunks++; return levelProbability(chunk.input); }).then(probability => {
      s.inFlight = false;
      if (this.speakers.get(s.id) !== s) return;
      this.judged(s, probability, chunk.endAt);
      this.pump(s);
      // The frames stopped while this chunk was judged: the gap timer found it busy.
      if (!s.inFlight && !s.chunks.length && this.clock.now() - s.lastFrameAt >= TURN_LIMITS.gapMs) this.gap(s);
    });
  }

  /** A chunk judged: speech (at threshold), not (under threshold - 0.15), or as the one before (between). */
  private judged(s: Speaker, probability: number, at: number) {
    const { threshold, minSpeechMs } = this.policy.vad;
    const chunkMs = TURN_LIMITS.chunk / (TURN_LIMITS.rate / 1_000);
    const speech = probability >= threshold || (s.speaking && probability >= threshold - 0.15);
    if (speech) {
      s.speaking = true;
      s.speechRunMs += chunkMs;
      if (s.turn) {
        s.turn.speechMs += chunkMs;
        s.turn.lastSpeechAt = at;
        // Talking again in a pause: the turn goes on.
        if (s.turn.silentSince !== undefined && s.speechRunMs >= minSpeechMs) this.resumed(s, at);
        if (at - s.turn.startedAt >= this.policy.maxTurnMs) { this.end(s, "max"); }
        else this.onSpeech?.(s.id, s.turn.speechMs);
      } else if (s.speechRunMs >= minSpeechMs) {
        const startedAt = at - s.speechRunMs;
        s.turn = { startedAt, speechMs: s.speechRunMs, lastSpeechAt: at, timers: [] };
        this.emit({ type: "speech_start", speaker: s.id, at: startedAt });
      }
    } else {
      s.speaking = false;
      s.speechRunMs = 0;
      if (s.turn && s.turn.silentSince === undefined) this.silent(s, s.turn.lastSpeechAt);
    }
  }

  // Pauses and ends ------------------------------------------------------------------

  /** No frames: a speaker in a turn is silent since their last speech. */
  private gap(s: Speaker) {
    if (this.speakers.get(s.id) !== s) return;
    s.speaking = false;
    s.speechRunMs = 0;
    if (s.turn && s.turn.silentSince === undefined && !s.chunks.length && !s.inFlight) this.silent(s, s.turn.lastSpeechAt);
  }

  /** Silence began at `since`: the checks are timed from it. */
  private silent(s: Speaker, since: number) {
    const turn = s.turn!;
    turn.silentSince = since;
    const after = (ms: number, fn: () => void) => turn.timers.push(this.clock.setTimeout(() => { if (s.turn === turn && this.speakers.get(s.id) === s) fn(); }, Math.max(0, since + ms - this.clock.now())));
    const { mode, checkMs, commitMs, maxSilenceMs, silenceMs } = this.policy.endOfTurn;
    if (mode === "silence" || !this.models) { after(silenceMs, () => this.end(s, "silence")); return; }
    after(checkMs, () => void this.check(s, turn));
    after(commitMs, () => { if (turn.likely) this.end(s, "complete"); });
    after(maxSilenceMs, () => this.end(s, turn.probability === undefined ? "silence" : "timeout"));
  }

  private async check(s: Speaker, turn: NonNullable<Speaker["turn"]>) {
    const since = turn.silentSince;
    turn.checking = true;
    let probability: number;
    // Too short to be speech worth judging (a click, the onset of noise): no model run for it.
    if (turn.speechMs < TURN_LIMITS.shortMs) probability = 1;
    else try { this.stats.checks++; probability = await this.models!.endOfTurn(this.checkAudio(s, turn.lastSpeechAt)); }
    catch (error) {
      this.stats.checkFailures++;
      turn.checking = false;
      if (!(error instanceof TurnModelsUnavailable)) console.error(JSON.stringify({ type: "voice_turn_check_failed", error: String((error as Error)?.message ?? error) }));
      // No answer: silence decides (silenceMs from the pause), as without the models.
      if (s.turn === turn && turn.silentSince === since) turn.timers.push(this.clock.setTimeout(() => { if (s.turn === turn && turn.silentSince === since) this.end(s, "silence"); }, Math.max(0, since! + this.policy.endOfTurn.silenceMs - this.clock.now())));
      return;
    }
    turn.checking = false;
    // They spoke again while it was judged, or the turn ended: the answer is about audio that is not the turn any more.
    if (s.turn !== turn || turn.silentSince !== since) return;
    turn.probability = probability;
    if (probability < this.policy.endOfTurn.threshold) return;
    turn.likely = true;
    const silenceMs = this.clock.now() - since!;
    this.stats.likelyEnds++;
    this.emit({ type: "likely_end", speaker: s.id, at: this.clock.now(), probability, silenceMs });
    // Judged after the commit point (a slow answer): it ends now.
    if (silenceMs >= this.policy.endOfTurn.commitMs) this.end(s, "complete");
  }

  private resumed(s: Speaker, at: number) {
    const turn = s.turn!;
    for (const timer of turn.timers) this.clock.clearTimeout(timer);
    turn.timers = [];
    turn.silentSince = undefined;
    turn.probability = undefined;
    if (turn.likely) {
      turn.likely = false;
      this.stats.resumes++;
      this.emit({ type: "resume", speaker: s.id, at });
    }
  }

  private end(s: Speaker, reason: Extract<TurnEvent, { type: "turn_end" }>["reason"]) {
    const turn = s.turn;
    if (!turn) return;
    for (const timer of turn.timers) this.clock.clearTimeout(timer);
    s.turn = undefined;
    const at = this.clock.now();
    this.stats.turns++;
    this.emit({
      type: "turn_end", speaker: s.id, at, reason, ...(turn.probability !== undefined ? { probability: turn.probability } : {}),
      startedAt: turn.startedAt, speechMs: Math.round(turn.speechMs), silenceMs: turn.silentSince === undefined ? 0 : Math.max(0, at - turn.silentSince),
    });
  }
}

/** A chunk judged by its level alone: 1 above TURN_LIMITS.quietDb, else 0 (the energy segmenter's rule). */
function levelProbability(input: Float32Array) {
  let sum = 0;
  for (let i = TURN_LIMITS.context; i < input.length; i++) sum += input[i] * input[i];
  const db = 10 * Math.log10(sum / (input.length - TURN_LIMITS.context) || 1e-12);
  return db > TURN_LIMITS.quietDb ? 1 : 0;
}
