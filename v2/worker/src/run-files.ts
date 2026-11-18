import { z } from "zod";
import { FILE_LIMITS } from "../../../src/limits.ts";
import { CamelFsClient, normalizeRepoPath } from "./camelfs.ts";
import { ApiError, type RunFile, type StoredRunFile } from "./types.ts";

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

export async function verifyRunFiles(
  cfs: CamelFsClient,
  refs: Array<{ lineage: string; file: RunFile }>,
): Promise<StoredRunFile[]> {
  const results: StoredRunFile[] = [];
  let imageBytes = 0;
  for (const { lineage, file } of refs) {
    const { commit, entries } = await cfs.ls(lineage, { at: file.commit, path: file.path });
    const entry = entries.find((entry) => entry.path === file.path && entry.type === "file");
    if (commit !== file.commit || !entry) {
      throw new ApiError(400, "invalid_attachments", `Attachment ${file.path} is missing at the specified commit`);
    }
    if (isImageAttachment(file)) {
      imageBytes += imageBase64Size(entry.size);
      if (entry.size === 0 || entry.size > FILE_LIMITS.requestImageBytes || imageBytes > FILE_LIMITS.requestImageBase64Bytes) {
        throw new ApiError(413, "attachment_size", `Image ${file.path} exceeds the model request image limit`);
      }
    }
    results.push({ ...file, lineage, size: entry.size });
  }
  return results;
}

export interface ModelImage {
  contentType: string;
  base64: string;
}

export async function loadConversationImages(
  cfs: CamelFsClient,
  messages: Array<{ files?: StoredRunFile[] }>,
): Promise<Map<number, ModelImage[]>> {
  const images = new Map<number, ModelImage[]>();
  let remaining = FILE_LIMITS.requestImageBase64Bytes;
  // Older images outside the provider request budget remain explicit file references in the prompt.
  for (let index = messages.length - 1; index >= 0; index--) {
    for (const file of messages[index]?.files ?? []) {
      if (!isImageAttachment(file)) continue;
      remaining -= imageBase64Size(file.size);
      if (remaining < 0) return images;
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
