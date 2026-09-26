import { parentPort, workerData } from "node:worker_threads";

// Parses one untrusted file: an image's format and size from its header, or a PDF's pages
// (and text, if asked) with pdf.js. It runs in a worker the parent terminates at a deadline or
// memory ceiling (inspect.ts), in a sandbox process when there are some. Nothing here is
// trusted by the parent: it checks every field it gets back.
const { bytes, text: wantText, maxChars } = workerData as { bytes: Uint8Array; text: boolean; maxChars: number };
const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const at = (offset: number, text: string) => data.subarray(offset, offset + text.length).toString("latin1") === text;

function image(): { mimeType: string; width: number; height: number } | undefined {
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

async function pdf() {
  const { getDocumentProxy, extractText } = await import("unpdf");
  const document = await getDocumentProxy(new Uint8Array(data), { isEvalSupported: false, useSystemFonts: false, verbosity: 0 } as never);
  if (!wantText) return { media: { kind: "pdf", pages: document.numPages } };
  const { text: pages } = await extractText(document, { mergePages: false });
  // Control characters (but newlines and tabs) are dropped: they carry nothing and bloat JSON.
  const text = (pages as string[]).map((page, index) => `--- Page ${index + 1} ---\n${page.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")}`).join("\n\n");
  return { media: { kind: "pdf", pages: document.numPages }, text: text.slice(0, maxChars), ...(text.length > maxChars ? { truncated: true } : {}) };
}

try {
  const found = image();
  parentPort!.postMessage(found ? { media: { kind: "image", ...found } } : at(0, "%PDF-") ? await pdf() : { media: { kind: "none", reason: "not an image or PDF the model can view" } });
} catch (error) {
  parentPort!.postMessage({ media: { kind: "none", reason: `could not be read (${String((error as Error)?.message ?? error).slice(0, 200)})` } });
}
