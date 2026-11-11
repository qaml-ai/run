import { Buffer } from "node:buffer";
import { declaredType, sniffContentType, validContentType } from "./file-policy.ts";
import { assertStorageWrite } from "./storage-quota.ts";
import { recordNativeFile } from "./tenant-storage.ts";
import { COMMIT_LIMITS, VOLUME_LIMITS } from "./volume-policy.ts";
import { FileError, normalizePath, type CommitFile, type CommitResult, type Volume } from "./volume.ts";
import type { FileBindings } from "./files.ts";

type CommitInput = {
  files?: unknown;
  snapshot?: { name?: string; pinned?: boolean; labels?: Record<string, string> };
};
type FileInput = {
  path?: unknown;
  version?: unknown;
  text?: unknown;
  data?: unknown;
  contentType?: unknown;
  from?: { volume?: unknown; path?: unknown; version?: unknown };
  delete?: unknown;
};

/**
 * POST /v1/volumes/:id/commit: content is stored first (inline bytes uploaded, another volume's files copied into this
 * one's ownership, or reused when this volume already owns them), then the volume checks every version and writes every
 * file in one transaction. Content stored for a commit that conflicts is collected like any unreferenced upload.
 */
export async function commitFiles(
  env: FileBindings,
  tenant: string,
  id: string,
  target: DurableObjectStub<Volume>,
  body: CommitInput,
  open: (id: string) => Promise<DurableObjectStub<Volume>>,
): Promise<Response> {
  if (!Array.isArray(body.files) || !body.files.length || body.files.length > COMMIT_LIMITS.files)
    throw new FileError(`files is a list of 1 to ${COMMIT_LIMITS.files} files`);
  if (body.snapshot !== undefined && (!body.snapshot || typeof body.snapshot !== "object" || Array.isArray(body.snapshot)))
    throw new FileError("snapshot is an object: { name?, pinned?, labels? }");
  const given = (body.files as FileInput[]).map((file) => {
    if (!file || typeof file !== "object") throw new FileError("Each file is an object");
    const path = normalizePath(file.path);
    if (path === "/") throw new FileError("A file needs a name");
    if (!Number.isSafeInteger(file.version) || (file.version as number) < 0)
      throw new FileError(`${path}: version must be a non-negative integer (0: the file must not exist)`);
    const sources = [file.text !== undefined, file.data !== undefined, file.from !== undefined, file.delete === true].filter(Boolean).length;
    if (sources !== 1) throw new FileError(`${path}: give exactly one of text, data, from or delete: true`);
    if (file.text !== undefined && typeof file.text !== "string") throw new FileError(`${path}: text is a string`);
    if (file.data !== undefined && typeof file.data !== "string") throw new FileError(`${path}: data is base64`);
    if (file.contentType !== undefined && !validContentType(file.contentType))
      throw new FileError(`${path}: invalid content type`);
    return { ...file, path, version: file.version as number };
  });
  if (new Set(given.map((f) => f.path)).size !== given.length) throw new FileError("A path is given twice");
  const inline = given.map((f) =>
    typeof f.text === "string" ? Buffer.from(f.text) : typeof f.data === "string" ? Buffer.from(f.data, "base64") : undefined,
  );
  if (inline.reduce((n, bytes) => n + (bytes?.length ?? 0), 0) > COMMIT_LIMITS.inlineBytes)
    throw new FileError("Inline contents exceed 16 MiB", 413);
  // Every source is checked before any byte is stored.
  const sources = new Map<string, DurableObjectStub<Volume>>();
  const located = await Promise.all(given.map(async (file) => {
    if (!file.from) return undefined;
    if (typeof file.from !== "object" || typeof file.from.volume !== "string")
      throw new FileError(`${file.path}: from is { volume, path?, version? }`);
    if (file.from.version !== undefined && (!Number.isSafeInteger(file.from.version) || (file.from.version as number) < 1))
      throw new FileError(`${file.path}: from.version is a positive integer`);
    const volume = file.from.volume;
    if (!sources.has(volume)) sources.set(volume, volume === id ? target : await open(volume));
    const entry = await sources.get(volume)!.stat(file.from.path === undefined ? file.path : normalizePath(file.from.path));
    if (file.from.version !== undefined && entry.version !== file.from.version)
      throw new FileError(`${volume}:${entry.path} is at version ${entry.version}, not ${file.from.version}`, 412);
    return entry;
  }));
  const copyBytes = located.reduce((n, entry) => n + (entry?.size ?? 0), 0);
  if (copyBytes > COMMIT_LIMITS.copyBytes) throw new FileError("Copied files exceed 1 GiB in one commit", 413);
  const own = `files/${encodeURIComponent(tenant)}/${encodeURIComponent(id)}/`;
  const files: CommitFile[] = [];
  for (const [index, file] of given.entries()) {
    const bytes = inline[index], entry = located[index];
    if (file.delete === true) {
      files.push({ path: file.path, version: file.version });
    } else if (bytes) {
      await assertStorageWrite(env, tenant, bytes.byteLength);
      const contentType = declaredType(file.contentType as string | undefined) ?? sniffContentType(bytes.subarray(0, 512), file.path);
      const stored = await target.storeDetached(bytes, contentType);
      files.push({ path: file.path, version: file.version, key: stored.key, size: bytes.byteLength, sha256: stored.key.split("/").at(-1)!, contentType });
    } else if (entry) {
      const sha256 = entry.sha256 ?? entry.key.split("/").at(-1)!;
      const contentType = declaredType(file.contentType as string | undefined) ?? entry.contentType;
      if (entry.key.startsWith(own)) {
        // This volume's own blob (a fork's unchanged base): referred to again, not copied.
        files.push({ path: file.path, version: file.version, key: entry.key, size: entry.size, sha256, contentType });
        continue;
      }
      if (entry.size > VOLUME_LIMITS.fileBytes) throw new FileError("File exceeds byte limit", 413);
      await assertStorageWrite(env, tenant, entry.size);
      const object = await env.BUCKET.get(entry.key);
      if (!object) throw new FileError("Source object missing", 503);
      const key = await target.beginUpload();
      await env.BUCKET.put(key, object.body, { httpMetadata: { contentType } });
      await recordNativeFile(env, tenant, key, object.size);
      files.push({ path: file.path, version: file.version, key, size: entry.size, sha256, contentType });
    }
  }
  const result: CommitResult = await target.commit(files, body.snapshot);
  if ("conflicts" in result)
    return Response.json(
      {
        error: `${result.conflicts.length} of the files changed since the versions given; nothing was written`,
        code: "COMMIT_CONFLICT",
        conflicts: result.conflicts,
      },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  return Response.json(
    {
      seq: result.seq,
      files: result.files.map(({ key: _key, sha256: _sha256, ...file }) => file),
      removed: result.removed,
      ...(result.snapshot ? { snapshot: result.snapshot } : {}),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
