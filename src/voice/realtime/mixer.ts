import { clock as nodeClock, type Clock } from "../../node-context.ts";

/**
 * The call's speakers mixed into the one stream a speech-to-speech model takes. Discord gives each speaker's audio
 * apart (24 kHz mono 16-bit PCM from the media plane, as they speak); a model hears one microphone. One speaker at a
 * time, the common case, passes straight through. While two or more talk at once (each heard within `overlapMs` of
 * the other), their audio is queued and summed every `tickMs`, so what overlaps in time overlaps in the mix. Each piece
 * out says whose audio is in it, so the brain can name who speaks.
 */
export class Mixer {
  private readonly out: (pcm: Uint8Array, speakers: string[]) => void;
  private readonly clock: Clock;
  private readonly tickMs: number;
  private readonly overlapMs: number;
  private readonly queues = new Map<string, Uint8Array[]>();
  private readonly lastAt = new Map<string, number>();
  private timer?: ReturnType<Clock["setTimeout"]>;
  private closed = false;

  constructor(out: (pcm: Uint8Array, speakers: string[]) => void, options: { clock?: Clock; tickMs?: number; overlapMs?: number } = {}) {
    this.out = out;
    this.clock = options.clock ?? nodeClock();
    this.tickMs = options.tickMs ?? 20;
    this.overlapMs = options.overlapMs ?? 60;
  }

  /** Whether anyone else was heard just now (within overlapMs), or still has audio waiting. */
  private others(speaker: string, now: number) {
    for (const [other, at] of this.lastAt) if (other !== speaker && now - at <= this.overlapMs) return true;
    for (const [other, queue] of this.queues) if (other !== speaker && queue.length) return true;
    return false;
  }

  push(speaker: string, pcm: Uint8Array) {
    if (this.closed || pcm.byteLength < 2) return;
    const now = this.clock.monotonic();
    const overlapping = this.others(speaker, now);
    this.lastAt.set(speaker, now);
    if (!overlapping && !this.queues.get(speaker)?.length) { this.out(pcm, [speaker]); return; }
    const queue = this.queues.get(speaker) ?? [];
    queue.push(pcm);
    this.queues.set(speaker, queue);
    this.timer ??= this.clock.setTimeout(() => this.tick(), this.tickMs);
  }

  /** Everything waiting, mixed and given out now (a turn ends: the model must have all of it before the commit). */
  flush() {
    if (this.timer) { this.clock.clearTimeout(this.timer); this.timer = undefined; }
    this.mix();
  }

  /** A speaker stopped (their turn ended): they no longer overlap anyone. */
  quiet(speaker: string) { this.lastAt.delete(speaker); }

  close() {
    this.closed = true;
    if (this.timer) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.queues.clear();
  }

  private tick() {
    this.timer = undefined;
    this.mix();
    // Keep ticking while two still overlap: what they send next is queued, and mixed at the next tick.
    const now = this.clock.monotonic();
    if ([...this.lastAt.values()].filter(at => now - at <= this.overlapMs).length > 1) this.timer = this.clock.setTimeout(() => this.tick(), this.tickMs);
  }

  private mix() {
    const parts: { speaker: string; pcm: Uint8Array }[] = [];
    for (const [speaker, queue] of this.queues) {
      if (!queue.length) continue;
      parts.push({ speaker, pcm: concat(queue.splice(0)) });
    }
    if (!parts.length) return;
    if (parts.length === 1) { this.out(parts[0].pcm, [parts[0].speaker]); return; }
    const length = Math.max(...parts.map(part => part.pcm.byteLength)) & ~1;
    const sum = new Int32Array(length >> 1);
    for (const { pcm } of parts) {
      const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      for (let i = 0; i + 1 < pcm.byteLength; i += 2) sum[i >> 1] += view.getInt16(i, true);
    }
    const mixed = Buffer.alloc(length);
    for (let i = 0; i < sum.length; i++) mixed.writeInt16LE(Math.max(-32_768, Math.min(32_767, sum[i])), i * 2);
    this.out(mixed, parts.map(part => part.speaker));
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
}
