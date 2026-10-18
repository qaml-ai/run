import type { WebSocket } from "ws";
import type { VoiceConnection, VoiceCredentials, VoiceHandlers, VoiceTransport } from "./voice-sessions.ts";
import type { Playback } from "./voice-speech.ts";
import { Opus } from "./opus.ts";
import { safeError } from "./metrics.ts";

/**
 * Voice sessions from a browser (`provider: "browser"`): a call with no Discord in it, for trying a voice bot out (a
 * test panel, a preview). The browser holds one WebSocket to the session (`/v1/voice/sessions/{id}/socket`), sends the
 * microphone's audio, and hears the bot's speech on the same socket. Everything else is the session as Discord's: the
 * segmenter, barge-in, transcription, delivery, speak and agent replies.
 *
 * The socket's protocol:
 * - Browser → runtime, binary: one frame per message, its first byte its kind. 1: an Opus packet (20 ms at 48 kHz, mono
 *   or stereo, as WebCodecs' AudioEncoder makes them). 2: 20 ms of 16-bit little-endian PCM, 48 kHz mono (1,920 bytes),
 *   which the runtime encodes.
 * - Browser → runtime, text (JSON): `{"type":"speaker","id":"…"}` says whose the frames that follow are (by default
 *   `browser`), so one page can play several people; `{"type":"others","users":[…]}` who else is in the "call" (an
 *   empty list lets the session's emptySeconds end it); `{"type":"config","audio":"opus"|"pcm"}` how the bot's speech
 *   comes back.
 * - Runtime → browser, binary: the bot's speech, a frame each 20 ms as it plays: kind 1 (Opus, 48 kHz stereo), or with
 *   `audio: "pcm"` kind 2 (16-bit PCM, 48 kHz mono, 1,920 bytes).
 * - Runtime → browser, text: `{"type":"ready"}`, then the session's events as they happen (`utterance`, `speech`), so a
 *   page needs no webhook.
 *
 * One socket at a time per session; a socket that closes is the person hanging up (the session's `others` empties).
 */

export const BROWSER_FRAME = Object.freeze({ opus: 1, pcm: 2 });
/** 20 ms of 48 kHz mono 16-bit PCM. */
const PCM_FRAME_BYTES = 960 * 2;
/** Who speaks when the browser has not said. */
export const BROWSER_SPEAKER = "browser";
const SPEAKER = /^[A-Za-z0-9_-]{1,64}$/;
/** The bot's user in a browser call: never a speaker. */
export const BROWSER_BOT = "bot";

export type BrowserTransport = VoiceTransport & {
  /** Give a session's connection its socket; false when this node has no such connection, or it has one already. */
  attach(session: string, socket: WebSocket): boolean;
  /** Whether this node holds the session's connection. */
  holds(session: string): boolean;
};

export function browserVoice(): BrowserTransport {
  const connections = new Map<string, BrowserVoice>();
  return {
    speaks: true,
    connect(credentials, handlers) {
      const connection = new BrowserVoice(credentials, handlers, () => { if (connections.get(credentials.sessionId) === connection) connections.delete(credentials.sessionId); });
      connections.set(credentials.sessionId, connection);
      return connection;
    },
    attach: (session, socket) => connections.get(session)?.attach(socket) ?? false,
    holds: session => connections.has(session),
  };
}

class BrowserVoice implements VoiceConnection {
  private readonly handlers: VoiceHandlers;
  private readonly forget: () => void;
  private socket?: WebSocket;
  private speaker = BROWSER_SPEAKER;
  private audio: "opus" | "pcm" = "opus";
  /** Who is in the call: undefined before any socket came; the browser's speakers (or what it said) while one is open. */
  private members?: Set<string>;
  private told?: string[];
  private encoder?: Opus;
  private decoder?: Opus;
  private closed = false;

  constructor(_credentials: VoiceCredentials, handlers: VoiceHandlers, forget: () => void) {
    this.handlers = handlers;
    this.forget = forget;
  }

  attach(socket: WebSocket): boolean {
    if (this.closed || (this.socket && this.socket.readyState <= 1)) return false;
    this.socket = socket;
    this.members = new Set([BROWSER_SPEAKER]);
    this.told = undefined;
    socket.on("message", (data, binary) => {
      try { binary ? this.frame(data as Buffer) : this.control(String(data)); }
      catch (error) { this.handlers.diagnostic("browser_frame_failed", { error: safeError(error) }); }
    });
    socket.once("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      // Hung up: no one else in the call, which the session's emptySeconds ends.
      this.members = new Set();
      this.told = [];
    });
    socket.on("error", () => {});
    this.handlers.diagnostic("browser_attached", {});
    this.send({ type: "ready" });
    this.handlers.ready();
    return true;
  }

  private frame(data: Buffer) {
    if (data.length < 2) return;
    const payload = data.subarray(1);
    if (data[0] === BROWSER_FRAME.opus) this.handlers.packet(this.speaker, new Uint8Array(payload));
    else if (data[0] === BROWSER_FRAME.pcm) {
      if (payload.length !== PCM_FRAME_BYTES) return;
      this.encoder ??= new Opus(48_000, 1, "voip");
      this.handlers.packet(this.speaker, new Uint8Array(this.encoder.encode(payload, 960)));
    }
  }

  private control(text: string) {
    if (text.length > 4_096) return;
    const message = JSON.parse(text) as { type?: string; id?: unknown; users?: unknown; audio?: unknown };
    if (message.type === "speaker" && typeof message.id === "string" && SPEAKER.test(message.id) && message.id !== BROWSER_BOT) {
      this.speaker = message.id;
      this.members?.add(message.id);
    } else if (message.type === "others" && Array.isArray(message.users)) {
      this.told = message.users.filter((user): user is string => typeof user === "string" && SPEAKER.test(user)).slice(0, 50);
    } else if (message.type === "config" && (message.audio === "opus" || message.audio === "pcm")) this.audio = message.audio;
  }

  private send(value: unknown) {
    if (this.socket?.readyState === 1) this.socket.send(typeof value === "string" || Buffer.isBuffer(value) ? value as never : JSON.stringify(value));
  }

  /** A session's event for the page (an utterance transcribed, speech started or ended). */
  notify(event: Record<string, unknown>) { this.send(event); }

  update() {}

  others() {
    if (this.told) return [...this.told];
    return this.members ? [...this.members] : undefined;
  }

  /** Speech to the browser, a frame each 20 ms as a player would send it (so a stop takes effect at once). */
  play(packets: AsyncIterable<Uint8Array>, started: () => void): Playback {
    let stopped = false, sent = 0;
    const self = this;
    const done = (async (): Promise<"done" | "stopped" | "error"> => {
      try {
        const begun = performance.now();
        for await (const packet of packets) {
          if (stopped || self.closed) break;
          if (!sent) started();
          self.out(packet);
          sent++;
          // Paced from the first: a late frame is caught up on, not added to.
          const wait = begun + sent * 20 - performance.now();
          if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        }
        return stopped ? "stopped" : "done";
      } catch (error) {
        self.handlers.diagnostic("speech_error", { error: safeError(error) });
        return stopped ? "stopped" : "error";
      }
    })();
    return { done, stop: () => { stopped = true; }, stats: () => ({ packets: sent, startMs: 0, waitedMs: 0, gapMs: 0, heldMs: {} }) };
  }

  private out(packet: Uint8Array) {
    if (this.socket?.readyState !== 1) return;
    if (this.audio === "opus") { this.socket.send(Buffer.concat([Buffer.of(BROWSER_FRAME.opus), packet])); return; }
    this.decoder ??= new Opus(48_000, 1, "audio");
    this.socket.send(Buffer.concat([Buffer.of(BROWSER_FRAME.pcm), this.decoder.decode(packet)]));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.forget();
    this.socket?.close(1000, "session ended");
    this.encoder?.delete();
    this.decoder?.delete();
  }
}
