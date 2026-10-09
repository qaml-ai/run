import { createHash } from "node:crypto";
import { downloadHeaders, fileResponse, guessContentType } from "./files.ts";
import { HttpError } from "./http.ts";
import type { FileGrant, RuntimeSigner } from "./identity.ts";
import { TOOL_FILE_LIMITS } from "./limits.ts";
import { tar } from "./tar.ts";
import type { FileEntry, VolumeService } from "./volumes.ts";

/**
 * Files a tool call's arguments name, sent to the tool's server as URLs bound to the call (tool-files.ts decides where).
 * A URL is `GET /v1/files/<token>/<name>`, its token an EdDSA JWT the runtime signs with the key of its identity tokens
 * (`aud: "camelrun:file"`): it names the tenant, agent, call, tool and the file, and lasts TOOL_FILE_LIMITS.urlSeconds.
 * A file's URL serves it only at the version the call named (410 once it changes), so a tool never gets a mix; a
 * directory's names a snapshot made for the call, as a manifest of its files (each with its own URL) and an archive.
 * Nothing else is reachable with it, and only for reading.
 */

/** Whether a source's tools take files in their arguments: `on` or `off`, by `fileArguments`. */
export type FileArguments = "on" | "off";

/**
 * Whether a tool source is sent files: as its `fileArguments` says, else on for the tenant's own servers (auth "runtime",
 * which check who is calling) and off for any other, which a model could otherwise send the agent's files to.
 */
export const takesFiles = (source: { auth?: { type: string }; fileArguments?: FileArguments }) =>
  (source.fileArguments ?? (source.auth?.type === "runtime" ? "on" : "off")) === "on";

/** A file as MCP SEP-2631 (draft) describes one: where to get it, its name, type and size, and its sha-256 (hex) when known. */
export type FileValue = { uri: string; name: string; mimeType: string; size: number; digest?: { algorithm: "sha-256"; value: string } };

/** A file's sha-256 (hex), read whole unless it is one chunk (whose hash it is); undefined past TOOL_FILE_LIMITS.digestBytes. */
export async function digestOf(volumes: VolumeService, tenant: string, entry: Pick<FileEntry, "size" | "chunks">): Promise<string | undefined> {
  if (entry.size > TOOL_FILE_LIMITS.digestBytes) return undefined;
  if (entry.chunks.length === 1 || entry.size === 0) return entry.chunks[0] ?? createHash("sha256").digest("hex");
  const hash = createHash("sha256");
  for await (const chunk of volumes.stream(tenant, entry)) hash.update(chunk);
  return hash.digest("hex");
}

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const relative = (path: string, directory: string) => directory === "/" ? path.slice(1) : path.slice(directory.length + 1);

export class FileUrls {
  private readonly options: { signer: RuntimeSigner; volumes: VolumeService; publicUrl: () => string };
  constructor(options: FileUrls["options"]) { this.options = options; }

  /** A URL for `grant` named `name`, valid until `expiresAt` (ms). */
  async url(grant: FileGrant, name: string, expiresAt: number) {
    const token = await this.options.signer.fileToken(grant, expiresAt);
    return `${this.options.publicUrl().replace(/\/+$/, "")}/v1/files/${token}/${encodeURIComponent(name || "file")}`;
  }

  /** What a file URL's token serves: its file (with `range`), or its directory's manifest or archive. */
  async serve(token: string, range?: string): Promise<Response> {
    const { signer, volumes } = this.options;
    const grant = await signer.verifyFileToken(token);
    if (!await volumes.owns(grant.volume, grant.tenant)) throw new HttpError(404, "Unknown volume");
    if (grant.kind === "file") {
      const entry = await this.stat(grant, grant.path);
      if (entry.type !== "file") throw new HttpError(404, `${grant.agentPath} is a directory`);
      if (grant.version !== undefined && entry.version !== grant.version) throw new HttpError(410, `${grant.agentPath} changed since the call`);
      return fileResponse(volumes, grant.tenant, entry, range);
    }
    const files = await this.files(grant);
    if (grant.kind === "manifest") {
      const expiresAt = grant.exp * 1000;
      const entries = await mapLimit(files, 8, async file => {
        const name = nameOf(file.path);
        const digest = await digestOf(volumes, grant.tenant, file);
        const shown = `${grant.agentPath}/${relative(file.path, grant.path)}`;
        return {
          path: relative(file.path, grant.path), uri: await this.url({ ...grant, kind: "file", path: file.path, agentPath: shown }, name, expiresAt),
          name, mimeType: file.contentType ?? guessContentType(name), size: file.size, ...(digest ? { digest: { algorithm: "sha-256", value: digest } } : {}),
        };
      });
      const archive = await this.url({ ...grant, kind: "archive" }, `${nameOf(grant.agentPath) || "files"}.tar.gz`, expiresAt);
      return new Response(JSON.stringify({ snapshot: grant.snapshot, root: grant.agentPath, files: entries, archive: { uri: archive, mimeType: "application/gzip" } }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    }
    const archive = tar(files.map(file => ({ name: relative(file.path, grant.path), size: file.size, mtime: file.updatedAt, stream: () => volumes.stream(grant.tenant, file) })));
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) { const next = await archive.next(); if (next.done) controller.close(); else controller.enqueue(new Uint8Array(next.value)); },
      async cancel() { await archive.return(undefined); },
    }).pipeThrough(new CompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
    return new Response(body, { headers: { ...downloadHeaders("application/gzip", `${nameOf(grant.agentPath) || "files"}.tar.gz`), "Cache-Control": "no-store" } });
  }

  /** A path as the grant's snapshot (or the volume, for a file granted at a version) has it; 410 once the snapshot is gone. */
  private async stat(grant: FileGrant, path: string) {
    return this.options.volumes.call(grant.volume, grant.tenant, "stat", { path, ...(grant.snapshot ? { snapshot: grant.snapshot } : {}) }).catch(error => {
      if ((error as HttpError).status !== 404) throw error;
      throw new HttpError(410, grant.snapshot && /snapshot/i.test(errorMessage(error)) ? "The call's files are no longer kept" : `${grant.agentPath} no longer exists`);
    });
  }

  /** The files under a directory grant's path, in its snapshot (at most TOOL_FILE_LIMITS.directoryFiles, as it was made). */
  private async files(grant: FileGrant): Promise<({ path: string } & FileEntry)[]> {
    if (!grant.snapshot) throw new HttpError(404, "Not a directory");
    const listing = await this.options.volumes.call(grant.volume, grant.tenant, "list", { path: grant.path, snapshot: grant.snapshot, limit: TOOL_FILE_LIMITS.directoryFiles })
      .catch(error => { throw (error as HttpError).status === 404 ? new HttpError(410, "The call's files are no longer kept") : error; });
    return listing.files;
  }
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** `work` over `items`, at most `limit` at once, in order. */
async function mapLimit<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]); }
  }));
  return results;
}
