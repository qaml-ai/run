import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { toolImageKey, type ToolImageRef } from "../tool-images.ts";
import { parseMarker, type ImageReference } from "./image-request-marker.ts";

// Keep Pi's image shape so history exposes the original MIME type on tool
// results. Only server-produced blocks carry this field.
interface StoredPiImage extends ImageContent {
  imageRef: { tenantId: string; digest: string; size: number };
}

const IMAGE_MIME = /^image\/[a-zA-Z0-9.+-]+$/;
const DIGEST = /^[0-9a-f]{64}$/;

export function readStoredPiImage(
  block: ImageContent,
  tenantId: string,
): Omit<ImageReference, "nonce"> | undefined {
  if (!("imageRef" in block)) return;
  const ref = (block as StoredPiImage).imageRef;
  if (
    block.data !== "" || !tenantId || !ref || ref.tenantId !== tenantId ||
    typeof ref.digest !== "string" || !DIGEST.test(ref.digest) ||
    !Number.isSafeInteger(ref.size) || ref.size <= 0 ||
    typeof block.mimeType !== "string" || !IMAGE_MIME.test(block.mimeType)
  ) {
    throw new Error("Invalid stored image reference");
  }
  return { key: toolImageKey(tenantId, ref), size: ref.size, mimeType: block.mimeType };
}

export function storedPiImage(
  tenantId: string,
  ref: Pick<ToolImageRef, "digest" | "size" | "contentType">,
): StoredPiImage {
  return {
    type: "image",
    mimeType: ref.contentType,
    data: "",
    imageRef: { tenantId, digest: ref.digest, size: ref.size },
  };
}

export async function persistPiImage(
  image: ImageContent,
  tenantId: string,
  bucket?: R2Bucket,
): Promise<ImageContent | TextContent> {
  const { data, mimeType } = image;
  if (parseMarker(data)) return { type: "text", text: "[Image omitted: reserved request marker]" };

  // Discard extra fields from untrusted image blocks, including reference metadata.
  if (!bucket || !IMAGE_MIME.test(mimeType)) return { type: "image", data, mimeType };
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length) throw new Error("Image has no data");
  const digest = createHash("sha256").update(bytes).digest("hex");
  await bucket.put(toolImageKey(tenantId, { digest }), bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: mimeType },
  });
  return storedPiImage(tenantId, { digest, size: bytes.length, contentType: mimeType });
}
