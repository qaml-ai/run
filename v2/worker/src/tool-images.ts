import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { imageHeader, imageIntact } from "../../../src/image-header.ts";
import { FILE_LIMITS } from "../../../src/limits.ts";
import type { Env } from "./types.ts";

export interface ToolImageRef {
  digest: string;
  contentType: string;
  size: number;
  width: number;
  height: number;
}

type ImageBlock = { type: "image"; data?: unknown; mimeType?: unknown };

export function toolImageContent(value: unknown): unknown[] | undefined {
  if (!value || typeof value !== "object" || !("content" in value)) return;
  const { content } = value;
  return Array.isArray(content) && content.some(isImageBlock) ? content : undefined;
}

function isImageBlock(value: unknown): value is ImageBlock {
  return !!value && typeof value === "object" && "type" in value && value.type === "image";
}

export function toolImageKey(tenantId: string, ref: ToolImageRef): string {
  return `${tenantId}/tool-images/${ref.digest}`;
}

export async function storeToolImages(env: Pick<Env, "MEDIA_BUCKET" | "IMAGES">, tenantId: string, result: unknown) {
  const content = toolImageContent(result);
  if (!content) return { result };
  const bucket = env.MEDIA_BUCKET;
  if (!bucket) throw new Error("Tool image storage is unavailable");
  if (content.filter(isImageBlock).length > FILE_LIMITS.requestImages) throw new Error("Tool returned too many images");
  let remaining = FILE_LIMITS.requestImageBase64Bytes;
  const references: ToolImageRef[] = [];
  const bytesByDigest = new Map<string, Buffer>();
  const summary: string[] = [];
  for (const block of content) {
    if (!isImageBlock(block)) {
      if (block && typeof block === "object" && "type" in block && block.type === "text" &&
          "text" in block && typeof block.text === "string") summary.push(block.text);
      continue;
    }
    const { data, mimeType } = block;
    if (typeof data !== "string" || !data.length || data.length > remaining) {
      throw new Error("Tool image exceeds the image byte budget or is missing");
    }
    remaining -= data.length;
    let bytes = Buffer.from(data, "base64");
    let header = imageHeader(bytes);
    if (!header || !header.width || !header.height || header.mimeType !== mimeType ||
        bytes.toString("base64") !== data || !imageIntact(bytes, header.mimeType)) {
      throw new Error("Tool returned an invalid or unsupported raster image");
    }
    if (Math.max(header.width, header.height) > FILE_LIMITS.requestImageSide || bytes.length > FILE_LIMITS.requestImageBytes) {
      if (!env.IMAGES) throw new Error("Tool image is too large and image resizing is unavailable");
      const source = new Blob([new Uint8Array(bytes)]).stream();
      const output = await env.IMAGES.input(source)
        .transform({ width: FILE_LIMITS.requestImageSide, height: FILE_LIMITS.requestImageSide, fit: "scale-down" })
        .output({ format: "image/jpeg", quality: 80, anim: false });
      const response = output.response();
      if (!response.ok) throw new Error("Tool image resizing failed");
      bytes = Buffer.from(await response.arrayBuffer());
      header = imageHeader(bytes);
      if (!header || !header.width || !header.height || Math.max(header.width, header.height) > FILE_LIMITS.requestImageSide ||
          bytes.length > FILE_LIMITS.requestImageBytes || !imageIntact(bytes, header.mimeType)) {
        throw new Error("Resized tool image exceeds the model image limits");
      }
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    references.push({ digest, contentType: header.mimeType, size: bytes.length, width: header.width, height: header.height });
    bytesByDigest.set(digest, bytes);
    summary.push(`[image ${header.width}×${header.height}]`);
  }
  for (const ref of references) {
    const bytes = bytesByDigest.get(ref.digest);
    if (bytes) {
      await bucket.put(toolImageKey(tenantId, ref), new Uint8Array(bytes), { httpMetadata: { contentType: ref.contentType } });
      bytesByDigest.delete(ref.digest);
    }
  }
  return { result: summary.join("\n"), images: references };
}
