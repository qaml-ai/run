/** A complete transparent 1x1 PNG carrying a reference in an ancillary iTXt chunk. */
export interface ImageReference {
  key: string;
  size: number;
  mimeType: string;
  sha256: string;
}

const PREFIX = "camelrun:image:v1:";
const MAX_MARKER_LENGTH = 4096;
const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, bytes) => size + bytes.length, 0));
  let offset = 0;
  for (const bytes of parts) { result.set(bytes, offset); offset += bytes.length; }
  return result;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length + 12);
  const view = new DataView(result.buffer);
  view.setUint32(0, data.length);
  result.set(encoder.encode(type), 4);
  result.set(data, 8);
  view.setUint32(data.length + 8, crc32(result.subarray(4, data.length + 8)));
  return result;
}

const PNG_HEADER = concat(
  Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
  chunk("IHDR", Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0)),
  // Deflated filter byte followed by one transparent RGBA pixel.
  chunk("IDAT", Uint8Array.of(0x78, 0x9c, 0x63, 0x60, 0, 2, 0, 0, 5, 0, 1)),
);
const PNG_END = chunk("IEND", new Uint8Array(0));
// keyword, uncompressed flag/method, empty language tag and translated keyword.
const TEXT_HEADER = concat(encoder.encode("camelrun"), Uint8Array.of(0, 0, 0, 0, 0));

function equals(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function isReference(value: unknown): value is ImageReference {
  if (!value || typeof value !== "object") return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.key === "string" && ref.key.length > 0 && ref.key.length <= 1024 &&
    Number.isSafeInteger(ref.size) && Number(ref.size) >= 0 &&
    typeof ref.mimeType === "string" && /^image\/[a-zA-Z0-9.+-]+$/.test(ref.mimeType) &&
    typeof ref.sha256 === "string" && /^[0-9a-f]{64}$/.test(ref.sha256);
}

export function makeMarker(ref: ImageReference): string {
  if (!isReference(ref)) throw new Error("Invalid image reference");
  const bytes = concat(PNG_HEADER, chunk("iTXt", concat(TEXT_HEADER, encoder.encode(PREFIX + JSON.stringify(ref)))), PNG_END);
  const result = btoa(String.fromCharCode(...bytes));
  if (result.length > MAX_MARKER_LENGTH) throw new Error("Image marker too large");
  return result;
}

export function parseMarker(data: string): ImageReference | null {
  if (!data || data.length > MAX_MARKER_LENGTH || data.length % 4 !== 0) return null;
  try {
    const binary = atob(data);
    if (btoa(binary) !== data) return null;
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    if (!equals(bytes.subarray(0, PNG_HEADER.length), PNG_HEADER)) return null;
    const offset = PNG_HEADER.length;
    const view = new DataView(bytes.buffer);
    const length = view.getUint32(offset);
    if (offset + length + 12 + PNG_END.length !== bytes.length) return null;
    if (!equals(bytes.subarray(offset + 4, offset + 8), encoder.encode("iTXt"))) return null;
    const textBytes = bytes.subarray(offset + 8, offset + 8 + length);
    if (!equals(textBytes.subarray(0, TEXT_HEADER.length), TEXT_HEADER)) return null;
    if (view.getUint32(offset + length + 8) !== crc32(bytes.subarray(offset + 4, offset + length + 8))) return null;
    if (!equals(bytes.subarray(offset + length + 12), PNG_END)) return null;
    const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(textBytes.subarray(TEXT_HEADER.length));
    if (!decoded.startsWith(PREFIX)) return null;
    const value: unknown = JSON.parse(decoded.slice(PREFIX.length));
    return isReference(value) ? value : null;
  } catch {
    return null;
  }
}
