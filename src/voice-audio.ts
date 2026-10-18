import { randomInt } from "node:crypto";
import { Opus } from "./opus.ts";
import { clock } from "./node-context.ts";
import { safeError } from "./metrics.ts";

type Timer = ReturnType<typeof setTimeout>;

/**
 * A voice call's audio, cut into utterances: each speaker's Opus packets (as Discord sends them: 48 kHz stereo, 20 ms
 * each, already decrypted) until they are silent for a while, packed as Ogg Opus, which transcription takes as it is.
 * Packets are decoded only to measure how loud they are (`Segmenter`), never re-encoded, and nothing is written
 * anywhere: an utterance lives in memory until it is transcribed.
 */

/** Samples (at 48 kHz) in an Opus packet, from its TOC byte (RFC 6716, 3.1). */
export function packetSamples(packet: Uint8Array): number {
  if (packet.length === 0) return 0;
  const toc = packet[0];
  const config = toc >> 3;
  // SILK 10/20/40/60 ms, hybrid 10/20 ms, CELT 2.5/5/10/20 ms.
  const frameMs = config < 12 ? [10, 20, 40, 60][config & 3] : config < 16 ? [10, 20][config & 1] : [2.5, 5, 10, 20][config & 3];
  const code = toc & 3;
  const frames = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 0x3f : 2;
  return frames * frameMs * 48;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

function oggCrc(page: Uint8Array): number {
  let crc = 0;
  for (const byte of page) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  return crc;
}

function oggPage(packets: Uint8Array[], granule: bigint, serial: number, sequence: number, flags: number): Buffer {
  const lacing: number[] = [];
  for (const packet of packets) {
    let left = packet.length;
    while (left >= 255) { lacing.push(255); left -= 255; }
    lacing.push(left);
  }
  const header = Buffer.alloc(27 + lacing.length);
  header.write("OggS", 0, "ascii");
  header[5] = flags;
  header.writeBigInt64LE(granule, 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(sequence, 18);
  header[26] = lacing.length;
  Buffer.from(lacing).copy(header, 27);
  const page = Buffer.concat([header, ...packets]);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

/** Ogg Opus (RFC 7845) of these packets: OpusHead and OpusTags pages, then up to 50 packets (a second) a page. */
export function oggOpus(packets: Uint8Array[], channels = 2): Buffer {
  const serial = randomInt(0, 0xffffffff);
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0, "ascii");
  head[8] = 1;
  head[9] = channels;
  // No pre-skip: Discord's encoder delay is unknown, and a few milliseconds of warm-up do not hurt speech.
  head.writeUInt32LE(48_000, 12);
  const vendor = Buffer.from("camelRun voice");
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write("OpusTags", 0, "ascii");
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  const pages = [oggPage([head], 0n, serial, 0, 0x02), oggPage([tags], 0n, serial, 1, 0)];
  let granule = 0n;
  for (let i = 0; i < packets.length; i += 50) {
    const chunk = packets.slice(i, i + 50);
    for (const packet of chunk) granule += BigInt(packetSamples(packet));
    pages.push(oggPage(chunk, granule, serial, pages.length, i + 50 >= packets.length ? 0x04 : 0));
  }
  return Buffer.concat(pages);
}

/** An utterance's audio, cut: who spoke, its packets, how long, when, and why it ended. */
export type Cut = {
  speaker: string; packets: Uint8Array[]; seconds: number; startedAt: number; endedAt: number;
  /**
   * silence: the speaker was silent for silenceMs (no packets, or only quiet ones); max: cut at maxMs (the speech goes
   * on in the next); error: the speaker's stream broke; handoff: the session moved to another node; end: the session ended.
   */
  ended: "silence" | "max" | "error" | "handoff" | "end";
  /** Its audio already went to the segmenter's `live` stream as it was spoken (trailing quiet too): commit it there. */
  live?: boolean;
};

/** Lost packets in a row that are concealed (libopus PLC); a longer gap is a pause, not loss. */
export const CONCEALED_MAX = 3;

/** Discord's silence frame, sent a few times as a speaker stops: not speech. */
const SILENCE_FRAME = [0xf8, 0xff, 0xfe];
const silent = (packet: Uint8Array) => packet.length === 3 && packet[0] === SILENCE_FRAME[0] && packet[1] === SILENCE_FRAME[1] && packet[2] === SILENCE_FRAME[2];

export const UTTERANCE_LIMITS = Object.freeze({
  /** A longer utterance is cut here, and goes on in the next. */
  maxMs: 30_000,
  /** One with less speech than this (a cough, a click) is dropped. */
  minMs: 300,
  /** A packet quieter than this (its decoded level, dBFS) is not speech. */
  quietDb: -45,
  /** Quiet kept on each side of the speech; the rest is not transcribed, nor billed. */
  padMs: 200,
});

/** A packet's level (dBFS, the RMS of its decoded samples); -Infinity for digital silence or a packet that does not decode. */
export function packetLevel(decoder: Opus, packet: Uint8Array): number {
  const pcm = decoded(decoder, packet);
  return pcm ? pcmLevel(pcm) : -Infinity;
}
/** A packet decoded (16-bit PCM at the decoder's rate), or undefined when it does not decode. */
function decoded(decoder: Opus, packet: Uint8Array): Buffer | undefined {
  try { return decoder.decode(packet); } catch { return undefined; }
}
function pcmLevel(pcm: Buffer) {
  const samples = pcm.length >> 1;
  let sum = 0;
  for (let i = 0; i < samples; i++) { const sample = pcm.readInt16LE(i * 2); sum += sample * sample; }
  return samples && sum ? 20 * Math.log10(Math.sqrt(sum / samples) / 32_768) : -Infinity;
}

type Held = { packet: Uint8Array; ms: number; loud: boolean; pcm?: Buffer };
type Speaking = {
  held: Held[]; heldMs: number; speechMs: number; quietMs: number;
  /** When its first and last loud packets came. */
  firstLoudAt?: number; lastLoudAt: number;
  timer?: Timer;
  /** Its own decoder: an Opus stream's packets decode in order, with the state of those before. */
  decoder: Opus;
  /** Its audio is going to `live` (from its first loud packet, with the quiet kept before it). */
  streaming?: boolean;
};

export type SegmenterOptions = {
  silenceMs: number; maxMs?: number; minMs?: number; quietDb?: number; padMs?: number;
  cut(cut: Cut): void;
  /** A speaker started talking: the first loud packet of an utterance (barge-in listens for it). */
  speech?(speaker: string): void;
  /**
   * Transcribing as people speak: each utterance's audio (24 kHz mono 16-bit PCM) as it comes, from its first loud
   * packet; `drop` when it is too short to keep. Its cuts say `live`.
   */
  live?: { audio(speaker: string, pcm: Buffer): void; drop(speaker: string): void };
};

/**
 * One call's speakers, cut into utterances. Senders differ in how they go quiet, so an utterance ends either way:
 *
 * - A person's Discord client stops sending when they stop talking (voice activity or push-to-talk), so `silenceMs`
 *   without a packet ends it.
 * - A sender that keeps sending (a bot playing audio, whose pauses are encoded silence; a client set to transmit
 *   always, or one that lets room noise through) never leaves a gap, so `silenceMs` of quiet packets ends it too. Each
 *   packet is decoded for its level (libopus in WebAssembly, 16 kHz mono: about 2 ms of CPU per second of audio); one
 *   under `quietDb` is quiet. A packet's size cannot tell: encoded silence and soft speech overlap.
 *
 * Quiet beyond `padMs` on each side is trimmed, so what is transcribed and billed is the speech. An utterance with
 * less than `minMs` of speech is dropped, and one longer than `maxMs` is cut there. Each cut goes to `cut`.
 */
export class Segmenter {
  private readonly speaking = new Map<string, Speaking>();
  private readonly options: SegmenterOptions;

  constructor(options: SegmenterOptions) { this.options = options; }

  /** Speakers with speech not yet cut. */
  get open() { return this.speaking.size; }

  packet(speaker: string, packet: Uint8Array, lost = 0) {
    if (silent(packet) || !packet.length) return;
    const now = clock().now();
    let speech = this.speaking.get(speaker);
    // Packets lost just before this one: what is streamed live is concealed over the gap, so it keeps its timing and
    // its decoder does not jump (what is transcribed after the cut is the packets as they came).
    if (speech?.streaming && lost > 0 && lost <= CONCEALED_MAX && this.options.live) {
      let pcm: Buffer | undefined;
      try { pcm = speech.decoder.conceal(lost * 20); } catch { pcm = undefined; }
      if (pcm?.length) this.options.live.audio(speaker, pcm);
    }
    if (!speech) this.speaking.set(speaker, speech = { held: [], heldMs: 0, speechMs: 0, quietMs: 0, lastLoudAt: now, decoder: new Opus(this.options.live ? 24_000 : 16_000, 1, "voip") });
    const ms = packetSamples(packet) / 48;
    const pcm = decoded(speech.decoder, packet);
    // A decoder that trapped is done: what was said so far is an utterance, and the next packet gets a new decoder.
    if (speech.decoder.broken) { this.end(speaker, "error"); return; }
    const loud = (pcm ? pcmLevel(pcm) : -Infinity) > (this.options.quietDb ?? UTTERANCE_LIMITS.quietDb);
    const live = this.options.live;
    speech.held.push({ packet, ms, loud, ...(live && pcm && !speech.streaming ? { pcm } : {}) });
    if (speech.streaming && pcm) live!.audio(speaker, pcm);
    else if (live && loud) {
      // Speech began: what was kept before it goes too.
      speech.streaming = true;
      for (const entry of speech.held) if (entry.pcm) live.audio(speaker, entry.pcm);
    }
    speech.heldMs += ms;
    clock().clearTimeout(speech.timer);
    if (loud) {
      speech.speechMs += ms;
      speech.quietMs = 0;
      if (speech.firstLoudAt === undefined) {
        speech.firstLoudAt = now;
        this.options.speech?.(speaker);
      }
      speech.lastLoudAt = now;
    } else {
      speech.quietMs += ms;
      // Before any speech, only the last padMs of quiet is kept.
      const pad = this.options.padMs ?? UTTERANCE_LIMITS.padMs;
      if (!speech.speechMs) while (speech.heldMs > pad && speech.held.length > 1) speech.heldMs -= speech.held.shift()!.ms;
      else if (speech.quietMs >= this.options.silenceMs) { this.end(speaker, "silence"); return; }
    }
    if (speech.heldMs >= (this.options.maxMs ?? UTTERANCE_LIMITS.maxMs)) { this.end(speaker, "max"); return; }
    // Silence is counted from the last loud packet, not the last packet: a client sends a few hundred ms of quiet ones
    // as it stops (its voice activity's hangover), which would otherwise each put the cut silenceMs further off.
    const wait = speech.speechMs ? Math.max(1, speech.lastLoudAt + this.options.silenceMs - now) : this.options.silenceMs;
    speech.timer = clock().setTimeout(() => this.ended(speaker, "silence"), wait);
    speech.timer.unref();
  }

  /** A speaker's stream broke: what they said so far is an utterance. */
  broken(speaker: string) { this.end(speaker, "error"); }

  /** Cut every speaker's speech now (`handoff`, `end`). */
  flush(ended: "handoff" | "end" | "error") { for (const speaker of [...this.speaking.keys()]) this.end(speaker, ended); }

  /** `end` from a timer: nothing it meets may escape to the process (it would end every session on the node). */
  private ended(speaker: string, ended: Cut["ended"]) {
    try { this.end(speaker, ended); }
    catch (error) { console.error(JSON.stringify({ type: "voice_segment_failed", speaker, error: safeError(error) })); }
  }

  private end(speaker: string, ended: Cut["ended"]) {
    const speech = this.speaking.get(speaker);
    if (!speech) return;
    this.speaking.delete(speaker);
    clock().clearTimeout(speech.timer);
    speech.decoder.delete();
    // Trailing quiet beyond padMs is not speech: not sent, not billed.
    const pad = this.options.padMs ?? UTTERANCE_LIMITS.padMs;
    for (let trailing = speech.quietMs; trailing > pad && speech.held.length && !speech.held.at(-1)!.loud;) {
      const dropped = speech.held.pop()!;
      trailing -= dropped.ms;
      speech.heldMs -= dropped.ms;
    }
    if (speech.speechMs < (this.options.minMs ?? UTTERANCE_LIMITS.minMs) || speech.firstLoudAt === undefined) {
      if (speech.streaming) this.options.live?.drop(speaker);
      return;
    }
    const seconds = Math.round(speech.heldMs / 10) / 100;
    this.options.cut({ speaker, packets: speech.held.map(entry => entry.packet), seconds, startedAt: speech.firstLoudAt, endedAt: Math.max(speech.lastLoudAt, speech.firstLoudAt + seconds * 1000), ended, ...(speech.streaming ? { live: true } : {}) });
  }
}

/** Discord's frame: 20 ms of 48 kHz stereo. */
const FRAME_SAMPLES = 960;
/** 20 ms of speech as a provider makes it (24 kHz mono, 16-bit): the bytes one frame is made from. */
const SPEECH_FRAME_BYTES = 480 * 2;

/** One 20 ms frame of 24 kHz mono PCM as 48 kHz stereo: each sample, then the midpoint to the next, on both channels. */
function upsampled(mono: Buffer): Buffer {
  const out = Buffer.alloc(FRAME_SAMPLES * 4);
  const samples = mono.length >> 1;
  for (let i = 0; i < samples; i++) {
    const sample = mono.readInt16LE(i * 2);
    const next = i + 1 < samples ? mono.readInt16LE(i * 2 + 2) : sample;
    const between = (sample + next) >> 1;
    out.writeInt16LE(sample, i * 8); out.writeInt16LE(sample, i * 8 + 2);
    out.writeInt16LE(between, i * 8 + 4); out.writeInt16LE(between, i * 8 + 6);
  }
  return out;
}

/**
 * Speech as Discord takes it: 24 kHz mono 16-bit PCM (as speech.ts makes it), chunk by chunk, to Opus packets of 20 ms
 * at 48 kHz stereo, each as soon as its 20 ms have come, so playback starts with the first. The last is padded with
 * silence. `samples` is told how many PCM samples each packet holds (for what was made, and billed).
 */
export async function* opusFromPcm(pcm: AsyncIterable<Uint8Array>, samples?: (count: number) => void): AsyncGenerator<Buffer> {
  const encoder = new Opus(48_000, 2, "audio");
  try {
    let pending = Buffer.alloc(0);
    for await (const chunk of pcm) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      while (pending.length >= SPEECH_FRAME_BYTES) {
        const frame = pending.subarray(0, SPEECH_FRAME_BYTES);
        pending = pending.subarray(SPEECH_FRAME_BYTES);
        samples?.(SPEECH_FRAME_BYTES >> 1);
        yield encoder.encode(upsampled(frame), FRAME_SAMPLES);
      }
    }
    if (pending.length >= 2) {
      samples?.(pending.length >> 1);
      const frame = Buffer.alloc(SPEECH_FRAME_BYTES);
      pending.copy(frame, 0, 0, pending.length & ~1);
      yield encoder.encode(upsampled(frame), FRAME_SAMPLES);
    }
  } finally { encoder.delete(); }
}

export const PLAYBACK_BUFFER = Object.freeze({
  /** Audio buffered before speech starts, when it comes fast enough (`startRate`). */
  startMs: 200,
  /** How fast (audio per wall-clock time, since its first packet, over at least `rateWindowMs`) it must come to start at `startMs`. */
  startRate: 1.5,
  rateWindowMs: 100,
  /** Otherwise it starts with this much buffered; and after running dry, resumes with this much, doubled at each stall. */
  slowStartMs: 1_000,
  maxResumeMs: 4_000,
  /**
   * With the speech's length known ahead (`expectedMs`, from its text): it starts once `knownStartMs` wait and what
   * waits covers the rest at the rate it comes (less a margin), rather than waiting for `startRate` or `slowStartMs`.
   */
  knownStartMs: 60,
  knownWindowMs: 50,
  rateMargin: 0.85,
});

/**
 * A jitter buffer for speech packets (20 ms each) made as they play: `packets` are read as fast as they come (so the
 * provider's stream is never held up), and given on once enough wait that playing them should not run dry:
 *
 * - At first, `startMs` (0.2 s) once they come at least `startRate` times faster than they play (measured since the
 *   first, over at least `rateWindowMs`): speech made that fast stays ahead. Slower, `slowStartMs` (1 s).
 * - If they run out mid-way (the provider stalled or bursts), again once `slowStartMs` wait, doubled at each further
 *   stall (to `maxResumeMs`): a provider that stalled once may again, so each gap buys a longer lead.
 *
 * The speech whole (or failed) is given on at once. A speech made faster than it plays never pauses; a bursty one
 * pauses at most at its first stall. Ends early (stops reading) when its reader stops.
 */
export async function* buffered<T>(packets: AsyncIterable<T>, options: Partial<typeof PLAYBACK_BUFFER> & { expectedMs?: number } = {}): AsyncGenerator<T> {
  const limits = { ...PLAYBACK_BUFFER, ...options };
  const queue: T[] = [];
  let done = false, failure: unknown, wake: (() => void) | undefined, stopped = false, arrived = 0, firstAt = 0;
  // A start that waits on time (rateWindowMs) as well as packets is looked at again as the window passes.
  let windowTimer: ReturnType<typeof setTimeout> | undefined;
  /** Packets that came with the first (within a few ms): a burst a provider sends at once says nothing of its rate. */
  let opening = 0;
  const pump = (async () => {
    try {
      for await (const packet of packets) {
        if (stopped) return;
        if (arrived === 0 || performance.now() - firstAt < 5) opening++;
        if (!arrived++) {
          firstAt = performance.now();
          windowTimer = setTimeout(() => wake?.(), (limits.expectedMs !== undefined ? limits.knownWindowMs : limits.rateWindowMs) + 5);
          windowTimer.unref?.();
        }
        queue.push(packet);
        wake?.();
      }
    } catch (error) { failure = error; }
    finally { done = true; wake?.(); }
  })();
  const ms = (count: number) => count * 20;
  const startable = () => {
    if (ms(queue.length) >= limits.slowStartMs) return true;
    const elapsed = performance.now() - firstAt;
    const rate = ms(arrived) / elapsed;
    if (limits.expectedMs !== undefined) {
      // Known length: play once what waits covers what is left to make at the rate it comes (taken a margin slower).
      // A provider faster than real time needs no lead past knownStartMs; a slower one, the shortfall it would leave.
      if (ms(queue.length) < limits.knownStartMs || elapsed < limits.knownWindowMs) return false;
      // The rate since the first, not counting what came with it.
      const effective = ms(arrived - opening) / elapsed * limits.rateMargin;
      const left = Math.max(0, limits.expectedMs - ms(arrived));
      return effective >= 1 || ms(queue.length) >= left * (1 - effective) / effective;
    }
    return ms(queue.length) >= limits.startMs && elapsed >= limits.rateWindowMs && rate >= limits.startRate;
  };
  try {
    for (let started = false, resumeMs: number = limits.slowStartMs; ;) {
      while (!done && !(started ? ms(queue.length) >= resumeMs : startable())) await new Promise<void>(resolve => { wake = resolve; });
      wake = undefined;
      if (!queue.length) {
        if (failure) throw failure;
        return;
      }
      if (started) resumeMs = Math.min(resumeMs * 2, limits.maxResumeMs);
      started = true;
      while (queue.length) yield queue.shift()!;
    }
  } finally {
    stopped = true;
    clearTimeout(windowTimer);
    void pump;
  }
}
