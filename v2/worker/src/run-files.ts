import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { imageHeader, imageIntact } from "./lib/image-header.ts";
import { toolImageKey, type ToolImageRef } from "./tool-images.ts";
import { z } from "zod";
import { FILE_LIMITS } from "./lib/limits.ts";
import { CamelFsClient, normalizeRepoPath } from "./camelfs.ts";
import { ApiError, type Env, type RunFile, type StoredRunFile } from "./types.ts";
import type { LegacyInlineBlock } from "./legacy-inline-images.ts";

const runFilesSchema = z.array(z.object({
  path: z.string().transform(normalizeRepoPath).refine(
    (path) => path.split("/").every((part) => part && part !== "." && part !== ".." && !/[\\\x00-\x1f]/.test(part)),
  ),
  commit: z.string().regex(/^[a-f0-9]{64}$/),
  contentType: z.string().toLowerCase().regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/),
})).max(FILE_LIMITS.attachments);

export function parseRunFiles(input: unknown): RunFile[] {
  if (input === undefined) return [];
  const parsed = runFilesSchema.safeParse(input);
  if (!parsed.success) {
    throw new ApiError(400, "invalid_attachments", "Each attachment requires a workspace file path, a commit hash, and a media type");
  }
  return parsed.data;
}

export function isImageAttachment(file: RunFile): boolean {
  return /^image\/(png|jpeg|gif|webp)$/.test(file.contentType);
}

function imageBase64Size(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

function imageHeaderMatches(base64: string, contentType: string): boolean {
  const bytes = atob(base64);
  switch (contentType) {
    case "image/png": return bytes.startsWith("\x89PNG\r\n\x1a\n");
    case "image/jpeg": return bytes.startsWith("\xff\xd8\xff");
    case "image/gif": return bytes.startsWith("GIF87a") || bytes.startsWith("GIF89a");
    case "image/webp": return bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP";
    default: return false;
  }
}

const MAX_RESIZABLE_IMAGE_BYTES = 32 * 1024 * 1024;

async function resizeOversizedAttachmentImage(
  cfs: CamelFsClient,
  lineage: string,
  file: RunFile,
  size: number,
  media: { env: Pick<Env, "MEDIA_BUCKET" | "IMAGES">; tenantId: string },
): Promise<ToolImageRef> {
  if (!media.env.IMAGES || !media.env.MEDIA_BUCKET) {
    throw new ApiError(413, "attachment_size", `Image ${file.path} exceeds the model request image limit`);
  }
  if (size > MAX_RESIZABLE_IMAGE_BYTES) {
    throw new ApiError(413, "attachment_size", `Image ${file.path} exceeds the model request image limit`);
  }
  const read = await cfs.read(lineage, { at: file.commit, path: file.path, limit: size + 1 });
  if (read.commit !== file.commit || read.size !== size || !read.base64) {
    throw new ApiError(422, "attachment_invalid", `Attachment ${file.path} could not be read as an image`);
  }
  const rawBytes = Buffer.from(read.base64, "base64");
  const output = await media.env.IMAGES.input(new Blob([new Uint8Array(rawBytes)]).stream())
    .transform({ width: FILE_LIMITS.requestImageSide, height: FILE_LIMITS.requestImageSide, fit: "scale-down" })
    .output({ format: "image/jpeg", quality: 80, anim: false });
  const response = output.response();
  if (!response.ok) {
    throw new ApiError(413, "attachment_size", `Image ${file.path} exceeds the model request image limit`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const header = imageHeader(bytes);
  if (
    !header ||
    !header.width ||
    !header.height ||
    Math.max(header.width, header.height) > FILE_LIMITS.requestImageSide ||
    bytes.length > FILE_LIMITS.requestImageBytes ||
    !imageIntact(bytes, header.mimeType)
  ) {
    throw new ApiError(413, "attachment_size", `Image ${file.path} exceeds the model request image limit`);
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  const ref: ToolImageRef = {
    digest,
    contentType: header.mimeType,
    size: bytes.length,
    width: header.width,
    height: header.height,
  };
  await media.env.MEDIA_BUCKET.put(toolImageKey(media.tenantId, ref), new Uint8Array(bytes), {
    httpMetadata: { contentType: ref.contentType },
  });
  return ref;
}

export async function verifyRunFiles(
  cfs: CamelFsClient,
  refs: Array<{ lineage: string; file: RunFile }>,
  media?: { env: Pick<Env, "MEDIA_BUCKET" | "IMAGES">; tenantId: string },
): Promise<StoredRunFile[]> {
  if (refs.length > FILE_LIMITS.attachments) {
    throw new ApiError(413, "attachment_count", `A turn accepts up to ${FILE_LIMITS.attachments} attachments`);
  }
  const results: StoredRunFile[] = [];
  let imageBytes = 0;
  for (const { lineage, file } of refs) {
    const { commit, entries } = await cfs.ls(lineage, { at: file.commit, path: file.path });
    const entry = entries.find((entry) => entry.path === file.path && entry.type === "file");
    if (commit !== file.commit || !entry) {
      throw new ApiError(400, "invalid_attachments", `Attachment ${file.path} is missing at the specified commit`);
    }
    let resized: ToolImageRef | undefined;
    if (isImageAttachment(file)) {
      if (entry.size === 0) {
        throw new ApiError(413, "attachment_size", `Image ${file.path} exceeds the model request image limit`);
      }
      const header = await cfs.read(lineage, { at: file.commit, path: file.path, limit: 12 });
      if (header.commit !== file.commit || !header.base64 || !imageHeaderMatches(header.base64, file.contentType)) {
        throw new ApiError(422, "attachment_invalid", `Attachment ${file.path} does not match its image type`);
      }
      if (entry.size > FILE_LIMITS.requestImageBytes || imageBytes + imageBase64Size(entry.size) > FILE_LIMITS.requestImageBase64Bytes) {
        if (!media) {
          throw new ApiError(413, "attachment_size", `Image ${file.path} exceeds the model request image limit`);
        }
        resized = await resizeOversizedAttachmentImage(cfs, lineage, file, entry.size, media);
        imageBytes += imageBase64Size(resized.size);
        if (imageBytes > FILE_LIMITS.requestImageBase64Bytes) {
          throw new ApiError(413, "attachment_size", `Image ${file.path} exceeds the model request image limit`);
        }
      } else {
        imageBytes += imageBase64Size(entry.size);
      }
    }
    results.push({ ...file, lineage, size: entry.size, ...(resized ? { resized } : {}) });
  }
  return results;
}

export interface ModelImage {
  contentType: string;
  base64: string;
  inlineBlockIndex?: number;
}

export async function loadConversationImages(
  cfs: CamelFsClient,
  messages: Array<{ files?: StoredRunFile[]; legacyInlineContent?: LegacyInlineBlock[]; toolImages?: ToolImageRef[] }>,
  imageLimit: number = FILE_LIMITS.requestImages,
  media?: { tenantId: string; bucket?: R2Bucket },
): Promise<Map<number, ModelImage[]>> {
  const images = new Map<number, ModelImage[]>();
  let remaining = FILE_LIMITS.requestImageBase64Bytes;
  let count = 0;
  // Older images outside the provider request budget remain explicit file references in the prompt.
  for (let index = messages.length - 1; index >= 0; index--) {
    const inline = messages[index]?.legacyInlineContent;
    if (inline) {
      for (let blockIndex = inline.length - 1; blockIndex >= 0; blockIndex--) {
        const block = inline[blockIndex]!;
        if (block.type !== "image") continue;
        remaining -= block.data.length;
        if (remaining < 0 || ++count > imageLimit) return images;
        const image = { contentType: block.mimeType, base64: block.data, inlineBlockIndex: blockIndex };
        const atIndex = images.get(index);
        if (atIndex) atIndex.push(image);
        else images.set(index, [image]);
      }
    }
    // Walk newest messages first, while keeping each tool's original image order.
    const toolImages = messages[index]?.toolImages ?? [];
    const selected: ModelImage[] = [];
    let toolBudgetExhausted = false;
    for (const ref of toolImages) {
      const refBase64Size = imageBase64Size(ref.size);
      remaining -= refBase64Size;
      if (remaining < 0 || ++count > imageLimit) {
        toolBudgetExhausted = true;
        break;
      }
      const key = media ? toolImageKey(media.tenantId, ref) : undefined;
      const image = media && key ? await media.bucket?.get(key) : undefined;
      if (!image || image.size !== ref.size) {
        // Restore budget and continue gracefully so a missing/deleted R2 object never bricks future turns.
        // The tool message text already carries the [image W×H] summary placeholder.
        remaining += refBase64Size;
        count--;
        console.warn(JSON.stringify({
          event: "tool_image_missing",
          tenantId: media?.tenantId ?? null,
          key: key ?? null,
          expectedSize: ref.size,
          actualSize: image?.size ?? null,
          width: ref.width,
          height: ref.height,
        }));
        continue;
      }
      selected.push({ contentType: ref.contentType, base64: Buffer.from(await image.arrayBuffer()).toString("base64") });
    }
    if (selected.length) images.set(index, [...(images.get(index) ?? []), ...selected]);
    if (toolBudgetExhausted) return images;
    for (const file of messages[index]?.files ?? []) {
      if (!isImageAttachment(file)) continue;
      if (file.resized) {
        remaining -= imageBase64Size(file.resized.size);
        if (remaining < 0 || ++count > imageLimit) return images;
        const stored = media && await media.bucket?.get(toolImageKey(media.tenantId, file.resized));
        if (!stored || stored.size !== file.resized.size) {
          throw new ApiError(422, "attachment_invalid", `Attachment ${file.path} could not be read as an image`);
        }
        const image = { contentType: file.resized.contentType, base64: Buffer.from(await stored.arrayBuffer()).toString("base64") };
        const atIndex = images.get(index);
        if (atIndex) atIndex.push(image);
        else images.set(index, [image]);
        continue;
      }
      remaining -= imageBase64Size(file.size);
      if (remaining < 0 || ++count > imageLimit) return images;
      const read = await cfs.read(file.lineage, { at: file.commit, path: file.path, limit: file.size + 1 });
      if (read.commit !== file.commit || read.size !== file.size || read.base64?.length !== imageBase64Size(file.size)) {
        throw new ApiError(422, "attachment_invalid", `Attachment ${file.path} could not be read as an image`);
      }
      const image = { contentType: file.contentType, base64: read.base64 };
      const atIndex = images.get(index);
      if (atIndex) atIndex.push(image);
      else images.set(index, [image]);
    }
  }
  return images;
}
