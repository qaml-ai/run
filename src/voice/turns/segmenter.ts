import { Opus } from "../../opus.ts";
import { clock } from "../../node-context.ts";
import { packetSamples, UTTERANCE_LIMITS, type Cut, type SegmenterOptions } from "../../voice-audio.ts";
import { Resampler24To16 } from "./features.ts";
import type { TurnModels } from "./inference.ts";
import { TurnTaker, type TurnEvent, type TurnPolicy } from "./turn-taker.ts";

/**
 * Utterances cut by turn-taking (turn-taker.ts) instead of by level and silence: the energy Segmenter's interface
 * (voice-audio.ts), so a session takes either. Each speaker's Opus packets are decoded (one decoder per speaker while
 * they talk now and then) and given to a TurnTaker as 16 kHz frames; an utterance is the packets from its turn's
 * `speech_start` (with `padMs` before it) to its `turn_end`. Noise never starts one (Silero hears speech, not level),
 * and a pause ends one when Smart Turn says the speaker is done, not after a fixed silence.
 *
 * As with the Segmenter, nothing is written anywhere; with `live`, each utterance's audio (24 kHz) streams as it is
 * spoken, from the start of its turn.
 */

type Held = { packet: Uint8Array; ms: number; at: number; pcm?: Buffer };
type Speaking = {
  decoder: Opus; resampler?: Resampler24To16; held: Held[]; heldMs: number;
  /** The turn this utterance is: since when, and whether its audio streams to `live`. */
  turn?: { startedAt: number; streaming: boolean };
  /** Why its next turn_end ends it, when this segmenter ended it (broken stream, flush). */
  ending?: Cut["ended"];
  idle?: ReturnType<typeof setTimeout>;
};

export type TurnSegmenterOptions = SegmenterOptions & {
  policy?: Partial<TurnPolicy>;
  models?: TurnModels;
  /** Every turn event (likely_end and resume too, for speculative replies), after the segmenter acted on it. */
  event?(event: TurnEvent): void;
};

/** A speaker silent this long gives back their decoder; their next packet makes another. */
const IDLE_MS = 5_000;

export class TurnSegmenter {
  private readonly speaking = new Map<string, Speaking>();
  private readonly options: TurnSegmenterOptions;
  readonly turns: TurnTaker;

  constructor(options: TurnSegmenterOptions) {
    this.options = options;
    const c = clock();
    this.turns = new TurnTaker({ maxTurnMs: options.maxMs ?? UTTERANCE_LIMITS.maxMs, ...options.policy }, {
      ...(options.models ? { models: options.models } : {}),
      clock: { now: () => c.now(), setTimeout: (fn, ms) => { const timer = c.setTimeout(fn, ms); timer.unref?.(); return timer; }, clearTimeout: timer => c.clearTimeout(timer as ReturnType<typeof setTimeout>) },
    });
    this.turns.on(event => this.turn(event));
  }

  /** Speakers with speech not yet cut. */
  get open() { return this.turns.open; }

  packet(speaker: string, packet: Uint8Array) {
    if (!packet.length || (packet.length === 3 && packet[0] === 0xf8 && packet[1] === 0xff && packet[2] === 0xfe)) return;
    const live = this.options.live;
    let s = this.speaking.get(speaker);
    if (!s) this.speaking.set(speaker, s = { decoder: new Opus(live ? 24_000 : 16_000, 1, "voip"), ...(live ? { resampler: new Resampler24To16() } : {}), held: [], heldMs: 0 });
    let pcm: Buffer | undefined;
    try { pcm = s.decoder.decode(packet); } catch { pcm = undefined; }
    // A decoder that trapped is done: what was said so far is an utterance, and the next packet gets a new decoder.
    if (s.decoder.broken) { this.broken(speaker); return; }
    const now = clock().now(), ms = packetSamples(packet) / 48;
    s.held.push({ packet, ms, at: now, ...(live && pcm && !s.turn?.streaming ? { pcm } : {}) });
    s.heldMs += ms;
    if (s.turn?.streaming && pcm) live!.audio(speaker, pcm);
    // Before a turn, only what its start might reach back to is kept: padMs, and the VAD's lag behind the audio.
    if (!s.turn) while (s.heldMs > (this.options.padMs ?? UTTERANCE_LIMITS.padMs) + 400 && s.held.length > 1) s.heldMs -= s.held.shift()!.ms;
    clearTimeout(s.idle);
    s.idle = setTimeout(() => { if (!s!.turn && this.speaking.get(speaker) === s) this.release(speaker); }, IDLE_MS);
    s.idle.unref?.();
    if (pcm) {
      const samples = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + (pcm.length & ~1)));
      this.turns.frame(speaker, s.resampler ? s.resampler.push(samples) : samples, now);
    }
  }

  /** A speaker's stream broke: what they said so far is an utterance. */
  broken(speaker: string) {
    const s = this.speaking.get(speaker);
    if (!s) return;
    s.ending = "error";
    this.turns.leave(speaker);
    this.release(speaker);
  }

  /** Cut every speaker's speech now (`handoff`, `end`). */
  flush(ended: "handoff" | "end") {
    for (const [speaker, s] of [...this.speaking]) {
      s.ending = ended;
      this.turns.leave(speaker);
      this.release(speaker);
    }
  }

  private release(speaker: string) {
    const s = this.speaking.get(speaker);
    if (!s) return;
    this.speaking.delete(speaker);
    clearTimeout(s.idle);
    s.decoder.delete();
    if (s.turn?.streaming) this.options.live?.drop(speaker);
    this.turns.leave(speaker);
  }

  private turn(event: TurnEvent) {
    const s = this.speaking.get(event.speaker);
    try {
      if (s && event.type === "speech_start") this.started(event.speaker, s, event.at);
      else if (s && event.type === "turn_end") this.ended(event.speaker, s, event);
    } finally { this.options.event?.(event); }
  }

  private started(speaker: string, s: Speaking, at: number) {
    // The turn's audio: from padMs before its first speech.
    const from = at - (this.options.padMs ?? UTTERANCE_LIMITS.padMs);
    while (s.held.length > 1 && s.held[0].at < from) s.heldMs -= s.held.shift()!.ms;
    const live = this.options.live;
    s.turn = { startedAt: at, streaming: !!live };
    if (live) for (const entry of s.held) { if (entry.pcm) live.audio(speaker, entry.pcm); entry.pcm = undefined; }
    this.options.speech?.(speaker);
  }

  private ended(speaker: string, s: Speaking, event: Extract<TurnEvent, { type: "turn_end" }>) {
    const turn = s.turn;
    if (!turn) return;
    s.turn = undefined;
    const held = s.held;
    const heldMs = s.heldMs;
    s.held = [];
    s.heldMs = 0;
    const ended: Cut["ended"] = s.ending ?? (event.reason === "max" ? "max" : event.reason === "flush" ? "end" : "silence");
    s.ending = undefined;
    if (event.speechMs < (this.options.minMs ?? UTTERANCE_LIMITS.minMs) || !held.length) {
      if (turn.streaming) this.options.live?.drop(speaker);
      return;
    }
    const seconds = Math.round(heldMs / 10) / 100;
    const endedAt = Math.max(event.at - event.silenceMs, turn.startedAt);
    this.options.cut({ speaker, packets: held.map(entry => entry.packet), seconds, startedAt: turn.startedAt, endedAt, ended, ...(turn.streaming ? { live: true } : {}) });
  }
}
