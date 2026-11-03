import { Worker } from "node:worker_threads";
import { posix } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createReadTool, createWriteTool, createEditTool } from "@earendil-works/pi-durable/tools";
import { FileError } from "@earendil-works/pi-durable/env";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { ComputerMount } from "./computer-env.ts";
const COMPUTER_VOLUME = "computer-session";
import { VolumeEnv } from "./volume-env.ts";
import type { ToolDefinition } from "./protocol.ts";
import { HttpError } from "./http.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import { normalizePath, type FileEntry, type Mount, type VolumeService } from "./volumes.ts";
import { essence, FILE_LIMITS, guessContentType, supportsDocuments, unseen, type FileRef } from "./files.ts";
import { fileRef, inspectFile } from "./inspect.ts";

/**
 * File tools over an agent's mounts: read, write, edit, ls, glob and grep. They
 * run in the runtime (never the sandbox), as direct tools and from code. Paths
 * are mount paths (`/workspace/notes.md`); results stay small, so large files are
 * read in windows and searched without entering the model's context. `read` shows
 * an image or PDF to a model that can view it as a file reference (files.ts), which
 * the agent host turns into a native block; a PDF's text is read in windows otherwise.
 */
export const FILE_TOOL_LIMITS = Object.freeze({
  readBytes: 32 * 1024, maxReadBytes: 128 * 1024, editBytes: 1024 * 1024,
  globResults: 200, maxGlobResults: 1000,
  grepMatches: 50, maxGrepMatches: 200, grepFiles: 1000, grepFileBytes: 4 * 1024 * 1024, grepBytes: 32 * 1024 * 1024, grepLine: 240, grepMs: 10_000,
});
/** A file the agent wrote, as a run's outcome lists it. */
export type WrittenFile = { path: string; version: number; size: number; contentType: string };
/**
 * `model` is the agent's current model, for what `read` can show it. `onWrite` hears of each file
 * the agent writes, and `onPresent` of each it hands over with present_file (with its path in the
 * volume); it throws to refuse one.
 */
export type ToolContext = {
  computer?: () => Promise<ComputerMount | null | undefined>;
  tenant: string; agent: string; mounts: Mount[]; model?: () => Model<Api>;
  /**
   * The version of each file (`<volume>:<path>`) the agent last read or wrote, kept by its host. A write or edit of a
   * file that changed since then is refused, so the model never acts on a stale read; the model never sees versions.
   */
  seen?: Map<string, number>;
  onWrite?(file: WrittenFile): void;
  onPresent?(file: FileRef & { caption?: string }, volumePath: string): void;
};

const piTools = { read: createReadTool(), write: createWriteTool(), edit: createEditTool() };

const path = (description: string) => ({ type: "string", description });
/** The file tools. Where the mounts are is in the agent's prompt (system-prompt.ts), so the tools stay the same when they change. */
export function volumeToolDefinitions(): ToolDefinition[] {
  const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition => ({
    name, description, exposure: "both", executionMode: ["write", "edit", "cp", "mv"].includes(name) ? "sequential" : "parallel",
    parameters: { type: "object", additionalProperties: false, properties, required },
  });
  return [
    ...["cp", "mv"].map(name => tool(name, `${name === "cp" ? "Copy" : "Move"} a file or directory between mounts. Destination is the exact path; overwrite defaults to false. Directory copies require recursive: true. At most 1000 files.`, { from: path("Source path"), to: path("Destination path"), overwrite: { type: "boolean", default: false }, ...(name === "cp" ? { recursive: { type: "boolean", default: false } } : {}) }, ["from", "to"])),
    tool("read", `Read text in line windows (offset is 1-based, limit is lines), up to ${FILE_TOOL_LIMITS.readBytes} bytes. Images and PDFs are shown when the model can view them; otherwise PDF text uses character offset/length. Binary files use encoding: base64 and byte offset/length. Text output is bounded; continue at the indicated line.`,
      { ...(piTools.read.parameters.properties as Record<string, unknown>), length: { type: "integer", minimum: 1, maximum: FILE_TOOL_LIMITS.maxReadBytes, description: "Byte count for base64, character count for PDF text" }, encoding: { type: "string", enum: ["utf8", "base64"] } }, ["path"]),
    tool("write", "Create or replace a file with text, or bytes with encoding: base64. Parent directories are created implicitly.", {
      ...(piTools.write.parameters.properties as Record<string, unknown>),
      encoding: { type: "string", enum: ["utf8", "base64"] },
      contentType: { type: "string", description: "e.g. image/png; by default sniffed from the bytes and name" },
    }, ["path", "content"]),
    tool("edit", piTools.edit.description, piTools.edit.parameters.properties as Record<string, unknown>, ["path", "edits"]),
    tool("present_file", "Hand a file you made to the user: it goes to them (or their application) with your reply, with a download link. Writing a file does not share it. Write the file first, then call this once per file to share.",
      { path: path("File path"), caption: { type: "string", maxLength: 1000, description: "A line about the file, shown with it" } }, ["path"]),
    tool("ls", "List a directory's entries with their sizes. / lists the mounts.", { path: path("Directory path") }, []),
    tool("glob", `Find files by glob (*, ?, **, {a,b}) relative to path; at most ${FILE_TOOL_LIMITS.maxGlobResults} results.`,
      { pattern: { type: "string" }, path: path("Directory to search"), limit: { type: "integer", minimum: 1, maximum: FILE_TOOL_LIMITS.maxGlobResults } }, ["pattern"]),
    tool("grep", `Search file contents line by line for text (or a regular expression with regex: true). Returns at most ${FILE_TOOL_LIMITS.maxGrepMatches} matching lines; files over ${FILE_TOOL_LIMITS.grepFileBytes} bytes and binary files are skipped.`,
      { pattern: { type: "string", minLength: 1, maxLength: 512 }, path: path("File or directory to search"), glob: { type: "string" }, regex: { type: "boolean" }, ignoreCase: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: FILE_TOOL_LIMITS.maxGrepMatches } }, ["pattern"]),
  ];
}

/** A path as the agent sees it (`/workspace/a.md`, or relative to its first mount): its mount, its path in the volume, and how to show volume paths. */
export type Resolved = { mount: Mount; path: string; show: (volumePath: string) => string };
export function resolve(mounts: Mount[], input: unknown): Resolved | undefined {
  if (!mounts.length) throw new Error("This agent has no volumes mounted");
  const raw = input === undefined ? mounts[0].path : input;
  if (typeof raw !== "string") throw new Error("path must be a string");
  const absolute = normalizePath(raw.startsWith("/") ? raw : `${mounts[0].path}/${raw}`);
  if (absolute === "/") return undefined;
  const mount = mounts.find(candidate => absolute === candidate.path || absolute.startsWith(`${candidate.path}/`));
  if (!mount) throw new Error(`${absolute} is not inside a mount. Mounted: ${mounts.map(candidate => candidate.path).join(", ")}`);
  const base = mount.subpath ?? "/";
  const rest = absolute.slice(mount.path.length);
  return {
    mount, path: base === "/" ? rest || "/" : base + rest,
    show: volumePath => mount.path + (base === "/" ? (volumePath === "/" ? "" : volumePath) : volumePath.slice(base.length)),
  };
}

export function writable(target: Resolved) {
  if (target.mount.mode !== "rw") throw new Error(`${target.mount.path} is mounted read-only`);
}

/** Say what a failed precondition means for the model, in its own paths, without versions it cannot use. */
function conflict(error: unknown, shown: string, verb: string): never {
  if ((error as HttpError).status !== 412) throw error;
  throw new Error(`${verb} rejected: ${shown} changed since you last read it. Read it again, then retry against its current content.`);
}
/** At most this many files' versions are remembered per agent; the oldest are forgotten (and so not checked). */
const SEEN_FILES = 10_000;
export function remember(seen: Map<string, number> | undefined, key: string, version: number) {
  if (!seen) return;
  seen.delete(key);
  seen.set(key, version);
  if (seen.size > SEEN_FILES) seen.delete(seen.keys().next().value!);
}

const decoder = () => new TextDecoder("utf-8", { fatal: false });
const binary = (data: Buffer) => data.subarray(0, 8000).includes(0);

/** Pi needs only env for these tools; keep the host's tool registration and execution boundary. */
async function runPiTool(volumes: VolumeService, context: ToolContext, name: keyof typeof piTools, args: Record<string, any>, signal: AbortSignal) {
  const { ComputerEnv } = await import("./computer-env.ts");
  const mount = resolve(context.mounts, args.path);
  const env = mount?.mount.volumeId === COMPUTER_VOLUME && context.computer ? new ComputerEnv((await context.computer())!, context, name === "edit", volumes) : new VolumeEnv(volumes, context, name === "edit");
  const tool = piTools[name];
  try {
    const result = await tool.execute(args as any, { env } as unknown as ToolExecutionApi, withAbortSignal(signal, BACKGROUND_CONTEXT));
    const content = [...result.output ?? []];
    if (name === "read" && content[0]?.type === "text" && Buffer.byteLength(content[0].text) > FILE_TOOL_LIMITS.readBytes) {
      let text = new TextDecoder().decode(Buffer.from(content[0].text).subarray(0, FILE_TOOL_LIMITS.readBytes), { stream: true });
      const end = text.lastIndexOf("\n");
      if (end >= 0) text = text.slice(0, end);
      content[0] = { type: "text", text };
      content.push({ type: "text", text: end >= 0 ? `Output limited to ${FILE_TOOL_LIMITS.readBytes} bytes. Continue with offset=${(args.offset || 1) + text.split("\n").length}.` : `Line exceeds ${FILE_TOOL_LIMITS.readBytes} bytes; use encoding: base64 to read byte windows.` });
      // Pi's continuation refers to its larger default window, not the window above.
      return { content, details: { content: text, truncated: true } };
    }
    for (const diagnostic of result.diagnostics ?? []) content.push({ type: "text", text: diagnostic.message.replace(/Use bash: .*/, "Use encoding: base64 to read byte windows.") });
    return { content, details: name === "read" ? { content: result.structuredOutput, ...(result.details as Record<string, unknown> | undefined) } : result.details, isError: result.isError };
  } catch (error) {
    // Pi's edit wrapper reports only the error code; retain the filesystem's actionable reason.
    if (error instanceof Error && error.cause instanceof FileError) throw error.cause;
    throw error;
  }
}

export async function runVolumeTool(volumes: VolumeService, context: ToolContext, name: string, args: Record<string, any>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const { ComputerFiles, computerScratch } = await import("./computer-env.ts");
  const storage = volumes;
  const computer = await context.computer?.();
  const paths = [args.path, args.from, args.to].filter(value => typeof value === "string") as string[];
  if (computer === null && paths.some(path => path === "/computer" || path.startsWith("/computer/"))) throw new Error("your computer isn't running; call computer_start");
  if (computer) context = { ...context, mounts: [...context.mounts, { volumeId: COMPUTER_VOLUME, path: "/computer", mode: "rw" }] };
  if (name === "cp" || name === "mv") return copyMove(volumes, context, computer, name, args, signal);
  const { tenant, mounts } = context;
  const target = name === "ls" ? resolve(mounts, args.path) : resolve(mounts, args.path ?? (name === "grep" || name === "glob" ? undefined : ""));
  if (name === "ls" && !target) return { path: "/", entries: mounts.map(mount => ({ name: mount.path.slice(1), type: "directory", mode: mount.mode })) };
  if (!target) throw new Error("/ holds only the mounts; name a path inside one");
  if (target.mount.volumeId === COMPUTER_VOLUME && computer) {
    const media = essence(guessContentType(target.path));
    if (name === "read" && args.encoding !== "base64" && (media.startsWith("image/") || media === "application/pdf")) {
      const scratch = computerScratch(storage, context, target.path);
      try {
        await computer.transfer({ ...context, onWrite: undefined }, false, { from: target.path, to: scratch.path });
        const result = await runVolumeTool(storage, { ...context, computer: undefined, mounts: context.mounts.filter(m => m.volumeId !== COMPUTER_VOLUME) }, name, { ...args, path: scratch.path }, signal) as any;
        // fileRef pins the chunks, so the transcript reference survives removing this path.
        return { ...result, path: target.show(target.path) };
      } finally { await scratch.remove(); }
    }
    if (name === "present_file") {
      const scratch = computerScratch(storage, context, target.path);
      let presented = false;
      try {
        await computer.transfer({ ...context, onWrite: undefined }, false, { from: target.path, to: scratch.path });
        const result = await runVolumeTool(storage, { ...context, computer: undefined, mounts: context.mounts.filter(m => m.volumeId !== COMPUTER_VOLUME) }, name, { ...args, path: scratch.path }, signal);
        // Keep the delivered copy at the path returned to the user.
        presented = true;
        return result;
      } finally { if (!presented) await scratch.remove(); }
    }
    const files = new ComputerFiles(computer, { volumes: storage, context });
    if (name === "grep") return files.grep({ ...args, path: target.path }, target.show, signal);
    volumes = files as unknown as VolumeService;
  }
  const call = (op: string, extra: Record<string, unknown> = {}) => volumes.call(target.mount.volumeId, tenant, op, { path: target.path, ...extra });
  const shown = target.show(target.path);
  const key = `${target.mount.volumeId}:${target.path}`;
  const file = async (): Promise<FileEntry> => {
    const stat = await call("stat").catch(error => { throw (error as HttpError).status === 404 ? new Error((error as Error).message.replace(target.path, shown)) : error; });
    if (stat.type !== "file") throw new Error(`${shown} is a directory; use ls`);
    return stat;
  };

  if (name === "edit") {
    writable(target);
    return runPiTool(storage, context, "edit", args, signal);
  }
  if (name === "read") {
    const entry = await file();
    const type = essence(entry.contentType ?? guessContentType(target.path));
    if (args.encoding !== "base64" && !type.startsWith("image/") && type !== "application/pdf") {
      const head = await volumes.readRange(tenant, entry, 0, Math.min(8000, entry.size));
      if (!binary(head)) return runPiTool(storage, context, "read", args, signal);
    }
    const offset = args.offset ?? 0;
    // A file from before types were recorded is labeled by its name here, rather than a chunk read to sniff it.
    const contentType = entry.contentType ?? guessContentType(target.path);
    remember(context.seen, key, entry.version);
    const about = { path: shown, size: entry.size, contentType };

    if (args.encoding !== "base64" && (type.startsWith("image/") || type === "application/pdf")) {
      const model = context.model?.();
      // Shown natively: the result carries a reference the agent host turns into the image or document.
      if (model && (type !== "application/pdf" || supportsDocuments(model)) && !offset) {
        const ref = await fileRef(volumes, tenant, context.agent, target.mount.volumeId, shown, { ...entry, contentType });
        const why = unseen(ref, model);
        if (!why) return { ...about, ...(ref.media?.kind === "pdf" ? { pages: ref.media.pages } : ref.media?.kind === "image" ? { width: ref.media.width, height: ref.media.height } : {}), file: ref };
        if (type !== "application/pdf" || ref.media?.kind === "none") return { ...about, note: `Not shown: ${why}` };
      }
      if (type === "application/pdf") {
        const found = await inspectFile(volumes, tenant, entry, contentType, true);
        if (found?.media.kind !== "pdf" || found.text === undefined) return { ...about, note: `This PDF ${found?.media.kind === "none" ? found.media.reason : "could not be read"}` };
        const content = found.text.slice(offset, offset + (args.length ?? FILE_TOOL_LIMITS.readBytes));
        const next = offset + content.length;
        return { ...about, pages: found.media.pages, offset, content, ...(next < found.text.length ? { nextOffset: next } : {}), ...(found.truncated && next >= found.text.length ? { truncated: "Only the start of this PDF's text is available" } : {}) };
      }
      if (!model || !model.input.includes("image")) return { ...about, note: "An image; this model cannot view images" };
    }
    if (offset > entry.size) throw new Error(`offset ${offset} is past the end of ${shown} (${entry.size} bytes)`);
    const data = await volumes.readRange(tenant, entry, offset, args.length ?? FILE_TOOL_LIMITS.readBytes);
    if (args.encoding === "base64") return { ...about, offset, data: data.toString("base64"), ...(offset + data.length < entry.size ? { nextOffset: offset + data.length } : {}) };
    if (binary(data)) return { ...about, binary: true, note: "Binary file; read it with encoding: base64 for its bytes" };
    // A window may end inside a UTF-8 sequence: stop before it, and continue from there.
    const content = decoder().decode(data, { stream: offset + data.length < entry.size });
    const next = offset + Buffer.byteLength(content);
    return { ...about, offset, content, ...(next < entry.size ? { nextOffset: next } : {}) };
  }
  if (name === "write") {
    if (args.encoding !== "base64" && args.contentType === undefined) return runPiTool(storage, context, "write", args, signal);
    writable(target);
    const content = args.content;
    const expected = context.seen?.get(key);
    const contentType = args.contentType;
    if (args.encoding === "base64" && !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw new Error("content is not base64");
    signal.throwIfAborted();
    const committed = await volumes.put(tenant, target.mount.volumeId, target.path, Buffer.from(content, args.encoding === "base64" ? "base64" : "utf8"), { contentType, ifMatch: expected, by: context.agent })
      .catch(error => conflict(error, shown, "Write"));
    remember(context.seen, key, committed.version);
    const written = { path: shown, version: committed.version, size: committed.size, contentType: committed.contentType! };
    context.onWrite?.(written);
    return { path: shown, size: written.size, contentType: written.contentType };
  }
  // The host's own write of a long tool result (agent-host.ts `saveToolResult`): text, within the same mount rules.
  if (name === "fs.writeFile") {
    writable(target);
    if (typeof args.text !== "string") throw new Error("fs.writeFile takes text");
    const data = Buffer.from(args.text, "utf8");
    if (data.length > FILE_LIMITS.scriptFileBytes) throw new Error(`fs.writeFile writes at most ${FILE_LIMITS.scriptFileBytes} bytes at a time`);
    signal.throwIfAborted();
    const { path: _path, chunks: _chunks, by: _by, version, ...entry } = await volumes.put(tenant, target.mount.volumeId, target.path, data, { contentType: args.contentType, by: context.agent });
    remember(context.seen, key, version);
    context.onWrite?.({ path: shown, version, size: entry.size, contentType: entry.contentType! });
    return { path: shown, ...entry };
  }
  if (name === "present_file") {
    const entry = await file();
    const contentType = await volumes.contentType(tenant, target.path, entry);
    const presented = { type: "file" as const, path: shown, volume: target.mount.volumeId, version: entry.version, size: entry.size, contentType, chunks: entry.chunks, ...(typeof args.caption === "string" ? { caption: args.caption } : {}) };
    // The run's outcome and stream refer to this version: its chunks stay while the agent does (storage-gc.ts).
    await volumes.pin(tenant, context.agent, entry.chunks);
    context.onPresent?.(presented, target.path);
    return { path: shown, size: entry.size, contentType, presented: true };
  }
  if (name === "ls") {
    const listing = await call("ls").catch(error => { throw (error as HttpError).status === 404 ? new Error((error as Error).message.replace(target.path, shown)) : error; });
    return { path: shown, entries: listing.entries.map(({ version: _version, ...entry }: { version?: number }) => entry), ...(listing.truncated ? { truncated: true } : {}) };
  }
  if (name === "glob") {
    const limit = args.limit ?? FILE_TOOL_LIMITS.globResults;
    const listing = await call("list", { glob: args.pattern, limit });
    return { paths: listing.files.map((entry: { path: string }) => target.show(entry.path)), ...(listing.next ? { truncated: true } : {}) };
  }
  if (name === "grep") {
    const source = args.regex ? args.pattern : args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const flags = args.ignoreCase ? "i" : "";
    try { new RegExp(source, flags); } catch (error) { throw new Error(`Invalid regular expression: ${(error as Error).message}`); }
    const listing = await call("list", { ...(args.glob !== undefined ? { glob: args.glob } : {}), limit: FILE_TOOL_LIMITS.grepFiles });
    const deadline = Date.now() + FILE_TOOL_LIMITS.grepMs;
    const files: { path: string; text: string }[] = [];
    let skipped = 0, bytes = 0;
    let truncated: string | undefined = listing.next ? `only the first ${FILE_TOOL_LIMITS.grepFiles} files were searched` : undefined;
    for (const entry of listing.files as ({ path: string } & FileEntry)[]) {
      signal.throwIfAborted();
      if (entry.size > FILE_TOOL_LIMITS.grepFileBytes) { skipped++; continue; }
      if (bytes + entry.size > FILE_TOOL_LIMITS.grepBytes || Date.now() > deadline) { truncated = "the search budget ran out; narrow path or glob"; break; }
      bytes += entry.size;
      const data = await volumes.readRange(tenant, entry, 0, entry.size);
      if (binary(data)) skipped++;
      else files.push({ path: target.show(entry.path), text: decoder().decode(data) });
    }
    const limit = args.limit ?? FILE_TOOL_LIMITS.grepMatches;
    const found = await searchLines({ source, flags, files, limit, width: FILE_TOOL_LIMITS.grepLine }, deadline, signal);
    if (found.more) truncated = `more than ${limit} matches`;
    return { matches: found.matches, filesSearched: files.length, ...(skipped ? { filesSkipped: skipped } : {}), ...(truncated ? { truncated } : {}) };
  }
  throw new Error(`Unknown file tool: ${name}`);
}

// The model writes the pattern, so it may backtrack catastrophically: match in a worker that is
// terminated at the deadline, never on the runtime's event loop. Lines are cut so each test is bounded.
const SEARCH = `
const { parentPort, workerData: { source, flags, files, limit, width } } = require("node:worker_threads");
const pattern = new RegExp(source, flags);
const matches = [];
let more = false;
search: for (const file of files) {
  const lines = file.text.split("\\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].slice(0, 4 * width);
    if (!pattern.test(line)) continue;
    if (matches.length === limit) { more = true; break search; }
    matches.push({ path: file.path, line: index + 1, text: line.slice(0, width) });
  }
}
parentPort.postMessage({ matches, more });`;

export function searchLines(work: { source: string; flags: string; files: { path: string; text: string }[]; limit: number; width: number }, deadline: number, signal: AbortSignal) {
  const worker = new Worker(SEARCH, { eval: true, workerData: work, resourceLimits: { maxOldGenerationSizeMb: 256 } });
  const done = Promise.withResolvers<{ matches: { path: string; line: number; text: string }[]; more: boolean }>();
  const stop = (error: Error) => { done.reject(error); void worker.terminate(); };
  const timer = setTimeout(() => stop(new Error("grep ran out of time; simplify the pattern or narrow path or glob")), Math.max(1, deadline - Date.now()));
  const abort = () => stop(new Error("grep was cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  worker.once("message", done.resolve);
  worker.once("error", error => done.reject(error));
  worker.once("exit", () => done.reject(new Error("grep stopped unexpectedly")));
  return done.promise.finally(() => { clearTimeout(timer); signal.removeEventListener("abort", abort); void worker.terminate(); });
}


async function copyMove(volumes: VolumeService, context: ToolContext, computer: ComputerMount | null | undefined, name: string, args: Record<string, any>, signal: AbortSignal) {
  const { ComputerFiles, computerPath } = await import("./computer-env.ts");
  if (typeof args.from !== "string" || typeof args.to !== "string") throw new Error("from and to must be paths");
  const from = resolve(context.mounts, args.from), to = resolve(context.mounts, args.to);
  if (!from || !to) throw new Error("Name paths inside mounts");
  writable(to);
  if (name === "mv") writable(from);
  const remote = (target: Resolved) => target.mount.volumeId === COMPUTER_VOLUME;
  const files = computer ? new ComputerFiles(computer) : undefined;
  const service = (target: Resolved) => remote(target) ? files! as unknown as VolumeService : volumes;
  const stat = (target: Resolved) => service(target).call(target.mount.volumeId, context.tenant, "stat", { path: target.path });
  const source = await stat(from);
  if (from.mount.volumeId === to.mount.volumeId && (from.path === to.path || to.path.startsWith(`${from.path}/`))) throw new Error("Destination must differ from source and cannot be inside it");
  const existing = await stat(to).catch(error => { if (error.status === 404) return undefined; throw error; });
  if (existing && !args.overwrite) throw new Error("Destination exists; set overwrite: true to replace it");
  if (existing && existing.type !== source.type) throw new Error("Source and destination must have the same type");
  if (source.type === "directory" && name === "cp" && !args.recursive) throw new Error("Copying a directory requires recursive: true");
  const entries = source.type === "file" ? [source] : await service(from).call(from.mount.volumeId, context.tenant, "list", { path: from.path, limit: 1001 }).then(listing => {
    if (listing.next || listing.files.length > 1000) throw new Error("Copy or move is limited to 1000 files");
    return listing.files;
  });
  const bytes = entries.reduce((sum: number, entry: FileEntry) => sum + entry.size, 0);
  if (remote(from) && remote(to)) {
    await files!.command(`mkdir -p -- ${computerPath(to.path.substring(0, to.path.lastIndexOf("/")) || "/")} && ${name === "mv" ? "mv -T" : "cp -aT"} ${args.overwrite ? "" : "-n"} -- ${computerPath(from.path)} ${computerPath(to.path)} && echo 'CAMEL_OK '`);
  } else if (!remote(from) && !remote(to) && from.mount.volumeId === to.mount.volumeId) {
    const result = await volumes.call(from.mount.volumeId, context.tenant, name === "mv" ? "rename" : "copy", { path: from.path, to: to.path, overwrite: !!args.overwrite, by: context.agent });
    for (const entry of result.files) { remember(context.seen, `${to.mount.volumeId}:${entry.path}`, entry.version); context.onWrite?.({ path: to.show(entry.path), version: entry.version, size: entry.size, contentType: entry.contentType }); }
  } else {
    // Preflight every destination before copying any bytes. Cross-mount moves remove only verified copies.
    for (const entry of entries) {
      const destination = to.path + (source.type === "file" ? "" : entry.path.slice(from.path === "/" ? 0 : from.path.length));
      const found = await service(to).call(to.mount.volumeId, context.tenant, "stat", { path: destination }).catch(error => { if (error.status === 404) return undefined; throw error; });
      if (found && !args.overwrite) throw new Error("Destination exists; set overwrite: true to replace it");
      if (found?.type === "directory") throw new Error("Destination is a directory");
    }
    if (source.type === "directory" && remote(to)) await files!.command(`mkdir -p -- ${computerPath(to.path)} && echo 'CAMEL_OK '`);
    for (const entry of entries) {
      signal.throwIfAborted();
      const destination = to.path + (source.type === "file" ? "" : entry.path.slice(from.path === "/" ? 0 : from.path.length));
      if (remote(from) || remote(to)) {
        // Receive into a unique sibling first. A failed receipt must not replace an existing destination.
        const temporary = posix.join(posix.dirname(destination), `.camel-${crypto.randomUUID()}${posix.extname(destination).slice(0, 32)}`);
        if (remote(to)) {
          try {
            await computer!.transfer(context, true, { from: from.show(entry.path), to: temporary });
            await files!.command(`${args.overwrite ? `mv -fT -- ${computerPath(temporary)} ${computerPath(destination)}` : `ln -- ${computerPath(temporary)} ${computerPath(destination)} && rm -- ${computerPath(temporary)}`} && echo 'CAMEL_OK '`);
          } finally { await files!.command(`rm -f -- ${computerPath(temporary)}; echo 'CAMEL_OK '`).catch(() => {}); }
        } else {
          try {
            await computer!.transfer({ ...context, onWrite: undefined }, false, { from: entry.path, to: to.show(temporary) });
            const copied = await volumes.call(to.mount.volumeId, context.tenant, "copy", { path: temporary, to: destination, overwrite: !!args.overwrite, by: context.agent });
            const written = copied.files[0];
            remember(context.seen, `${to.mount.volumeId}:${destination}`, written.version);
            context.onWrite?.({ path: to.show(destination), version: written.version, size: written.size, contentType: written.contentType });
          } finally { await volumes.call(to.mount.volumeId, context.tenant, "remove", { path: temporary, by: context.agent }).catch(() => {}); }
        }
      } else {
        const written = await volumes.put(context.tenant, to.mount.volumeId, destination, volumes.stream(context.tenant, entry), { contentType: entry.contentType, by: context.agent, ifMatch: args.overwrite ? undefined : 0 });
        remember(context.seen, `${to.mount.volumeId}:${destination}`, written.version);
        context.onWrite?.({ path: to.show(destination), version: written.version, size: written.size, contentType: written.contentType! });
      }
      if (name === "mv") await service(from).call(from.mount.volumeId, context.tenant, "remove", { path: entry.path, ifMatch: entry.version, by: context.agent });
    }
    if (name === "mv" && source.type === "directory" && remote(from)) await files!.command(`find ${computerPath(from.path)} -depth -type d -empty -delete; [ ! -e ${computerPath(from.path)} ] && echo 'CAMEL_OK '`);
  }
  return { from: from.show(from.path), to: to.show(to.path), files: entries.length, bytes };
}
