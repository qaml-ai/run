import { Buffer } from "node:buffer";
import { imageHeader, imageIntact } from "./lib/image-header.ts";
import { FILE_LIMITS } from "./lib/limits.ts";
import { ApiError, type StoredMessageContent } from "./types.ts";

export type LegacyInlineBlock = { type: "text"; text: string } |
  { type: "image"; data: string; mimeType: string };

/** This import path preserves already-fitted raster bytes; it never repairs or resizes history. */
export function validateLegacyInlineContent(content: unknown): LegacyInlineBlock[] {
  if (!Array.isArray(content)) throw new ApiError(422, "unsupported_history", "Invalid inline image history");
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") continue;
    if (block?.type !== "image" || typeof block.data !== "string" ||
        !/^image\/(png|jpeg|gif|webp)$/.test(block.mimeType)) {
      throw new ApiError(422, "unsupported_history", "Inline history requires text and supported raster images");
    }
    if (block.data.length > 4 * Math.ceil(FILE_LIMITS.requestImageBytes / 3)) {
      throw new ApiError(422, "unsupported_history", "Inline history contains an image requiring legacy resizing");
    }
    const bytes = Buffer.from(block.data, "base64");
    const header = imageHeader(bytes);
    if (!block.data.length || bytes.toString("base64") !== block.data ||
        !header || header.mimeType !== block.mimeType || !imageIntact(bytes, block.mimeType) ||
        Math.max(header.width, header.height) > FILE_LIMITS.requestImageSide ||
        bytes.length > FILE_LIMITS.requestImageBytes) {
      throw new ApiError(422, "unsupported_history", "Inline history contains an image requiring legacy repair or resizing");
    }
  }
  return content as LegacyInlineBlock[];
}

/** Raw v1 content is stored once, under the unchanged full-history import receipt. */
export function readLegacyInlineContent(content: StoredMessageContent): LegacyInlineBlock[] | undefined {
  if (!content.legacyInlineImages) return undefined;
  const original = content.meta?.v1 as { role?: unknown; content?: unknown } | undefined;
  if (original?.role !== "user") throw new ApiError(422, "unsupported_history", "Inline history has an invalid role");
  return validateLegacyInlineContent(original.content);
}
