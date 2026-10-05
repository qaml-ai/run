import { Worker } from "node:worker_threads";
import { FILE_LIMITS } from "./limits.ts";
import { errorText } from "./protocol.ts";
import { sandboxProcesses } from "./codemode.ts";
import { textual, type FileRef, type Media } from "./files.ts";
import { imageHeader } from "./image-header.ts";
import type { FileEntry, VolumeService } from "./volumes.ts";

/**
 * Parsing untrusted files: an image's format and size, a PDF's pages and text. It never runs on
 * the runtime's main thread, which holds secrets and database credentials. With sandbox
 * processes (production) it runs in one of them: its own uid, no environment, no sockets, a
 * seccomp filter; an exploit there reaches nothing, and a crash takes down only that process,
 * which the launcher restarts. Without them (development) it runs on a worker thread here.
 * Either way the worker has a V8 heap limit, a deadline, and a ceiling on the process's resident
 * memory: pdf.js inflates streams into ArrayBuffers, which heap limits do not count, so a small
 * compressed "bomb" is stopped by the ceiling. Inspecting an image reads only its header; an
 * image is decoded only to scale it down for a model request (`fitImage`).
 */
export type Inspection = { media: Media; text?: string; truncated?: boolean };
/**
 * An image as a model request carries it: the bytes given, or scaled down; or why it cannot be shown,
 * `transient` when another try may do (a deadline, memory ceiling or crash, which load can cause).
 */
export type Fitted = { data: Buffer; mimeType: string; width: number; height: number } | { omitted: string; transient?: true };

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const none = (reason: string): Inspection => ({ media: { kind: "none", reason } });

/** How the worker scales an image down for a model request (inspect-worker.ts). */
const FIT = { side: FILE_LIMITS.requestImageSide, bytes: FILE_LIMITS.requestImageBytes, pixels: FILE_LIMITS.imageSide ** 2, ms: FILE_LIMITS.inspectMs };

/** Parse `bytes` on a worker thread of this process, within the limits above; `fit` scales an image down for a model request. */
export function inspectHere(bytes: Uint8Array, text: boolean, fit = false): Promise<unknown> {
  const worker = new Worker(new URL("./inspect-worker.ts", import.meta.url), {
    workerData: { bytes, text, maxChars: FILE_LIMITS.extractedChars, ...(fit ? { fit: FIT } : {}) }, env: {},
    resourceLimits: { maxOldGenerationSizeMb: FILE_LIMITS.inspectHeapMb, maxYoungGenerationSizeMb: 32 },
  });
  const done = Promise.withResolvers<unknown>();
  // Stopped from outside, not by what the file holds: the caller may try again (`fitImage`).
  const stop = (reason: string) => { done.resolve({ ...none(`could not be read (${reason})`), transient: true }); void worker.terminate(); };
  const baseline = process.memoryUsage.rss();
  const watchdog = setInterval(() => { if (process.memoryUsage.rss() - baseline > FILE_LIMITS.inspectMemoryBytes) stop("it needs too much memory"); }, 20);
  const timer = setTimeout(() => stop("it took too long"), FILE_LIMITS.inspectMs);
  worker.once("message", done.resolve);
  worker.once("error", error => stop(errorText(error)));
  worker.once("exit", () => stop("its parser stopped"));
  return done.promise.finally(() => { clearInterval(watchdog); clearTimeout(timer); void worker.terminate(); });
}

/** What a worker or sandbox process answered, rebuilt from checked fields: neither is trusted. */
export function inspection(value: any): Inspection {
  const media = value?.media;
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
  if (media?.kind === "image" && IMAGE_TYPES.includes(media.mimeType) && count(media.width) && count(media.height)) {
    return { media: { kind: "image", mimeType: media.mimeType, width: media.width, height: media.height } };
  }
  if (media?.kind === "pdf" && count(media.pages)) {
    return { media: { kind: "pdf", pages: media.pages }, ...(typeof value.text === "string" ? { text: value.text.slice(0, FILE_LIMITS.extractedChars) } : {}), ...(value.truncated === true ? { truncated: true } : {}) };
  }
  return none(typeof media?.reason === "string" ? media.reason.slice(0, 300) : "could not be read");
}

/** Inspect bytes where it is safe to: in a sandbox process if there are any, else on a worker thread here. `text` extracts a PDF's text too. */
export async function inspect(bytes: Uint8Array, text = false): Promise<Inspection> {
  if (bytes.length > FILE_LIMITS.inspectBytes) return none(`larger than ${FILE_LIMITS.inspectBytes} bytes`);
  const processes = sandboxProcesses();
  try { return inspection(await (processes ? processes.pick().inspect(bytes, text) : inspectHere(bytes, text))); }
  catch (error) { return none(`could not be read (${errorText(error)})`); }
}

/** Whether an image of this size and these bytes goes in a model request as it is. */
export const fits = (width: number, height: number, bytes: number) => Math.max(width, height) <= FILE_LIMITS.requestImageSide && bytes <= FILE_LIMITS.requestImageBytes;

/**
 * An image as a model request may carry it: `bytes` as they are when their header is within
 * `fits`, else decoded and scaled down where untrusted files are parsed (`inspect`). The same bytes
 * always give the same output. One that cannot be (not an image a model takes, over the input,
 * pixel or time caps, or still too large) is `omitted`, with the reason, for a placeholder.
 */
export async function fitImage(bytes: Buffer): Promise<Fitted> {
  const header = imageHeader(bytes);
  if (header && fits(header.width, header.height, bytes.length)) return { data: bytes, ...header };
  const size = header ? `${header.width}×${header.height} px` : "not an image the model can view";
  if (!header) return { omitted: size };
  if (bytes.length > FILE_LIMITS.inspectBytes) return { omitted: `${size}, larger than ${FILE_LIMITS.inspectBytes} bytes` };
  if (header.width * header.height > FIT.pixels) return { omitted: `${size}, too many pixels to scale down` };
  const processes = sandboxProcesses();
  let answer: any;
  try { answer = await (processes ? processes.pick().inspect(bytes, false, true) : inspectHere(bytes, false, true)); }
  catch (error) { return { omitted: `${size}, could not be resized (${errorText(error)})`, transient: true }; }
  // As untrusted as any answer: the bytes must be an image a model takes, as large as they say and within the caps.
  const data = answer?.data instanceof Uint8Array ? Buffer.from(answer.data.buffer, answer.data.byteOffset, answer.data.byteLength) : undefined;
  const scaled = data && imageHeader(data);
  if (!data || !scaled || !["image/png", "image/jpeg"].includes(scaled.mimeType) || !fits(scaled.width, scaled.height, data.length) || scaled.mimeType !== answer.media?.mimeType) {
    const reason = typeof answer?.media?.reason === "string" ? answer.media.reason.slice(0, 200) : undefined;
    return { omitted: `${size}, could not be resized${reason ? ` (${reason})` : ""}`, ...(answer?.transient === true ? { transient: true as const } : {}) };
  }
  return { data, ...scaled };
}

/**
 * What a volume file is for the model: its type says image or PDF and it is small enough to be
 * shown, so its bytes are inspected; otherwise nothing is parsed. `text` also extracts a PDF's text.
 */
export async function inspectFile(volumes: VolumeService, tenant: string, entry: Pick<FileEntry, "size" | "chunks">, contentType: string, text = false): Promise<Inspection | undefined> {
  const type = contentType.split(";")[0].trim().toLowerCase();
  const limit = IMAGE_TYPES.includes(type) ? FILE_LIMITS.imageBytes : type === "application/pdf" ? (text ? FILE_LIMITS.inspectBytes : FILE_LIMITS.documentBytes) : 0;
  if (!limit) return undefined;
  if (entry.size > limit) return none(`larger than ${limit} bytes`);
  return inspect(await volumes.readRange(tenant, entry, 0, entry.size), text);
}

/**
 * A volume file as the transcript of `agent` refers to it, with what inspecting it found. Its chunks are pinned to the
 * agent (storage-gc.ts): they stay stored while it exists, whatever becomes of the file.
 */
export async function fileRef(volumes: VolumeService, tenant: string, agent: string, volume: string, shown: string, entry: FileEntry & { contentType: string }): Promise<FileRef> {
  await volumes.pin(tenant, agent, entry.chunks);
  const found = await inspectFile(volumes, tenant, entry, entry.contentType);
  const head = textual(entry.contentType) && entry.size ? firstLines(await volumes.readRange(tenant, entry, 0, FILE_LIMITS.headBytes), entry.size > FILE_LIMITS.headBytes) : undefined;
  return { type: "file", path: shown, volume, version: entry.version, size: entry.size, contentType: entry.contentType, chunks: entry.chunks, ...(found ? { media: found.media } : {}), ...(head ? { head } : {}) };
}

/** A text's first lines, each cut to a width; a line the read cut short is left out. */
function firstLines(data: Buffer, more: boolean): string | undefined {
  if (data.includes(0)) return undefined;
  const lines = new TextDecoder().decode(data).split(/\r?\n/);
  if (more && lines.length > 1) lines.pop();
  const head = lines.slice(0, FILE_LIMITS.headLines).map(line => line.length > FILE_LIMITS.headWidth ? `${line.slice(0, FILE_LIMITS.headWidth - 1)}…` : line).join("\n").trimEnd();
  return head || undefined;
}
