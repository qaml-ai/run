import type { VoiceConnection, VoiceCredentials, VoiceTransport } from "../voice-sessions.ts";
import type { Playback } from "../voice-speech.ts";
import { opusFromPcm, Segmenter, type Cut } from "../voice-audio.ts";
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
  /** A person starting to talk stops the speech playing (`speechStart` follows). */
  bargeIn: boolean;
  /** Each utterance's audio goes to `pcm` as it is spoken (live transcription). */
  live: boolean;
};

/** What the media reports to its session. Each is called on the session's thread. */
export interface MediaEvents {
  /** Connected and receiving (again, after a reconnect). */
  ready(): void;
  /** The connection cannot go on with these credentials (`VoiceHandlers.lost`). */
  lost(reason: "kicked" | "credentials" | "error", detail?: string): void;
  /** Structured diagnostics: never audio, tokens or session ids. */
  diagnostic(event: string, fields: Record<string, unknown>): void;
  /** A speaker started talking: an utterance's first loud packet. With `bargeIn`, the media already stopped playing. */
  speechStart(speaker: string): void;
  /** `live`: a speaker's utterance audio as it comes, 24 kHz mono 16-bit PCM, from the quiet kept before its speech. */
  pcm(speaker: string, pcm: Uint8Array): void;
  /** `live`: the speaker's utterance was too short to keep: forget the audio sent of it. */
  drop(speaker: string): void;
  /** An utterance was cut. */
  cut(cut: Cut): void;
  /**
   * The media died (its worker crashed, ran out of memory or stopped answering): no event follows, and its playbacks
   * ended `error`. Only media in a worker can.
   */
  crashed?(reason: string): void;
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
  /**
   * Play speech: 24 kHz mono 16-bit PCM as it is made. The media frames and encodes it, and plays it on the call;
   * `started` is called as its first packet goes out.
   */
  play(pcm: AsyncIterable<Uint8Array>, started: () => void): Playback;
  /** Close: each speaker's speech so far is cut (`flush`) and reported before it resolves, then the connection closes. */
  close(flush: "handoff" | "end" | "error"): Promise<void>;
}

/** Opens a session's media. */
export type MediaFactory = (session: string, credentials: VoiceCredentials, options: MediaOptions, events: MediaEvents) => Media;

/** Media on the calling thread, on a transport's connections. */
export function inlineMedia(transport: VoiceTransport): MediaFactory {
  return (_session, credentials, options, events) => new MediaSession(transport, credentials, options, events);
}

/**
 * One session's media: its connection, a segmenter over its speakers, and playback. The same class runs inline and
 * inside a media worker.
 */
export class MediaSession implements Media {
  private readonly connection: VoiceConnection;
  private readonly segmenter: Segmenter;
  private options: MediaOptions;
  private self: string;
  private readonly events: MediaEvents;
  /** Speech playing now, to stop on barge-in. */
  private readonly playing = new Set<Playback>();
  private closed = false;

  constructor(transport: VoiceTransport, credentials: VoiceCredentials, options: MediaOptions, events: MediaEvents) {
    this.options = { ...options, ignoreUserIds: [...options.ignoreUserIds] };
    this.self = credentials.userId;
    this.events = events;
    this.segmenter = new Segmenter({
      silenceMs: options.silenceMs,
      cut: cut => events.cut(cut),
      ...(options.live ? { live: { audio: (speaker: string, pcm: Buffer) => events.pcm(speaker, pcm), drop: (speaker: string) => events.drop(speaker) } } : {}),
      speech: speaker => {
        // The session hears first (it stops its speech, and says why), then barge-in stops what plays here: a
        // worker's media stops its speech without waiting for the session's round trip.
        events.speechStart(speaker);
        if (this.options.bargeIn) for (const playback of [...this.playing]) playback.stop();
      },
    });
    this.connection = transport.connect(credentials, {
      ready: () => { if (!this.closed) events.ready(); },
      packet: (speaker, packet) => {
        if (this.closed || speaker === this.self || this.options.ignoreUserIds.includes(speaker)) return;
        this.segmenter.packet(speaker, packet);
      },
      broken: speaker => { if (!this.closed) this.segmenter.broken(speaker); },
      lost: (reason, detail) => { if (!this.closed) events.lost(reason, detail); },
      diagnostic: (event, fields) => { if (!this.closed) events.diagnostic(event, fields); },
    });
  }

  get speaks() { return !!this.connection.play; }

  update(credentials: VoiceCredentials) {
    this.self = credentials.userId;
    this.connection.update(credentials);
  }

  configure(options: Partial<MediaOptions>) {
    this.options = { ...this.options, ...options };
  }

  others() { return this.connection.others(); }

  play(pcm: AsyncIterable<Uint8Array>, started: () => void): Playback {
    const play = this.connection.play;
    if (!play || this.closed) return { done: Promise.resolve("error"), stop: () => {} };
    const playback = play.call(this.connection, opusFromPcm(pcm), started);
    this.playing.add(playback);
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
