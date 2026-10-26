/**
 * Each SSRC's RTP packets put back in order (docs/operations/voice-pipeline.md, "Audio hygiene"). UDP may deliver a
 * speaker's packets out of order or not at all, and an Opus stream decodes in order. A packet in order goes on at
 * once, so the buffer adds no delay when nothing is wrong. One that arrives ahead of a gap is held, for at most
 * `holdMs` or until `maxHeld` are waiting, for the missing ones to come. Then what is held goes on in order, each
 * after the gap before it is counted as lost (`lost`, for concealment). A packet older than what already went on is
 * late, and dropped: its place was concealed.
 *
 * Sequence numbers are 16-bit and wrap.
 */

export const JITTER = Object.freeze({
  /** The longest a packet waits for those missing before it: 60 ms, three packets of 20 ms. */
  holdMs: 60,
  maxHeld: 3,
  /** A jump this far (or a step back this far) is a new stream (a client that restarted its sequence), not loss. */
  resetGap: 1_000,
});

type Stream = { expected: number; held: Map<number, Uint8Array>; timer?: ReturnType<typeof setTimeout> };

/** Packets lost and late, per SSRC and in all: for diagnostics. */
export type JitterStats = { released: number; reordered: number; lost: number; late: number };

/** Signed distance from `from` to `to`, in 16-bit sequence space. */
const ahead = (from: number, to: number) => ((to - from + 0x8000) & 0xffff) - 0x8000;

export class JitterBuffer<P extends Uint8Array = Uint8Array> {
  private readonly streams = new Map<number, Stream>();
  private readonly release: (ssrc: number, packet: P, lost: number) => void;
  private readonly holdMs: number;
  private readonly maxHeld: number;
  readonly stats: JitterStats = { released: 0, reordered: 0, lost: 0, late: 0 };

  constructor(release: (ssrc: number, packet: P, lost: number) => void, options: { holdMs?: number; maxHeld?: number } = {}) {
    this.release = release;
    this.holdMs = options.holdMs ?? JITTER.holdMs;
    this.maxHeld = options.maxHeld ?? JITTER.maxHeld;
  }

  push(ssrc: number, sequence: number, packet: P) {
    let stream = this.streams.get(ssrc);
    if (!stream) {
      this.streams.set(ssrc, stream = { expected: (sequence + 1) & 0xffff, held: new Map() });
      this.out(ssrc, packet, 0);
      return;
    }
    const distance = ahead(stream.expected, sequence);
    if (Math.abs(distance) >= JITTER.resetGap) {
      // A new stream on the same SSRC: what was held goes first, then this one, with nothing counted lost.
      this.flush(ssrc);
      stream.expected = (sequence + 1) & 0xffff;
      this.out(ssrc, packet, 0);
      return;
    }
    if (distance < 0 || stream.held.has(sequence)) { this.stats.late++; return; }
    if (distance === 0) {
      stream.expected = (sequence + 1) & 0xffff;
      this.out(ssrc, packet, 0);
      this.drain(ssrc, stream);
      return;
    }
    // Ahead of a gap: wait a little for what is missing.
    stream.held.set(sequence, packet as P & Uint8Array);
    this.stats.reordered++;
    if (stream.held.size > this.maxHeld) { this.skip(ssrc, stream); return; }
    if (!stream.timer) {
      stream.timer = setTimeout(() => { stream.timer = undefined; this.skip(ssrc, stream); }, this.holdMs);
      stream.timer.unref?.();
    }
  }

  /** Release what an SSRC holds now, in order (its speaker left, or the connection closes). */
  flush(ssrc: number) {
    const stream = this.streams.get(ssrc);
    if (!stream) return;
    while (stream.held.size) this.skip(ssrc, stream, false);
  }

  /** Forget an SSRC (its speaker left). */
  forget(ssrc: number) {
    const stream = this.streams.get(ssrc);
    if (stream) clearTimeout(stream.timer);
    this.streams.delete(ssrc);
  }

  /** SSRCs it tracks, and packets it holds: for memory reports. */
  sizes() {
    let held = 0;
    for (const stream of this.streams.values()) held += stream.held.size;
    return { jitterSsrcs: this.streams.size, jitterHeld: held };
  }

  close() {
    for (const stream of this.streams.values()) clearTimeout(stream.timer);
    this.streams.clear();
  }

  /** The missing packet is given up on: the earliest held goes on after the gap, and what follows it in order. */
  private skip(ssrc: number, stream: Stream, rearm = true) {
    clearTimeout(stream.timer);
    stream.timer = undefined;
    let next: number | undefined;
    for (const sequence of stream.held.keys()) if (next === undefined || ahead(next, sequence) < 0) next = sequence;
    if (next === undefined) return;
    const lost = ahead(stream.expected, next);
    const packet = stream.held.get(next)!;
    stream.held.delete(next);
    stream.expected = (next + 1) & 0xffff;
    this.stats.lost += lost;
    this.out(ssrc, packet as P, lost);
    this.drain(ssrc, stream);
    if (rearm && stream.held.size && !stream.timer) {
      stream.timer = setTimeout(() => { stream.timer = undefined; this.skip(ssrc, stream); }, this.holdMs);
      stream.timer.unref?.();
    }
  }

  /** What is held that is next in order goes on. */
  private drain(ssrc: number, stream: Stream) {
    for (let packet; (packet = stream.held.get(stream.expected));) {
      stream.held.delete(stream.expected);
      stream.expected = (stream.expected + 1) & 0xffff;
      this.out(ssrc, packet as P, 0);
    }
    if (!stream.held.size) { clearTimeout(stream.timer); stream.timer = undefined; }
  }

  private out(ssrc: number, packet: P, lost: number) {
    this.stats.released++;
    this.release(ssrc, packet, lost);
  }
}
