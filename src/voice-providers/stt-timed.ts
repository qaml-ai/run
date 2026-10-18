import { LIVE_LIMITS, type LiveTranscript, type LiveTranscription, type SttEvent } from "../transcription-live.ts";
import type { Socket } from "./socket.ts";

/**
 * A live stream to a provider that timestamps what it hears (Deepgram, Soniox, AssemblyAI): audio goes out as binary
 * frames as it comes, the provider sends final words with their times in the stream, and a commit asks it to finalize
 * what it has (each provider's own message) and takes the final words that start in that commit's stretch of audio.
 * Cleared audio's words are dropped by the same times, so a provider that cannot clear its buffer need not.
 *
 * Audio is 24 kHz mono 16-bit PCM (48 bytes a millisecond). Never logged, nor is a transcript.
 */

export const BYTES_PER_MS = 48;

/** A word the provider says is final: its text and where it is in the stream (ms from the stream's start). */
export type TimedWord = { text: string; startMs: number; endMs: number };

type Waiter = { fromMs: number; toMs: number; bytes: number; resolve(transcript: LiveTranscript): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

export type TimedOptions = {
  provider: string;
  model: string;
  onEvent?: (event: SttEvent) => void;
  /** Sent once open, before any audio (a configuration message). */
  first?: string;
  /** Sent after this long without audio, so the provider keeps the stream open. */
  keepAlive?: { ms: number; message: string };
  /** Sent before closing, so the provider ends the stream cleanly. */
  last?: string | Uint8Array;
  commitTimeoutMs?: number;
  /** How the words of one transcript join: " " for words, "" for providers whose tokens carry their own spaces. */
  joiner?: string;
};

export abstract class TimedLive implements LiveTranscription {
  closed = false;
  protected readonly socket: Socket;
  protected readonly settings: TimedOptions;
  private open = false;
  private closing = false;
  private readonly queue: (string | Uint8Array)[] = [];
  private readonly waiters: Waiter[] = [];
  /** Final words not yet taken by a commit, in stream order. */
  private words: TimedWord[] = [];
  /** Audio sent (ms of it), and where the audio not yet committed or cleared starts. */
  protected sentMs = 0;
  private cutMs = 0;
  /** How far into the stream the provider has finalized (`finalThrough`). */
  private finalizedMs = 0;
  private bytes = 0;
  private lastAudio = Date.now();
  private language?: string;
  private readonly connectTimer: ReturnType<typeof setTimeout>;
  private readonly keepAliveTimer?: ReturnType<typeof setInterval>;

  constructor(socket: Socket, settings: TimedOptions) {
    this.socket = socket;
    this.settings = settings;
    if (settings.first) this.queue.push(settings.first);
    this.connectTimer = setTimeout(() => { if (!this.open) this.fail(new Error(`The ${settings.provider} live transcription connection did not open`)); }, LIVE_LIMITS.connectTimeoutMs);
    this.connectTimer.unref?.();
    if (settings.keepAlive) {
      const { ms, message } = settings.keepAlive;
      this.keepAliveTimer = setInterval(() => { if (this.open && Date.now() - this.lastAudio >= ms) this.socket.send(message); }, ms);
      this.keepAliveTimer.unref?.();
    }
    socket.onopen = () => {
      clearTimeout(this.connectTimer);
      this.open = true;
      for (const message of this.queue.splice(0)) socket.send(message);
    };
    socket.onmessage = event => this.message(event.data);
    socket.onerror = () => this.fail(new Error(`The ${settings.provider} live transcription connection failed`));
    socket.onclose = event => this.fail(new Error(`The ${settings.provider} live transcription connection closed${event?.code ? ` (${event.code}${event.reason ? `: ${String(event.reason).slice(0, 200)}` : ""})` : ""}`));
  }

  /** What the provider sent: its words (`final`), partial text (`partial`), a finalize answered (`flushed`). */
  protected abstract message(data: unknown): void;
  /** Ask the provider to finalize what it has heard: it answers with `flushed()`. */
  protected abstract finalize(): void;

  append(pcm: Uint8Array) {
    if (this.closed || !pcm.byteLength) return;
    this.bytes += pcm.byteLength;
    this.sentMs += pcm.byteLength / BYTES_PER_MS;
    this.lastAudio = Date.now();
    this.send(pcm);
  }

  commit(): Promise<LiveTranscript> {
    if (this.closed) return Promise.reject(new Error(`The ${this.settings.provider} live transcription connection is closed`));
    const fromMs = this.cutMs, toMs = this.sentMs, bytes = this.bytes;
    this.cutMs = this.sentMs;
    this.bytes = 0;
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        fromMs, toMs, bytes, resolve, reject,
        timer: setTimeout(() => this.settle(waiter, new Error(`The ${this.settings.provider} live transcription did not answer in time`)), this.settings.commitTimeoutMs ?? LIVE_LIMITS.commitTimeoutMs),
      };
      waiter.timer.unref?.();
      this.waiters.push(waiter);
      // All of it finalized already (nothing new since): answered now.
      if (toMs <= this.finalizedMs + 20 && this.waiters.length === 1) this.answer(waiter);
      else this.finalize();
    });
  }

  clear() {
    if (this.closed) return;
    this.cutMs = this.sentMs;
    this.bytes = 0;
    this.words = this.words.filter(word => word.startMs >= this.cutMs);
  }

  close(graceful = false) {
    if (graceful && this.waiters.length) { this.closing = true; return; }
    if (this.open && this.settings.last !== undefined) { try { this.socket.send(this.settings.last); } catch { /* closing anyway */ } }
    this.fail(new Error(`The ${this.settings.provider} live transcription connection is closed`));
  }

  protected send(data: string | Uint8Array) {
    if (this.closed) return;
    if (this.open) this.socket.send(data);
    else this.queue.push(data);
  }

  /** Final words heard. Words of audio since cleared are dropped. */
  protected final(words: TimedWord[], language?: string) {
    if (language) this.language = language;
    for (const word of words) {
      if (!word.text) continue;
      // Of cleared audio: before the oldest commit waiting, and before the current stretch.
      if (word.startMs < this.cutAt - 1) continue;
      this.words.push(word);
    }
  }

  /** The words heard since the last commit: its final words not yet taken, then `pending` (words not final yet). */
  protected partial(pending: string) {
    if (!this.settings.onEvent) return;
    const joiner = this.settings.joiner ?? " ";
    const trimmed = [...this.words.map(word => word.text), pending].join(joiner).replace(/\s+/g, " ").trim();
    if (trimmed) this.settings.onEvent?.({ type: "partial", text: trimmed });
  }

  protected event(event: SttEvent) { this.settings.onEvent?.(event); }

  /** The provider finalized all it had: the oldest commit takes its words. */
  protected flushed() {
    const waiter = this.waiters[0];
    if (waiter) this.answer(waiter);
  }

  /** The provider has finalized the stream up to `ms`: commits that end by then take their words. */
  protected finalThrough(ms: number) {
    this.finalizedMs = Math.max(this.finalizedMs, ms);
    while (this.waiters[0] && this.waiters[0].toMs <= this.finalizedMs + 20) this.answer(this.waiters[0]);
  }

  /** Where the audio a word may still be taken for starts: the oldest waiting commit's, else the current stretch's. */
  protected get cutAt() { return this.waiters[0]?.fromMs ?? this.cutMs; }

  /** Whether a commit waits for its words. */
  protected get waiting() { return this.waiters.length > 0; }

  /** The oldest waiting commit's stretch of the stream, if any. */
  protected get oldestWaiting() { const waiter = this.waiters[0]; return waiter && { fromMs: waiter.fromMs, toMs: waiter.toMs }; }

  /** Answer the oldest commit now with the words it has (a provider whose finalize never says it is done). */
  protected answerOldest() { this.flushed(); }

  private answer(waiter: Waiter) {
    // The words that start before the commit's end are its own; a word straddling the cut belongs where it starts.
    const taken = this.words.filter(word => word.startMs < waiter.toMs);
    this.words = this.words.filter(word => word.startMs >= waiter.toMs);
    const text = taken.map(word => word.text).join(this.settings.joiner ?? " ").replace(/\s+/g, " ").trim();
    this.settle(waiter, {
      text, ...(this.language ? { language: this.language } : {}),
      seconds: Math.ceil(waiter.bytes / (BYTES_PER_MS * 1000)), model: this.settings.model, provider: this.settings.provider,
    });
  }

  protected fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.connectTimer);
    clearInterval(this.keepAliveTimer);
    for (const waiter of this.waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.socket.onopen = this.socket.onmessage = this.socket.onclose = this.socket.onerror = null;
    try { this.socket.close(); } catch { /* not open yet */ }
  }

  private settle(waiter: Waiter, outcome: LiveTranscript | Error) {
    const index = this.waiters.indexOf(waiter);
    if (index < 0) return;
    this.waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    if (outcome instanceof Error) waiter.reject(outcome);
    else waiter.resolve(outcome);
    if (this.closing && !this.waiters.length) this.close();
  }
}
