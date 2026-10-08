import { createHmac, timingSafeEqual } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import { HttpError } from "./http.ts";
import { FILE_LIMITS } from "./limits.ts";
import type { FileEntry, VolumeService } from "./volumes.ts";

/**
 * Files in and out of agents. Every file an agent gets or makes is a volume file with a
 * content type; the model sees its path, and images and PDFs natively when it can. This
 * module holds what the runtime and the agent host share: limits, content types, safe
 * download headers, signed links, and the file reference the transcript keeps.
 */
export { FILE_LIMITS };

/** A content type's essence: `type/subtype`, lowercase, without parameters. */
export const essence = (contentType: string) => contentType.split(";")[0].trim().toLowerCase();

/** A content type as files record it: an essence of at most 100 characters. */
export const validContentType = (value: unknown): value is string => typeof value === "string" && value.length <= 100 && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value);

/** A declared Content-Type worth recording; generic ones (octet-stream, form defaults) are left to sniffing. */
export function declaredType(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 200) return undefined;
  const type = essence(value);
  if (!validContentType(type)) return undefined;
  return ["application/octet-stream", "application/x-www-form-urlencoded", "multipart/form-data"].includes(type) ? undefined : type;
}

const EXTENSIONS: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json", jsonl: "application/x-ndjson",
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript", ts: "text/plain", py: "text/plain",
  xml: "application/xml", svg: "image/svg+xml", yaml: "application/yaml", yml: "application/yaml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac", weba: "audio/webm", mp4: "video/mp4", webm: "video/webm",
  zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
/** Content types read as text: everything else a tool returns is saved as a file. */
export const textual = (contentType: string) => /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json|javascript|x-www-form-urlencoded)\b)|\+json\b|\+xml\b/i.test(contentType.trim());
/** A type from a name alone, for files recorded before content types were (listings do not read contents). */
export const guessContentType = (name: string) => EXTENSIONS[/\.([a-z0-9]{1,8})$/i.exec(name)?.[1].toLowerCase() ?? ""] ?? "application/octet-stream";
const starts = (head: Uint8Array, bytes: number[], at = 0) => bytes.every((byte, index) => head[at + index] === byte);
const ascii = (text: string) => [...text].map(char => char.charCodeAt(0));

/**
 * A file's content type from its first bytes (magic numbers), then its name's extension, then
 * whether it reads as text. Only a label for listings and downloads: nothing trusts it for
 * safety, and what the model is shown natively is decided by inspecting the bytes (inspect.ts).
 */
export function sniffContentType(head: Uint8Array, name: string): string {
  const extension = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1].toLowerCase() ?? "";
  if (starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts(head, ascii("GIF87a")) || starts(head, ascii("GIF89a"))) return "image/gif";
  if (starts(head, ascii("RIFF")) && starts(head, ascii("WEBP"), 8)) return "image/webp";
  if (starts(head, ascii("%PDF-"))) return "application/pdf";
  if (starts(head, [0x1f, 0x8b])) return "application/gzip";
  if (starts(head, ascii("OggS"))) return "audio/ogg";
  if (starts(head, ascii("fLaC"))) return "audio/flac";
  if (starts(head, ascii("RIFF")) && starts(head, ascii("WAVE"), 8)) return "audio/wav";
  if (starts(head, ascii("ID3"))) return "audio/mpeg";
  if (starts(head, [0x50, 0x4b, 0x03, 0x04])) return ["docx", "xlsx", "pptx"].includes(extension) ? EXTENSIONS[extension] : "application/zip";
  if (EXTENSIONS[extension]) return EXTENSIONS[extension];
  if (head.includes(0)) return "application/octet-stream";
  try { new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, Math.max(0, head.length - 3))); return "text/plain"; }
  catch { return "application/octet-stream"; }
}

/** Types a browser may show inline: they cannot run script. Everything else downloads as an attachment. */
const INLINE = new Set(["text/plain", "text/csv", "text/markdown", "application/json", "application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/flac", "audio/webm", "video/mp4", "video/webm"]);

/**
 * Headers for serving a file from the runtime's origin, where console sessions live. Nothing is
 * sniffed by the browser, and anything that could run script (HTML, SVG, XML, unknown types) is
 * an attachment in a CSP sandbox. PDFs go without the sandbox, which browsers' PDF viewers refuse;
 * those viewers run a PDF's script in their own isolation, never as this origin.
 */
export function downloadHeaders(contentType: string, name: string): Record<string, string> {
  const type = essence(contentType);
  const inline = INLINE.has(type);
  return {
    "Content-Type": type.startsWith("text/") ? `${type}; charset=utf-8` : type,
    "X-Content-Type-Options": "nosniff",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name || "file")}`,
    ...(type === "application/pdf" ? {} : { "Content-Security-Policy": "sandbox; default-src 'none'" }),
  };
}

/** A file's download: streamed a chunk at a time, with a `range` (bytes=start-end) if asked, under `downloadHeaders`. */
export async function fileResponse(volumes: VolumeService, tenant: string, entry: { path: string } & Pick<FileEntry, "size" | "version" | "chunks" | "contentType">, range?: string) {
  let start = 0, end = entry.size;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match && match[1]) { start = Number(match[1]); if (match[2]) end = Math.min(entry.size, Number(match[2]) + 1); }
    else if (match && match[2]) start = Math.max(0, entry.size - Number(match[2]));
    if (!match || (!match[1] && !match[2]) || start >= end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${entry.size}` } });
  }
  const contentType = await volumes.contentType(tenant, entry.path, entry);
  const chunks = volumes.stream(tenant, entry, start, end);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close(); else controller.enqueue(new Uint8Array(next.value));
    },
    async cancel() { await chunks.return(undefined); },
  });
  return new Response(body, { status: range ? 206 : 200, headers: {
    ...downloadHeaders(contentType, entry.path.slice(entry.path.lastIndexOf("/") + 1)), "Content-Length": String(end - start), ETag: `"${entry.version}"`,
    // The version again, where no proxy rewrites it (a compressing one makes the ETag weak, W/"n").
    "X-File-Version": String(entry.version), "Cache-Control": "no-store",
    ...(range ? { "Content-Range": `bytes ${start}-${end - 1}/${entry.size}` } : {}),
  } });
}

/** An attached audio file's transcript, as its reference keeps it: the text, and the audio's language, length and the model that heard it. */
export type FileTranscript = { text: string; language?: string; seconds: number; model: string };

/** What inspecting a file's bytes found: an image or PDF the model may be shown natively, or why it cannot be. */
export type Media = { kind: "image"; mimeType: string; width: number; height: number } | { kind: "pdf"; pages: number } | { kind: "none"; reason: string };

/**
 * A file as the transcript keeps it, in a user message or a tool result, in place of its bytes.
 * The chunk list is the file's content at the time: chunks are content-addressed and never
 * rewritten, so the reference reads the same bytes after the file is changed or deleted.
 */
export type FileRef = {
  type: "file"; path: string; volume: string; version: number; size: number; contentType: string; chunks: string[];
  media?: Media;
  /** Audio transcribed when it was attached (transcription.ts): the model reads this in place of the sound. */
  transcript?: FileTranscript;
  /** Audio that was to be transcribed by default and could not be, and why: the model is told. */
  untranscribed?: string;
  /** A text file's first lines, so the model knows its shape without reading it. */
  head?: string;
};

export function validFileRef(value: any): value is FileRef {
  return !!value && value.type === "file" && typeof value.path === "string" && typeof value.volume === "string" &&
    Number.isSafeInteger(value.version) && Number.isSafeInteger(value.size) && value.size >= 0 && typeof value.contentType === "string" &&
    Array.isArray(value.chunks) && value.chunks.every((hash: unknown) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) &&
    (value.transcript === undefined || (typeof value.transcript?.text === "string" && Number.isFinite(value.transcript.seconds) && typeof value.transcript.model === "string"));
}

/** Which native block a file becomes for `model`, if any: images for vision models, PDFs where the provider takes documents. */
export function nativeBlock(ref: FileRef, model: Model<Api>): "image" | "document" | undefined {
  const media = ref.media;
  if (media?.kind === "image" && model.input.includes("image") && ref.size <= FILE_LIMITS.imageBytes && Math.max(media.width, media.height) <= FILE_LIMITS.imageSide) return "image";
  if (media?.kind === "pdf" && supportsDocuments(model) && ref.size <= FILE_LIMITS.documentBytes && media.pages <= FILE_LIMITS.documentPages) return "document";
  return undefined;
}

/**
 * Whether a model takes PDFs as input. Pi's catalog declares only text and images, so this is the
 * runtime's own capability data: the APIs whose document blocks `documentPayload` writes.
 */
export function supportsDocuments(model: Model<Api>): boolean {
  if (!model.input.includes("image")) return false;
  if (["anthropic-messages", "google-generative-ai", "google-vertex", "openai-responses", "azure-openai-responses"].includes(model.api)) return true;
  return model.api === "openai-completions" && model.provider === "openrouter";
}

/**
 * Characters a file block stands for in context estimates: an image as pi counts one, a PDF by its
 * pages (text plus a page image, about 3,000 tokens each), anything else by the line describing it.
 */
export function fileChars(ref: FileRef): number {
  if (ref.transcript) return 200 + ref.transcript.text.length;
  if (ref.media?.kind === "image") return 4800;
  if (ref.media?.kind === "pdf") return ref.media.pages * 12_000;
  return 200;
}

/** Why `model` is not shown a file natively, when it is an image or PDF; undefined for other files, and for ones it is shown. */
export function unseen(ref: FileRef, model: Model<Api>): string | undefined {
  const media = ref.media;
  if (!media || nativeBlock(ref, model)) return undefined;
  if (media.kind === "none") return media.reason;
  if (media.kind === "image") return model.input.includes("image") ? `too large to view (at most ${FILE_LIMITS.imageBytes} bytes and ${FILE_LIMITS.imageSide} pixels a side)` : "this model cannot view images";
  return supportsDocuments(model) ? `too large to view (at most ${FILE_LIMITS.documentBytes} bytes and ${FILE_LIMITS.documentPages} pages); read it for its text` : "this model cannot view PDFs; read it for its text";
}

/** A file name from a caller, safe as one path segment: no separators or control characters, not hidden, at most 200 bytes. */
export function safeName(name: unknown, fallback = "file"): string {
  const base = (typeof name === "string" ? name.split(/[\\/]/).pop()! : "").replace(/[\x00-\x1f\x7f]/g, "").trim().replace(/^\.+/, "");
  if (Buffer.byteLength(base) <= 200) return base || fallback;
  const extension = /\.[A-Za-z0-9]{1,8}$/.exec(base)?.[0] ?? "";
  let stem = base.slice(0, base.length - extension.length);
  while (Buffer.byteLength(stem + extension) > 200) stem = stem.slice(0, -1);
  return stem + extension;
}

/**
 * The text a file block becomes when it is not shown natively; an audio file's transcript with it. (A model that hears
 * audio could be given the sound instead, where `nativeBlock` would say so; none is yet.)
 */
export function describeFile(ref: FileRef, why?: string) {
  const size = ref.size >= 1024 * 1024 ? `${(ref.size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(ref.size / 1024)} KB`;
  if (ref.transcript) {
    const seconds = Math.round(ref.transcript.seconds);
    return `[Audio ${ref.path} (${ref.contentType}, ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}${ref.transcript.language ? `, ${ref.transcript.language}` : ""}), transcript:\n${ref.transcript.text || "(no speech)"}\n]`;
  }
  why ??= ref.untranscribed && `not transcribed (${ref.untranscribed})`;
  return `[File ${ref.path} (${ref.contentType}, ${size})${why ? `: ${why}` : ""}${ref.head ? `, beginning:\n${ref.head}` : ""}]`;
}

/**
 * Pi carries a PDF as an image block with type application/pdf; before the request is sent it
 * becomes the provider's document block. Anthropic: `document`; OpenAI Responses: `input_file`;
 * chat completions (OpenRouter): `file`. Google takes a PDF as `inlineData` as it is.
 */
export function documentPayload(payload: unknown): unknown {
  const pdf = "data:application/pdf;base64,";
  const walk = (value: any): any => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;
    if (value.type === "image" && value.source?.media_type === "application/pdf") return { type: "document", source: value.source };
    if (value.type === "input_image" && typeof value.image_url === "string" && value.image_url.startsWith(pdf)) return { type: "input_file", filename: "document.pdf", file_data: value.image_url };
    if (value.type === "image_url" && typeof value.image_url?.url === "string" && value.image_url.url.startsWith(pdf)) return { type: "file", file: { filename: "document.pdf", file_data: value.image_url.url } };
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) copy[key] = walk(entry);
    return copy;
  };
  return walk(payload);
}

/** What a signed link lets its holder do: read one file, or write one path (within a size and content type). */
export type LinkGrant = { tenant: string; volume: string; path: string; method: "GET" | "PUT"; expiresAt: number; maxBytes?: number; contentType?: string };

/**
 * Short-lived signed URLs for one volume file, so an app, browser, tool server or channel can fetch
 * or put it without a token. The HMAC key is derived from the session secret every node shares, so
 * any node verifies a link; the grant is bound to tenant, volume, path, method and expiry, and an
 * upload's to its size and content type. Links are not revocable before they expire.
 */
export class FileLinks {
  private readonly key: Buffer;
  /** Where links point: the runtime's public URL. */
  publicUrl: string;
  constructor(secret: string, publicUrl: string) {
    this.key = createHmac("sha256", secret).update("agent-runtime:file-links:v1").digest();
    this.publicUrl = publicUrl.replace(/\/+$/, "");
  }

  private mac(payload: string) { return createHmac("sha256", this.key).update(payload).digest("base64url"); }

  /** Sign a grant; `expiresIn` (seconds) defaults to 15 minutes and is capped at a day. */
  sign(grant: Omit<LinkGrant, "expiresAt"> & { expiresIn?: unknown }) {
    const seconds = grant.expiresIn ?? FILE_LIMITS.linkSeconds;
    if (!Number.isInteger(seconds) || (seconds as number) < 1 || (seconds as number) > FILE_LIMITS.maxLinkSeconds) throw new HttpError(400, `expiresIn must be 1–${FILE_LIMITS.maxLinkSeconds} seconds`);
    if (grant.method === "PUT" && grant.maxBytes !== undefined && (!Number.isSafeInteger(grant.maxBytes) || grant.maxBytes < 0)) throw new HttpError(400, "maxBytes must be a non-negative integer");
    const { expiresIn: _, ...rest } = grant;
    const signed: LinkGrant = { ...rest, expiresAt: Date.now() + (seconds as number) * 1000 };
    const payload = Buffer.from(JSON.stringify(signed)).toString("base64url");
    const name = grant.path.slice(grant.path.lastIndexOf("/") + 1);
    // `urlPath` too, so a proxy in front of a private runtime can serve the link at its own origin.
    const urlPath = `/v1/links/${payload}.${this.mac(payload)}/${encodeURIComponent(name)}`;
    return { url: `${this.publicUrl}${urlPath}`, urlPath, ...signed };
  }

  /** The grant a link's token carries, if its signature holds and it has not expired. */
  verify(token: string): LinkGrant {
    const [payload, mac, ...rest] = token.split(".");
    const expected = payload ? Buffer.from(this.mac(payload)) : undefined;
    if (rest.length || !expected || !mac || expected.length !== mac.length || !timingSafeEqual(expected, Buffer.from(mac))) throw new HttpError(403, "Invalid link");
    const grant = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as LinkGrant;
    if (!(grant.expiresAt > Date.now())) throw new HttpError(403, "This link has expired");
    return grant;
  }
}
