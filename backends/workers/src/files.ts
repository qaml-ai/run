import { Buffer } from "node:buffer";
import { defineTool } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { withSql } from "./postgres.ts";
import { digest, FileError, normalizePath, type Volume } from "./volume.ts";
import {
  boundedBytes,
  imageInputs,
  signFile,
  storeImage,
  type ImageBindings,
  type ImageRef,
} from "./images.ts";
export { handleSignedFileRequest } from "./images.ts";
export interface FileBindings extends ImageBindings {
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
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "cache-control": "no-store" } });
async function input(request: Request) {
  const bytes = await boundedBytes(request.body, 64 * 1024);
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
const stub = (env: FileBindings, tenant: string, id: string) =>
  env.VOLUMES.getByName(`${tenant}:${id}`);
async function volume(
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
          }>(
            "SELECT name FROM volumes WHERE id=$1 AND tenant=$2 AND deleted_at IS NULL",
            [id, tenant],
          )
        ).rows[0],
    );
    if (!row) throw new FileError("Unknown volume", 404);
    const v = stub(env, tenant, id);
    await v.initialize(tenant, id, row.name);
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
): Promise<Response> {
  const v = await volume(env, tenant, id, privateAgent);
  path = normalizePath(path);
  if (request.method === "PUT") {
    const bytes = await boundedBytes(request.body, 32 * 1024 * 1024);
    const { key, ...file } = await v.write(
      path,
      bytes,
      request.headers.get("content-type") ?? "application/octet-stream",
      version(request),
    );
    return json(file, 201);
  }
  if (request.method === "DELETE")
    return json(await v.remove(path, version(request)));
  if (request.method === "GET") {
    const { file, bytes } = await v.read(
      path,
      new URL(request.url).searchParams.get("snapshot") ?? undefined,
    );
    const headers: Record<string, string> = {
      "content-type": file.contentType,
      etag: `"${file.version}"`,
      "x-file-version": String(file.version),
      "accept-ranges": "bytes",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    };
    const range = request.headers.get("range");
    if (!range) return new Response(bytes, { headers });
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]))
      throw new FileError("Invalid range", 416);
    const start = match[1]
        ? Number(match[1])
        : Math.max(0, bytes.length - Number(match[2])),
      end = match[1]
        ? match[2]
          ? Math.min(Number(match[2]), bytes.length - 1)
          : bytes.length - 1
        : bytes.length - 1;
    if (start > end || start >= bytes.length)
      throw new FileError("Unsatisfiable range", 416);
    headers["content-range"] = `bytes ${start}-${end}/${bytes.length}`;
    return new Response(bytes.slice(start, end + 1), { status: 206, headers });
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
    return await fileRequest(
      request,
      env,
      tenant,
      `agent:${agentId}`,
      path.replace(/^\/workspace(?=\/|$)/, "") || "/",
      true,
    );
  } catch (error) {
    return fileFailure(error);
  }
}
const fileFailure = (error: unknown) => {
  const message =
      error instanceof Error ? error.message : "File operation failed",
    coded = /FILE_(\d{3}):([^]*)/.exec(message);
  return json(
    { error: coded?.[2] ?? "File operation failed" },
    coded ? Number(coded[1]) : 500,
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
      if (request.method === "GET")
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
      if (request.method === "POST") {
        const body = (await input(request)) as {
          name?: string;
        };
        if (
          body.name !== undefined &&
          (typeof body.name !== "string" || body.name.length > 256)
        )
          throw new FileError("Invalid volume name");
        const id =
            "vol_" + crypto.randomUUID().replaceAll("-", "").slice(0, 24),
          name = body.name ?? "";
        await withSql(env, (sql) =>
          sql.query(
            "INSERT INTO volumes(id,tenant,name,created_at) VALUES($1,$2,$3,$4)",
            [id, tenant, name, Date.now()],
          ),
        );
        return json(
          await stub(env, tenant, id).initialize(tenant, id, name),
          201,
        );
      }
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
        files = selected.map(({ key, ...f }) => f);
      if (url.searchParams.get("content") === "true") {
        let total = 0;
        const contents = [];
        for (const entry of selected) {
          total += entry.size;
          if (total > 16 * 1024 * 1024)
            throw new FileError("Combined files exceed 16 MiB", 413);
          const object = await env.BUCKET.get(entry.key);
          if (!object) throw new FileError("File object missing", 503);
          const bytes = await boundedBytes(object.body, entry.size);
          if (
            bytes.length !== entry.size ||
            (await digest(bytes)) !== entry.key.split("/").at(-1)
          )
            throw new FileError("File integrity check failed", 503);
          contents.push({
            ...entry,
            data: Buffer.from(bytes).toString("base64"),
          });
        }
        return json({ files: contents, seq: readSet.seq });
      }
      return json({
        files,
        ...(entries.filter((f) => f.path > after).length > limit
          ? { next: selected.at(-1)?.path }
          : {}),
      });
    }
    if (tail === "changes" && request.method === "GET")
      return json(await v.changes(Number(url.searchParams.get("since") ?? 0)));
    if (tail === "snapshots" && request.method === "GET")
      return json(await v.snapshots());
    if (tail === "snapshots" && request.method === "POST") {
      const body = (await input(request)) as {
        name?: string;
      };
      return json(await v.snapshot(body.name), 201);
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
      if (body.method && body.method !== "GET")
        throw new FileError("Only GET capabilities are supported", 501);
      const file = await v.stat(body.path);
      return json(
        await signFile(env, tenant, file.key, url.origin, body.expiresIn),
        201,
      );
    }
    throw new FileError("Unsupported file operation", 501);
  } catch (error) {
    return fileFailure(error);
  }
}
/** Tools and HTTP share the same files; only explicit Linux computers have a separate filesystem. */
export function volumeTools(
  env: FileBindings,
  tenant: string,
  agentId: string,
  getMounts: () => Promise<Mount[]> = async () => [],
) {
  const target = async (path: string, write = false) => {
    path = normalizePath(path);
    const mounts = (await getMounts()).sort(
      (a, b) => b.path.length - a.path.length,
    );
    const mount = mounts.find(
      (m) => path === m.path || path.startsWith(m.path + "/"),
    );
    if (mount) {
      if (write && mount.mode !== "rw")
        throw new FileError("Mount is read-only", 403);
      return {
        v: await volume(env, tenant, mount.volumeId),
        path: normalizePath(
          (mount.subpath ?? "/") + "/" + path.slice(mount.path.length),
        ),
      };
    }
    return {
      v: await volume(env, tenant, `agent:${agentId}`, true),
      path: path.replace(/^\/workspace(?=\/|$)/, "") || "/",
    };
  };
  return [
    defineTool({
      name: "read",
      description:
        "Read UTF-8 text from a persistent file in /workspace or a mounted volume.",
      replay: "safe",
      parameters: obj({ path: str() }),
      async execute({ path }) {
        const t = await target(path),
          entry = await t.v.stat(t.path);
        if (entry.size > 1024 * 1024)
          throw new FileError("Tool file exceeds 1 MiB", 413);
        const { bytes } = await t.v.read(t.path);
        return {
          output: [{ type: "text", text: new TextDecoder().decode(bytes) }],
        };
      },
    }),
    defineTool({
      name: "write",
      description:
        "Write UTF-8 text to a persistent file in /workspace or a writable mounted volume.",
      replay: "unsafe",
      parameters: obj({ path: str(), content: opt(str()), text: opt(str()) }),
      async execute({ path, content, text }) {
        if (content === undefined && text === undefined)
          throw new FileError("content is required");
        const t = await target(path, true);
        const entry = await t.v.write(
          t.path,
          new TextEncoder().encode(content ?? text),
          "text/plain; charset=utf-8",
        );
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
        const t = await target(path ?? "/workspace");
        return {
          output: [
            { type: "text", text: JSON.stringify(await t.v.list(t.path)) },
          ],
        };
      },
    }),
  ];
}
