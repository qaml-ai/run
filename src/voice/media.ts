import type { EndOfTurn, VoiceConnection, VoiceCredentials, VoiceTransport } from "../voice-sessions.ts";
import type { TurnModels } from "./turns/inference.ts";
import type { TurnEvent } from "./turns/turn-taker.ts";
import { TurnSegmenter } from "./turns/segmenter.ts";
import type { Playback } from "../voice-speech.ts";
import { opusFromPcm, Segmenter, type Cut, type SegmenterOptions } from "../voice-audio.ts";
import { safeError } from "../metrics.ts";

/**
 * A voice session's media plane (docs/operations/voice-pipeline.md): the call's connection, each speaker's audio cut
 * into utterances, and speech encoded and played. Everything that touches audio samples or the Discord media
 * connection is here, behind `Media`. The session (src/voice-sessions.ts) keeps the database, the money, the providers
 * and delivery, and talks to its media only through `Media` and `MediaEvents`. So the media can run on the session's
 * thread (`inlineMedia`) or in a worker (src/voice/media-host.ts) without the session telling the difference.
 */

/** What the media needs to know of the session's settings. */
export type MediaOptions = {
  /** Silence that ends an utterance. */
  silenceMs: number;
  /** Speakers not listened to (the bot itself never is). */
  ignoreUserIds: string[];
  /** A person talking over the bot stops (or pauses) the speech playing (`bargeIn` follows). */
  bargeIn: boolean;
  /** Speech (ms) over the bot before barge-in acts: 0 (the default) at the first loud packet. */
  bargeInMinMs?: number;
  /**
   * Barge-in pauses playback instead of stopping it, and the session decides (src/voice/echo-guard.ts): `resume`, or it
   * stops the speech. While paused, each of that speaker's loud packets is reported (`speechProgress`).
   */
  bargeInPause?: boolean;
  /** Each utterance's audio goes to `pcm` as it is spoken (live transcription). */
  live: boolean;
  /**
   * How a turn ends (src/voice/turns): smart, by Silero VAD and Smart Turn (TurnSegmenter), when the media has the
   * node's turn models; else on silence (Segmenter).
   */
  endOfTurn?: EndOfTurn;
};

/** What the media reports to its session. Each is called on the session's thread. */
export interface MediaEvents {
  /** Connected and receiving (again, after a reconnect). */
  ready(): void;
  /** The connection cannot go on with these credentials (`VoiceHandlers.lost`). */
  lost(reason: "kicked" | "credentials" | "error", detail?: string): void;
  /** Structured diagnostics: never audio, tokens or session ids. */
  diagnostic(event: string, fields: Record<string, unknown>): void;
  /** A speaker started talking: an utterance's first loud packet. */
  speechStart(speaker: string): void;
  /**
   * With `bargeIn`: a speaker talked over the bot for `bargeInMinMs` (`speechMs` so far). The media already stopped
   * what it plays, or with `bargeInPause` paused it (until `resume`).
   */
  bargeIn?(speaker: string, speechMs: number): void;
  /** With `bargeInPause`, while paused: more speech from a speaker who paused it (their utterance's speech so far, ms). */
  speechProgress?(speaker: string, speechMs: number): void;
  /** `live`: a speaker's utterance audio as it comes, 24 kHz mono 16-bit PCM, from the quiet kept before its speech. */
  pcm(speaker: string, pcm: Uint8Array): void;
  /** `live`: the speaker's utterance was too short to keep: forget the audio sent of it. */
  drop(speaker: string): void;
  /** An utterance was cut. */
  cut(cut: Cut): void;
  /** Turn-taking's events, with smart end of turn (likely_end, resume, turn_end…), after the segmenter acted on each. */
  turn?(event: TurnEvent): void;
  /**
   * The media died (its worker crashed, ran out of memory or stopped answering): no event follows, and its playbacks
   * ended `error`. Only media in a worker can. `kind`: crashed, out_of_memory, unresponsive or memory_limit.
   */
  crashed?(kind: string): void;
}

/** A session's media. */
export interface Media {
  /** Whether it can play speech. */
  readonly speaks: boolean;
  /** Discord moved the call: reconnect with these. */
  update(credentials: VoiceCredentials): void;
  /** Settings that changed (PATCH). */
  configure(options: Partial<MediaOptions>): void;
  /** The other users in the call, when known. */
  others(): string[] | undefined;
  /** End a barge-in pause (`bargeInPause`): what still plays goes on where it paused. Stopping it is the playback's. */
  resume(): void;
  /**
   * Play speech: 24 kHz mono 16-bit PCM as it is made. The media frames and encodes it, and plays it on the call;
   * `started` is called as its first packet goes out.
   */
  play(pcm: AsyncIterable<Uint8Array>, started: () => void, expectedMs?: number): Playback;
  /** A session's event for the far end, when the transport shows them (a browser call's page). */
  notify?(event: Record<string, unknown>): void;
  /** Close: each speaker's speech so far is cut (`flush`) and reported before it resolves, then the connection closes. */
  close(flush: "handoff" | "end" | "error"): Promise<void>;
}

/** Opens a session's media. */
export type MediaFactory = (session: string, credentials: VoiceCredentials, options: MediaOptions, events: MediaEvents) => Media;

/** Media on the calling thread, on a transport's connections. */
export function inlineMedia(transport: VoiceTransport, models?: TurnModels): MediaFactory {
  return (_session, credentials, options, events) => new MediaSession(transport, credentials, options, events, models);
}

/** What cuts a session's speakers into utterances: the energy Segmenter, or turn-taking's TurnSegmenter. */
type Cutter = { packet(speaker: string, packet: Uint8Array, lost?: number): void; broken(speaker: string): void; flush(ended: "handoff" | "end" | "error"): void };

/**
 * One session's media: its connection, a segmenter over its speakers, and playback. The same class runs inline and
 * inside a media worker.
 */
export class MediaSession implements Media {
  private readonly connection: VoiceConnection;
  private readonly segmenter: Cutter;
  private options: MediaOptions;
  private self: string;
  private readonly events: MediaEvents;
  /** Speech playing now, to stop on barge-in. */
  private readonly playing = new Set<Playback>();
  /** Speakers whose utterance has acted on barge-in (once each), and whether playback is paused for barge-in. */
  private readonly barged = new Set<string>();
  private paused = false;
  private closed = false;

  constructor(transport: VoiceTransport, credentials: VoiceCredentials, options: MediaOptions, events: MediaEvents, models?: TurnModels) {
    this.options = { ...options, ignoreUserIds: [...options.ignoreUserIds] };
    this.self = credentials.userId;
    this.events = events;
    const cutting: SegmenterOptions = {
      silenceMs: options.silenceMs,
      cut: cut => events.cut(cut),
      ...(options.live ? { live: { audio: (speaker: string, pcm: Buffer) => events.pcm(speaker, pcm), drop: (speaker: string) => events.drop(speaker) } } : {}),
      speech: speaker => {
        this.barged.delete(speaker);
        events.speechStart(speaker);
      },
      loud: (speaker, speechMs) => this.loud(speaker, speechMs),
    };
    const turn = options.endOfTurn;
    this.segmenter = turn?.mode === "smart" && models
      ? new TurnSegmenter({
        ...cutting, models, event: event => events.turn?.(event),
        policy: { endOfTurn: { mode: "smart", checkMs: 200, commitMs: turn.commitMs, threshold: turn.threshold, maxSilenceMs: turn.maxSilenceMs, silenceMs: options.silenceMs } },
      }) as unknown as Cutter
      : new Segmenter(cutting);
    this.connection = transport.connect(credentials, {
      ready: () => { if (!this.closed) events.ready(); },
      packet: (speaker, packet, lost) => {
        if (this.closed || speaker === this.self || this.options.ignoreUserIds.includes(speaker)) return;
        this.segmenter.packet(speaker, packet, lost);
      },
      broken: speaker => { if (!this.closed) this.segmenter.broken(speaker); },
      lost: (reason, detail) => { if (!this.closed) events.lost(reason, detail); },
      diagnostic: (event, fields) => { if (!this.closed) events.diagnostic(event, fields); },
    });
  }

  get speaks() { return !!this.connection.play; }

  /**
   * A loud packet: barge-in once its utterance has `bargeInMinMs` of speech. The session hears first (it stops its
   * speech and says why, or starts deciding), then what plays here stops or pauses: a worker's media acts without
   * waiting for the session's round trip.
   */
  private loud(speaker: string, speechMs: number) {
    if (!this.options.bargeIn) return;
    if (this.barged.has(speaker)) {
      if (this.paused) this.events.speechProgress?.(speaker, speechMs);
      return;
    }
    if (speechMs < (this.options.bargeInMinMs ?? 0)) return;
    this.barged.add(speaker);
    const pause = !!this.options.bargeInPause;
    if (pause) this.paused = true;
    this.events.bargeIn?.(speaker, speechMs);
    for (const playback of [...this.playing]) {
      if (pause) playback.pause?.();
      else playback.stop();
    }
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    for (const playback of this.playing) playback.resume?.();
  }

  update(credentials: VoiceCredentials) {
    this.self = credentials.userId;
    this.connection.update(credentials);
  }

  configure(options: Partial<MediaOptions>) {
    this.options = { ...this.options, ...options };
  }

  others() { return this.connection.others(); }

  notify(event: Record<string, unknown>) { this.connection.notify?.(event); }

  play(pcm: AsyncIterable<Uint8Array>, started: () => void, expectedMs?: number): Playback {
    const play = this.connection.play;
    if (!play || this.closed) return { done: Promise.resolve("error"), stop: () => {} };
    const playback = play.call(this.connection, opusFromPcm(pcm), started, expectedMs);
    this.playing.add(playback);
    // Speech that starts during a barge-in pause starts paused.
    if (this.paused) playback.pause?.();
    void playback.done.finally(() => this.playing.delete(playback));
    return playback;
  }

  async close(flush: "handoff" | "end" | "error") {
    if (this.closed) return;
    // What was said so far is cut first, while its events still go out.
    try { this.segmenter.flush(flush); }
    catch (error) { this.events.diagnostic("audio_failed", { error: safeError(error) }); }
    this.closed = true;
    for (const playback of this.playing) playback.stop();
    this.connection.close();
  }
}
