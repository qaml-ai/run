import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import { FileError, ExecutionError, LineScanner, type ExecutionEnv, type FileSystem, type FileInfo, type Result, type BinaryReader } from "@earendil-works/pi-durable/env";
import { type FileEntry, type VolumeService, normalizePath } from "./volumes.ts";
import { FILE_TOOL_LIMITS, remember, resolve, writable, type ToolContext } from "./volume-tools.ts";

/** One Pi call's filesystem. Open readers retain the volume entry, so all ranges see the same version. */
export class VolumeEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  private readonly readVersions = new Map<string, number>();
  private readonly contentTypes = new Map<string, string | undefined>();

  private readonly volumes: VolumeService;
  private readonly owner: ToolContext;
  private readonly editing: boolean;

  constructor(volumes: VolumeService, owner: ToolContext, editing = false) {
    this.volumes = volumes;
    this.owner = owner;
    this.editing = editing;
    this.cwd = owner.mounts[0]?.path ?? "/";
    this.id = JSON.stringify([owner.tenant, owner.mounts]);
  }

  private async result<T>(path: string, context: Context, run: () => Promise<T> | T): Promise<Result<T, FileError>> {
    try {
      context.abortSignal?.throwIfAborted();
      return { ok: true, value: await run() };
    } catch (error) {
      if (error instanceof FileError) return { ok: false, error };
      const status = (error as { status?: number }).status;
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: new FileError(context.abortSignal?.aborted ? "aborted" : status === 404 ? "not_found" : status === 403 ? "permission_denied" : status === 400 ? "invalid" : "unknown", message, path) };
    }
  }

  private target(path: string) {
    const target = resolve(this.owner.mounts, path);
    if (!target) throw new FileError("is_directory", "/ holds only the mounts; name a path inside one", path);
    return target;
  }

  private async entry(path: string): Promise<FileEntry> {
    const target = this.target(path);
    let entry;
    try { entry = await this.volumes.call(target.mount.volumeId, this.owner.tenant, "stat", { path: target.path }); }
    catch (error) {
      if ((error as { status?: number }).status === 404) throw new FileError("not_found", `${path} does not exist`, path);
      throw error;
    }
    if (entry.type !== "file") throw new FileError("is_directory", `${path} is a directory; use ls`, path);
    return entry;
  }

  private key(path: string) { const target = this.target(path); return `${target.mount.volumeId}:${target.path}`; }
  private remember(path: string, entry: FileEntry) {
    const key = this.key(path);
    if (this.editing && this.owner.seen?.has(key) && this.owner.seen.get(key) !== entry.version) throw new FileError("invalid", `${path} changed since you last read it; read it again, then retry against its current content`, path);
    this.readVersions.set(key, entry.version);
    this.contentTypes.set(key, entry.contentType);
    remember(this.owner.seen, key, entry.version);
  }
  private info(path: string, entry: FileEntry): FileInfo { return { path, name: posix.basename(path), kind: "file", size: entry.size, mtimeMs: entry.updatedAt }; }

  absolutePath(path: string, context: Context) {
    return this.result(path, context, () => {
      const absolute = normalizePath(path.startsWith("/") ? path : `${this.cwd}/${path}`);
      if (absolute !== "/") this.target(absolute);
      return absolute;
    });
  }
  joinPath(parts: string[], context: Context) { return this.absolutePath(posix.join(...parts), context); }
  canonicalPath(path: string, context: Context) { return this.absolutePath(path, context); }
  fileInfo(path: string, context: Context) { return this.result(path, context, async () => this.info(path, await this.entry(path))); }
  exists(path: string, context: Context) {
    return this.result(path, context, async () => {
      const target = this.target(path);
      try { await this.volumes.call(target.mount.volumeId, this.owner.tenant, "stat", { path: target.path }); return true; }
      catch (error) { if ((error as { status?: number }).status === 404) return false; throw error; }
    });
  }
  readTextFile(path: string, context: Context) {
    return this.result(path, context, async () => {
      const entry = await this.entry(path);
      if (entry.size > FILE_TOOL_LIMITS.editBytes) throw new FileError("invalid", `${path} is larger than ${FILE_TOOL_LIMITS.editBytes} bytes; read it in line windows`, path);
      const bytes = await this.volumes.readRange(this.owner.tenant, entry, 0, entry.size);
      this.remember(path, entry);
      if (bytes.subarray(0, 8000).includes(0)) throw new FileError("invalid", `${path} is a binary file`, path);
      // Preserve the BOM so Pi can restore it after editing.
      return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    });
  }
  openBinaryReader(path: string, _options: { noFollow?: boolean } | undefined, context: Context) {
    return this.result<BinaryReader>(path, context, async () => {
      const entry = await this.entry(path);
      this.remember(path, entry);
      return {
        info: ctx => this.result(path, ctx, () => this.info(path, entry)),
        read: (offset, length, ctx) => this.result(path, ctx, () => {
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > FILE_TOOL_LIMITS.maxReadBytes) throw new FileError("invalid", "Invalid read range", path);
          return this.volumes.readRange(this.owner.tenant, entry, offset, length);
        }),
        scanLines: (options, ctx) => this.result(path, ctx, async () => {
          const scanner = new LineScanner(options.startLine, options.endLine);
          for (let offset = 0; offset < entry.size; offset += FILE_TOOL_LIMITS.maxReadBytes) {
            ctx.abortSignal?.throwIfAborted();
            scanner.push(await this.volumes.readRange(this.owner.tenant, entry, offset, Math.min(FILE_TOOL_LIMITS.maxReadBytes, entry.size - offset)));
          }
          return scanner.finish();
        }),
        close: async () => {},
      };
    });
  }
  writeFile(path: string, content: string | Uint8Array, context: Context) {
    return this.result(path, context, async () => {
      const target = this.target(path);
      writable(target);
      const key = this.key(path);
      const expected = this.readVersions.get(key) ?? this.owner.seen?.get(key);
      const data = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
      const committed = await this.volumes.put(this.owner.tenant, target.mount.volumeId, target.path, data, {
        ifMatch: expected, by: this.owner.agent, contentType: this.editing ? this.contentTypes.get(key) : undefined,
      }).catch(error => {
        if ((error as { status?: number }).status === 412) throw new FileError("invalid", `${path} changed since you last read it; read it again, then retry against its current content`, path);
        throw error;
      });
      remember(this.owner.seen, key, committed.version);
      this.owner.onWrite?.({ path, version: committed.version, size: committed.size, contentType: committed.contentType! });
    });
  }
  private async unsupported<T>(): Promise<Result<T, FileError>> { return { ok: false, error: new FileError("not_supported", "This operation is not supported by volume files") }; }
  readBinaryFile: FileSystem["readBinaryFile"] = () => this.unsupported();
  readTextLines: FileSystem["readTextLines"] = () => this.unsupported();
  openTextLineReader: FileSystem["openTextLineReader"] = () => this.unsupported();
  createDir: FileSystem["createDir"] = () => this.unsupported();
  listDir: FileSystem["listDir"] = () => this.unsupported();
  remove: FileSystem["remove"] = () => this.unsupported();
  appendFile: FileSystem["appendFile"] = () => this.unsupported();
  truncateFile: FileSystem["truncateFile"] = () => this.unsupported();
  flushFile: FileSystem["flushFile"] = () => this.unsupported();
  renameFile: FileSystem["renameFile"] = () => this.unsupported();
  openDirReader: FileSystem["openDirReader"] = () => this.unsupported();
  watch: FileSystem["watch"] = () => this.unsupported();
  createTempDir: FileSystem["createTempDir"] = () => this.unsupported();
  createTempFile: FileSystem["createTempFile"] = () => this.unsupported();
  async exec(): Promise<Result<never, ExecutionError>> { return { ok: false, error: new ExecutionError("shell_unavailable", "Volume files have no shell; computers use a separate filesystem") }; }
  async cleanup() {}
}
