import { Buffer } from "node:buffer";
import { SVG_RENDER_LIMITS as LIMITS } from "../../svg-renderer/limits.ts";
import { computeRawHmacHex, constantTimeEqual, randomId } from "./crypto.ts";
import { imageHeader, imageIntact } from "./lib/image-header.ts";
import { ApiError, jsonResponse, type Env } from "./types.ts";

const MEDIA_ID_RE = /^img_[A-Za-z0-9_-]{1,64}$/;
const ALLOWED_UPLOAD_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
export const MEDIA_SIGNED_URL_TTL_SECONDS = 3600;

function mediaSigningSecret(env: Pick<Env, "VAULT_SECRET">): string {
  return env.VAULT_SECRET || "default-dev-vault-secret";
}

export async function signMediaUrlParams(
  env: Pick<Env, "VAULT_SECRET">,
  mediaId: string,
  tenantId: string,
  ttlSeconds = MEDIA_SIGNED_URL_TTL_SECONDS,
): Promise<{ exp: number; sig: string; expiresAt: string }> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await computeRawHmacHex(`camelrun-media-v2:${mediaId}:${tenantId}:${exp}`, mediaSigningSecret(env));
  return { exp, sig, expiresAt: new Date(exp * 1000).toISOString() };
}

export async function verifyMediaUrlSignature(
  env: Pick<Env, "VAULT_SECRET">,
  mediaId: string,
  tenantId: string,
  expParam: string | null | undefined,
  sigParam: string | null | undefined,
): Promise<{ valid: boolean; remainingSeconds: number }> {
  if (!expParam || !sigParam || !/^\d+$/.test(expParam) || !/^[0-9a-f]{64}$/i.test(sigParam)) {
    return { valid: false, remainingSeconds: 0 };
  }
  const exp = Number(expParam);
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(exp) || exp < nowSec) {
    return { valid: false, remainingSeconds: 0 };
  }
  const expected = await computeRawHmacHex(`camelrun-media-v2:${mediaId}:${tenantId}:${exp}`, mediaSigningSecret(env));
  if (!constantTimeEqual(sigParam.toLowerCase(), expected)) {
    return { valid: false, remainingSeconds: 0 };
  }
  return { valid: true, remainingSeconds: Math.max(1, exp - nowSec) };
}

async function readStreamWithLimit(
  request: Request,
  maxBytes: number,
  tooLargeCode: string,
  tooLargeMessage: string,
  emptyCode: string,
  emptyMessage: string,
): Promise<Buffer> {
  if (Number(request.headers.get("content-length")) > maxBytes) {
    throw new ApiError(413, tooLargeCode, tooLargeMessage);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, emptyCode, emptyMessage);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ApiError(413, tooLargeCode, tooLargeMessage);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export async function readSvgRequest(request: Request) {
  const buf = await readStreamWithLimit(
    request,
    LIMITS.bodyBytes,
    "render_too_large",
    "SVG render request exceeds the byte budget",
    "invalid_svg",
    "SVG render request requires a JSON body",
  );
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid_svg", "SVG render request requires a JSON body");
  }
}

export async function normalizeSvgRasterInput(
  env: Pick<Env, "IMAGES">,
  bytes: Buffer,
): Promise<{ bytes: Buffer; contentType: "image/png" | "image/jpeg"; width: number; height: number }> {
  if (bytes.length === 0) {
    throw new ApiError(400, "invalid_image", "Image body is empty");
  }
  if (bytes.length > LIMITS.imageBytes) {
    throw new ApiError(413, "render_too_large", "Image exceeds the 10 MiB limit");
  }
  const header = imageHeader(bytes);
  if (
    !header ||
    !header.width ||
    !header.height ||
    !ALLOWED_UPLOAD_MIME_TYPES.has(header.mimeType) ||
    Math.max(header.width, header.height) > LIMITS.imageSide ||
    !imageIntact(bytes, header.mimeType)
  ) {
    throw new ApiError(
      400,
      "invalid_image",
      "Image must be a valid PNG, JPEG, WebP, or GIF within 4096×4096 px",
    );
  }
  if (header.mimeType === "image/png" || header.mimeType === "image/jpeg") {
    return { bytes, contentType: header.mimeType, width: header.width, height: header.height };
  }

  // Convert WebP and GIF (first frame only) to PNG using the Cloudflare Images binding.
  if (!env.IMAGES) {
    throw new ApiError(503, "image_conversion_unavailable", "Image conversion for WebP/GIF is unavailable");
  }
  let converted: Buffer;
  try {
    const source = new Blob([new Uint8Array(bytes)]).stream();
    const output = await env.IMAGES.input(source).output({ format: "image/png", anim: false });
    const response = output.response();
    if (!response.ok) {
      throw new ApiError(422, "invalid_image", "Could not convert WebP or GIF image to PNG");
    }
    converted = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(422, "invalid_image", "Could not convert WebP or GIF image to PNG");
  }
  const outHeader = imageHeader(converted);
  if (
    !outHeader ||
    outHeader.mimeType !== "image/png" ||
    !outHeader.width ||
    !outHeader.height ||
    Math.max(outHeader.width, outHeader.height) > LIMITS.imageSide ||
    converted.length > LIMITS.imageBytes ||
    !imageIntact(converted, "image/png")
  ) {
    throw new ApiError(422, "invalid_image", "Converted PNG image is invalid or exceeds limits");
  }
  return { bytes: converted, contentType: "image/png", width: outHeader.width, height: outHeader.height };
}

export async function handleMediaUploadRequest(
  env: Env,
  tenantId: string,
  request: Request,
): Promise<Response> {
  if (!env.MEDIA_BUCKET) {
    throw new ApiError(501, "media_bucket_unconfigured", "MEDIA_BUCKET R2 binding is not configured");
  }
  const rawCt = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  let rawBytes: Buffer;

  if (ALLOWED_UPLOAD_MIME_TYPES.has(rawCt)) {
    rawBytes = await readStreamWithLimit(
      request,
      LIMITS.imageBytes,
      "payload_too_large",
      "Image exceeds the 10 MiB limit",
      "invalid_image",
      "Image body is empty",
    );
  } else if (rawCt === "application/json") {
    const jsonBuf = await readStreamWithLimit(
      request,
      LIMITS.imageBase64Bytes + 4096,
      "payload_too_large",
      "Image exceeds the 10 MiB limit",
      "invalid_request",
      "Request requires a JSON body with base64 `data`",
    );
    let parsed: { data?: unknown; contentType?: unknown };
    try {
      parsed = JSON.parse(jsonBuf.toString("utf8")) as { data?: unknown; contentType?: unknown };
    } catch {
      throw new ApiError(400, "invalid_request", "Request requires a valid JSON body");
    }
    if (!parsed || typeof parsed !== "object" || typeof parsed.data !== "string" || !parsed.data.trim()) {
      throw new ApiError(400, "invalid_request", "JSON body requires non-empty base64 `data`");
    }
    if (parsed.contentType !== undefined) {
      if (typeof parsed.contentType !== "string") {
        throw new ApiError(400, "invalid_request", "`contentType` must be a valid image MIME type");
      }
      const declared = parsed.contentType.split(";")[0]!.trim().toLowerCase();
      if (!ALLOWED_UPLOAD_MIME_TYPES.has(declared)) {
        throw new ApiError(400, "invalid_image", "Unsupported image contentType; expected PNG, JPEG, WebP, or GIF");
      }
    }
    const compact = parsed.data.replace(/\s+/g, "");
    if (!compact || compact.length % 4 === 1 || !BASE64_RE.test(compact)) {
      throw new ApiError(400, "invalid_image", "Invalid base64 image data");
    }
    rawBytes = Buffer.from(compact, "base64");
  } else {
    throw new ApiError(
      400,
      "invalid_request",
      "Content-Type must be image/png, image/jpeg, image/webp, image/gif, or application/json",
    );
  }

  const normalized = await normalizeSvgRasterInput(env, rawBytes);
  const id = randomId("img", 8);
  await env.MEDIA_BUCKET.put(`images/${id}`, new Uint8Array(normalized.bytes), {
    httpMetadata: { contentType: normalized.contentType },
    customMetadata: {
      tenantId,
      source: "upload",
      width: String(normalized.width),
      height: String(normalized.height),
      createdAt: String(Date.now()),
    },
  });

  const signed = await signMediaUrlParams(env, id, tenantId);
  return jsonResponse({
    id,
    url: `/v2/images/${id}?exp=${signed.exp}&sig=${signed.sig}`,
    expiresAt: signed.expiresAt,
    contentType: normalized.contentType,
    width: normalized.width,
    height: normalized.height,
    sizeBytes: normalized.bytes.length,
  });
}

export async function handleMediaDeleteRequest(
  env: Env,
  tenantId: string,
  id: string,
): Promise<Response> {
  if (!MEDIA_ID_RE.test(id)) {
    throw new ApiError(400, "invalid_request", "Invalid media ID");
  }
  if (!env.MEDIA_BUCKET) {
    throw new ApiError(501, "media_bucket_unconfigured", "MEDIA_BUCKET R2 binding is not configured");
  }
  const existing = await env.MEDIA_BUCKET.head(`images/${id}`);
  if (!existing || existing.customMetadata?.tenantId !== tenantId) {
    throw new ApiError(404, "media_not_found", `Media '${id}' not found`);
  }
  await env.MEDIA_BUCKET.delete(`images/${id}`);
  return jsonResponse({ ok: true, id, deleted: true });
}

export async function resolveRenderFiles(env: Env, tenantId: string, files: unknown) {
  if (files === undefined) return undefined;
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new ApiError(400, "invalid_svg_files", "files must map SVG image names to media IDs or inline base64 data");
  }
  const entries = Object.entries(files);
  if (entries.length > LIMITS.imageCount) throw new ApiError(400, "invalid_svg_files", "Too many SVG input images");
  const resolved: Record<string, { data: string }> = Object.create(null);
  let total = 0;
  for (const [name, value] of entries) {
    let data: string;
    if (typeof value === "string" && MEDIA_ID_RE.test(value)) {
      const image = await env.MEDIA_BUCKET?.get(`images/${value}`);
      if (!image || image.customMetadata?.tenantId !== tenantId) {
        throw new ApiError(404, "media_not_found", "An SVG input image is unavailable");
      }
      if (image.size > LIMITS.imageBytes) {
        throw new ApiError(413, "render_too_large", "SVG input exceeds the image byte budget");
      }
      let rawBytes = Buffer.from(await image.arrayBuffer());
      const header = imageHeader(rawBytes);
      if (header && (header.mimeType === "image/webp" || header.mimeType === "image/gif")) {
        rawBytes = (await normalizeSvgRasterInput(env, rawBytes)).bytes;
      }
      data = rawBytes.toString("base64");
    } else if (value && typeof value === "object" && typeof value.data === "string") {
      data = value.data;
      if (data.length > LIMITS.imageBase64Bytes) {
        throw new ApiError(413, "render_too_large", "SVG input exceeds the image byte budget");
      }
      const rawBytes = Buffer.from(data, "base64");
      const header = imageHeader(rawBytes);
      if (header && (header.mimeType === "image/webp" || header.mimeType === "image/gif")) {
        if (rawBytes.toString("base64") !== data) {
          throw new ApiError(400, "invalid_image", "SVG file base64 data is malformed");
        }
        data = (await normalizeSvgRasterInput(env, rawBytes)).bytes.toString("base64");
      }
    } else {
      throw new ApiError(400, "invalid_svg_files", "Each SVG input needs a media ID or inline base64 data");
    }
    total += data.length;
    if (total > LIMITS.imageBase64Bytes) throw new ApiError(413, "render_too_large", "SVG input exceeds the image byte budget");
    resolved[name] = { data };
  }
  return resolved;
}

export async function renderSvg(env: Env, svg: unknown, files?: Record<string, { data: string }>) {
  if (typeof svg !== "string" || !svg.trim() || Buffer.byteLength(svg) > LIMITS.svgBytes) {
    throw new ApiError(400, "invalid_svg", "Supply a non-empty SVG up to 1 MiB");
  }
  if (!env.SVG_RENDERER) throw new ApiError(503, "svg_renderer_unavailable", "SVG renderer is unavailable");
  const response = await env.SVG_RENDERER.fetch("https://svg-renderer/render", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ svg, files }),
  });
  if (response.status === 400 || response.status === 413) {
    const body = await response.json() as { error?: string };
    throw new ApiError(response.status, "invalid_svg", body.error ?? "Invalid SVG");
  }
  if (!response.ok) throw new ApiError(502, "svg_render_failed", "SVG rendering failed");
  return {
    contentType: "image/png" as const,
    width: Number(response.headers.get("x-image-width")),
    height: Number(response.headers.get("x-image-height")),
    data: Buffer.from(await response.arrayBuffer()).toString("base64"),
  };
}

export async function recordSvgRenderUsage(
  tenantStub: { settleUsage(input: { refId: string; model: string; inputTokens: number; outputTokens: number; vmMs: number; costUsd: number; note?: string; skipLedger?: boolean }): Promise<unknown> },
  durationMs: number,
  note = "POST /v2/images/render",
): Promise<void> {
  await tenantStub
    .settleUsage({
      refId: `svg:${randomId("rnd", 8)}`,
      model: "image:resvg",
      inputTokens: 0,
      outputTokens: 0,
      vmMs: Math.max(0, Math.round(durationMs)),
      costUsd: 0,
      note,
      skipLedger: true,
    })
    .catch(() => {});
}
