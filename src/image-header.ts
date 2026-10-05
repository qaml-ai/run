/**
 * An image's format and size from its header: PNG, GIF, WebP and JPEG, the types models take.
 * Only bounds-checked reads of a few bytes, nothing decoded; undefined when the header is not one of them.
 */
export function imageHeader(data: Buffer): { mimeType: string; width: number; height: number } | undefined {
  const at = (offset: number, text: string) => data.subarray(offset, offset + text.length).toString("latin1") === text;
  if (data.length >= 24 && data[0] === 0x89 && at(1, "PNG") && at(12, "IHDR")) return { mimeType: "image/png", width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  if (data.length >= 10 && (at(0, "GIF87a") || at(0, "GIF89a"))) return { mimeType: "image/gif", width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  if (data.length >= 30 && at(0, "RIFF") && at(8, "WEBP")) {
    if (at(12, "VP8 ")) return { mimeType: "image/webp", width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    if (at(12, "VP8L")) { const bits = data.readUInt32LE(21); return { mimeType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
    if (at(12, "VP8X")) return { mimeType: "image/webp", width: data.readUIntLE(24, 3) + 1, height: data.readUIntLE(27, 3) + 1 };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
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
