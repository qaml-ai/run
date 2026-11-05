import { createHash } from "node:crypto";
import { FileError } from "./volume.ts";
import { declaredType, sniffContentType } from "./file-policy.ts";
import { VOLUME_LIMITS } from "./volume-policy.ts";
import type { FileBindings } from "./files.ts";
import { storageFull, storageQuota } from "./storage-quota.ts";
/** Upload with at most one 5 MiB part buffered, including requests without Content-Length. */
export async function uploadFile(
  env: FileBindings,
  tenant: string,
  id: string,
  path: string,
  source: ReadableStream<Uint8Array> | null,
  contentType: string | null,
  expectedVersion?: number,
  maxBytes = VOLUME_LIMITS.fileBytes,
) {
  const quota = await storageQuota(env, tenant);
  if (quota && quota.used >= quota.limit) throw storageFull(quota);
  const v = env.VOLUMES.getByName(`${tenant}:${id}`),
    key = await v.beginUpload(),
    hash = createHash("sha256");
  let size = 0,
    filled = 0,
    part = new Uint8Array(5 * 1024 * 1024),
    upload: R2MultipartUpload | undefined;
  const parts: R2UploadedPart[] = [],
    head: number[] = [];
  const emit = async () => {
    upload ??= await env.BUCKET.createMultipartUpload(key, {
      httpMetadata: {
        contentType:
          declaredType(contentType) ??
          sniffContentType(new Uint8Array(head), path),
      },
    });
    parts.push(
      await upload.uploadPart(parts.length + 1, part.slice(0, filled)),
    );
    filled = 0;
  };
  try {
    if (source)
      for await (const bytes of source) {
        size += bytes.length;
        if (size > Math.min(maxBytes, VOLUME_LIMITS.fileBytes))
          throw new FileError("File exceeds byte limit", 413);
        if (quota && quota.used + size > quota.limit) throw storageFull(quota);
        hash.update(bytes);
        const headCount = Math.min(bytes.length, 512 - head.length);
        for (let i = 0; i < headCount; i++) head.push(bytes[i]);
        let offset = 0;
        while (offset < bytes.length) {
          if (filled === part.length) await emit();
          const length = Math.min(part.length - filled, bytes.length - offset);
          part.set(bytes.subarray(offset, offset + length), filled);
          offset += length;
          filled += length;
        }
      }
    const type =
      declaredType(contentType) ?? sniffContentType(new Uint8Array(head), path);
    if (upload) {
      if (filled) await emit();
      await upload.complete(parts);
    } else
      await env.BUCKET.put(key, part.slice(0, filled), {
        httpMetadata: { contentType: type },
      });
    return await v.commitUpload(
      path,
      key,
      size,
      hash.digest("hex"),
      type,
      expectedVersion,
    );
  } catch (error) {
    if (upload) await upload.abort().catch(() => {});
    throw error;
  }
}
