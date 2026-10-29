/**
 * Where a voice session's speech plays (voice-sessions.ts): its realtime brain's answers (src/voice/realtime/brain.ts),
 * what the bot's code has it say, and audio it plays (src/voice/jukebox.ts),
 * as PCM the session's media encodes into 20 ms Opus packets as it comes (voice-audio.ts), so the first audio goes out
 * well before the whole answer is made.
 */

/** A playback on a connection: done when its packets ran out (`done`), it was stopped, or it failed. */
export interface Playback {
  done: Promise<"done" | "stopped" | "error">; stop(): void;
  /** Hold the packets (the listener hears silence) until `resume`, where it left off: a player that cannot, has none. */
  pause?(): void; resume?(): void;
  /** Packets sent, the time spent waiting for the next packet (speech still being made), and time held back by why. */
  stats?(): { packets: number; startMs: number; waitedMs: number; gapMs: number; heldMs: Record<string, number> };
}
/**
 * Where speech plays: a session's media (src/voice/media.ts). `pcm` is the speech as it is made (24 kHz mono 16-bit),
 * which the media encodes; `started` is called as its first packet goes out.
 */
export interface Player { play(pcm: AsyncIterable<Uint8Array>, started: () => void, expectedMs?: number, options?: PlayOptions): Playback }
/**
 * `music`: audio the bot plays (src/voice/jukebox.ts) rather than speech. Barge-in leaves it be (people talk over
 * music), and the bot's speech holds it instead (the jukebox's `duck`).
 */
export type PlayOptions = { music?: boolean };
