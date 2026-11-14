import { Buffer } from "node:buffer";
import { tar } from "../../../src/tar.ts";
import { HttpError } from "./errors.ts";
import type { SecurityEnv } from "./security-services.ts";
import { createVolume } from "./file-mounts.ts";
import {
  declaredType,
  sniffContentType,
  downloadHeaders,
  safeName,
} from "./file-policy.ts";
import { uploadFile } from "./file-upload.ts";
import { commitFiles } from "./volume-commit.ts";
import { assertStorageWrite } from "./storage-quota.ts";
import type { NativeStorageBindings } from "./tenant-storage.ts";
import { signVolumeLink, verifyVolumeLink } from "./file-links.ts";
import { ARCHIVE_LIMITS, READ_ALL_LIMITS } from "./volume-policy.ts";
import { withSql } from "./postgres.ts";
import { withMoneyIdempotency } from "./money-idempotency.ts";
import { digest, FileError, normalizePath, type Volume, type FileEntry } from "./volume.ts";
import {
  boundedBytes,
  imageInputs,
  signFile,
  storeImage,
  type ImageBindings,
  type ImageRef,
} from "./images.ts";
import { handleSignedFileRequest as handleSignedImageRequest } from "./images.ts";
export async function handleSignedFileRequest(
  request: Request,
  env: FileBindings,
): Promise<Response | null> {
  try {
    const grant = verifyVolumeLink(request, env);
    if (grant) {
      if (grant.method === "PUT" && grant.contentType) {
        const headers = new Headers(request.headers);
        headers.set("content-type", grant.contentType);
        request = new Request(request, { headers });
      }
      return await fileRequest(
        request,
        env,
        grant.tenant,
        grant.volume,
        grant.path,
        false,
        grant.maxBytes,
        "link",
      );
    }
    return handleSignedImageRequest(request, env);
  } catch (error) {
    return fileFailure(error);
  }
}
export interface FileBindings extends ImageBindings, SecurityEnv, NativeStorageBindings {
  VOLUMES: DurableObjectNamespace<Volume>;
  HYPERDRIVE: {
    connectionString: string;
  };
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
async function input(request: Request, limit = 64 * 1024) {
  const bytes = await boundedBytes(request.body, limit);
  try {
    const value: unknown = bytes.length
      ? JSON.parse(new TextDecoder().decode(bytes))
      : {};
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("object required");
    return value;
  } catch {
    throw new FileError("Expected a JSON object");
  }
}
export const stub = (env: FileBindings, tenant: string, id: string) =>
  env.VOLUMES.getByName(`${tenant}:${id}`);
export async function volume(
  env: FileBindings,
  tenant: string,
  id: string,
  privateAgent = false,
) {
  if (!privateAgent) {
    const row = await withSql(
      env,
      async (sql) =>
        (
          await sql.query<{
            name: string;
            created_at: number;
          }>(
            "SELECT name,created_at FROM volumes WHERE id=$1 AND tenant=$2 AND deleted_at IS NULL",
            [id, tenant],
          )
        ).rows[0],
    );
    if (!row) throw new FileError("Unknown volume", 404);
    const v = stub(env, tenant, id);
    await v.initialize(tenant, id, row.name, row.created_at);
    return v;
  }
  const v = stub(env, tenant, id);
  await v.initialize(tenant, id, "Private agent files");
  return v;
}
function version(request: Request) {
  if (request.headers.get("if-none-match") === "*") return 0;
  const header = request.headers.get("if-match");
  if (header === null) return undefined;
  const n = Number(header.replace(/^W\//, "").replaceAll('"', ""));
  if (!Number.isSafeInteger(n) || n < 0)
    throw new FileError("Invalid file version");
  return n;
}
async function fileRequest(
  request: Request,
  env: FileBindings,
  tenant: string,
  id: string,
  path: string,
  privateAgent = false,
  maxBytes = 256 * 1024 * 1024,
  by?: string,
): Promise<Response> {
  const v = await volume(env, tenant, id, privateAgent);
  path = normalizePath(path);
  if (request.method === "PUT") {
    const { key, sha256, ...file } = await uploadFile(
      env,
      tenant,
      id,
      path,
      request.body,
      request.headers.get("content-type"),
      version(request),
      maxBytes,
    );
    return json({ ...file, ...(by ? { by } : {}) }, 201);
  }
  if (request.method === "DELETE")
    return json(await v.remove(path, version(request)));
  if (request.method === "GET") {
    const file = await v.stat(
      path,
      new URL(request.url).searchParams.get("snapshot") ?? undefined,
    );
    if (file.size > maxBytes) throw new FileError("File exceeds the link size limit", 413);
    const headers: Record<string, string> = {
      ...downloadHeaders(file.contentType, file.path.split("/").at(-1)!),
      etag: `"${file.version}"`,
      "x-file-version": String(file.version),
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
    };
    const range = request.headers.get("range");
    if (!range) {
      const object = await env.BUCKET.get(file.key);
      if (!object) throw new FileError("File object missing", 503);
      headers["content-length"] = String(file.size);
      return new Response(object.body, { headers });
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match || (!match[1] && !match[2]))
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${file.size}` },
      });
    const start = match[1]
        ? Number(match[1])
        : Math.max(0, file.size - Number(match[2])),
      end = match[1]
        ? match[2]
          ? Math.min(Number(match[2]), file.size - 1)
          : file.size - 1
        : file.size - 1;
    if (start > end || start >= file.size)
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${file.size}` },
      });
    headers["content-range"] = `bytes ${start}-${end}/${file.size}`;
    const object = await env.BUCKET.get(file.key, {
      range: { offset: start, length: end - start + 1 },
    });
    if (!object) throw new FileError("File object missing", 503);
    headers["content-length"] = String(end - start + 1);
    return new Response(object.body, { status: 206, headers });
  }
  throw new FileError("Method not allowed", 405);
}
const fileFailure = (error: unknown) => {
  const message =
      error instanceof Error ? error.message : "File operation failed",
    coded = /FILE_(\d{3}):([^]*)/.exec(message);
  return json(
    {
      error:
        coded?.[2] ??
        (error instanceof HttpError ? error.message : "File operation failed"),
      ...(error instanceof HttpError ? { code: error.code, ...error.details } : {}),
    },
    coded ? Number(coded[1]) : error instanceof HttpError ? error.status : 500,
  );
};
export async function handleFileRequest(
  request: Request,
  env: FileBindings,
  principal: {
    tenantId: string;
  },
  path = new URL(request.url).pathname,
): Promise<Response | null> {
  if (path.startsWith("/v1/volumes") && request.method === "POST" && request.headers.has("Idempotency-Key")) {
    return await withMoneyIdempotency(request, env, principal.tenantId, async request =>
      await fileRoute(request, env, principal, path) ?? undefined) ?? null;
  }
  return fileRoute(request, env, principal, path);
}

async function fileRoute(
  request: Request,
  env: FileBindings,
  principal: { tenantId: string },
  path: string,
): Promise<Response | null> {
  const tenant = principal.tenantId,
    url = new URL(request.url);
  if (!path.startsWith("/v1/volumes") && !path.startsWith("/v1/images"))
    return null;
  try {
    if (path === "/v1/images" && request.method === "POST")
      return json(
        await storeImage(
          env,
          tenant,
          await boundedBytes(request.body, 32 * 1024 * 1024),
        ),
        201,
      );
    if (path === "/v1/images/prepare" && request.method === "POST") {
      const body = (await input(request)) as {
        images: ImageRef[];
        urlSupport?: boolean;
      };
      if (!Array.isArray(body.images))
        throw new FileError("images must be references");
      return json({
        content: await imageInputs(
          env,
          tenant,
          body.images,
          url.origin,
          body.urlSupport === true,
        ),
      });
    }
    if (path === "/v1/volumes") {
      if (request.method === "GET") {
        const ids = url.searchParams.get("ids");
        if (ids !== null) {
          const wanted = [
            ...new Set(
              ids
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            ),
          ];
          if (wanted.length > 50)
            throw new FileError("ids names at most 50 volumes");
          return json(
            await Promise.all(
              wanted.map(async (id) => (await volume(env, tenant, id)).info()),
            ),
          );
        }
        return json(
          await withSql(
            env,
            async (sql) =>
              (
                await sql.query(
                  'SELECT id,name,created_at AS "createdAt" FROM volumes WHERE tenant=$1 AND deleted_at IS NULL ORDER BY created_at',
                  [tenant],
                )
              ).rows,
          ),
        );
      }
      if (request.method === "POST")
        return json(await createVolume(env, tenant, await input(request)), 201);
    }
    const match = /^\/v1\/volumes\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (!match) throw new FileError("Unknown file route", 404);
    const [, id, tail = ""] = match;
    // Local tests only: reach a volume's collection and pins directly, deleted volumes too.
    if (tail.startsWith("__") && (env as FileBindings & { TEST_MODE?: string }).TEST_MODE === "1") {
      const raw = stub(env, tenant, id);
      if (tail === "__gc" && request.method === "POST")
        return json(await raw.collectGarbage(Date.now() + Math.max(0, Math.min(2 * 86400_000, Number(url.searchParams.get("advance") ?? 0)))));
      if (tail === "__alarm" && request.method === "POST") return json(await raw.testRunAlarm());
      if (tail === "__alarm" && request.method === "GET") return json(await raw.testAlarm());
      if (tail === "__fail-unpin" && request.method === "POST") return json(await raw.testFailUnpin(Number(url.searchParams.get("times") ?? 1)) ?? {});
      if (tail === "__pin" && request.method === "POST") {
        const ttl = url.searchParams.get("ttl");
        await raw.testPinFiles(url.searchParams.get("owner")!, ttl ? Date.now() + Number(ttl) : undefined);
        return json({});
      }
      if (tail === "__pin" && request.method === "DELETE") return json((await raw.unpin(url.searchParams.get("owner")!)) ?? {});
      if (tail === "__forwarded" && request.method === "GET") return json(await raw.testForwardedPins());
    }
    const v = await volume(env, tenant, id);
    if (!tail && request.method === "GET") return json(await v.info());
    if (!tail && request.method === "DELETE") {
      await withSql(env, (sql) =>
        sql.query(
          "UPDATE volumes SET deleted_at=$3 WHERE id=$1 AND tenant=$2",
          [id, tenant, Date.now()],
        ),
      );
      return json(await v.delete());
    }
    if (tail.startsWith("files/"))
      return await fileRequest(
        request,
        env,
        tenant,
        id,
        decodeURIComponent(tail.slice(5)),
      );
    if (tail === "files" && request.method === "GET") {
      const readSet = await v.readSet(
        url.searchParams.get("prefix") ?? "/",
        url.searchParams.get("snapshot") ?? undefined,
        url.searchParams.get("glob") ?? undefined,
      );
      const entries = readSet.files;
      const after = url.searchParams.get("after") ?? "",
        limit = Math.min(
          1000,
          Math.max(1, Number(url.searchParams.get("limit") ?? 1000)),
        );
      if (!Number.isInteger(limit))
        throw new FileError("Invalid listing limit");
      const selected = entries.filter((f) => f.path > after).slice(0, limit),
        files = selected.map(({ key, sha256, ...f }) => f);
      if (url.searchParams.get("content") === "true") {
        let total = 0;
        const contents = [];
        if (entries.length > READ_ALL_LIMITS.files)
          throw new FileError("At most 1000 files in one read", 413);
        for (const entry of entries) {
          total += entry.size;
          if (total > 16 * 1024 * 1024)
            throw new FileError("Combined files exceed 16 MiB", 413);
          const object = await env.BUCKET.get(entry.key);
          if (!object) throw new FileError("File object missing", 503);
          const bytes = await boundedBytes(object.body, entry.size);
          if (
            bytes.length !== entry.size ||
            (await digest(bytes)) !==
              (entry.sha256 ?? entry.key.split("/").at(-1))
          )
            throw new FileError("File integrity check failed", 503);
          let text: string | undefined;
          try {
            if (bytes.subarray(0, 8000).includes(0)) throw new Error("binary");
            text = new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: false,
            }).decode(bytes);
          } catch {}
          contents.push({
            path: entry.path,
            version: entry.version,
            size: entry.size,
            contentType: entry.contentType,
            sha256: await digest(bytes),
            ...(text === undefined
              ? { data: Buffer.from(bytes).toString("base64") }
              : { text }),
          });
        }
        return json({
          files: contents,
          seq: readSet.seq,
          ...(readSet.snapshot ? { snapshot: readSet.snapshot } : {}),
        });
      }
      return json({
        files,
        ...(entries.filter((f) => f.path > after).length > limit
          ? { next: selected.at(-1)?.path }
          : {}),
      });
    }
    if (tail === "changes" && request.method === "GET")
      return json(
        await v.changes(
          Number(url.searchParams.get("since") ?? 0),
          url.searchParams.get("prefix") ?? "/",
        ),
      );
    if (tail === "snapshots" && request.method === "GET") {
      const labels = Object.fromEntries(
        url.searchParams.getAll("label").map((label) => {
          const colon = label.indexOf(":");
          if (colon < 1) throw new FileError("label is key:value");
          return [label.slice(0, colon), label.slice(colon + 1)];
        }),
      );
      return json(await v.snapshots(labels));
    }
    const snapshotMatch = /^snapshots\/([^/]+)$/.exec(tail);
    if (snapshotMatch && request.method === "PATCH")
      return json(
        await v.updateSnapshot(snapshotMatch[1], await input(request)),
      );
    if (snapshotMatch && request.method === "DELETE")
      return json(
        await v.deleteSnapshot(
          snapshotMatch[1],
          url.searchParams.get("force") === "true",
        ),
      );
    if (tail === "archive" && request.method === "GET") {
      const root = normalizePath(url.searchParams.get("path") ?? "/");
      const at = await v.readSet(
        root,
        url.searchParams.get("snapshot") ?? undefined,
        url.searchParams.get("glob") ?? undefined,
      );
      if (
        at.files.length > ARCHIVE_LIMITS.files ||
        at.files.reduce((sum, file) => sum + file.size, 0) >
          ARCHIVE_LIMITS.bytes
      )
        throw new FileError("Archive exceeds 10000 files or 1 GiB", 413);
      const pin = "archive:" + crypto.randomUUID();
      await v.pin(
        pin,
        at.files.map((f) => f.key),
        Date.now() + 86400_000,
      );
      const archive = tar(
        at.files.map((file) => ({
          name:
            root === "/"
              ? file.path.slice(1)
              : file.path.slice(root.length + 1),
          size: file.size,
          mtime: file.updatedAt,
          stream: async function* () {
            const object = await env.BUCKET.get(file.key);
            if (!object) throw new FileError("File object missing", 503);
            for await (const bytes of object.body) yield bytes;
          },
        })),
      );
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await archive.next();
            if (next.done) {
              controller.close();
              await v.unpin(pin);
            } else controller.enqueue(next.value);
          } catch (error) {
            controller.error(error);
            await v.unpin(pin);
          }
        },
        async cancel() {
          await archive.return(undefined);
          await v.unpin(pin);
        },
      });
      return new Response(stream.pipeThrough(new CompressionStream("gzip")), {
        headers: {
          "content-type": "application/gzip",
          "content-disposition": `attachment; filename="${url.searchParams.get("snapshot") ?? id}.tar.gz"`,
          "x-volume-seq": String(at.seq),
          "cache-control": "no-store",
        },
      });
    }
    if (tail === "fork" && request.method === "POST") {
      const options = (await input(request)) as {
        name?: string;
        snapshot?: string;
      };
      const at = await v.readSet("/", options.snapshot),
        info = await v.info();
      const created = await createVolume(env, tenant, {
        name: options.name ?? `${info.name} (fork)`,
      });
      // Metadata only: the fork shares the content, pinned for as long as the fork lives (Volume.seed). Every key read
      // here is held by the source now, and an unheld blob is kept for a day before it is collected, so the fork's pins
      // land well inside that.
      return json(
        await stub(env, tenant, created.id!).seed(at.files, {
          volume: id,
          ...(options.snapshot ? { snapshot: options.snapshot } : {}),
          seq: at.seq,
        }),
        201,
      );
    }
    if (tail === "commit" && request.method === "POST")
      return await commitFiles(
        env,
        tenant,
        id,
        v,
        (await input(request, 24 * 1024 * 1024)) as Parameters<typeof commitFiles>[4],
        (source) => volume(env, tenant, source),
      );
    if (tail === "snapshots" && request.method === "POST") {
      const options = (await input(request, 24 * 1024 * 1024)) as {
        name?: string;
        pinned?: boolean;
        labels?: Record<string, string>;
        files?: unknown;
      };
      let given: Awaited<ReturnType<typeof v.readSet>>["files"] | undefined;
      let contents:
        { path: string; size: number; sha256: string }[] | undefined;
      if (options.files !== undefined) {
        if (
          !options.files ||
          typeof options.files !== "object" ||
          Array.isArray(options.files)
        )
          throw new FileError(
            "files is an object of path to text, or to {data} in base64",
          );
        const all = Object.entries(options.files);
        if (all.length > 1000) throw new FileError("At most 1000 files", 413);
        const decoded = all.map(([path, value]) => {
          const normal = normalizePath(path);
          if (normal === "/") throw new FileError("A file needs a name");
          if (typeof value === "string")
            return {
              path: normal,
              bytes: Buffer.from(value),
              contentType: "text/plain; charset=utf-8",
            };
          if (
            !value ||
            typeof value !== "object" ||
            typeof value.data !== "string"
          )
            throw new FileError("File must be text or {data}");
          return {
            path: normal,
            bytes: Buffer.from(value.data, "base64"),
            contentType: value.contentType ?? "application/octet-stream",
          };
        });
        if (new Set(decoded.map((f) => f.path)).size !== decoded.length)
          throw new FileError("A path is given twice");
        if (
          decoded.reduce((n, f) => n + f.bytes.length, 0) >
          READ_ALL_LIMITS.bytes
        )
          throw new FileError("Snapshot contents exceed 16 MiB", 413);
        given = [];
        contents = [];
        for (const file of decoded) {
          await assertStorageWrite(env, tenant, file.bytes.byteLength);
          const stored = await v.storeDetached(file.bytes, file.contentType);
          given.push({ ...stored, path: file.path, version: 0 });
          contents.push({
            path: file.path,
            size: file.bytes.length,
            sha256: await digest(file.bytes),
          });
        }
      }
      return json(
        {
          ...(await v.snapshot(options.name, {
            pinned: options.pinned,
            labels: options.labels,
            given,
          })),
          ...(contents ? { contents } : {}),
        },
        201,
      );
    }
    if (tail === "restore" && request.method === "POST") {
      const body = (await input(request)) as {
        snapshot: string;
      };
      return json(await v.restore(body.snapshot));
    }
    if (tail === "links" && request.method === "POST") {
      const body = (await input(request)) as {
        path: string;
        expiresIn?: number;
        method?: string;
      };
      return json(
        signVolumeLink(env, url.origin, tenant, id, body as never),
        201,
      );
    }
    throw new FileError("Unknown file route", 404);
  } catch (error) {
    return fileFailure(error);
  }
}
export type PresentedVolumeFile = {
  type: "file";
  path: string;
  volume: string;
  version: number;
  size: number;
  contentType: string;
  key: string;
  caption?: string;
};
export type WrittenVolumeFile = Pick<FileEntry, "path" | "version" | "size" | "contentType">;
export type { Mount } from "./repos/mounts.ts";
export { handleAgentFileRequest, handleAgentFilesRoute } from "./repos/agent-files.ts";
export type { PresentedRepoFile, WrittenRepoFile } from "./repos/agent-files.ts";
