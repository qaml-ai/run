import { createHmac, timingSafeEqual } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai";
import { HttpError } from "./http.ts";
import type { FileEntry, VolumeService } from "./volumes.ts";

/**
 * Files in and out of agents. Every file an agent gets or makes is a volume file with a
 * content type; the model sees its path, and images and PDFs natively when it can. This
 * module holds what the runtime and the agent host share: limits, content types, safe
 * download headers, signed links, and the file reference the transcript keeps.
 */
export const FILE_LIMITS = Object.freeze({
  /** Files attached to one message, and their inline (base64) bytes in all, decoded. */
  attachments: 20, inlineBytes: 4 * 1024 * 1024,
  /** An image the model sees natively: Anthropic's per-image cap, and the longest side any provider takes. */
  imageBytes: 5 * 1024 * 1024, imageSide: 8000,
  /** A PDF the model sees natively (Anthropic's page cap; well under every provider's size cap). */
  documentBytes: 16 * 1024 * 1024, documentPages: 100,
  /** Across one model request: older files past these are described in text instead. */
  requestFileBytes: 24 * 1024 * 1024, requestImages: 100,
  /** File bytes the agent host keeps hydrated between model requests. */
  hydratedBytes: 32 * 1024 * 1024,
  /** Parsing untrusted files (in a worker, in a sandbox process when there are some): input, time, memory and text out. */
  inspectBytes: 32 * 1024 * 1024, inspectMs: 10_000, inspectHeapMb: 256, inspectMemoryBytes: 512 * 1024 * 1024, extractedChars: 1_000_000,
  /** Signed links: default and longest lifetime, in seconds. */
  linkSeconds: 15 * 60, maxLinkSeconds: 24 * 60 * 60,
  /** An upload's whole request may take this long (other requests get 30 s). */
  uploadMs: 15 * 60_000,
  /** One js_exec fs.readFile or fs.writeFile: base64 of this fits a 1 MiB tool result. */
  scriptFileBytes: 768 * 1024,
});

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
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4", webm: "video/webm",
  zip: "application/zip", gz: "application/gzip", tar: "application/x-tar",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
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
  if (starts(head, [0x50, 0x4b, 0x03, 0x04])) return ["docx", "xlsx", "pptx"].includes(extension) ? EXTENSIONS[extension] : "application/zip";
  if (EXTENSIONS[extension]) return EXTENSIONS[extension];
  if (head.includes(0)) return "application/octet-stream";
  try { new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, Math.max(0, head.length - 3))); return "text/plain"; }
  catch { return "application/octet-stream"; }
}

/** Types a browser may show inline: they cannot run script. Everything else downloads as an attachment. */
const INLINE = new Set(["text/plain", "text/csv", "text/markdown", "application/json", "application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "audio/mpeg", "audio/wav", "audio/ogg", "video/mp4", "video/webm"]);

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
    ...downloadHeaders(contentType, entry.path.slice(entry.path.lastIndexOf("/") + 1)), "Content-Length": String(end - start), ETag: `"${entry.version}"`, "Cache-Control": "no-store",
    ...(range ? { "Content-Range": `bytes ${start}-${end - 1}/${entry.size}` } : {}),
  } });
}

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
};

export function validFileRef(value: any): value is FileRef {
  return !!value && value.type === "file" && typeof value.path === "string" && typeof value.volume === "string" &&
    Number.isSafeInteger(value.version) && Number.isSafeInteger(value.size) && value.size >= 0 && typeof value.contentType === "string" &&
    Array.isArray(value.chunks) && value.chunks.every((hash: unknown) => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash));
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
  if (ref.media?.kind === "image") return 4800;
  if (ref.media?.kind === "pdf") return ref.media.pages * 12_000;
  return 200;
}

/** The text a file block becomes when it is not shown natively. */
export function describeFile(ref: FileRef, why?: string) {
  const size = ref.size >= 1024 * 1024 ? `${(ref.size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(ref.size / 1024)} KB`;
  return `[File ${ref.path} (${ref.contentType}, ${size})${why ? `: ${why}` : ""}]`;
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
  readonly publicUrl: string;
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
    return { url: `${this.publicUrl}/v1/links/${payload}.${this.mac(payload)}/${encodeURIComponent(name)}`, ...signed };
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
