import { Worker } from "node:worker_threads";
import { FILE_LIMITS } from "./limits.ts";
import { errorText } from "./protocol.ts";
import { sandboxProcesses } from "./codemode.ts";
import { textual, type FileRef, type Media } from "./files.ts";
import type { FileEntry, VolumeService } from "./volumes.ts";

/**
 * Parsing untrusted files: an image's format and size, a PDF's pages and text. It never runs on
 * the runtime's main thread, which holds secrets and database credentials. With sandbox
 * processes (production) it runs in one of them: its own uid, no environment, no sockets, a
 * seccomp filter; an exploit there reaches nothing, and a crash takes down only that process,
 * which the launcher restarts. Without them (development) it runs on a worker thread here.
 * Either way the worker has a V8 heap limit, a deadline, and a ceiling on the process's resident
 * memory: pdf.js inflates streams into ArrayBuffers, which heap limits do not count, so a small
 * compressed "bomb" is stopped by the ceiling. Images pass through as they are: only their
 * header is read, nothing is decoded or re-encoded.
 */
export type Inspection = { media: Media; text?: string; truncated?: boolean };

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const none = (reason: string): Inspection => ({ media: { kind: "none", reason } });

/** Parse `bytes` on a worker thread of this process, within the limits above. */
export function inspectHere(bytes: Uint8Array, text: boolean): Promise<unknown> {
  const worker = new Worker(new URL("./inspect-worker.ts", import.meta.url), {
    workerData: { bytes, text, maxChars: FILE_LIMITS.extractedChars }, env: {},
    resourceLimits: { maxOldGenerationSizeMb: FILE_LIMITS.inspectHeapMb, maxYoungGenerationSizeMb: 32 },
  });
  const done = Promise.withResolvers<unknown>();
  const stop = (reason: string) => { done.resolve(none(`could not be read (${reason})`)); void worker.terminate(); };
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
