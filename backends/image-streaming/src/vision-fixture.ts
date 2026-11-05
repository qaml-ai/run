/** A deterministic, small visual with no answer text baked into the image. */
export const VISION_FIXTURE = {
  name: 'red-square-left-blue-circle-right',
  width: 512,
  height: 320,
  expected: {left: 'red square', right: 'blue circle'},
} as const;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {bytes.set(part, offset); offset += part.length;}
  return bytes;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(data.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  bytes.set(new TextEncoder().encode(type), 4);
  bytes.set(data, 8);
  view.setUint32(data.length + 8, crc32(bytes.subarray(4, data.length + 8)));
  return bytes;
}

export async function makeVisionFixture(): Promise<Uint8Array> {
  const {width, height} = VISION_FIXTURE;
  const stride = width * 3 + 1;
  const scanlines = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * stride + 1 + x * 3;
      const square = x >= 64 && x < 208 && y >= 88 && y < 232;
      const circle = (x - 368) ** 2 + (y - 160) ** 2 <= 72 ** 2;
      scanlines[offset] = square ? 230 : circle ? 25 : 255;
      scanlines[offset + 1] = square ? 25 : circle ? 70 : 255;
      scanlines[offset + 2] = square ? 35 : circle ? 230 : 255;
    }
  }
  // Deflate includes the zlib header required by PNG. The raw buffer is < 0.5 MiB.
  const compressed = new Uint8Array(await new Response(
    new Blob([scanlines]).stream().pipeThrough(new CompressionStream('deflate')),
  ).arrayBuffer());
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8;
  header[9] = 2; // Eight-bit RGB.
  return concat([
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND', new Uint8Array()),
  ]);
}
