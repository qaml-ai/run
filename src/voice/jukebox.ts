import { randomBytes } from "node:crypto";
import { clock as nodeClock, type Clock } from "../node-context.ts";
import { HttpError } from "../http.ts";
import { safeError } from "../metrics.ts";
import type { Playback, Player } from "../voice-speech.ts";
import { AUDIO_RATE, decodeAudio } from "./audio-decode.ts";

/**
 * Audio a voice session plays into its call (POST /v1/voice/sessions/{id}/audio): files the bot has, or http(s) URLs of
 * audio files and streams, one after another from a queue. Each is decoded as it comes (audio-decode.ts: MP3, Ogg
 * Opus, WAV) and handed to the session's media a little ahead of where it plays, never all at once, so a long file or a
 * stream holds a second or two in memory.
 *
 * - **Speech comes first.** While the bot speaks (its realtime brain's answers, what its code has it say), the music
 *   holds (`duck`) and goes on where it stopped a moment after. People talking over it don't stop it: barge-in is for
 *   speech.
 * - **Controls.** pause, resume, skip, stop (the queue too), and volume (0 to 1, applied to what is handed out next).
 * - **Limits.** AUDIO_LIMITS: tracks queued, bytes fetched or uploaded, and how long one track plays (a stream ends
 *   there).
 *
 * Audio is never stored: an upload is held in memory until it plays, and a URL is read as it plays.
 */

export const AUDIO_LIMITS = Object.freeze({
  /** Tracks waiting, besides the one playing. */
  queue: 20,
  /** Bytes read of one URL: a stream past it ends there. */
  fileBytes: 50 * 1024 * 1024,
  /** Bytes of one upload, and of the uploads a session holds queued. */
  uploadBytes: 10 * 1024 * 1024, uploadsBytes: 40 * 1024 * 1024,
  /** The longest a track plays. */
  trackSeconds: 30 * 60,
  /** How far ahead of where it plays audio is handed to the media. */
  leadMs: 1_000,
  /** How long after the bot stops speaking music goes on. */
  resumeMs: 400,
  /** A track's title. */
  titleChars: 200,
});

/** What to play: a URL read as it plays, or bytes given. */
export type AudioSource = { url: string } | { bytes: Uint8Array };

export type TrackView = { id: string; title: string | null; source: "url" | "upload"; addedAt: number };
export type AudioState = {
  playing: (TrackView & { positionMs: number; paused: boolean }) | null;
  queue: TrackView[]; volume: number; paused: boolean;
};
export type TrackEnded = "done" | "skipped" | "stopped" | "error";

export interface JukeboxHooks {
  /** Where audio plays now (the session's media), if anywhere. */
  player(): Player | undefined;
  /** The source's bytes as they come; throws (an HttpError) when it can't be read. */
  open(source: AudioSource, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
  /** A track began playing, or ended (with the seconds it played, and why). */
  event(event: { type: "started"; track: TrackView } | { type: "ended"; track: TrackView; reason: TrackEnded; seconds: number; error?: string }): void;
  /** Audio is playing: the call isn't idle. Called about every 30 s of it. */
  active(): void;
  /** Structured log lines: never URLs or audio. */
  log(type: string, fields?: Record<string, unknown>): void;
}

/** 100 ms of PCM at AUDIO_RATE, 16-bit mono: the unit audio is handed out in. */
const CHUNK_BYTES = AUDIO_RATE / 10 * 2;
const CHUNK_MS = 100;

type Track = TrackView & { input: AudioSource };

/** A track's PCM in 100 ms chunks, read from its source as needed; what was handed out but not heard can be read again. */
class Cursor {
  private readonly track: Track;
  private readonly hooks: JukeboxHooks;
  private readonly abort = new AbortController();
  private decoded?: AsyncIterator<Uint8Array>;
  private carry = new Uint8Array(0);
  private ended = false;
  /** Chunks from `keptMs` on, and the next to read. */
  private kept: Uint8Array[] = [];
  private keptMs = 0;
  private next = 0;

  constructor(track: Track, hooks: JukeboxHooks) { this.track = track; this.hooks = hooks; }

  /** Where the next read starts (ms into the track). */
  get positionMs() { return this.keptMs + this.next * CHUNK_MS; }

  /** Read from `ms` on again (what was handed out past it was not heard); what came before is let go. */
  seek(ms: number) {
    const drop = Math.max(0, Math.min(this.kept.length, Math.floor((ms - this.keptMs) / CHUNK_MS)));
    this.kept.splice(0, drop);
    this.keptMs += drop * CHUNK_MS;
    this.next = 0;
  }

  /** What plays before `ms` was heard: let go (what was handed out after it is kept, to go on from there). */
  release(ms: number) {
    const drop = Math.max(0, Math.min(this.next, Math.floor((ms - this.keptMs) / CHUNK_MS)));
    this.kept.splice(0, drop);
    this.keptMs += drop * CHUNK_MS;
    this.next -= drop;
  }

  /** Chunks held (for tests and the memory it takes). */
  get held() { return this.kept.length; }

  /** The next 100 ms, or undefined at the end. */
  async read(): Promise<Uint8Array | undefined> {
    if (this.next < this.kept.length) return this.kept[this.next++];
    if (this.positionMs >= AUDIO_LIMITS.trackSeconds * 1000) return undefined;
    this.decoded ??= decodeAudio(await this.hooks.open(this.track.input, this.abort.signal))[Symbol.asyncIterator]();
    while (this.carry.length < CHUNK_BYTES && !this.ended) {
      const step = await this.decoded.next();
      if (step.done) { this.ended = true; break; }
      const joined = new Uint8Array(this.carry.length + step.value.length);
      joined.set(this.carry);
      joined.set(step.value, this.carry.length);
      this.carry = joined;
    }
    if (!this.carry.length) return undefined;
    const chunk = this.carry.slice(0, CHUNK_BYTES);
    this.carry = this.carry.subarray(chunk.length);
    this.kept.push(chunk);
    this.next++;
    return chunk;
  }

  close() {
    this.abort.abort();
    void this.decoded?.return?.(undefined)?.catch(() => {});
    this.kept = [];
  }
}

type Current = {
  track: Track; cursor: Cursor; playback?: Playback;
  /** Heard of it so far (ms), and when what plays now started. */
  playedMs: number; startedAt?: number; announced: boolean;
  error?: string;
};

export class Jukebox {
  private readonly hooks: JukeboxHooks;
  private readonly clock: Clock;
  private readonly queue: Track[] = [];
  private current?: Current;
  private paused = false;
  /** Bots' speech holds it (`duck`), and when it may go on. */
  private ducked = false;
  private resumeTimer?: ReturnType<Clock["setTimeout"]>;
  private volume = 0.5;
  private closed = false;
  readonly stats = { tracks: 0, playedMs: 0, errors: 0 };

  constructor(hooks: JukeboxHooks, options: { clock?: Clock } = {}) {
    this.hooks = hooks;
    this.clock = options.clock ?? nodeClock();
  }

  /** Queue a track (`next`: before the others); it plays at once when nothing else is. */
  add(source: AudioSource, options: { title?: string; next?: boolean; volume?: number } = {}): { track: TrackView; position: number } {
    if (this.closed) throw new HttpError(409, "The voice session ended");
    if (this.queue.length >= AUDIO_LIMITS.queue) throw new HttpError(429, `At most ${AUDIO_LIMITS.queue} tracks wait in the queue: skip or stop some first`, "AUDIO_QUEUE_FULL");
    if ("bytes" in source) {
      if (source.bytes.length > AUDIO_LIMITS.uploadBytes) throw new HttpError(413, `An upload is at most ${AUDIO_LIMITS.uploadBytes / 1024 / 1024} MB: give a URL for a bigger file`);
      const held = this.queue.reduce((sum, track) => sum + ("bytes" in track.input ? track.input.bytes.length : 0), 0);
      if (held + source.bytes.length > AUDIO_LIMITS.uploadsBytes) throw new HttpError(429, `Uploads waiting in the queue hold at most ${AUDIO_LIMITS.uploadsBytes / 1024 / 1024} MB`, "AUDIO_QUEUE_FULL");
    }
    if (options.volume !== undefined) this.setVolume(options.volume);
    const track: Track = {
      id: `au_${randomBytes(8).toString("hex")}`, title: options.title?.trim().slice(0, AUDIO_LIMITS.titleChars) || null,
      source: "url" in source ? "url" : "upload", addedAt: this.clock.now(), input: source,
    };
    if (options.next) this.queue.unshift(track);
    else this.queue.push(track);
    const position = this.current ? this.queue.indexOf(track) + 1 : 0;
    this.advance();
    return { track: view(track), position };
  }

  state(): AudioState {
    const current = this.current;
    return {
      playing: current ? { ...view(current.track), positionMs: Math.round(this.heardMs(current)), paused: this.paused } : null,
      queue: this.queue.map(view), volume: this.volume, paused: this.paused,
    };
  }

  pause() { this.paused = true; this.hold(); return this.state(); }

  resume() {
    this.paused = false;
    this.start();
    return this.state();
  }

  /** The track playing ends, and the next one plays. */
  skip() {
    if (this.current) this.finish(this.current, "skipped");
    return this.state();
  }

  /** Nothing more plays: the track playing ends, and the queue is emptied. */
  stop() {
    const dropped = this.queue.splice(0);
    if (this.current) this.finish(this.current, "stopped");
    for (const track of dropped) this.hooks.event({ type: "ended", track: view(track), reason: "stopped", seconds: 0 });
    return this.state();
  }

  setVolume(volume: number) {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new HttpError(400, "volume must be from 0 to 1");
    this.volume = volume;
    return this.state();
  }

  /** The bot is speaking (`true`): the music holds; once it stops (`false`), it goes on a moment later. */
  duck(speaking: boolean) {
    if (speaking === this.ducked) return;
    this.ducked = speaking;
    this.clock.clearTimeout(this.resumeTimer);
    this.resumeTimer = undefined;
    if (speaking) { this.hold(); return; }
    this.resumeTimer = this.clock.setTimeout(() => { this.resumeTimer = undefined; this.start(); }, AUDIO_LIMITS.resumeMs);
  }

  /** Whether anything plays or waits. */
  get busy() { return !!this.current || this.queue.length > 0; }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.clock.clearTimeout(this.resumeTimer);
    const current = this.current;
    this.current = undefined;
    this.queue.splice(0);
    if (current) {
      current.playback?.stop();
      current.cursor.close();
      this.stats.playedMs += this.heardMs(current);
    }
  }

  // ------------------------------------------------------------------------------------

  private heardMs(current: Current) {
    return current.playedMs + (current.startedAt === undefined ? 0 : Math.max(0, this.clock.now() - current.startedAt));
  }

  /** Nothing playing: the next track in the queue begins. */
  private advance() {
    if (this.closed || this.current) return;
    const track = this.queue.shift();
    if (!track) return;
    this.current = { track, cursor: new Cursor(track, this.hooks), playedMs: 0, announced: false };
    this.stats.tracks++;
    this.start();
  }

  /** Stop what plays now, keeping where it was heard to (it goes on from there). */
  private hold() {
    this.current?.playback?.stop();
  }

  /** Play the current track from where it was heard to, unless something holds it. */
  private start() {
    const current: Current | undefined = this.current;
    if (!current || current.playback || this.paused || this.ducked || this.closed) return;
    const player = this.hooks.player();
    if (!player) return;
    const playing: Current = current;
    const { cursor } = current;
    cursor.seek(current.playedMs);
    const fromMs = cursor.positionMs;
    current.playedMs = fromMs;
    const self = this;
    let sentMs = 0, exhausted = false, activeAt = 0;
    const began = this.clock.now();
    async function* paced(): AsyncGenerator<Uint8Array> {
      for (;;) {
        let chunk: Uint8Array | undefined;
        try { chunk = await cursor.read(); }
        catch (error) {
          playing.error = error instanceof HttpError ? error.message : `The audio couldn't be read: ${safeError(error)}`;
          return;
        }
        if (!chunk) { exhausted = true; return; }
        // Handed out at most leadMs ahead of where it plays.
        const ahead = sentMs - (self.clock.now() - began) - AUDIO_LIMITS.leadMs;
        if (ahead > 0) await self.clock.sleep(ahead);
        if (sentMs - activeAt >= 30_000) { activeAt = sentMs; self.hooks.active(); }
        // What was heard is let go: only what is ahead of the listener stays.
        if (playing.startedAt !== undefined) cursor.release(fromMs + self.clock.now() - playing.startedAt - CHUNK_MS);
        sentMs += CHUNK_MS;
        yield scaled(chunk, self.volume);
      }
    }
    const playback = player.play(paced(), () => {
      current.startedAt = this.clock.now();
      if (current.announced) return;
      current.announced = true;
      this.hooks.event({ type: "started", track: view(current.track) });
      this.hooks.active();
    }, undefined, { music: true });
    current.playback = playback;
    void playback.done.then(result => {
      // Played out: all of it was heard; else what was heard since it started (it plays in real time).
      const heard = exhausted && result === "done" ? sentMs : current.startedAt === undefined ? 0 : Math.min(sentMs, this.clock.now() - current.startedAt);
      current.playedMs = fromMs + Math.max(0, heard);
      current.startedAt = undefined;
      current.playback = undefined;
      if (this.current !== current) return;
      if (current.error) { this.finish(current, "error"); return; }
      if (exhausted && result === "done") { this.finish(current, "done"); return; }
      if (result === "error") { current.error = "The call's audio failed"; this.finish(current, "error"); return; }
      // Held (paused, the bot speaking) or cut off: it goes on from where it was heard to, when it may.
      if (!this.paused && !this.ducked) this.clock.setTimeout(() => this.start(), AUDIO_LIMITS.resumeMs);
    });
  }

  private finish(current: Current, reason: TrackEnded) {
    if (this.current !== current) return;
    this.current = undefined;
    current.playback?.stop();
    current.cursor.close();
    const heardMs = this.heardMs(current);
    this.stats.playedMs += heardMs;
    if (reason === "error") this.stats.errors++;
    this.hooks.log("voice_audio_ended", { track: current.track.id, reason, seconds: Math.round(heardMs / 100) / 10, source: current.track.source });
    this.hooks.event({ type: "ended", track: view(current.track), reason, seconds: Math.round(heardMs / 100) / 10, ...(current.error ? { error: current.error } : {}) });
    this.advance();
  }
}

function view(track: Track): TrackView {
  return { id: track.id, title: track.title, source: track.source, addedAt: track.addedAt };
}

/** A chunk at `volume` (0 to 1). */
function scaled(chunk: Uint8Array, volume: number): Uint8Array {
  const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.byteLength >> 1);
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.round(samples[i] * volume);
  return new Uint8Array(out.buffer);
}
