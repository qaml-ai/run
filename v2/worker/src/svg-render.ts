import { Buffer } from "node:buffer";
import { SVG_RENDER_LIMITS as LIMITS } from "../../svg-renderer/limits.ts";
import { ApiError, type Env } from "./types.ts";

export async function readSvgRequest(request: Request) {
  if (Number(request.headers.get("content-length")) > LIMITS.bodyBytes) {
    throw new ApiError(413, "render_too_large", "SVG render request exceeds the byte budget");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "invalid_svg", "SVG render request requires a JSON body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > LIMITS.bodyBytes) {
        await reader.cancel();
        throw new ApiError(413, "render_too_large", "SVG render request exceeds the byte budget");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid_svg", "SVG render request requires a JSON body");
  }
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
    if (typeof value === "string" && /^img_[A-Za-z0-9_-]{1,64}$/.test(value)) {
      const image = await env.MEDIA_BUCKET?.get(`images/${value}`);
      if (!image || image.customMetadata?.tenantId !== tenantId) {
        throw new ApiError(404, "media_not_found", "An SVG input image is unavailable");
      }
      if (image.size > LIMITS.imageBytes || total + Math.ceil(image.size / 3) * 4 > LIMITS.imageBase64Bytes) {
        throw new ApiError(413, "render_too_large", "SVG input exceeds the image byte budget");
      }
      data = Buffer.from(await image.arrayBuffer()).toString("base64");
    } else if (value && typeof value === "object" && typeof value.data === "string") {
      data = value.data;
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
