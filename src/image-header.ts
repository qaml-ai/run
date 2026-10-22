import { crc32 } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Why a damaged image is replaced in requests, without changing the saved history. */
export const IMAGE_DAMAGED = "could not be read (damaged or incomplete image)";

/**
 * An image's format and size from its header: PNG, GIF, WebP and JPEG, the types models take.
 * Only bounds-checked reads of a few bytes, nothing decoded; undefined when the header is not one of them.
 */
export function imageHeader(data: Buffer): { mimeType: string; width: number; height: number } | undefined {
  const at = (offset: number, text: string) => data.subarray(offset, offset + text.length).toString("latin1") === text;
  if (data.length >= 24 && data.subarray(0, 8).equals(PNG_SIGNATURE) && at(12, "IHDR")) return { mimeType: "image/png", width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data.length >= 10 && (at(0, "GIF87a") || at(0, "GIF89a"))) return { mimeType: "image/gif", width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  if (data.length >= 30 && at(0, "RIFF") && at(8, "WEBP")) {
    if (at(12, "VP8 ")) return { mimeType: "image/webp", width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    if (at(12, "VP8L")) { const bits = data.readUInt32LE(21); return { mimeType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
    if (at(12, "VP8X")) return { mimeType: "image/webp", width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    // Walk the segments to the frame header (SOF0–SOF15, except DHT, JPG and DAC).
    for (let offset = 2; offset + 9 < data.length;) {
      if (data[offset] !== 0xff) return undefined;
      const marker = data[offset + 1];
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { mimeType: "image/jpeg", width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
      offset += 2 + data.readUInt16BE(offset + 2);
    }
  }
  return undefined;
}

/**
 * Cheap structural completeness, without decoding untrusted pixels. Headers alone admit truncated images
 * that poison every later request carrying the history. This is not a decoder: providers may still refuse
 * intact containers, in which case the host retries that turn without images. PNG permits bytes after IEND.
 */
export function imageIntact(data: Buffer, mimeType: string): boolean {
  const at = (offset: number, text: string) => data.subarray(offset, offset + text.length).toString("latin1") === text;
  if (mimeType === "image/png") {
    if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
    let idat = false;
    for (let offset = 8; offset + 12 <= data.length;) {
      const length = data.readUInt32BE(offset), end = offset + 12 + length;
      if (end > data.length || (offset === 8 && (!at(offset + 4, "IHDR") || length !== 13))) return false;
      if (crc32(data.subarray(offset + 4, end - 4)) !== data.readUInt32BE(end - 4)) return false;
      if (at(offset + 4, "IEND")) return length === 0 && idat;
      if (at(offset + 4, "IDAT")) idat = true;
      offset = end;
    }
    return false;
  }
  if (mimeType === "image/jpeg") {
    if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8 || data[2] !== 0xff) return false;
    for (let offset = 2; offset + 1 < data.length;) {
      if (data[offset] !== 0xff) return false;
      const marker = data[offset + 1];
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      if (marker === 0x00 || marker === 0xd8 || marker === 0xd9 || offset + 4 > data.length) return false;
      const length = data.readUInt16BE(offset + 2), end = offset + 2 + length;
      if (length < 2 || end > data.length) return false;
      if (marker === 0xda) {
        for (let tail = data.length - 2; tail >= end; tail--) if (data[tail] === 0xff && data[tail + 1] === 0xd9) return true;
        return false;
      }
      offset = end;
    }
    return false;
  }
  if (mimeType === "image/gif") {
    if (data.length < 14 || !(at(0, "GIF87a") || at(0, "GIF89a"))) return false;
    let tail = data.length - 1;
    while (tail >= 13 && data[tail] === 0) tail--;
    return data[tail] === 0x3b;
  }
  if (mimeType === "image/webp") {
    if (data.length < 20 || !at(0, "RIFF") || !at(8, "WEBP")) return false;
    const end = data.readUInt32LE(4) + 8, length = data.readUInt32LE(16);
    return end <= data.length && end >= 20 && 20 + length + (length & 1) <= end &&
      ((at(12, "VP8 ") && length >= 10) || (at(12, "VP8L") && length >= 5) || (at(12, "VP8X") && length >= 10));
  }
  return false;
}
