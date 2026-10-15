import { randomInt } from "node:crypto";
import { clock } from "./node-context.ts";

type Timer = ReturnType<typeof setTimeout>;

/**
 * A voice call's audio, cut into utterances: each speaker's Opus packets (as Discord sends them: 48 kHz stereo, 20 ms
 * each, already decrypted) until they are silent for a while, packed as Ogg Opus, which transcription takes as it is.
 * Nothing is decoded and nothing is written anywhere: an utterance lives in memory until it is transcribed.
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
   * silence: the speaker was silent for silenceMs; max: cut at maxMs (the speech goes on in the next); error: the
   * speaker's stream broke; handoff: the session moved to another node; end: the session ended.
   */
  ended: "silence" | "max" | "error" | "handoff" | "end";
};

/** Discord's silence frame, sent a few times as a speaker stops: not speech. */
const SILENCE_FRAME = [0xf8, 0xff, 0xfe];
const silent = (packet: Uint8Array) => packet.length === 3 && packet[0] === SILENCE_FRAME[0] && packet[1] === SILENCE_FRAME[1] && packet[2] === SILENCE_FRAME[2];

export const UTTERANCE_LIMITS = Object.freeze({
  /** A longer utterance is cut here, and goes on in the next. */
  maxMs: 30_000,
  /** A shorter one (a cough, a click) is dropped. */
  minMs: 300,
});

type Speaking = { packets: Uint8Array[]; samples: number; startedAt: number; lastAt: number; timer?: Timer };

/**
 * One call's speakers, cut into utterances: a speaker's packets until `silenceMs` passes without one, or `maxMs` of
 * speech. Each cut longer than `minMs` goes to `cut`.
 */
export class Segmenter {
  private readonly speaking = new Map<string, Speaking>();
  private readonly options: { silenceMs: number; maxMs?: number; minMs?: number; cut(cut: Cut): void };

  constructor(options: { silenceMs: number; maxMs?: number; minMs?: number; cut(cut: Cut): void }) { this.options = options; }

  /** Speakers with speech not yet cut. */
  get open() { return this.speaking.size; }

  packet(speaker: string, packet: Uint8Array) {
    if (silent(packet) || !packet.length) return;
    const now = clock().now();
    let speech = this.speaking.get(speaker);
    if (!speech) this.speaking.set(speaker, speech = { packets: [], samples: 0, startedAt: now, lastAt: now });
    speech.packets.push(packet);
    speech.samples += packetSamples(packet);
    speech.lastAt = now;
    clock().clearTimeout(speech.timer);
    if (speech.samples / 48 >= (this.options.maxMs ?? UTTERANCE_LIMITS.maxMs)) { this.end(speaker, "max"); return; }
    speech.timer = clock().setTimeout(() => this.end(speaker, "silence"), this.options.silenceMs);
    speech.timer.unref();
  }

  /** A speaker's stream broke: what they said so far is an utterance. */
  broken(speaker: string) { this.end(speaker, "error"); }

  /** Cut every speaker's speech now (`handoff`, `end`). */
  flush(ended: "handoff" | "end") { for (const speaker of [...this.speaking.keys()]) this.end(speaker, ended); }

  private end(speaker: string, ended: Cut["ended"]) {
    const speech = this.speaking.get(speaker);
    if (!speech) return;
    this.speaking.delete(speaker);
    clock().clearTimeout(speech.timer);
    if (speech.samples / 48 < (this.options.minMs ?? UTTERANCE_LIMITS.minMs)) return;
    const seconds = Math.round(speech.samples / 480) / 100;
    this.options.cut({ speaker, packets: speech.packets, seconds, startedAt: speech.startedAt, endedAt: Math.max(speech.lastAt, speech.startedAt + seconds * 1000), ended });
  }
}
