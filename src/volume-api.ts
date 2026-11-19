import { createRoute, z, type RouteConfig } from "@hono/zod-openapi";
import type { Context } from "hono";
import { binary, content, invalid, json, parse, reply } from "./api-helpers.ts";
import * as schema from "./api-schemas.ts";
import type { Db } from "./db.ts";
import { declaredType, downloadHeaders, fileResponse, type FileLinks } from "./files.ts";
import { HttpError, readJson } from "./http.ts";
import { tar } from "./tar.ts";
import { normalizePath, snapshotContents, commitContents, VOLUME_LIMITS, type FileEntry, type VolumeService } from "./volumes.ts";

type VolumeEnv = { Variables: { principal: { tenant: string } } };
type Route<E extends VolumeEnv> = (config: RouteConfig, handler: (c: Context<E>) => Response | Promise<Response>, path?: string) => void;

export function volumeLinkRoutes<E extends VolumeEnv>(route: Route<E>, volumes: () => VolumeService, links: () => FileLinks, database: () => Db) {
  // A signed link is its own credential, so its routes come before the check below. The grant
  // still names a tenant, which must still own the volume.
  const linkRoute = { request: { params: z.object({ token: z.string(), name: z.string().openapi({ description: "The file's name, for browsers; not checked" }) }) }, security: [] };
  const granted = async (c: Context, method: "GET" | "PUT") => {
    const grant = links().verify(c.req.param("token")!);
    if (grant.method !== method) throw new HttpError(405, `This link is for ${grant.method}`);
    if (grant.agent && !(await database().query("select 1 from agents where tenant=$1 and id=$2 and not revoked and purged_at is null and (expires_at is null or expires_at>$3)", [grant.tenant, grant.agent, Date.now()])).rowCount) throw new HttpError(403, "Agent no longer active");
    if (!await volumes().owns(grant.volume, grant.tenant)) throw new HttpError(404, "Unknown volume");
    return grant;
  };
  route(createRoute({ ...linkRoute, method: "get", path: "/v1/links/{token}/{name}", responses: { 200: binary("The file, with safe download headers"), 206: binary("The requested range") } }), async c => {
    const grant = await granted(c, "GET");
    const entry = await volumes().call(grant.volume, grant.tenant, "stat", { path: grant.path });
    if (entry.type !== "file") throw new HttpError(404, `${grant.path} is a directory`);
    if (grant.maxBytes !== undefined && entry.size > grant.maxBytes) throw new HttpError(413, "File exceeds the link size limit");
    return fileResponse(volumes(), grant.tenant, entry, c.req.header("range"));
  });
  route(createRoute({ ...linkRoute, method: "put", path: "/v1/links/{token}/{name}", request: { ...linkRoute.request, body: binary("The file's bytes, streamed; at most the link's maxBytes") }, responses: { 201: reply("The file's new version", schema.VolumeFile) } }), async c => {
    const grant = await granted(c, "PUT");
    const limit = Math.min(grant.maxBytes ?? VOLUME_LIMITS.fileBytes, VOLUME_LIMITS.fileBytes);
    if (Number(c.req.header("content-length") ?? 0) > limit) throw new HttpError(413, `This link takes at most ${limit} bytes`);
    const declared = declaredType(c.req.header("content-type"));
    if (grant.contentType && declared && declared !== grant.contentType) throw new HttpError(415, `This link takes ${grant.contentType}`);
    const { chunks: _chunks, ...entry } = await volumes().put(grant.tenant, grant.volume, grant.path, (c.req.raw.body ?? []) as AsyncIterable<Uint8Array>, { contentType: grant.contentType ?? declared, by: grant.agent ?? "link", limit });
    return json(c, 201, entry);
  });

}

export function volumeRoutes<E extends VolumeEnv>(route: Route<E>, volumes: () => VolumeService, links: () => FileLinks, agentLinks?: () => void) {
  const volumeId = z.object({ id: z.string() });
  const volume = async (c: Context<E>) => {
    const id = c.req.param("id")!;
    if (!await volumes().owns(id, c.var.principal.tenant)) throw new HttpError(404, "Unknown volume");
    return { id, tenant: c.var.principal.tenant, call: (op: string, args: Record<string, unknown> = {}) => volumes().call(id, c.var.principal.tenant, op, args) };
  };
  route(createRoute({
    method: "get", path: "/v1/volumes", request: { query: z.object({ ids: z.string().optional().openapi({ description: "Comma-separated volume ids (at most 50): those volumes, each with its seq, files and bytes (Volume), instead of every volume" }) }) },
    responses: { 200: reply("The tenant's volumes; with ids, those volumes as they are now", z.array(z.union([schema.VolumeSummary, schema.Volume]))) },
  }), async c => {
    const ids = c.req.query("ids");
    if (ids === undefined) return json(c, 200, await volumes().list(c.var.principal.tenant));
    const wanted = [...new Set(ids.split(",").map(id => id.trim()).filter(Boolean))];
    if (wanted.length > 50) throw new HttpError(400, "ids names at most 50 volumes");
    return json(c, 200, await Promise.all(wanted.map(id => volumes().call(id, c.var.principal.tenant, "info"))));
  });
  route(createRoute({ method: "post", path: "/v1/volumes", request: { body: content(schema.VolumeInput) }, responses: { 201: reply("The volume", schema.Volume) } }), async c => {
    const body = await readJson(c.req.raw.body, 4096, {});
    return json(c, 201, await volumes().create(c.var.principal.tenant, body));
  });
  route(createRoute({ method: "get", path: "/v1/volumes/{id}", request: { params: volumeId }, responses: { 200: reply("The volume", schema.Volume) } }),
    async c => json(c, 200, await (await volume(c)).call("info")));
  route(createRoute({ method: "delete", path: "/v1/volumes/{id}", request: { params: volumeId }, responses: { 200: reply("The volume is deleted; agents mounting it can no longer reach it", schema.Deleted) } }),
    async c => json(c, 200, await (await volume(c)).call("delete")));
  route(createRoute({
    method: "get", path: "/v1/volumes/{id}/snapshots",
    request: { params: volumeId, query: z.object({ label: z.string().optional().openapi({ description: "key:value; repeat it for several. Only snapshots with every label given" }) }) },
    responses: { 200: reply("The volume's snapshots, oldest first", z.array(schema.Snapshot)) },
  }), async c => {
    const asked = c.req.queries("label") ?? [];
    const labels = Object.fromEntries(asked.map(label => {
      const colon = label.indexOf(":");
      if (colon < 1) throw new HttpError(400, "label is key:value");
      return [label.slice(0, colon), label.slice(colon + 1)];
    }));
    return json(c, 200, await (await volume(c)).call("snapshots", asked.length ? { labels } : {}));
  });
  route(createRoute({ method: "post", path: "/v1/volumes/{id}/snapshots", request: { params: volumeId, body: content(schema.SnapshotInput) }, responses: { 201: reply("The snapshot: a copy of the file metadata, sharing contents", schema.SnapshotMade) } }), async c => {
    const target = await volume(c);
    // Room for a snapshot made from contents: 16 MiB of files, as base64 or text.
    const { name, pinned, labels, files } = await readJson(c.req.raw.body, 24 * 1024 * 1024, {}) ?? {};
    // From contents: the files are stored first and the snapshot recorded once they all are, so it is all or nothing.
    const made = files === undefined ? undefined : await snapshotContents(volumes(), target.tenant, files);
    const snapshot = await target.call("snapshot", { name, pinned, labels, ...(made ? { given: made.given } : {}) });
    return json(c, 201, made ? { ...snapshot, contents: made.contents } : snapshot);
  });
  route(createRoute({ method: "patch", path: "/v1/volumes/{id}/snapshots/{snapshotId}", request: { params: volumeId.extend({ snapshotId: z.string() }), body: content(schema.SnapshotUpdate) }, responses: { 200: reply("The snapshot as it is now", schema.Snapshot) } }), async c => {
    const target = await volume(c);
    const { pinned, labels } = await readJson(c.req.raw.body, 16 * 1024, {}) ?? {};
    return json(c, 200, await target.call("updateSnapshot", { snapshot: c.req.param("snapshotId"), pinned, labels }));
  });
  route(createRoute({
    method: "delete", path: "/v1/volumes/{id}/snapshots/{snapshotId}",
    request: { params: volumeId.extend({ snapshotId: z.string() }), query: z.object({ force: z.enum(["true"]).optional().openapi({ description: "Delete a pinned snapshot too" }) }) },
    responses: { 200: reply("The snapshot is deleted", schema.Deleted), 409: reply("The snapshot is pinned: unpin it, or pass force=true", schema.ApiError) },
  }), async c => json(c, 200, await (await volume(c)).call("deleteSnapshot", { snapshot: c.req.param("snapshotId"), force: c.req.query("force") === "true" })));
  route(createRoute({
    method: "get", path: "/v1/volumes/{id}/archive",
    request: { params: volumeId, query: z.object({
      snapshot: z.string().optional().openapi({ description: "Archive a snapshot (a project's version) instead of the volume as it is" }),
      path: z.string().optional().openapi({ description: "Only the files under this directory (default /); their names in the archive are relative to it" }),
      glob: z.string().optional().openapi({ description: "Only files matching this pattern, relative to path (e.g. **/*.ts)" }),
    }) },
    responses: { 200: binary("A tar.gz of the files, as the volume (or the snapshot) has them at one seq, named relative to path; X-Volume-Seq is that seq. At most 10,000 files and 1 GiB, else 413") },
  }), async c => {
    const target = await volume(c);
    const { snapshot, path, glob } = c.req.query();
    const at = await target.call("archive", { ...(snapshot ? { snapshot } : {}), ...(path ? { path } : {}), ...(glob ? { glob } : {}) }) as { seq: number; root: string; files: ({ path: string } & FileEntry)[] };
    const service = volumes();
    const archive = tar(at.files.map(file => ({ name: at.root === "/" ? file.path.slice(1) : file.path.slice(at.root.length + 1), size: file.size, mtime: file.updatedAt, stream: () => service.stream(target.tenant, file) })));
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) { const next = await archive.next(); if (next.done) controller.close(); else controller.enqueue(new Uint8Array(next.value)); },
      async cancel() { await archive.return(undefined); },
    }).pipeThrough(new CompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
    const name = `${snapshot ?? target.id}.tar.gz`;
    return new Response(body, { headers: { ...downloadHeaders("application/gzip", name), "X-Volume-Seq": String(at.seq), "Cache-Control": "no-store" } });
  });
  route(createRoute({ method: "post", path: "/v1/volumes/{id}/restore", request: { params: volumeId, body: content(schema.RestoreInput) }, responses: { 200: reply("The volume is as the snapshot was: what it lacked is removed, what differed is written, each a change", schema.Restored), 404: reply("Unknown volume or snapshot", schema.ApiError) } }), async c => {
    const target = await volume(c);
    const { snapshot } = parse(schema.RestoreInput, await readJson(c.req.raw.body, 4096, {}));
    return json(c, 200, await target.call("restore", { snapshot }));
  });
  route(createRoute({
    method: "post", path: "/v1/volumes/{id}/commit", request: { params: volumeId, body: content(schema.CommitInput) },
    responses: {
      200: reply("Every file is written and removed as given, in one change (and the snapshot taken, when asked)", schema.Committed),
      409: reply("A file is not at the version given: nothing is written", schema.CommitConflict),
    },
  }), async c => {
    const target = await volume(c);
    const result = await commitContents(volumes(), target.tenant, target.id, await readJson(c.req.raw.body, 24 * 1024 * 1024, {}));
    if (result.conflicts) return json(c, 409, { error: `${result.conflicts.length} of the files changed since the versions given; nothing was written`, code: "COMMIT_CONFLICT", conflicts: result.conflicts });
    return json(c, 200, result);
  });
  route(createRoute({ method: "post", path: "/v1/volumes/{id}/fork", request: { params: volumeId, body: content(schema.ForkInput) }, responses: { 201: reply("A new, independent volume with the same files", schema.Volume) } }), async c => {
    const target = await volume(c);
    const { name, snapshot } = await readJson(c.req.raw.body, 4096, {});
    return json(c, 201, await target.call("fork", { name, snapshot }));
  });
  agentLinks?.();
  route(createRoute({
    method: "post", path: "/v1/volumes/{id}/links", request: { params: volumeId, body: content(schema.LinkInput) },
    responses: { 201: reply("A signed URL for one file, usable without a token until it expires", schema.Link) },
  }), async c => {
    const target = await volume(c);
    const input = parse(schema.LinkInput, await readJson(c.req.raw.body, 4096, {}));
    return json(c, 201, links().sign({ tenant: target.tenant, volume: target.id, path: normalizePath(input.path), method: input.method ?? "GET", expiresIn: input.expiresIn,
      ...(input.maxBytes !== undefined ? { maxBytes: input.maxBytes } : {}), ...(input.contentType !== undefined ? { contentType: declaredType(input.contentType) ?? invalid("contentType must be a specific content type") } : {}) }));
  });
  route(createRoute({
    method: "get", path: "/v1/volumes/{id}/changes", request: { params: volumeId, query: z.object({ since: z.string().optional().openapi({ description: "Changes after this seq" }), prefix: z.string().optional().openapi({ description: "Only changes at or under this path" }) }) },
    responses: { 200: reply("Recent changes, oldest first", schema.Changes) },
  }), async c => json(c, 200, await (await volume(c)).call("changes", { since: Number(c.req.query("since") ?? 0) || 0, ...(c.req.query("prefix") ? { prefix: c.req.query("prefix") } : {}) })));
  route(createRoute({
    method: "get", path: "/v1/volumes/{id}/files", request: { params: volumeId, query: z.object({
      prefix: z.string().optional(), glob: z.string().optional(), after: z.string().optional(), limit: z.string().optional(),
      snapshot: z.string().optional().openapi({ description: "List (or read) a snapshot of the volume instead of the volume as it is" }),
      content: z.enum(["true"]).optional().openapi({ description: "Every matching file with its contents, in one answer at one seq (FileContents): at most 1,000 files and 16 MiB, else 413" }),
    }) },
    responses: { 200: reply("Files under prefix, in path order, a page at a time; with content=true, all of them with their contents (FileContents)", z.union([schema.FileList, schema.FileContents])) },
  }), async c => {
    const { prefix, glob, after, limit, snapshot, content } = c.req.query();
    const at = snapshot ? { snapshot } : {};
    if (content === "true") return json(c, 200, await (await volume(c)).call("readAll", { path: prefix ?? "/", ...(glob ? { glob } : {}), ...at }));
    const listing = await (await volume(c)).call("list", { path: prefix ?? "/", ...(glob ? { glob } : {}), ...(after ? { after } : {}), ...(limit ? { limit: Number(limit) } : {}), ...at });
    return json(c, 200, { files: listing.files.map(({ chunks: _chunks, ...file }: { chunks: string[] }) => file), ...(listing.next ? { next: listing.next } : {}) });
  });
  const filePath = (c: Context) => {
    const encoded = new URL(c.req.url).pathname.split("/files/").slice(1).join("/files/");
    try { return normalizePath(`/${encoded.split("/").map(decodeURIComponent).join("/")}`); }
    catch { throw new HttpError(400, "Invalid file path"); }
  };
  const version = (value: string | undefined) => {
    if (value === undefined) return undefined;
    const parsed = Number(value.replace(/^W\//, "").replaceAll('"', ""));
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new HttpError(400, "If-Match must be a file version");
    return parsed;
  };
  const file = { params: volumeId.extend({ path: z.string().openapi({ description: "Path inside the volume; may contain /" }) }) };
  const files = "/v1/volumes/:id/files/*";
  route(createRoute({
    method: "put", path: "/v1/volumes/{id}/files/{path}",
    request: { ...file, headers: z.object({ "if-match": z.string().optional().openapi({ description: "Only replace this version" }), "if-none-match": z.string().optional().openapi({ description: "* to create only" }) }), body: binary("The file's bytes") },
    responses: { 201: reply("The file's new version", schema.VolumeFile) },
  }), async c => {
    const target = await volume(c);
    const path = filePath(c);
    const ifMatch = c.req.header("if-none-match") === "*" ? 0 : version(c.req.header("if-match"));
    const { chunks: _chunks, ...entry } = await volumes().put(target.tenant, target.id, path, (c.req.raw.body ?? []) as AsyncIterable<Uint8Array>, { contentType: c.req.header("content-type"), ifMatch });
    return json(c, 201, entry);
  }, files);
  route(createRoute({
    method: "get", path: "/v1/volumes/{id}/files/{path}", request: { ...file, query: z.object({ snapshot: z.string().optional().openapi({ description: "Read the file as a snapshot of the volume has it" }) }), headers: z.object({ range: z.string().optional().openapi({ description: "bytes=start-end" }) }) },
    responses: { 200: binary("The file, streamed a chunk at a time; its version is X-File-Version (and the ETag, which a proxy may rewrite)"), 206: binary("The requested range") },
  }), async c => {
    const target = await volume(c);
    const snapshot = c.req.query("snapshot");
    const entry = await target.call("stat", { path: filePath(c), ...(snapshot ? { snapshot } : {}) });
    if (entry.type !== "file") throw new HttpError(404, `${entry.path} is a directory`);
    return fileResponse(volumes(), target.tenant, entry, c.req.header("range"));
  }, files);
  route(createRoute({
    method: "delete", path: "/v1/volumes/{id}/files/{path}", request: { ...file, headers: z.object({ "if-match": z.string().optional() }) },
    responses: { 200: reply("The file is deleted", z.object({ path: z.string(), deleted: z.literal(true), seq: z.number() })) },
  }), async c => {
    const target = await volume(c);
    const ifMatch = version(c.req.header("if-match"));
    return json(c, 200, await target.call("remove", { path: filePath(c), ...(ifMatch !== undefined ? { ifMatch } : {}) }));
  }, files);
}
