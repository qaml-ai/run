import { randomBytes } from "node:crypto";
import type { HttpError } from "./http.ts";
import { safeError } from "./metrics.ts";
import { SPEECH_RATE, type SpeechCredentials, type Synthesizer } from "./speech.ts";
import { opusFromPcm } from "./voice-audio.ts";

/**
 * A voice session's speech (voice-sessions.ts): what its bot was asked to say, said one at a time on the session's
 * connection. Each is made as it plays (speech.ts streams PCM, voice-audio.ts encodes 20 ms Opus packets as they come),
 * so the first audio goes out well before the whole is made. Stopping (a new speech that interrupts, a DELETE, a person
 * starting to talk with barge-in on, the session ending or moving) cuts the one playing and clears the queue; each
 * speech ends once, with what it made (and cost) so far.
 */

/** Something asked to be said. */
export type SpeechItem = { id: string; text: string; voice: string; instructions?: string; queuedAt: number };
/** How a speech ended: said whole, cut short (`by` whom), or failed. */
export type SpeechEnding = { reason: "done" | "interrupted" | "error"; by?: StopReason; seconds: number; costUsd: number; error?: string };
export type StopReason = "interrupt" | "requested" | "barge_in" | "end" | "handoff" | "budget";

/** A playback on a connection: done when its packets ran out (`done`), it was stopped, or it failed. */
export interface Playback { done: Promise<"done" | "stopped" | "error">; stop(): void }
/** A connection that can play: `packets` are 20 ms Opus packets at 48 kHz stereo; `started` is called with the first. */
export interface Player { play(packets: AsyncIterable<Uint8Array>, started: () => void): Playback }

/** What a session's speech needs of it: the connection, the money checks, and where its events and usage go. */
export interface SpeechEffects {
  /** The connection to play on now, if the session has one that can play. */
  player(): Player | undefined;
  /** The tenant may spend (run limit); throws a 402 HttpError otherwise. */
  admit(): Promise<void>;
  /** Holds `usd` of the end user's credit, where the tenant meters end users; throws 402 END_USER_CREDIT. */
  hold(usd: number, speech: string): Promise<{ settle(usd: number): Promise<void>; release(): Promise<void> } | undefined>;
  /** Waits for a fresh lease: a node cut off from the cluster makes no effects. */
  fresh(): Promise<void>;
  credentials(): Promise<SpeechCredentials & { platform: boolean }>;
  /** The speech started playing, `latencyMs` after it was asked for. */
  started(item: SpeechItem, latencyMs: number): void;
  /** It ended; `platform` says whose key made it (usage). */
  ended(item: SpeechItem, ending: SpeechEnding, platform: boolean | undefined): void;
  /** The money ran out: the session ends (`budget`). */
  budget(limit: "tenant" | "end_user", endUserReason?: string): void;
}

/** Speeches waiting at most per session, and how long one waits for a connection to play on. */
export const SPEECH_QUEUE = Object.freeze({ max: 20, connectionWaitMs: 15_000 });

export const speechId = () => `sp_${randomBytes(12).toString("hex")}`;

export class SessionSpeech {
  private readonly queue: SpeechItem[] = [];
  private current?: { item: SpeechItem; abort: AbortController; playback?: Playback; stoppedBy?: StopReason };
  private running = false;
  private closed = false;
  private readonly synthesizer: Synthesizer;
  private readonly effects: SpeechEffects;

  constructor(synthesizer: Synthesizer, effects: SpeechEffects) {
    this.synthesizer = synthesizer;
    this.effects = effects;
  }

  /** Whether a speech is being made or played now. */
  get speaking() { return !!this.current; }
  /** Speeches waiting behind the current one. */
  get waiting() { return this.queue.length; }

  /** Queue a speech (`interrupt`: stop what is playing and clear the queue first); answers its place: 0 plays next. */
  say(item: SpeechItem, interrupt = false) {
    if (interrupt) this.stop("interrupt");
    this.queue.push(item);
    void this.run();
    return this.queue.length - 1 + (this.current && !this.current.stoppedBy ? 1 : 0);
  }

  /** Stop the speech playing and clear the queue: each ends `interrupted`, `by`. Answers how many there were. */
  stop(by: StopReason) {
    const cleared = this.queue.splice(0);
    for (const item of cleared) this.effects.ended(item, { reason: "interrupted", by, seconds: 0, costUsd: 0 }, undefined);
    const current = this.current;
    if (current && !current.stoppedBy) {
      current.stoppedBy = by;
      current.abort.abort();
      current.playback?.stop();
    }
    return cleared.length + (current ? 1 : 0);
  }

  /** The session ended or moved: nothing more is said. */
  close(by: "end" | "handoff") {
    this.closed = true;
    this.stop(by);
  }

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      for (let item; !this.closed && (item = this.queue.shift());) await this.speak(item);
    } finally { this.running = false; }
  }

  private async speak(item: SpeechItem) {
    const abort = new AbortController();
    const current: NonNullable<SessionSpeech["current"]> = { item, abort };
    this.current = current;
    let samples = 0, platform: boolean | undefined, error: string | undefined, result: "done" | "stopped" | "error" = "error";
    let held: Awaited<ReturnType<SpeechEffects["hold"]>>;
    try {
      try {
        await this.effects.admit();
        held = await this.effects.hold(this.synthesizer.cost(this.synthesizer.estimateSeconds(item.text)), item.id);
      } catch (refused) {
        const status = (refused as HttpError).status;
        if (status !== 402) throw refused;
        const endUser = (refused as HttpError).code === "END_USER_CREDIT";
        const reason = (refused as HttpError).details?.reason;
        current.stoppedBy = "budget";
        this.effects.budget(endUser ? "end_user" : "tenant", endUser && typeof reason === "string" ? reason : undefined);
        return;
      }
      if (current.stoppedBy) return;
      await this.effects.fresh();
      const credentials = await this.effects.credentials();
      platform = credentials.platform;
      const player = await this.connected(abort.signal);
      if (current.stoppedBy) return;
      if (!player) throw new Error("No connection to speak on");
      const pcm = this.synthesizer.stream({ text: item.text, voice: item.voice, ...(item.instructions ? { instructions: item.instructions } : {}) }, credentials, abort.signal);
      current.playback = player.play(opusFromPcm(pcm, count => { samples += count; }), () => this.effects.started(item, Date.now() - item.queuedAt));
      if (current.stoppedBy) current.playback.stop();
      result = await current.playback.done;
    } catch (failure) {
      if (!current.stoppedBy) error = safeError(failure);
    } finally {
      const seconds = Math.round(samples / SPEECH_RATE * 100) / 100;
      const costUsd = samples ? this.synthesizer.cost(seconds) : 0;
      if (held) await (samples ? held.settle(costUsd) : held.release()).catch(failure => console.error(JSON.stringify({ type: "voice_speech_credit_failed", speech: item.id, error: safeError(failure) })));
      const ending: SpeechEnding = current.stoppedBy
        ? { reason: "interrupted", by: current.stoppedBy, seconds, costUsd }
        : result === "done" && !error ? { reason: "done", seconds, costUsd } : { reason: "error", seconds, costUsd, ...(error ? { error } : {}) };
      if (this.current === current) this.current = undefined;
      this.effects.ended(item, ending, platform);
    }
  }

  /** The connection to play on, waiting a while for one (a reconnect); undefined if none comes, or it was stopped. */
  private async connected(signal: AbortSignal) {
    const deadline = Date.now() + SPEECH_QUEUE.connectionWaitMs;
    for (;;) {
      const player = this.effects.player();
      if (player || signal.aborted || Date.now() >= deadline) return player;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
