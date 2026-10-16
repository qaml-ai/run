import type { TranscriptionCredentials, TranscriptionOptions } from "./transcription.ts";

/**
 * Speech transcribed as it is spoken (voice sessions): each speaker's audio goes to OpenAI's Realtime transcription
 * session as it comes, and the end of an utterance (our own segmenter's cut, never the provider's VAD) commits it, so
 * the transcript follows the end of speech by the model's last step rather than an upload and a whole transcription.
 * Audio is 24 kHz mono 16-bit PCM. Never logged, nor is a transcript.
 */

/** OpenAI's streaming model: deltas as audio arrives, the final transcript right after a commit. */
export const LIVE_TRANSCRIPTION_MODEL = "gpt-live-transcribe";
export const LIVE_LIMITS = Object.freeze({
  /** A commit with no transcript by then fails (and its utterance is transcribed the usual way). */
  commitTimeoutMs: 10_000,
  connectTimeoutMs: 10_000,
  /** A speaker's connection closes after this long without audio; the next utterance opens another. */
  idleMs: 60_000,
});

export type LiveTranscript = { text: string; language?: string; seconds: number; model: string };

/** One speaker's stream: audio appended as it comes, cut into transcripts by `commit`. */
export interface LiveTranscription {
  /** 24 kHz mono 16-bit PCM. */
  append(pcm: Uint8Array): void;
  /** The audio appended since the last commit or clear, transcribed. Rejects if the stream fails or times out. */
  commit(): Promise<LiveTranscript>;
  /** Forget the audio appended since the last commit (an utterance too short to keep). */
  clear(): void;
  /** Close now, or once the commits it has have answered (`graceful`). */
  close(graceful?: boolean): void;
  readonly closed: boolean;
}

export interface LiveTranscriptionProvider {
  id: string;
  model: string;
  /** A stream on these credentials, or undefined when they cannot stream (a key scope's own gateway). */
  connect(credentials: TranscriptionCredentials, options: TranscriptionOptions): LiveTranscription | undefined;
}

type Socket = { send(data: string): void; close(): void; readyState: number; onopen: (() => void) | null; onmessage: ((event: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: ((event: unknown) => void) | null };
type Waiter = { bytes: number; item?: string; resolve(transcript: LiveTranscript): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

/**
 * OpenAI's Realtime transcription over a WebSocket (wss://…/v1/realtime?intent=transcription), with turn detection
 * off: we say where utterances end. Only the operator's address (or OpenAI's) is dialled, never a key scope's.
 */
export function openaiLiveTranscription(options: { baseUrl?: string; model?: string; delay?: string; socket?: (url: string, headers: Record<string, string>) => Socket } = {}): LiveTranscriptionProvider {
  const { baseUrl = "https://api.openai.com/v1", model = LIVE_TRANSCRIPTION_MODEL, delay } = options;
  const socket = options.socket ?? ((url, headers) => new WebSocket(url, { headers } as never) as unknown as Socket);
  return {
    id: "openai",
    model,
    connect(given, asked) {
      // The platform's Azure deployment: its OpenAI fallback streams instead. A key scope's own address does not.
      const credentials = given.via === "azure" ? given.fallback : given;
      if (!credentials || credentials.baseUrl || credentials.via || !credentials.apiKey) return undefined;
      const url = `${baseUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/realtime?intent=transcription`;
      return new OpenAILive(socket(url, { Authorization: `Bearer ${credentials.apiKey}` }), {
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24_000 },
              transcription: { model, ...(asked.language ? { language: asked.language } : {}), ...(asked.prompt && model !== "gpt-realtime-whisper" ? { prompt: asked.prompt } : {}), ...(delay ? { delay } : {}) },
              turn_detection: null,
            },
          },
        },
      }, model);
    },
  };
}

class OpenAILive implements LiveTranscription {
  closed = false;
  private readonly socket: Socket;
  private readonly model: string;
  private open = false;
  private closing = false;
  /** What is sent before the socket opens. */
  private readonly queue: string[] = [];
  /** Commits waiting for their transcripts, oldest first; each is named by its item once committed. */
  private readonly waiters: Waiter[] = [];
  private bytes = 0;
  private readonly connectTimer: ReturnType<typeof setTimeout>;

  constructor(socket: Socket, update: unknown, model: string) {
    this.socket = socket;
    this.model = model;
    this.queue.push(JSON.stringify(update));
    this.connectTimer = setTimeout(() => { if (!this.open) this.fail(new Error("The live transcription connection did not open")); }, LIVE_LIMITS.connectTimeoutMs);
    this.connectTimer.unref?.();
    socket.onopen = () => {
      clearTimeout(this.connectTimer);
      this.open = true;
      for (const message of this.queue.splice(0)) socket.send(message);
    };
    socket.onmessage = event => this.message(event.data);
    socket.onerror = () => this.fail(new Error("The live transcription connection failed"));
    socket.onclose = () => this.fail(new Error("The live transcription connection closed"));
  }

  append(pcm: Uint8Array) {
    if (this.closed || !pcm.byteLength) return;
    this.bytes += pcm.byteLength;
    this.send({ type: "input_audio_buffer.append", audio: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64") });
  }

  commit(): Promise<LiveTranscript> {
    if (this.closed) return Promise.reject(new Error("The live transcription connection is closed"));
    const bytes = this.bytes;
    this.bytes = 0;
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        bytes, resolve, reject,
        timer: setTimeout(() => this.settle(waiter, new Error("The live transcription did not answer in time")), LIVE_LIMITS.commitTimeoutMs),
      };
      waiter.timer.unref?.();
      this.waiters.push(waiter);
      this.send({ type: "input_audio_buffer.commit" });
    });
  }

  clear() {
    if (this.closed) return;
    this.bytes = 0;
    this.send({ type: "input_audio_buffer.clear" });
  }

  close(graceful = false) {
    if (graceful && this.waiters.length) { this.closing = true; return; }
    this.fail(new Error("The live transcription connection is closed"));
  }

  private send(message: unknown) {
    const data = JSON.stringify(message);
    if (this.open) this.socket.send(data);
    else this.queue.push(data);
  }

  private message(data: unknown) {
    let event: any;
    try { event = JSON.parse(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8")); } catch { return; }
    if (event?.type === "input_audio_buffer.committed") {
      const waiter = this.waiters.find(entry => entry.item === undefined);
      if (waiter) waiter.item = event.item_id;
    } else if (event?.type === "conversation.item.input_audio_transcription.completed") {
      // Turns may answer out of order: matched by item.
      const waiter = this.waiters.find(entry => entry.item === event.item_id);
      if (!waiter) return;
      const usage = event.usage;
      // Whole seconds, as transcriptions are billed: OpenAI's duration, else the audio sent.
      const seconds = Math.ceil(usage?.type === "duration" && Number.isFinite(usage.seconds) ? Number(usage.seconds) : waiter.bytes / 48_000);
      const language = typeof event.languages?.[0]?.code === "string" ? event.languages[0].code : undefined;
      this.settle(waiter, { text: String(event.transcript ?? "").trim(), ...(language ? { language } : {}), seconds, model: this.model });
    } else if (event?.type === "conversation.item.input_audio_transcription.failed") {
      const waiter = this.waiters.find(entry => entry.item === event.item_id);
      if (waiter) this.settle(waiter, new Error(`Live transcription failed${typeof event.error?.code === "string" ? ` (${event.error.code})` : ""}`));
    } else if (event?.type === "error") {
      // A commit refused (an empty buffer) is the oldest one not committed; anything else ends the stream.
      const code = typeof event.error?.code === "string" ? event.error.code : "error";
      const waiter = this.waiters.find(entry => entry.item === undefined);
      if (waiter && /buffer/.test(code)) this.settle(waiter, new Error(`Live transcription refused the audio (${code})`));
      else this.fail(new Error(`Live transcription failed (${code})`));
    }
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

  private fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.connectTimer);
    for (const waiter of this.waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.socket.onopen = this.socket.onmessage = this.socket.onclose = this.socket.onerror = null;
    try { this.socket.close(); } catch { /* not open yet */ }
  }
}

/**
 * A stream whose credentials are still being found: what it is asked meanwhile is kept, in order, and given to the
 * stream once there is one. Without one (no key that can stream), commits reject, and the caller transcribes the
 * usual way.
 */
export function deferredLive(opening: Promise<LiveTranscription | undefined>): LiveTranscription {
  let stream: LiveTranscription | undefined, settled = false, closed = false;
  const pending: ((live: LiveTranscription | undefined) => void)[] = [];
  void opening.then(live => live, () => undefined).then(live => {
    settled = true;
    stream = closed ? (live?.close(), undefined) : live;
    for (const step of pending.splice(0)) step(stream);
  });
  const later = <T>(step: (live: LiveTranscription | undefined) => T) => settled ? step(stream) : void pending.push(step);
  return {
    append: pcm => later(live => live?.append(pcm)),
    commit: () => new Promise((resolve, reject) => later(live => live ? live.commit().then(resolve, reject) : reject(new Error("No key can transcribe live")))),
    clear: () => later(live => live?.clear()),
    close: graceful => { if (!settled) closed = !graceful; later(live => live?.close(graceful)); },
    get closed() { return closed || (settled && (!stream || stream.closed)); },
  };
}
