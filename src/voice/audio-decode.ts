import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { HttpError } from "../http.ts";
import { Opus } from "../opus.ts";

/**
 * Audio files played into a call (src/voice/jukebox.ts), decoded as they come to the PCM a session's media plays:
 * 24 kHz mono 16-bit. Three formats, each sniffed from its first bytes (a name or a content type is not trusted):
 *
 * - **MP3** (MPEG-1/2/2.5 Layer III): frames split here, decoded by minimp3 (CC0, built to WebAssembly by minimp3-wasm,
 *   Apache-2.0). Whole frames go in a block at a time, and the decoder's state runs on between blocks, so a stream
 *   decodes as seamlessly as a file.
 * - **Ogg Opus** (.opus, .ogg with Opus in it, Discord's voice messages): pages demuxed here, packets decoded by libopus
 *   (src/opus.ts). Ogg Vorbis is refused: no decoder under a permissive license is bundled.
 * - **WAV**: PCM at 8, 16, 24 or 32 bits, or 32-bit float.
 *
 * Every format is mixed down to mono and resampled (a low-pass FIR first when the rate goes down) to 24 kHz.
 */

export const AUDIO_RATE = 24_000;

/**
 * How much of a source is looked at to tell its format. A live MP3 stream can be joined mid-frame, so its first whole
 * frame comes up to one frame (1,441 bytes at most) in, and the frame after it must be seen too.
 */
export const MP3_SNIFF_BYTES = 4096;

export const AUDIO_FORMATS = ["mp3", "opus", "wav"] as const;
export type AudioFormat = typeof AUDIO_FORMATS[number];

/** Why a file can't be played: 415 for a format it is not, 422 for a file that is broken. */
export class AudioRefused extends HttpError {
  constructor(status: 415 | 422, message: string) { super(status, message, status === 415 ? "AUDIO_UNSUPPORTED" : "AUDIO_INVALID"); }
}

/** The format of a file from its first bytes (at least 12; MP3_SNIFF_BYTES to find an MP3 joined mid-frame), or undefined when it is none of AUDIO_FORMATS. */
export function sniff(head: Uint8Array): AudioFormat | "vorbis" | undefined {
  const ascii = (at: number, length: number) => String.fromCharCode(...head.subarray(at, at + length));
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "wav";
  if (ascii(0, 4) === "OggS") {
    // The first page's first packet says the codec: "OpusHead" or "\x01vorbis".
    const segments = head[26] ?? 0;
    const packet = 27 + segments;
    if (ascii(packet, 8) === "OpusHead") return "opus";
    if (ascii(packet + 1, 6) === "vorbis") return "vorbis";
    return undefined;
  }
  if (ascii(0, 3) === "ID3") return "mp3";
  if (head[0] === 0xff && mp3Frame(head, 0)) return "mp3";
  // Joined mid-frame: two frames in a row, as a stray 0xFF in other bytes almost never makes.
  for (let at = 0; at < Math.min(head.length, MP3_SNIFF_BYTES); at++) {
    const length = head[at] === 0xff ? mp3Frame(head, at) : undefined;
    if (length && mp3Frame(head, at + length)) return "mp3";
  }
  return undefined;
}

/**
 * A source's audio as 24 kHz mono 16-bit PCM, chunk by chunk as it decodes. `gain` scales each sample (read at each
 * chunk, so a volume change applies at once). Throws AudioRefused for a format it does not take or a broken file.
 */
export async function* decodeAudio(source: AsyncIterable<Uint8Array>, options: { gain?: () => number } = {}): AsyncGenerator<Uint8Array> {
  const reader = new ByteReader(source);
  // Most formats show in the first bytes, so what they play isn't held up; only the rest wait for more.
  const format = sniff(await reader.peek(64)) ?? sniff(await reader.peek(MP3_SNIFF_BYTES));
  if (format === "vorbis") throw new AudioRefused(415, "Ogg Vorbis isn't supported: use MP3, Ogg Opus or WAV");
  if (!format) throw new AudioRefused(415, "That isn't an audio file camelRun plays: MP3, Ogg Opus or WAV");
  const decoded = format === "mp3" ? mp3(reader) : format === "opus" ? oggOpus(reader) : wav(reader);
  let resampler: Resampler | undefined;
  for await (const block of decoded) {
    resampler ??= new Resampler(block.rate);
    const pcm = resampler.push(block.mono);
    if (pcm.length) yield toS16(pcm, options.gain?.() ?? 1);
  }
}

/** Decoded samples: mono, as floats in -1..1, at their own rate. */
type Block = { rate: number; mono: Float32Array };

/** Bytes as they come, read by count. */
class ByteReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private buffer: Uint8Array = new Uint8Array(0);
  private ended = false;
  constructor(source: AsyncIterable<Uint8Array>) { this.iterator = source[Symbol.asyncIterator](); }

  /** At least `count` bytes buffered (fewer only at the end), not consumed. */
  async peek(count: number): Promise<Uint8Array> {
    while (this.buffer.length < count && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) { this.ended = true; break; }
      this.buffer = concat(this.buffer, next.value);
    }
    return this.buffer.subarray(0, Math.min(count, this.buffer.length));
  }

  /** Whatever is buffered and the next chunk, consumed; empty at the end. */
  async chunk(): Promise<Uint8Array> {
    if (this.buffer.length) { const out = this.buffer; this.buffer = new Uint8Array(0); return out; }
    if (this.ended) return out0;
    const next = await this.iterator.next();
    if (next.done) { this.ended = true; return out0; }
    return next.value;
  }

  /** `count` bytes, consumed; fewer only at the end. */
  async take(count: number): Promise<Uint8Array> {
    const got = await this.peek(count);
    this.buffer = this.buffer.subarray(got.length);
    return got.slice();
  }

  async skip(count: number) {
    while (count > 0) {
      const got = await this.take(Math.min(count, 1 << 16));
      if (!got.length) return;
      count -= got.length;
    }
  }
}
const out0 = new Uint8Array(0);

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.length) return b;
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a);
  joined.set(b, a.length);
  return joined;
}

// MP3 ---------------------------------------------------------------------------------

const MP3_BITRATES = {
  v1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  v2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_RATES: Record<number, number[]> = { 3: [44_100, 48_000, 32_000], 2: [22_050, 24_000, 16_000], 0: [11_025, 12_000, 8_000] };

/** The Layer III frame at `at`: its length in bytes, or undefined when no valid header is there. */
export function mp3Frame(bytes: Uint8Array, at: number): number | undefined {
  if (at + 4 > bytes.length || bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) return undefined;
  const version = (bytes[at + 1] >> 3) & 3, layer = (bytes[at + 1] >> 1) & 3;
  const bitrateIndex = bytes[at + 2] >> 4, rateIndex = (bytes[at + 2] >> 2) & 3, padding = (bytes[at + 2] >> 1) & 1;
  // Layer III only; no free-format bitrate (0) or bad index (15); version 1 is reserved.
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return undefined;
  const bitrate = (version === 3 ? MP3_BITRATES.v1 : MP3_BITRATES.v2)[bitrateIndex] * 1000;
  const rate = MP3_RATES[version][rateIndex];
  return Math.floor((version === 3 ? 144 : 72) * bitrate / rate) + padding;
}

type Minimp3 = {
  memory: WebAssembly.Memory;
  decoder_init(): void; decoder_mp3_data_offset(): number; decoder_set_mp3_data_size(size: number): void;
  decoder_decode(seconds: number): void; decoder_pcm_data_offset(): number; decoder_pcm_data_size(): number;
  decode_results_sampling_rate(): number; decode_results_num_channels(): number;
};
let minimp3Module: WebAssembly.Module | undefined;
/** A decoder of its own (one per file: its memory grows to the block it holds, and goes with it). */
function minimp3(): Minimp3 {
  minimp3Module ??= new WebAssembly.Module(readFileSync(createRequire(import.meta.url).resolve("minimp3-wasm/dist/decoder.opt.wasm")));
  const exports = new WebAssembly.Instance(minimp3Module, {}).exports as unknown as Minimp3;
  exports.decoder_init();
  return exports;
}

/** Bytes of whole frames handed to the decoder at a time (about 4 s at 128 kbps). */
const MP3_BLOCK = 64 * 1024;

async function* mp3(reader: ByteReader): AsyncGenerator<Block> {
  // An ID3v2 tag first (its size is syncsafe, plus a footer when flagged) is skipped.
  const head = await reader.peek(10);
  if (head.length === 10 && String.fromCharCode(head[0], head[1], head[2]) === "ID3") {
    const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
    await reader.skip(10 + size + (head[5] & 0x10 ? 10 : 0));
  }
  const decoder = minimp3();
  let pending: Uint8Array = new Uint8Array(0);
  let frames = 0;
  for (let ended = false; !ended;) {
    const chunk = await reader.chunk();
    if (!chunk.length) ended = true;
    pending = concat(pending, chunk);
    if (pending.length < MP3_BLOCK && !ended) continue;
    // Whole frames only; bytes between frames (junk, a trailing tag) are skipped one at a time until a header.
    let at = 0, end = 0;
    const whole: Uint8Array[] = [];
    while (at + 4 <= pending.length) {
      const length = mp3Frame(pending, at);
      if (!length) { at++; end = at; continue; }
      if (at + length > pending.length) break;
      whole.push(pending.subarray(at, at + length));
      at += length;
      end = at;
    }
    pending = pending.slice(ended ? pending.length : end);
    if (!whole.length) continue;
    frames += whole.length;
    const block = concatAll(whole);
    const offset = decoder.decoder_mp3_data_offset();
    decoder.decoder_set_mp3_data_size(block.length);
    new Uint8Array(decoder.memory.buffer, offset, block.length).set(block);
    decoder.decoder_decode(1e9);
    const samples = decoder.decoder_pcm_data_size() / 2;
    const rate = decoder.decode_results_sampling_rate(), channels = decoder.decode_results_num_channels();
    if (!samples || !rate || !channels) continue;
    const pcm = new Int16Array(decoder.memory.buffer, decoder.decoder_pcm_data_offset(), samples);
    yield { rate, mono: downmix(pcm, channels) };
  }
  if (!frames) throw new AudioRefused(422, "The MP3 file has no audio frames");
}

function concatAll(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

// Ogg Opus ----------------------------------------------------------------------------

/** Packets of the first logical stream in an Ogg file, as its pages come. */
async function* oggPackets(reader: ByteReader): AsyncGenerator<Uint8Array> {
  let serial: number | undefined;
  let partial: Uint8Array[] = [];
  for (;;) {
    const header = await reader.take(27);
    if (header.length < 27) return;
    if (String.fromCharCode(header[0], header[1], header[2], header[3]) !== "OggS") throw new AudioRefused(422, "The Ogg file is broken (a page doesn't start with OggS)");
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const pageSerial = view.getUint32(14, true);
    const lacing = await reader.take(header[26]);
    const size = lacing.reduce((sum, value) => sum + value, 0);
    const body = await reader.take(size);
    if (body.length < size) return;
    serial ??= pageSerial;
    if (pageSerial !== serial) continue;
    let at = 0;
    for (const value of lacing) {
      partial.push(body.subarray(at, at + value));
      at += value;
      if (value < 255) { yield concatAll(partial); partial = []; }
    }
  }
}

async function* oggOpus(reader: ByteReader): AsyncGenerator<Block> {
  const packets = oggPackets(reader);
  const head = (await packets.next()).value as Uint8Array | undefined;
  if (!head || head.length < 19) throw new AudioRefused(422, "The Ogg Opus file is broken (no OpusHead)");
  const channels = head[9];
  // Channel mapping family 0 (mono or stereo) only: surround needs a multistream decoder.
  if (channels < 1 || channels > 2 || head[18] !== 0) throw new AudioRefused(415, "Only mono or stereo Opus is supported");
  let preSkip = head[10] | (head[11] << 8);
  // OpusTags.
  await packets.next();
  const opus = new Opus(48_000, channels as 1 | 2, "audio");
  try {
    for await (const packet of packets) {
      if (!packet.length) continue;
      let pcm: Buffer;
      try { pcm = opus.decode(packet); }
      catch { throw new AudioRefused(422, "The Ogg Opus file is broken (a packet doesn't decode)"); }
      let samples = new Int16Array(new Uint8Array(pcm).buffer, 0, pcm.byteLength >> 1);
      if (preSkip) {
        const skip = Math.min(preSkip, samples.length / channels);
        samples = samples.subarray(skip * channels);
        preSkip -= skip;
      }
      if (samples.length) yield { rate: 48_000, mono: downmix(samples, channels) };
    }
  } finally {
    opus.delete();
  }
}

// WAV ---------------------------------------------------------------------------------

async function* wav(reader: ByteReader): AsyncGenerator<Block> {
  await reader.skip(12);
  let format: { code: number; channels: number; rate: number; bits: number } | undefined;
  for (;;) {
    const chunk = await reader.take(8);
    if (chunk.length < 8) throw new AudioRefused(422, "The WAV file has no data chunk");
    const view = new DataView(chunk.buffer, chunk.byteOffset, 8);
    const id = String.fromCharCode(...chunk.subarray(0, 4));
    const size = view.getUint32(4, true);
    if (id === "fmt ") {
      const body = await reader.take(size + (size & 1));
      const fmt = new DataView(body.buffer, body.byteOffset, body.byteLength);
      let code = fmt.getUint16(0, true);
      // WAVE_FORMAT_EXTENSIBLE: the sub-format's first two bytes are the code.
      if (code === 0xfffe && size >= 26) code = fmt.getUint16(24, true);
      format = { code, channels: fmt.getUint16(2, true), rate: fmt.getUint32(4, true), bits: fmt.getUint16(14, true) };
      continue;
    }
    if (id !== "data") { await reader.skip(size + (size & 1)); continue; }
    if (!format) throw new AudioRefused(422, "The WAV file has no format chunk before its data");
    const { code, channels, rate, bits } = format;
    const pcm = code === 1 && [8, 16, 24, 32].includes(bits), float = code === 3 && bits === 32;
    if (!pcm && !float) throw new AudioRefused(415, "Only PCM or 32-bit float WAV is supported");
    if (channels < 1 || channels > 8 || rate < 8_000 || rate > 192_000) throw new AudioRefused(415, "The WAV file's channels or sample rate aren't supported");
    const frame = channels * bits / 8;
    // A stream's data size may be 0 or the largest: read to the end then.
    let left = size === 0 || size === 0xffffffff ? Infinity : size;
    let carry = new Uint8Array(0);
    while (left > 0) {
      const got = await reader.chunk();
      if (!got.length) break;
      const bytes = concat(carry, got.subarray(0, Math.min(got.length, left === Infinity ? got.length : left - carry.length)));
      if (left !== Infinity) left -= bytes.length - carry.length;
      const whole = bytes.length - bytes.length % frame;
      carry = bytes.slice(whole);
      if (!whole) continue;
      yield { rate, mono: wavSamples(bytes.subarray(0, whole), channels, bits, float) };
    }
    return;
  }
}

function wavSamples(bytes: Uint8Array, channels: number, bits: number, float: boolean): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const step = bits / 8, frames = bytes.length / (step * channels);
  const mono = new Float32Array(frames);
  for (let i = 0, at = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++, at += step) {
      sum += float ? view.getFloat32(at, true)
        : bits === 8 ? (bytes[at] - 128) / 128
        : bits === 16 ? view.getInt16(at, true) / 32_768
        : bits === 24 ? ((bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) << 8 >> 8) / 8_388_608
        : view.getInt32(at, true) / 2_147_483_648;
    }
    mono[i] = sum / channels;
  }
  return mono;
}

// Mixing and resampling ---------------------------------------------------------------

function downmix(pcm: Int16Array, channels: number): Float32Array {
  const frames = Math.floor(pcm.length / channels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm[i * channels + c];
    mono[i] = sum / channels / 32_768;
  }
  return mono;
}

function toS16(samples: Float32Array, gain: number): Uint8Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = Math.max(-32_768, Math.min(32_767, Math.round(samples[i] * gain * 32_767)));
  return new Uint8Array(out.buffer);
}

/** Taps of the anti-alias filter used when the rate goes down. */
const TAPS = 33;

/**
 * Mono floats at `rate` to AUDIO_RATE: low-pass filtered (windowed sinc, below the new Nyquist) when going down, then
 * linearly interpolated. Its state runs on across blocks.
 */
export class Resampler {
  private readonly step: number;
  private readonly filter?: Float32Array;
  private history: Float32Array;
  /** Position of the next output sample, in input samples, from the start of `history`. */
  private position = 0;
  private last = 0;
  readonly rate: number;

  constructor(rate: number) {
    this.rate = rate;
    this.step = rate / AUDIO_RATE;
    if (rate > AUDIO_RATE) {
      const cutoff = 0.45 * AUDIO_RATE / rate;
      const filter = new Float32Array(TAPS);
      let sum = 0;
      for (let i = 0; i < TAPS; i++) {
        const n = i - (TAPS - 1) / 2;
        const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
        const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (TAPS - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (TAPS - 1));
        filter[i] = sinc * window;
        sum += filter[i];
      }
      for (let i = 0; i < TAPS; i++) filter[i] /= sum;
      this.filter = filter;
    }
    this.history = new Float32Array(this.filter ? TAPS - 1 : 0);
  }

  push(input: Float32Array): Float32Array {
    if (this.rate === AUDIO_RATE) return input;
    let samples = input;
    if (this.filter) {
      // Filtered with the last TAPS-1 inputs before it.
      const joined = new Float32Array(this.history.length + input.length);
      joined.set(this.history);
      joined.set(input, this.history.length);
      samples = new Float32Array(input.length);
      for (let i = 0; i < input.length; i++) {
        let sum = 0;
        for (let k = 0; k < TAPS; k++) sum += joined[i + k] * this.filter[k];
        samples[i] = sum;
      }
      this.history = joined.slice(joined.length - (TAPS - 1));
    }
    // Interpolated between the previous block's last sample (`last`) and this one's.
    const source = new Float32Array(samples.length + 1);
    source[0] = this.last;
    source.set(samples, 1);
    const out: number[] = [];
    let position = this.position;
    while (position + 1 < source.length) {
      const index = Math.floor(position), fraction = position - index;
      out.push(source[index] * (1 - fraction) + source[index + 1] * fraction);
      position += this.step;
    }
    this.position = position - samples.length;
    this.last = samples.length ? samples[samples.length - 1] : this.last;
    return Float32Array.from(out);
  }
}
