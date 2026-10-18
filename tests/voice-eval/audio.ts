import { Opus } from "../../src/opus.ts";

/**
 * Synthetic speakers' audio for the voice eval: 20 ms Opus packets (48 kHz stereo) as a Discord client sends them.
 * Each speaker has its own encoder, so its packets are a continuous stream, and every packet it sends is remembered
 * (`origin`) with the turn and frame it carries, so a transcriber can tell exactly which frames of which turns an
 * utterance holds.
 */

export const FRAME_MS = 20;
const SAMPLES = 960;

/** Discord's silence frame: a client sends five as it stops transmitting. */
export const SILENCE_FRAME = Uint8Array.from([0xf8, 0xff, 0xfe]);

/** A seeded random number generator (mulberry32), so runs are repeatable. */
export function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const amplitude = (db: number) => 10 ** (db / 20);

/** Which turn's frame a packet carries (speech), or none (quiet, noise). */
export type Origin = { turn: number; frame: number };

/** Every packet sent in a run, by its bytes: what the transcriber looks up. */
export class Origins {
  private readonly packets = new Map<string, Origin>();
  /** Packets made twice (two frames with the same bytes): they could not be told apart. */
  collisions = 0;
  add(packet: Uint8Array, origin: Origin) {
    const key = Buffer.from(packet).toString("base64");
    const before = this.packets.get(key);
    if (before && (before.turn !== origin.turn || before.frame !== origin.frame)) this.collisions++;
    this.packets.set(key, origin);
  }
  of(packet: Uint8Array): Origin | undefined { return this.packets.get(Buffer.from(packet).toString("base64")); }
}

/**
 * One speaker's encoder. `frame` makes the next 20 ms: speech (a voiced sound at `speechDb`, its pitch and loudness
 * moving as a voice's do), quiet (the room through an open mic, at `floorDb`), or `pcm` given (real speech, from a
 * speech provider), each with the speaker's background noise mixed in.
 */
export class SpeakerAudio {
  private readonly encoder = new Opus(48_000, 2, "audio");
  private readonly random: () => number;
  private phase = 0;
  private t = 0;
  readonly noiseDb?: number;

  constructor(seed: number, noiseDb?: number) {
    this.random = seeded(seed);
    this.noiseDb = noiseDb;
    // Each speaker's (and turn's) voice starts somewhere else, so no two make the same packets.
    this.t = Math.floor(this.random() * 10_000);
    this.phase = this.random() * 2 * Math.PI;
  }

  /** 20 ms of 48 kHz stereo PCM: `kind` speech or quiet, or the samples given (mono, 48 kHz, SAMPLES long). */
  frame(kind: "speech" | "quiet", options: { speechDb?: number; floorDb?: number; pcm?: Int16Array } = {}): Uint8Array {
    const pcm = Buffer.alloc(SAMPLES * 4);
    const noise = this.noiseDb === undefined ? 0 : amplitude(this.noiseDb) * Math.sqrt(3);
    const floor = amplitude(options.floorDb ?? -70) * Math.sqrt(3);
    // A voiced sound: a fundamental with harmonics, its pitch drifting (110-220 Hz) and its loudness moving with syllables.
    const base = 140 + 40 * Math.sin(this.t / 7) + 25 * Math.sin(this.t / 3.1);
    const syllable = 0.55 + 0.45 * Math.abs(Math.sin(this.t * Math.PI / 11));
    const level = amplitude(options.speechDb ?? -20) * syllable;
    for (let i = 0; i < SAMPLES; i++) {
      let sample: number;
      if (options.pcm) sample = (options.pcm[i] ?? 0) / 32_768;
      else if (kind === "speech") {
        this.phase += 2 * Math.PI * base / 48_000;
        sample = level * (0.6 * Math.sin(this.phase) + 0.25 * Math.sin(2 * this.phase) + 0.15 * Math.sin(3 * this.phase));
      } else sample = floor * (this.random() * 2 - 1);
      // Dither, so every packet differs (packets are told apart by their bytes).
      sample += (noise + 0.0003) * (this.random() * 2 - 1);
      const value = Math.max(-32_768, Math.min(32_767, Math.round(sample * 32_767)));
      pcm.writeInt16LE(value, i * 4);
      pcm.writeInt16LE(value, i * 4 + 2);
    }
    this.t++;
    return new Uint8Array(this.encoder.encode(pcm, SAMPLES));
  }

  close() { this.encoder.delete(); }
}

/** 24 kHz mono 16-bit PCM (a speech provider's) as 48 kHz mono frames of SAMPLES, for `SpeakerAudio.frame`'s `pcm`. */
export function framesOf(pcm24k: Uint8Array): Int16Array[] {
  const view = new Int16Array(pcm24k.buffer, pcm24k.byteOffset, Math.floor(pcm24k.byteLength / 2));
  const frames: Int16Array[] = [];
  for (let at = 0; at < view.length; at += SAMPLES / 2) {
    const frame = new Int16Array(SAMPLES);
    for (let i = 0; i < SAMPLES / 2; i++) {
      const sample = view[at + i] ?? 0, next = view[at + i + 1] ?? sample;
      frame[i * 2] = sample;
      frame[i * 2 + 1] = (sample + next) >> 1;
    }
    frames.push(frame);
  }
  return frames;
}

/** The packets of an Ogg Opus file (RFC 7845), without its two header packets. */
export function oggPackets(ogg: Uint8Array): Uint8Array[] {
  const bytes = Buffer.from(ogg.buffer, ogg.byteOffset, ogg.byteLength);
  const packets: Uint8Array[] = [];
  let partial: Buffer[] = [];
  for (let at = 0; at + 27 <= bytes.length && bytes.toString("ascii", at, at + 4) === "OggS";) {
    const segments = bytes[at + 26];
    const lacing = bytes.subarray(at + 27, at + 27 + segments);
    let body = at + 27 + segments;
    for (const size of lacing) {
      partial.push(bytes.subarray(body, body + size));
      body += size;
      if (size < 255) { packets.push(Buffer.concat(partial)); partial = []; }
    }
    at = body;
  }
  return packets.slice(2);
}
