import { Buffer } from "node:buffer";
import { tar } from "../../../src/tar.ts";
import { HttpError } from "./errors.ts";
import type { SecurityEnv } from "./security-services.ts";
import { createVolume, workspaceId } from "./file-mounts.ts";
import {
  declaredType,
  sniffContentType,
  downloadHeaders,
  safeName,
} from "./file-policy.ts";
import { uploadFile } from "./file-upload.ts";
import { assertStorageWrite } from "./storage-quota.ts";
import type { NativeStorageBindings } from "./tenant-storage.ts";
import type { FileVersions } from "./file-versions.ts";
import { signVolumeLink, verifyVolumeLink } from "./file-links.ts";
import { ARCHIVE_LIMITS, READ_ALL_LIMITS } from "./volume-policy.ts";
import { defineTool } from "@earendil-works/pi-durable";
import { obj, opt, str, arr, bool, int } from "@earendil-works/pi-schema";
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
export interface Mount {
  volumeId: string;
  path: string;
  mode: "ro" | "rw";
  subpath?: string;
  notify?: boolean;
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
export async function handleAgentFileRequest(
  request: Request,
  env: FileBindings,
  tenant: string,
  agentId: string,
  path: string,
  mounts: Mount[] = [],
): Promise<Response> {
  try {
    path = normalizePath(path);
    const mount = [...mounts]
      .sort((a, b) => b.path.length - a.path.length)
      .find((m) => path === m.path || path.startsWith(m.path + "/"));
    if (mount) {
      if (request.method !== "GET" && mount.mode !== "rw")
        throw new FileError("Mount is read-only", 403);
      return await fileRequest(
        request,
        env,
        tenant,
        mount.volumeId,
        normalizePath(
          (mount.subpath ?? "/") + "/" + path.slice(mount.path.length),
        ),
      );
    }
    throw new FileError("Path is not inside a mount", 403);
  } catch (error) {
    return fileFailure(error);
  }
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
    const [, id, tail = ""] = match,
      v = await volume(env, tenant, id);
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
      const pin = "fork:" + created.id;
      await v.pin(
        pin,
        at.files.map((f) => f.key),
        Date.now() + 86400_000,
      );
      try {
        return json(
          await stub(env, tenant, created.id!).seed(at.files, {
            volume: id,
            ...(options.snapshot ? { snapshot: options.snapshot } : {}),
            seq: at.seq,
          }),
          201,
        );
      } finally {
        await v.unpin(pin);
      }
    }
    if (
      tail === "__gc" &&
      request.method === "POST" &&
      (env as FileBindings & { TEST_MODE?: string }).TEST_MODE === "1"
    )
      return json(
        await v.collectGarbage(
          Date.now() +
            Math.max(
              0,
              Math.min(
                2 * 86400_000,
                Number(url.searchParams.get("advance") ?? 0),
              ),
            ),
        ),
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
export async function handleAgentFilesRoute(
  request: Request,
  env: FileBindings,
  tenant: string,
  agent: string,
  mounts: Mount[],
  path = new URL(request.url).pathname,
): Promise<Response | null> {
  if (path !== "/files" && path !== "/links" && !path.startsWith("/uploads/")) return null;
  try {
    const url = new URL(request.url);
    if (path.startsWith("/uploads/")) {
      if (request.method !== "PUT") throw new FileError("Method not allowed", 405);
      const upload = /^\/uploads\/([^/]+)\/([^/]+)$/.exec(path);
      if (!upload) throw new FileError("Invalid upload path");
      const requestId = decodeURIComponent(upload[1]);
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) throw new FileError("Invalid request id");
      const own = await workspaceId(agent);
      const mount = mounts.find(m => m.volumeId === own && m.mode === "rw") ?? mounts.find(m => m.path === "/workspace" && m.mode === "rw") ?? mounts.find(m => m.mode === "rw");
      if (!mount) throw new FileError("Attaching files needs a writable mount, like the default /workspace");
      const relative = `/uploads/${requestId}/${safeName(decodeURIComponent(upload[2]))}`;
      await volume(env, tenant, mount.volumeId);
      const { key, sha256, ...file } = await uploadFile(env, tenant, mount.volumeId, normalizePath((mount.subpath ?? "/") + relative), request.body, request.headers.get("content-type"));
      return json({ ...file, path: mount.path + relative, by: agent }, 201);
    }
    const inputBody =
      path === "/links"
        ? ((await input(request)) as {
            path: string;
            method?: "GET" | "PUT";
            expiresIn?: number;
            maxBytes?: number;
            contentType?: string;
          })
        : undefined;
    const asked =
      inputBody?.path ?? url.searchParams.get("path") ?? mounts[0]?.path;
    if (typeof asked !== "string")
      throw new FileError("This agent has no volumes mounted");
    const absolute = normalizePath(
      asked.startsWith("/") ? asked : (mounts[0]?.path ?? "") + "/" + asked,
    );
    const mount = mounts.find(
      (m) => absolute === m.path || absolute.startsWith(m.path + "/"),
    );
    if (!mount) throw new FileError("Path is not inside a mount", 400);
    const inside = normalizePath(
      (mount.subpath ?? "/") + "/" + absolute.slice(mount.path.length),
    );
    if (path === "/links") {
      if (request.method !== "POST")
        throw new FileError("Method not allowed", 405);
      if (inputBody?.method === "PUT" && mount.mode !== "rw")
        throw new FileError("Mount is read-only", 403);
      const { tenant: _tenant, volume: _volume, ...link } = signVolumeLink(env, url.origin, tenant, mount.volumeId, {
          ...inputBody!,
          path: inside,
        });
      return json({ ...link, path: absolute }, 201);
    }
    if (request.method !== "GET")
      throw new FileError("Method not allowed", 405);
    const v = await volume(env, tenant, mount.volumeId),
      files = await v.list(
        inside,
        undefined,
        url.searchParams.get("glob") ?? undefined,
      );
    const after = url.searchParams.get("after") ?? "",
      limit = Math.max(
        1,
        Math.min(1000, Number(url.searchParams.get("limit") ?? 1000)),
      );
    if (!Number.isInteger(limit)) throw new FileError("Invalid limit");
    const show = (path: string) =>
      mount.path +
      ((mount.subpath ?? "/") === "/"
        ? path
        : path.slice(mount.subpath!.length));
    const matches = files.filter((file) => show(file.path) > after);
    return json({
      files: matches.slice(0, limit).map(({ key, sha256, ...file }) => ({
        ...file,
        path: show(file.path),
      })),
      ...(matches.length > limit
        ? { next: show(matches[limit - 1].path) }
        : {}),
    });
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
/** Tools and HTTP share the same files; only explicit Linux computers have a separate filesystem. */
export function volumeTools(
  env: FileBindings,
  tenant: string,
  agentId: string,
  getMounts: () => Promise<Mount[]> = async () => [
    { volumeId: `agent:${agentId}`, path: "/workspace", mode: "rw" },
  ],
  onPresent?: (file: PresentedVolumeFile, volumePath: string) => Promise<void>,
  onWrite?: (file: WrittenVolumeFile) => Promise<void>,
  seen?: FileVersions,
) {
  const target = async (raw: string, write = false) => {
    const mounts = await getMounts();
    if (!mounts.length)
      throw new FileError("This agent has no volumes mounted");
    const path = normalizePath(
      raw.startsWith("/") ? raw : mounts[0].path + "/" + raw,
    );
    const mount = [...mounts]
      .sort((a, b) => b.path.length - a.path.length)
      .find((m) => path === m.path || path.startsWith(m.path + "/"));
    if (!mount) throw new FileError(`${path} is not inside a mount`);
    if (write && mount.mode !== "rw")
      throw new FileError("Mount is read-only", 403);
    const base = mount.subpath ?? "/";
    return {
      v: await volume(
        env,
        tenant,
        mount.volumeId,
        mount.volumeId.startsWith("agent:"),
      ),
      path: normalizePath(base + "/" + path.slice(mount.path.length)),
      mount,
      show: (p: string) =>
        mount.path +
        (base === "/" ? (p === "/" ? "" : p) : p.slice(base.length)),
    };
  };
  const output = (value: unknown) => ({
    output: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    ],
  });
  const seenKey = (target: { mount: Mount; path: string }) => `${target.mount.volumeId}:${target.path}`;
  const stale = (target: { path: string; show(path: string): string }) =>
    new FileError(`${target.show(target.path)} changed since you last read it; read it again, then retry against its current content`, 412);
  const guard = async <T>(target: { path: string; show(path: string): string }, run: () => Promise<T>): Promise<T> => {
    try { return await run(); }
    catch (error) {
      if ((error as { status?: number }).status === 412 || /FILE_412:/.test(String(error))) throw stale(target);
      throw error;
    }
  };
  return [
    defineTool({
      name: "read",
      description:
        "Read UTF-8 text from a persistent file in /workspace or a mounted volume.",
      replay: "safe",
      parameters: obj({
        path: str(),
        offset: opt(int()),
        limit: opt(int()),
        encoding: opt(str()),
        length: opt(int()),
      }),
      async execute({ path, offset, limit, encoding, length }) {
        const t = await target(path),
          entry = await t.v.stat(t.path);
        if (entry.size > 1024 * 1024)
          throw new FileError("Tool file exceeds 1 MiB", 413);
        const { file, bytes } = await t.v.read(t.path, undefined, 1024 * 1024);
        seen?.remember(seenKey(t), file.version);
        if (encoding === "base64") {
          const start = offset ?? 0,
            end = Math.min(bytes.length, start + (length ?? 16384));
          if (start < 0 || start > bytes.length)
            throw new FileError("Invalid offset");
          return output({
            path,
            size: file.size,
            contentType: file.contentType,
            offset: start,
            data: Buffer.from(bytes.subarray(start, end)).toString("base64"),
            ...(end < bytes.length ? { nextOffset: end } : {}),
          });
        }
        const lines = new TextDecoder().decode(bytes).split("\n"),
          start = (offset ?? 1) - 1,
          count = limit ?? 200;
        if (start < 0 || count < 1) throw new FileError("Invalid line window");
        const text = lines.slice(start, start + count).join("\n");
        return output(
          text +
            (start + count < lines.length
              ? `\n[Continue at line ${start + count + 1}]`
              : ""),
        );
      },
    }),
    defineTool({
      name: "write",
      description:
        "Write UTF-8 text to a persistent file in /workspace or a writable mounted volume.",
      replay: "unsafe",
      parameters: obj({
        path: str(),
        content: opt(str()),
        text: opt(str()),
        encoding: opt(str()),
        contentType: opt(str()),
      }),
      async execute({ path, content, text, encoding, contentType }) {
        if (content === undefined && text === undefined)
          throw new FileError("content is required");
        const t = await target(path, true);
        const bytes = encoding === "base64"
          ? Buffer.from(content ?? text!, "base64")
          : new TextEncoder().encode(content ?? text);
        await assertStorageWrite(env, tenant, bytes.byteLength);
        const entry = await guard(t, () => t.v.write(
          t.path,
          bytes,
          declaredType(contentType) ??
            sniffContentType(
              new TextEncoder().encode(content ?? text).subarray(0, 512),
              t.path,
            ),
          seen?.get(seenKey(t)),
        ));
        seen?.remember(seenKey(t), entry.version);
        await onWrite?.({ path: t.show(entry.path), version: entry.version, size: entry.size, contentType: entry.contentType });
        return { output: [{ type: "text", text: JSON.stringify(entry) }] };
      },
    }),
    defineTool({
      name: "ls",
      description:
        "List persistent files under a /workspace or mounted directory.",
      replay: "safe",
      parameters: obj({ path: opt(str()) }),
      async execute({ path }) {
        if (path === "/")
          return output({
            path: "/",
            entries: (await getMounts()).map((m) => ({
              name: m.path.slice(1),
              type: "directory",
              mode: m.mode,
            })),
          });
        const t = await target(
          path ?? (await getMounts())[0]?.path ?? "/workspace",
        );
        const files = await t.v.list(t.path),
          entries = new Map<string, unknown>();
        for (const file of files) {
          const rest = file.path.slice(t.path === "/" ? 1 : t.path.length + 1),
            name = rest.split("/")[0];
          if (!name) continue;
          entries.set(
            name,
            rest.includes("/")
              ? { name, type: "directory" }
              : {
                  name,
                  type: "file",
                  size: file.size,
                  contentType: file.contentType,
                },
          );
        }
        return output({ path: t.show(t.path), entries: [...entries.values()] });
      },
    }),
    defineTool({
      name: "present_file",
      description:
        "Hand a file you made to the user with your reply. Writing alone does not share it.",
      replay: "unsafe",
      parameters: obj({ path: str(), caption: opt(str()) }),
      async execute({ path, caption }) {
        const t = await target(path),
          file = await t.v.stat(t.path);
        if (caption && caption.length > 1000)
          throw new FileError("Caption exceeds 1000 characters");
        await t.v.pin(`agent:${agentId}`, [file.key]);
        const presented: PresentedVolumeFile = {
          type: "file",
          path: t.show(t.path),
          volume: t.mount.volumeId,
          version: file.version,
          size: file.size,
          contentType: file.contentType,
          key: file.key,
          ...(caption ? { caption } : {}),
        };
        await onPresent?.(presented, t.path);
        return output({
          path: presented.path,
          size: file.size,
          contentType: file.contentType,
          presented: true,
        });
      },
    }),
    defineTool({
      name: "edit",
      description:
        "Replace exact text in a UTF-8 file. Each oldText must occur exactly once.",
      replay: "unsafe",
      parameters: obj({
        path: str(),
        edits: arr(obj({ oldText: str(), newText: str() })),
      }),
      async execute({ path, edits }) {
        const t = await target(path, true),
          { file, bytes } = await t.v.read(t.path, undefined, 1024 * 1024);
        const expected = seen?.get(seenKey(t));
        if (expected !== undefined && expected !== file.version) throw stale(t);
        seen?.remember(seenKey(t), file.version);
        if (bytes.length > 1024 * 1024)
          throw new FileError("Tool file exceeds 1 MiB", 413);
        let text = new TextDecoder().decode(bytes);
        for (const edit of edits) {
          if (!edit.oldText || text.split(edit.oldText).length !== 2)
            throw new FileError("oldText must occur exactly once");
          text = text.replace(edit.oldText, edit.newText);
        }
        const edited = new TextEncoder().encode(text);
        await assertStorageWrite(env, tenant, edited.byteLength);
        const written = await guard(t, () => t.v.write(
            t.path,
            edited,
            file.contentType,
            file.version,
          ));
        seen?.remember(seenKey(t), written.version);
        await onWrite?.({ path: t.show(written.path), version: written.version, size: written.size, contentType: written.contentType });
        return output(written);
      },
    }),
    defineTool({
      name: "glob",
      description:
        "Find files by *, ?, ** and {a,b} patterns relative to a mounted directory.",
      replay: "safe",
      parameters: obj({ pattern: str(), path: opt(str()), limit: opt(int()) }),
      async execute({ pattern, path, limit }) {
        const t = await target(
            path ?? (await getMounts())[0]?.path ?? "/workspace",
          ),
          files = await t.v.list(t.path, undefined, pattern),
          count = Math.max(1, Math.min(limit ?? 1000, 1000));
        return output({
          paths: files.slice(0, count).map((f) => t.show(f.path)),
          ...(files.length > count ? { truncated: true } : {}),
        });
      },
    }),
    defineTool({
      name: "grep",
      description:
        "Search UTF-8 file contents line by line. Large and binary files are skipped.",
      replay: "safe",
      parameters: obj({
        pattern: str(),
        path: opt(str()),
        glob: opt(str()),
        regex: opt(bool()),
        ignoreCase: opt(bool()),
        limit: opt(int()),
      }),
      async execute({ pattern, path, glob, regex, ignoreCase, limit }) {
        if (!pattern || pattern.length > 512)
          throw new FileError("Invalid pattern");
        const t = await target(
            path ?? (await getMounts())[0]?.path ?? "/workspace",
          ),
          files = await t.v.list(t.path, undefined, glob),
          matches: { path: string; line: number; text: string }[] = [],
          count = Math.max(1, Math.min(limit ?? 100, 1000));
        // Node runs untrusted patterns in a killable worker thread. Until this
        // host routes them through the codemode isolate, do not block a DO on JS RegExp.
        if (regex)
          throw new FileError(
            "Regular-expression grep requires isolated execution",
            501,
          );
        for (const file of files) {
          if (file.size > 1024 * 1024) continue;
          const { bytes } = await t.v.read(file.path);
          if (bytes.subarray(0, 8000).includes(0)) continue;
          const lines = new TextDecoder().decode(bytes).split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (
              ignoreCase
                ? line.toLowerCase().includes(pattern.toLowerCase())
                : line.includes(pattern)
            ) {
              matches.push({
                path: t.show(file.path),
                line: i + 1,
                text: line.slice(0, 2000),
              });
              if (matches.length >= count)
                return output({ matches, truncated: true });
            }
          }
        }
        return output({ matches });
      },
    }),
    ...(["cp", "mv"] as const).map((name) =>
      defineTool({
        name,
        description:
          "Copy or move files between mounted volumes. Directories require recursive for cp.",
        replay: "unsafe",
        parameters: obj({
          from: str(),
          to: str(),
          overwrite: opt(bool()),
          recursive: opt(bool()),
        }),
        async execute({ from, to, overwrite, recursive }) {
          const source = await target(from),
            destination = await target(to, true);
          if (name === "mv") await target(from, true);
          if (
            source.mount.volumeId === destination.mount.volumeId &&
            (source.path === destination.path ||
              destination.path.startsWith(source.path + "/"))
          )
            throw new FileError(
              "Destination cannot be the source or inside it",
            );
          const files = await source.v.list(source.path);
          if (!files.length) throw new FileError("Source not found", 404);
          const directory = files[0].path !== source.path;
          if (directory && name === "cp" && !recursive)
            throw new FileError("Directory copies require recursive: true");
          if (files.length > 1000)
            throw new FileError("At most 1000 files", 413);
          const plan = [];
          for (const file of files) {
            const path = destination.path + file.path.slice(source.path.length);
            let version = 0;
            try {
              version = (await destination.v.stat(path)).version;
              if (!overwrite) throw new FileError("Destination exists", 409);
            } catch (e) {
              if (!String(e).includes("FILE_404:")) throw e;
            }
            plan.push({ file, path, version });
          }
          for (const entry of plan) {
            const object = await env.BUCKET.get(entry.file.key);
            if (!object) throw new FileError("Source object missing", 503);
            const written = await uploadFile(
              env,
              tenant,
              destination.mount.volumeId,
              entry.path,
              object.body,
              entry.file.contentType,
              entry.version,
            );
            seen?.remember(`${destination.mount.volumeId}:${entry.path}`, written.version);
            await onWrite?.({ path: destination.show(written.path), version: written.version, size: written.size, contentType: written.contentType });
          }
          if (name === "mv")
            for (const entry of plan)
              await source.v.remove(entry.file.path, entry.file.version);
          return output({ copied: files.length, moved: name === "mv" });
        },
      }),
    ),
  ];
}
