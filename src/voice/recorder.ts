import { Opus } from "../opus.ts";
import { oggOpus, packetSamples } from "../voice-audio.ts";

/**
 * A voice session's recording (POST /v1/voice/sessions/{id}/recording): the call's audio as Ogg Opus, mixed into one
 * file or one file per speaker (the bot's own speech among them). It runs on the session's control thread, fed the
 * packets its media heard and played (`MediaEvents.recorded`), so it outlives a media that crashed or reconnected.
 *
 * Each packet goes in a 20 ms slot by when it arrived, counted from the recording's start: its speaker's next free one
 * if that is later (a burst after jitter), so a track keeps its order. Per-speaker tracks keep the packets as Discord
 * sent them (no decoding). The mix decodes each speaker to 24 kHz mono, sums the slots a little behind real time
 * (`mixDelayMs`, for late packets) and encodes them again. What is recorded goes to object storage in chunks
 * (`flush`), so memory stays small and a session handed to another node goes on recording into the same recording;
 * `assemble` turns the chunks into files, a silent frame in every slot nobody filled so all tracks line up.
 */

export const RECORDING_LIMITS = Object.freeze({
  /** How long a recording may run, in minutes. */
  maxMinutes: { default: 60, min: 1, max: 240 },
  /** The audio a recording may hold (its packets' bytes, before Ogg's framing and the silence between them). */
  maxBytes: { default: 25 * 1024 * 1024, min: 1024 * 1024, max: 100 * 1024 * 1024 },
  /** How long its files are kept after it ends, in hours (30 days at most). */
  retentionHours: { default: 24, min: 1, max: 720 },
  /** Speakers a recording of tracks keeps (the first ones heard); later speakers are left out of it. */
  tracks: 25,
  /** How far behind real time the mix runs, for packets that arrive late. */
  mixDelayMs: 600,
  /** A chunk is written at least this often, or once this much is waiting. */
  flushMs: 30_000,
  flushBytes: 1024 * 1024,
});

export type RecordingTracks = "mixed" | "speakers";
/** One packet as the media saw it: who (the bot, for its own speech), when it arrived (epoch ms), its Opus bytes. */
export type RecordedPacket = { speaker: string; at: number; packet: Uint8Array };
/** A finished recording's file. */
export type RecordingFile = { name: string; contentType: "audio/ogg"; bytes: number; seconds: number; speakerId?: string };

const SLOT_MS = 20;
/** Discord's 20 ms silence frame: what fills a slot no packet did. */
const SILENCE = Uint8Array.from([0xf8, 0xff, 0xfe]);
/** The mix's rate (Opus decodes any packet to it) and a slot's samples at it. */
const MIX_RATE = 24_000;
const MIX_SAMPLES = MIX_RATE * SLOT_MS / 1000;
/** The mix's bitrate: speech stays clear, and an hour of it is about 7 MB (under Discord's 10 MB upload on most servers). */
const MIX_BITRATE = 16_000;
const MIXED = "mixed";

const slots = (packet: Uint8Array) => Math.max(1, Math.round(packetSamples(packet) / (48 * SLOT_MS)));

export class Recorder {
  readonly startedAt: number;
  readonly tracks: RecordingTracks;
  private readonly maxBytes: number;
  private readonly maxMs: number;
  /** Each track's next free slot. In a mix, each speaker's, for placing their packets. */
  private readonly next = new Map<string, number>();
  /** Packets not yet written, by track: [slot, packet]. */
  private pending: Array<[track: string, slot: number, packet: Uint8Array]> = [];
  private pendingBytes = 0;
  /** The mix: each speaker's decoder, and the slots summed so far (at MIX_RATE), not yet encoded. */
  private readonly decoders = new Map<string, Opus>();
  private readonly mix = new Map<number, Int32Array>();
  private encoder?: Opus;
  /** Slots before this are mixed already: a packet for one comes too late. */
  private mixedThrough = 0;
  private flushedAt: number;
  /** Packets kept (their bytes, as `maxBytes` counts), and packets left out (late for the mix, past `tracks`). */
  bytes: number;
  dropped = 0;

  constructor(options: { startedAt: number; tracks: RecordingTracks; maxBytes: number; maxMinutes: number; bytes?: number; now?: number }) {
    this.startedAt = options.startedAt;
    this.tracks = options.tracks;
    this.maxBytes = options.maxBytes;
    this.maxMs = options.maxMinutes * 60_000;
    this.bytes = options.bytes ?? 0;
    this.flushedAt = options.now ?? Date.now();
    // Resumed (on another node): the slots up to now are behind it.
    if (this.tracks === MIXED) this.mixedThrough = this.slot(options.now ?? Date.now()) - this.delaySlots;
  }

  private get delaySlots() { return Math.ceil(RECORDING_LIMITS.mixDelayMs / SLOT_MS); }
  private slot(at: number) { return Math.max(0, Math.floor((at - this.startedAt) / SLOT_MS)); }

  /** Whether it is past a limit: `max_duration` or `max_size`, else undefined. */
  full(now = Date.now()): "max_duration" | "max_size" | undefined {
    if (this.bytes >= this.maxBytes) return "max_size";
    if (now - this.startedAt >= this.maxMs) return "max_duration";
    return undefined;
  }

  /** Packets the media heard or played. */
  add(packets: RecordedPacket[]) {
    for (const { speaker, at, packet } of packets) {
      if (!packet.length || at < this.startedAt || this.bytes >= this.maxBytes) continue;
      if (!this.next.has(speaker) && this.tracks === "speakers" && this.next.size >= RECORDING_LIMITS.tracks) { this.dropped++; continue; }
      const slot = Math.max(this.next.get(speaker) ?? 0, this.slot(at));
      this.next.set(speaker, slot + slots(packet));
      if (this.tracks === "speakers") {
        this.pending.push([speaker, slot, packet]);
        this.pendingBytes += packet.length;
        this.bytes += packet.length;
      } else this.mixIn(speaker, slot, packet);
    }
    if (this.tracks === MIXED && packets.length) this.encodeThrough(this.slot(packets.at(-1)!.at) - this.delaySlots);
  }

  /** A speaker's packet decoded and summed into its slots (a 40 or 60 ms packet fills two or three). */
  private mixIn(speaker: string, slot: number, packet: Uint8Array) {
    if (slot < this.mixedThrough) { this.dropped++; return; }
    let decoder = this.decoders.get(speaker);
    if (!decoder || decoder.broken) this.decoders.set(speaker, decoder = new Opus(MIX_RATE, 1, "voip"));
    let pcm: Buffer;
    try { pcm = decoder.decode(packet); } catch { this.dropped++; return; }
    const samples = pcm.length >> 1;
    for (let offset = 0, at = slot; offset < samples; offset += MIX_SAMPLES, at++) {
      let frame = this.mix.get(at);
      if (!frame) this.mix.set(at, frame = new Int32Array(MIX_SAMPLES));
      for (let i = 0; i < MIX_SAMPLES && offset + i < samples; i++) frame[i] += pcm.readInt16LE((offset + i) * 2);
    }
  }

  /** The mix's slots before `through`, encoded (clipped to 16 bits) into pending packets. */
  private encodeThrough(through: number) {
    if (through <= this.mixedThrough) return;
    const due = [...this.mix.keys()].filter(slot => slot < through).sort((a, b) => a - b);
    for (const slot of due) {
      const frame = this.mix.get(slot)!;
      this.mix.delete(slot);
      const pcm = Buffer.alloc(MIX_SAMPLES * 2);
      for (let i = 0; i < MIX_SAMPLES; i++) pcm.writeInt16LE(Math.max(-32_768, Math.min(32_767, frame[i])), i * 2);
      if (!this.encoder || this.encoder.broken) {
        this.encoder = new Opus(MIX_RATE, 1, "voip");
        this.encoder.bitrate(MIX_BITRATE);
      }
      let packet: Buffer;
      try { packet = this.encoder.encode(pcm, MIX_SAMPLES); } catch { this.dropped++; continue; }
      this.pending.push([MIXED, slot, packet]);
      this.pendingBytes += packet.length;
      this.bytes += packet.length;
    }
    this.mixedThrough = through;
  }

  /** Whether a chunk is due: `flushMs` since the last, or `flushBytes` waiting. */
  due(now = Date.now()) {
    return this.pendingBytes >= RECORDING_LIMITS.flushBytes || (now - this.flushedAt >= RECORDING_LIMITS.flushMs && (this.pending.length > 0 || this.mix.size > 0));
  }

  /**
   * What is waiting, as a chunk to store (undefined when nothing is); `final` mixes what the mix still holds, as the
   * recording ends or leaves this node.
   */
  chunk(final = false, now = Date.now()): Uint8Array | undefined {
    if (this.tracks === MIXED) this.encodeThrough(final ? Math.max(this.mixedThrough, ...this.mix.keys()) + 1 : this.slot(now) - this.delaySlots);
    this.flushedAt = now;
    if (!this.pending.length) return undefined;
    const out = encodeChunk(this.pending);
    this.pending = [];
    this.pendingBytes = 0;
    return out;
  }

  close() {
    for (const decoder of this.decoders.values()) decoder.delete();
    this.decoders.clear();
    this.encoder?.delete();
    this.encoder = undefined;
  }
}

/** A chunk: records of [track name length (u8)][track name][slot (u32)][packet length (u16)][packet]. */
function encodeChunk(entries: Array<[string, number, Uint8Array]>): Uint8Array {
  const parts: Buffer[] = [];
  for (const [track, slot, packet] of entries) {
    const name = Buffer.from(track);
    const head = Buffer.alloc(1 + name.length + 6);
    head[0] = name.length;
    name.copy(head, 1);
    head.writeUInt32LE(slot, 1 + name.length);
    head.writeUInt16LE(packet.length, 5 + name.length);
    parts.push(head, Buffer.from(packet));
  }
  return Buffer.concat(parts);
}

function* decodeChunk(chunk: Uint8Array): Generator<[string, number, Uint8Array]> {
  const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  for (let at = 0; at < bytes.length;) {
    const length = bytes[at];
    const track = bytes.subarray(at + 1, at + 1 + length).toString();
    const slot = bytes.readUInt32LE(at + 1 + length);
    const size = bytes.readUInt16LE(at + 5 + length);
    const start = at + 7 + length;
    if (start + size > bytes.length) throw new Error("A recording chunk is cut short");
    yield [track, slot, bytes.subarray(start, start + size)];
    at = start + size;
  }
}

/**
 * A recording's files from its chunks, in order: the mix as `recording.ogg` (mono), or each speaker's track as
 * `<speaker id>.ogg` (as Discord sent it: stereo), every one from the recording's start to its last packet, the slots
 * between filled with silence. Its length is the longest track's.
 */
export function assemble(chunks: Uint8Array[], tracks: RecordingTracks): { files: Array<RecordingFile & { data: Buffer }>; seconds: number } {
  const byTrack = new Map<string, Map<number, Uint8Array>>();
  for (const chunk of chunks) {
    for (const [track, slot, packet] of decodeChunk(chunk)) {
      let slotsOf = byTrack.get(track);
      if (!slotsOf) byTrack.set(track, slotsOf = new Map());
      if (!slotsOf.has(slot)) slotsOf.set(slot, packet);
    }
  }
  let end = 0;
  for (const slotsOf of byTrack.values()) for (const [slot, packet] of slotsOf) end = Math.max(end, slot + slots(packet));
  const files = [...byTrack].map(([track, slotsOf]) => {
    const packets: Uint8Array[] = [];
    for (let slot = 0; slot < end;) {
      const packet = slotsOf.get(slot);
      if (packet) { packets.push(packet); slot += slots(packet); }
      else { packets.push(SILENCE); slot++; }
    }
    const data = oggOpus(packets, tracks === MIXED ? 1 : 2);
    const name = tracks === MIXED ? "recording.ogg" : `${track}.ogg`;
    return { name, contentType: "audio/ogg" as const, bytes: data.length, seconds: end * SLOT_MS / 1000, ...(tracks === MIXED ? {} : { speakerId: track }), data };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { files, seconds: end * SLOT_MS / 1000 };
}
