import { posix } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { FileError, ExecutionError, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { VolumeEnv } from "./volume-env.ts";
import { FILE_TOOL_LIMITS, resolve, type ToolContext } from "./volume-tools.ts";
import { HttpError } from "./http.ts";
import { guessContentType } from "./files.ts";
import { globRegex, normalizePath, type FileEntry, type VolumeService } from "./volumes.ts";
import { quote } from "./computers/providers.ts";

export type ComputerMount = {
  id: string;
  exec(command: string, receiptsOnly?: boolean): Promise<unknown>;
  transfer(context: ToolContext, upload: boolean, args: { from: string; to: string }): Promise<unknown>;
};
export const COMPUTER_VOLUME = "computer-session";
export const computerPath = (path: string) => `"$HOME"${quote(normalizePath(path) === "/" ? "" : normalizePath(path))}`;

export const COMPUTER_INLINE_BYTES = 32 * 1024;

/** Scratch paths live in the writable volume, never at its visible top level. */
export function computerScratch(volumes: VolumeService, context: ToolContext, name: string) {
  const home = context.mounts.find(mount => mount.volumeId !== COMPUTER_VOLUME && mount.mode === "rw");
  if (!home) throw new Error("A writable volume is required for computer file transfers");
  const path = posix.join(home.path, ".camel/computer", randomUUID(), posix.basename(name));
  const target = resolve(context.mounts, path)!;
  return {
    path,
    put: (bytes: Uint8Array) => volumes.put(context.tenant, target.mount.volumeId, target.path, bytes, { by: context.agent }),
    read: async (offset: number, length: number) => {
      const entry = await volumes.call(target.mount.volumeId, context.tenant, "stat", { path: target.path });
      return volumes.readRange(context.tenant, entry, offset, length);
    },
    remove: () => volumes.call(target.mount.volumeId, context.tenant, "remove", { path: target.path, by: context.agent }).catch(error => { if (error.status !== 404) throw error; }),
  };
}

/** Only receipts are trusted. A provider's error can contain a command or signed URL. */
export class ComputerFiles {
  readonly computer: ComputerMount;
  private readonly storage?: { volumes: VolumeService; context: ToolContext };
  constructor(computer: ComputerMount, storage?: { volumes: VolumeService; context: ToolContext }) { this.computer = computer; this.storage = storage; }
  private scratch(name: string) {
    if (!this.storage) throw new Error("A writable volume is required for computer file transfers");
    return computerScratch(this.storage.volumes, this.storage.context, name);
  }
  async command(command: string): Promise<string>;
  async command(command: string, binary: true): Promise<Buffer>;
  async command(command: string, binary = false): Promise<string | Buffer> {
    let result: any;
    try { result = await this.computer.exec(`${command} 2>/dev/null`, true); }
    catch { throw new Error("Computer file operation failed"); }
    const output = typeof result?.stdout === "string" ? result.stdout : "";
    if (/^CAMEL_MISSING$/m.test(output)) throw new HttpError(404, "File does not exist");
    if (/^CAMEL_CONFLICT$/m.test(output)) throw new HttpError(412, "File changed since you last read it; read it again, then retry against its current content");
    const receipt = /^CAMEL_OK ([A-Za-z0-9+/=]*)$/m.exec(output);
    if (result?.exitCode !== 0 || result?.truncated || !receipt) throw new Error("Computer file operation failed");
    const bytes = Buffer.from(receipt[1], "base64");
    return binary ? bytes : bytes.toString("utf8");
  }
  async stat(path: string) {
    const p = computerPath(path);
    const value = await this.command(`[ -e ${p} ] || { echo CAMEL_MISSING; exit 1; }; v=$(stat -Lc '%s %Y %y %z %i' -- ${p}) || exit 1; k=file; [ ! -d ${p} ] || k=directory; printf 'CAMEL_OK '; printf '%s %s' "$k" "$v" | base64 -w0; echo`);
    const [type, size, mtime] = value.split(" ");
    const version = parseInt(createHash("sha256").update(`${this.computer.id}:${value}`).digest("hex").slice(0, 12), 16);
    return { path, fingerprint: value.slice(value.indexOf(" ") + 1), type, size: Number(size), updatedAt: Number(mtime) * 1000, version, chunks: [], contentType: guessContentType(path) };
  }
  async readRange(_tenant: string, entry: FileEntry & { path?: string }, offset: number, length: number) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) throw new Error("Invalid read range");
    const count = Math.max(0, Math.min(length, entry.size - offset));
    const check = async () => {
      if ((await this.stat(entry.path!)).version !== entry.version) throw new HttpError(412, "File changed since you last read it; read it again");
    };
    await check();
    let bytes: Buffer;
    if (count <= COMPUTER_INLINE_BYTES) {
      bytes = await this.command(`printf 'CAMEL_OK '; tail -c +${offset + 1} -- ${computerPath(entry.path!)} | head -c ${count} | base64 -w0; echo`, true);
    } else {
      const scratch = this.scratch(entry.path!);
      try {
        await this.computer.transfer({ ...this.storage!.context, onWrite: undefined }, false, { from: entry.path!, to: scratch.path });
        bytes = await scratch.read(offset, count);
      } finally { await scratch.remove(); }
    }
    await check();
    if (bytes.length !== count) throw new Error("Computer file changed while reading; read it again");
    return bytes;
  }

  async put(_tenant: string, _id: string, path: string, source: Uint8Array, options: { ifMatch?: number } = {}) {
    if (source.length > FILE_TOOL_LIMITS.editBytes) throw new Error(`Computer writes are limited to ${FILE_TOOL_LIMITS.editBytes} bytes`);
    let fingerprint: string | undefined;
    if (options.ifMatch !== undefined) {
      const current = await this.stat(path).catch(e => { if (e.status === 404) return undefined; throw e; });
      fingerprint = current?.fingerprint;
      if ((current?.version ?? 0) !== options.ifMatch) throw new HttpError(412, "File changed since you last read it; read it again");
    }
    const tempPath = posix.join(posix.dirname(path), `.camel-${randomUUID()}`);
    const p = computerPath(path), temp = computerPath(tempPath);
    const scratch = source.length > COMPUTER_INLINE_BYTES ? this.scratch(path) : undefined;
    await this.command(`mkdir -p -- ${computerPath(posix.dirname(path))} && (umask 077; set -C; : > ${temp}) && echo 'CAMEL_OK '`);
    try {
      if (scratch) {
        await scratch.put(source);
        const receipt = await this.computer.transfer({ ...this.storage!.context, onWrite: undefined }, true, { from: scratch.path, to: tempPath }) as { sha256?: string; size?: number };
        if (receipt?.sha256 !== createHash("sha256").update(source).digest("hex") || receipt.size !== source.length) throw new Error("Computer transfer receipt mismatch");
      } else {
        await this.command(`printf %s ${quote(Buffer.from(source).toString("base64"))} | base64 -d > ${temp} && echo 'CAMEL_OK '`);
      }
      const check = options.ifMatch === undefined ? "" : fingerprint === undefined ? `[ ! -e ${p} ]` : `[ "$(stat -Lc '%s %Y %y %z %i' -- ${p})" = ${quote(fingerprint)} ]`;
      await this.command(`${check ? `${check} || { echo CAMEL_CONFLICT; exit 1; }; ` : ""}mv -fT -- ${temp} ${p} && echo 'CAMEL_OK '`);
      return this.stat(path);
    } finally {
      await this.command(`rm -f -- ${temp}; echo 'CAMEL_OK '`).catch(() => {});
      if (scratch) await scratch.remove();
    }
  }
  async call(_id: string, _tenant: string, op: string, args: Record<string, any>): Promise<any> {
    const path = normalizePath(args.path);
    if (op === "stat") return this.stat(path);
    if (op === "remove") {
      if (path === "/") throw new Error("Cannot remove a mount root");
      const entry = await this.stat(path);
      if (entry.type !== "file") throw new Error("Cannot remove a directory with fs.remove");
      if (args.ifMatch !== undefined && args.ifMatch !== entry.version) throw new HttpError(412, "File changed since you last read it");
      await this.command(`[ "$(stat -Lc '%s %Y %y %z %i' -- ${computerPath(path)})" = ${quote(entry.fingerprint)} ] || { echo CAMEL_CONFLICT; exit 1; }; rm -f -- ${computerPath(path)} && echo 'CAMEL_OK '`);
      return { seq: 0 };
    }
    if (op === "ls" || op === "list") {
      const stat = await this.stat(path);
      if (stat.type === "file") { if (op === "ls") throw new Error(`${path} is a file`); return { files: args.glob && !globMatch(posix.basename(path), args.glob) ? [] : [stat] }; }
      const limit = op === "ls" ? 1000 : args.limit ?? 1000;
      const files: any[] = [];
      for (let start = 1; files.length <= limit; start += 20) {
        const value = await this.command(`printf 'CAMEL_OK '; find ${computerPath(path)} -mindepth 1 ${op === "ls" ? "-maxdepth 1" : "-type f"} -printf '%P\\0' | sort -z | tail -z -n +${start} | head -z -n 20 | base64 -w0; echo`);
        const names = value.split("\0").filter(Boolean);
        for (const name of names) {
          if (args.glob && !globMatch(name, args.glob)) continue;
          const entry = await this.stat(posix.join(path, name));
          files.push(op === "ls" ? entry.type === "directory" ? { name, type: "directory" } : { name, type: "file", size: entry.size, contentType: entry.contentType } : entry);
          if (files.length > limit) break;
        }
        if (names.length < 20) break;
        if (start > 10000) throw new Error("Computer listing exceeds 10000 entries; narrow the path");
      }
      return op === "ls" ? { entries: files.slice(0, limit), truncated: files.length > limit } : { files: files.slice(0, limit), next: files.length > limit };
    }
    throw new Error(`Unsupported computer file operation: ${op}`);
  }
  async grep(args: Record<string, any>, show: (path: string) => string, signal: AbortSignal) {
    const pattern = args.regex ? args.pattern : args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try { new RegExp(pattern, args.ignoreCase ? "i" : ""); } catch { throw new Error("Invalid regular expression"); }
    const deadline = Date.now() + FILE_TOOL_LIMITS.grepMs;
    const listing = await this.call("", "", "list", { path: args.path, glob: args.glob, limit: FILE_TOOL_LIMITS.grepFiles });
    const limit = args.limit ?? FILE_TOOL_LIMITS.grepMatches;
    const matches: { path: string; line: number; text: string }[] = [];
    let filesSearched = 0, filesSkipped = 0, bytes = 0;
    let truncated: string | undefined = listing.next ? `only the first ${FILE_TOOL_LIMITS.grepFiles} files were searched` : undefined;
    search: for (const entry of listing.files) {
      signal.throwIfAborted();
      if (entry.size > FILE_TOOL_LIMITS.grepFileBytes) { filesSkipped++; continue; }
      if (bytes + entry.size > FILE_TOOL_LIMITS.grepBytes || Date.now() > deadline) { truncated = "the search budget ran out; narrow path or glob"; break; }
      bytes += entry.size;
      if ((await this.readRange("", entry, 0, Math.min(8000, entry.size))).includes(0)) { filesSkipped++; continue; }
      filesSearched++;
      // Clip before transporting, and page the receipt below the driver's stdout cap.
      for (let start = 1; ; start += 15) {
        if (Date.now() > deadline) { truncated = "the search budget ran out; narrow path or glob"; break search; }
        const seconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
        const output = await this.command(`d=$(mktemp) || exit 1; trap 'rm -f -- "$d"' EXIT; timeout ${seconds}s grep -rInh ${args.regex ? "-E" : "-F"} ${args.ignoreCase ? "-i" : ""} -m ${limit + 1} -- ${quote(args.pattern)} ${computerPath(entry.path)} > "$d"; r=$?; [ "$r" -le 1 ] || exit 1; printf 'CAMEL_OK '; LC_ALL=C cut -c 1-${4 * FILE_TOOL_LIMITS.grepLine + 12} "$d" | tail -n +${start} | head -n 15 | base64 -w0; echo`);
        const lines = output.split("\n").filter(Boolean);
        for (const line of lines) {
          if (matches.length === limit) { truncated = `more than ${limit} matches`; break search; }
          const match = /^(\d+):(.*)$/.exec(line);
          if (!match) throw new Error("Invalid computer search receipt");
          matches.push({ path: show(entry.path), line: Number(match[1]), text: match[2].slice(0, FILE_TOOL_LIMITS.grepLine) });
        }
        if (lines.length < 15) break;
      }
    }
    return { matches, filesSearched, ...(filesSkipped ? { filesSkipped } : {}), ...(truncated ? { truncated } : {}) };
  }
  async contentType(_tenant: string, path: string) { return guessContentType(path); }
}
// Use the same glob compiler as volumes, including braces and globstar.
const globMatch = (path: string, pattern: string) => globRegex(pattern).test(path);

/** Pi's public filesystem boundary; the storage adapter keeps its tools unchanged. */
export class ComputerEnv extends VolumeEnv {
  readonly files: ComputerFiles;
  constructor(computer: ComputerMount, owner: ToolContext, editing = false, volumes?: VolumeService) {
    const files = new ComputerFiles(computer, volumes ? { volumes, context: owner } : undefined);
    super(files as unknown as VolumeService, { ...owner, mounts: [{ volumeId: COMPUTER_VOLUME, path: "/computer", mode: "rw" }] }, editing);
    this.files = files;
    this.cwd = "/computer";
  }
  override createDir: ExecutionEnv["createDir"] = async (path, _options, context) => {
    try { context.abortSignal?.throwIfAborted(); await this.files.command(`mkdir -p -- ${computerPath(path.replace(/^\/computer(?=\/|$)/, ""))} && echo 'CAMEL_OK '`); return { ok: true, value: undefined }; }
    catch { return { ok: false, error: new FileError("unknown", "Computer mkdir failed", path) }; }
  };
  override readBinaryFile: ExecutionEnv["readBinaryFile"] = async (path, context) => {
    try {
      context.abortSignal?.throwIfAborted();
      const entry = await this.files.stat(path.replace(/^\/computer(?=\/|$)/, "") || "/");
      if (entry.size > FILE_TOOL_LIMITS.editBytes) throw new Error("File exceeds the read size limit");
      return { ok: true, value: await this.files.readRange("", entry, 0, entry.size) };
    } catch (error) { return { ok: false, error: new FileError("invalid", (error as Error).message, path) }; }
  };
  override listDir: ExecutionEnv["listDir"] = async (path, context) => {
    try {
      context.abortSignal?.throwIfAborted();
      const listing = await this.files.call("", "", "ls", { path: path.replace(/^\/computer(?=\/|$)/, "") || "/" });
      return { ok: true, value: listing.entries.map((entry: any) => ({ path: posix.join(path, entry.name), name: entry.name, kind: entry.type, size: entry.size, mtimeMs: entry.updatedAt })) };
    } catch { return { ok: false, error: new FileError("unknown", "Computer listing failed", path) }; }
  };
  override exec: ExecutionEnv["exec"] = async (command, options, context) => {
    try {
      context.abortSignal?.throwIfAborted();
      const run = typeof command === "string" ? command : command.map(quote).join(" ");
      const result = await this.files.computer.exec(`cd ${options?.cwd ? computerPath(options.cwd.replace(/^\/computer(?=\/|$)/, "")) : '"$HOME"'} && ${run}`) as any;
      options?.onOutput?.(result.stdout ?? "", context, { stream: "stdout" });
      options?.onOutput?.(result.stderr ?? "", context, { stream: "stderr" });
      return { ok: true, value: { exitCode: result.exitCode } };
    }
    catch { return { ok: false, error: new ExecutionError("unknown", "Computer command failed") }; }
  };
}
