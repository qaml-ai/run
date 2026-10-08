/**
 * An audio file's format and length from its container: Ogg (Opus, Vorbis), WebM/Matroska, WAV, FLAC,
 * MP4/M4A and MP3, the formats transcription takes. Only bounds-checked reads of the container's own
 * fields, nothing decoded; undefined when the bytes are none of these. `seconds` is undefined when the
 * container does not say how long it is (a stream cut short, a header that lies), so nothing is
 * sent to a provider whose cost cannot be bounded first.
 */
export type AudioFormat = "ogg" | "webm" | "wav" | "flac" | "mp4" | "mp3";
export type AudioHeader = { format: AudioFormat; contentType: string; seconds?: number };

const CONTENT_TYPES: Record<AudioFormat, string> = { ogg: "audio/ogg", webm: "audio/webm", wav: "audio/wav", flac: "audio/flac", mp4: "audio/mp4", mp3: "audio/mpeg" };
/** The audio formats `audioHeader` reads, by name, for messages that list them. */
export const AUDIO_FORMATS = Object.keys(CONTENT_TYPES) as AudioFormat[];

/** A plausible length: finite, positive, under a day. */
const length = (seconds: number) => Number.isFinite(seconds) && seconds > 0 && seconds < 86_400 ? seconds : undefined;

export function audioHeader(data: Buffer): AudioHeader | undefined {
  const at = (offset: number, text: string) => data.subarray(offset, offset + text.length).toString("latin1") === text;
  const header = (format: AudioFormat, seconds: number | undefined): AudioHeader => ({ format, contentType: CONTENT_TYPES[format], ...(seconds !== undefined ? { seconds } : {}) });
  if (data.length >= 28 && at(0, "OggS")) return header("ogg", oggSeconds(data));
  if (data.length >= 4 && data.readUInt32BE(0) === 0x1a45dfa3) return header("webm", webmSeconds(data));
  if (data.length >= 12 && at(0, "RIFF") && at(8, "WAVE")) return header("wav", wavSeconds(data));
  if (data.length >= 42 && at(0, "fLaC")) return header("flac", flacSeconds(data));
  if (data.length >= 12 && at(4, "ftyp")) return header("mp4", mp4Seconds(data));
  const mp3 = mp3Seconds(data);
  if (mp3) return header("mp3", mp3.seconds);
  return undefined;
}

/** Ogg: the last page's granule position, at 48 kHz less the pre-skip for Opus, at the stream's rate for Vorbis. */
function oggSeconds(data: Buffer): number | undefined {
  // The first page holds the codec's identification header.
  const segments = data[26];
  const packet = 27 + segments;
  if (packet + 19 > data.length) return undefined;
  let rate: number, skip = 0;
  if (data.subarray(packet, packet + 8).toString("latin1") === "OpusHead") { rate = 48_000; skip = data.readUInt16LE(packet + 10); }
  else if (data[packet] === 1 && data.subarray(packet + 1, packet + 7).toString("latin1") === "vorbis" && packet + 16 <= data.length) rate = data.readUInt32LE(packet + 12);
  else return undefined;
  if (!rate) return undefined;
  // The last page: the last "OggS" whose header and segments end exactly at the end of the data.
  for (let offset = data.lastIndexOf("OggS"); offset >= 0; offset = offset ? data.lastIndexOf("OggS", offset - 1) : -1) {
    if (offset + 27 > data.length || data[offset + 4] !== 0) continue;
    const count = data[offset + 26];
    if (offset + 27 + count > data.length) continue;
    let size = 27 + count;
    for (let index = 0; index < count; index++) size += data[offset + 27 + index];
    if (offset + size !== data.length) continue;
    const granule = data.readBigInt64LE(offset + 6);
    if (granule < 0n) return undefined;
    return length((Number(granule) - skip) / rate);
  }
  return undefined;
}

/**
 * WebM/Matroska: the segment's Duration (in TimecodeScale units), else the latest block's time, as a
 * browser's MediaRecorder writes no Duration. Elements are read in order: masters (Segment, Info, Cluster,
 * BlockGroup) are entered, so their size may be unknown, as a live recording's are; others are skipped.
 */
function webmSeconds(data: Buffer): number | undefined {
  const MASTERS = new Set([0x18538067, 0x1549a966, 0x1f43b675, 0xa0]);
  /** A variable-length integer at `offset`: its value (all ones: unknown) and length. */
  const vint = (offset: number, id = false) => {
    const first = data[offset];
    if (first === undefined || first === 0) return undefined;
    const bytes = Math.clz32(first) - 23;
    if (bytes > 8 || offset + bytes > data.length) return undefined;
    let value = id ? first : first & (0xff >> bytes);
    let unknown = value === (0xff >> bytes);
    for (let index = 1; index < bytes; index++) {
      value = value * 256 + data[offset + index];
      if (data[offset + index] !== 0xff) unknown = false;
    }
    return { value, bytes, unknown: !id && unknown };
  };
  const uint = (offset: number, size: number) => { let value = 0; for (let index = 0; index < size; index++) value = value * 256 + data[offset + index]; return value; };
  let scale = 1_000_000, duration: number | undefined, cluster = 0, latest = 0;
  // Skip the EBML header to the first element after it.
  const head = vint(4);
  if (!head || head.unknown) return undefined;
  let offset = 4 + head.bytes + head.value;
  while (offset < data.length) {
    const id = vint(offset, true), size = id && vint(offset + id.bytes);
    if (!id || !size) break;
    const start = offset + id.bytes + size.bytes;
    if (MASTERS.has(id.value)) { offset = start; continue; }
    if (size.unknown || start + size.value > data.length) break;
    if (id.value === 0x2ad7b1 && size.value <= 8) scale = uint(start, size.value);
    else if (id.value === 0x4489 && size.value === 4) duration = data.readFloatBE(start);
    else if (id.value === 0x4489 && size.value === 8) duration = data.readDoubleBE(start);
    else if (id.value === 0xe7 && size.value <= 8) cluster = uint(start, size.value);
    else if ((id.value === 0xa3 || id.value === 0xa1) && size.value >= 4) {
      const track = vint(start);
      if (track && start + track.bytes + 2 <= data.length) latest = Math.max(latest, cluster + data.readInt16BE(start + track.bytes));
    }
    offset = start + size.value;
  }
  if (!scale) return undefined;
  return length((duration && duration > 0 ? duration : latest) * scale / 1e9);
}

/** WAV: the data chunk's size over the format's bytes a second (the rest of the file when the size is left open). */
function wavSeconds(data: Buffer): number | undefined {
  let rate = 0;
  for (let offset = 12; offset + 8 <= data.length;) {
    const id = data.subarray(offset, offset + 4).toString("latin1"), size = data.readUInt32LE(offset + 4);
    if (id === "fmt " && offset + 20 <= data.length) rate = data.readUInt32LE(offset + 16);
    if (id === "data") return rate ? length(Math.min(size, data.length - offset - 8) / rate) : undefined;
    offset += 8 + size + (size & 1);
  }
  return undefined;
}

/** FLAC: STREAMINFO's total samples over its sample rate. */
function flacSeconds(data: Buffer): number | undefined {
  if ((data[4] & 0x7f) !== 0) return undefined;
  const info = 8;
  const rate = (data[info + 10] << 12) | (data[info + 11] << 4) | (data[info + 12] >> 4);
  const samples = (data[info + 13] & 0x0f) * 2 ** 32 + data.readUInt32BE(info + 14);
  return rate && samples ? length(samples / rate) : undefined;
}

/** MP4/M4A: the movie header's duration over its timescale (moov may come after the media). */
function mp4Seconds(data: Buffer): number | undefined {
  const boxes = (start: number, end: number, visit: (type: string, body: number, end: number) => number | undefined): number | undefined => {
    for (let offset = start; offset + 8 <= end;) {
      let size = data.readUInt32BE(offset), body = offset + 8;
      const type = data.subarray(offset + 4, offset + 8).toString("latin1");
      if (size === 1) { if (offset + 16 > end) return undefined; size = Number(data.readBigUInt64BE(offset + 8)); body += 8; }
      else if (size === 0) size = end - offset;
      if (size < body - offset || offset + size > end) return undefined;
      const found = visit(type, body, offset + size);
      if (found !== undefined) return found;
      offset += size;
    }
    return undefined;
  };
  return boxes(0, data.length, (type, body, end) => type !== "moov" ? undefined : boxes(body, end, (inner, at, stop) => {
    if (inner !== "mvhd") return undefined;
    const version = data[at];
    if (version === 0 && at + 20 <= stop) return length(data.readUInt32BE(at + 16) / data.readUInt32BE(at + 12));
    if (version === 1 && at + 32 <= stop) return length(Number(data.readBigUInt64BE(at + 24)) / data.readUInt32BE(at + 20));
    return undefined;
  }));
}

const MP3_BITRATES = [
  // MPEG-1 layer III, then MPEG-2/2.5 layer III, kbit/s by index.
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
];
const MP3_RATES = [[11_025, 12_000, 8_000], [0, 0, 0], [22_050, 24_000, 16_000], [44_100, 48_000, 32_000]];

/**
 * MP3: after any ID3v2 tag, a layer III frame header. A Xing/Info or VBRI header's frame count gives the
 * length; without one the stream is taken as constant bitrate (the audio's bytes over its bitrate).
 */
function mp3Seconds(data: Buffer): { seconds?: number } | undefined {
  let offset = 0;
  if (data.length >= 10 && data.subarray(0, 3).toString("latin1") === "ID3") {
    offset = 10 + ((data[6] & 0x7f) << 21 | (data[7] & 0x7f) << 14 | (data[8] & 0x7f) << 7 | (data[9] & 0x7f)) + (data[5] & 0x10 ? 10 : 0);
  }
  if (offset + 4 > data.length || data[offset] !== 0xff || (data[offset + 1] & 0xe0) !== 0xe0) return undefined;
  const version = (data[offset + 1] >> 3) & 3, layer = (data[offset + 1] >> 1) & 3;
  const bitrate = MP3_BITRATES[version === 3 ? 0 : 1][data[offset + 2] >> 4], rate = MP3_RATES[version][(data[offset + 2] >> 2) & 3];
  // Layer III only (01), with a known bitrate and sample rate.
  if (layer !== 1 || !bitrate || !rate) return undefined;
  const mono = (data[offset + 3] >> 6) === 3;
  const samples = version === 3 ? 1152 : 576;
  const side = version === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
  const xing = offset + 4 + side;
  const tag = data.subarray(xing, xing + 4).toString("latin1");
  if ((tag === "Xing" || tag === "Info") && xing + 12 <= data.length && data.readUInt32BE(xing + 4) & 1) return { seconds: length(data.readUInt32BE(xing + 8) * samples / rate) };
  if (data.subarray(offset + 36, offset + 40).toString("latin1") === "VBRI" && offset + 54 <= data.length) return { seconds: length(data.readUInt32BE(offset + 50) * samples / rate) };
  return { seconds: length((data.length - offset) * 8 / (bitrate * 1000)) };
}
