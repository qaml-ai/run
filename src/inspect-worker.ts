import { parentPort, workerData } from "node:worker_threads";
import { imageHeader } from "./image-header.ts";

// Parses one untrusted file: an image's format and size from its header, or a PDF's pages
// (and text, if asked) with pdf.js; or decodes an image to scale it down for a model request
// (`fit`), with sharp. It runs in a worker the parent terminates at a deadline or memory
// ceiling (parse-job.ts), in a parse job of its own. Nothing here is trusted by
// the parent: it checks every field it gets back.
type Fit = { side: number; bytes: number; pixels: number; ms: number };
const { bytes, text: wantText, maxChars, fit } = workerData as { bytes: Uint8Array; text: boolean; maxChars: number; fit?: Fit };
const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * The image as a model request may carry it (`fit`): scaled down, keeping its aspect ratio, to at most
 * `side` pixels a side and `bytes` encoded. The same bytes always give the same output, so a provider's
 * cached prompt prefix holds across turns: one libvips thread, no operation cache, no metadata kept. A
 * JPEG stays a JPEG; anything else becomes a PNG (a GIF or WebP its first frame), or a JPEG on white if
 * a PNG would be too large.
 */
async function fitted(found: { width: number; height: number; mimeType: string }) {
  const { default: sharp } = await import("sharp");
  sharp.cache(false);
  sharp.concurrency(1);
  const scaled = sharp(data, { limitInputPixels: fit!.pixels, failOn: "error" }).timeout({ seconds: Math.ceil(fit!.ms / 1000) })
    .rotate().resize({ width: fit!.side, height: fit!.side, fit: "inside", withoutEnlargement: true });
  let out = await (found.mimeType === "image/jpeg" ? scaled.clone().jpeg({ quality: 85 }) : scaled.clone().png({ compressionLevel: 6 })).toBuffer({ resolveWithObject: true });
  if (out.data.length > fit!.bytes && found.mimeType !== "image/jpeg") out = await scaled.clone().flatten({ background: "#ffffff" }).jpeg({ quality: 80 }).toBuffer({ resolveWithObject: true });
  if (out.data.length > fit!.bytes) throw new Error(`still over ${fit!.bytes} bytes scaled down`);
  return { media: { kind: "image", mimeType: `image/${out.info.format}`, width: out.info.width, height: out.info.height }, data: out.data };
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
  const found = imageHeader(data);
  if (fit && found && (Math.max(found.width, found.height) > fit.side || data.length > fit.bytes)) parentPort!.postMessage(await fitted(found));
  else parentPort!.postMessage(found ? { media: { kind: "image", ...found } } : !fit && data.subarray(0, 5).toString("latin1") === "%PDF-" ? await pdf() : { media: { kind: "none", reason: `not an image${fit ? "" : " or PDF"} the model can view` } });
} catch (error) {
  parentPort!.postMessage({ media: { kind: "none", reason: `could not be read (${String((error as Error)?.message ?? error).slice(0, 200)})` } });
}
