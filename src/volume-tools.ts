import { Worker } from "node:worker_threads";
import type { ToolDefinition } from "./protocol.ts";
import { HttpError } from "./http.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import { normalizePath, type FileEntry, type Mount, type VolumeService } from "./volumes.ts";
import { essence, FILE_LIMITS, guessContentType, supportsDocuments, unseen, type FileRef } from "./files.ts";
import { fileRef, inspectFile } from "./inspect.ts";

/**
 * File tools over an agent's mounts: read, write, edit, ls, glob and grep. They
 * run in the runtime (never the sandbox), as direct tools and from js_exec. Paths
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
  tenant: string; agent: string; mounts: Mount[]; model?: () => Model<Api>;
  onWrite?(file: WrittenFile): void;
  onPresent?(file: FileRef & { caption?: string }, volumePath: string): void;
};

const path = (description: string) => ({ type: "string", description });
/** The file tools. Where the mounts are is in the agent's prompt (system-prompt.ts), so the tools stay the same when they change. */
export function volumeToolDefinitions(): ToolDefinition[] {
  const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition => ({
    name, description, exposure: "both", executionMode: name === "write" || name === "edit" ? "sequential" : "parallel",
    parameters: { type: "object", additionalProperties: false, properties, required },
  });
  const version = { type: "integer", minimum: 0, description: "Only succeed if the file is still at this version (from read or ls); 0 means it must not exist yet" };
  return [
    tool("read", `Read a file. Text comes back up to ${FILE_TOOL_LIMITS.readBytes} bytes from offset (at most ${FILE_TOOL_LIMITS.maxReadBytes}); nextOffset is set when more remains. Images and PDFs are shown to you when you can view them; otherwise a PDF's text comes back in windows (offset and length in characters). Other binary files need encoding: base64. Returns the file's version, for edit and write.`,
      { path: path("File path"), offset: { type: "integer", minimum: 0 }, length: { type: "integer", minimum: 1, maximum: FILE_TOOL_LIMITS.maxReadBytes }, encoding: { type: "string", enum: ["utf8", "base64"], description: "base64: the raw bytes" } }, ["path"]),
    tool("write", "Create or replace a file: text, or bytes as base64 with encoding: base64.", {
      path: path("File path"), content: { type: "string" }, version,
      encoding: { type: "string", enum: ["utf8", "base64"], description: "base64: content is the file's bytes, base64-encoded" },
      contentType: { type: "string", description: "e.g. image/png; by default it is sniffed from the bytes and name" },
    }, ["path", "content"]),
    tool("edit", "Replace an exact text span in a file (old must appear once unless replaceAll). Pass the version from your last read so an edit based on a stale read is rejected.",
      { path: path("File path"), old: { type: "string", minLength: 1 }, new: { type: "string" }, replaceAll: { type: "boolean" }, version }, ["path", "old", "new"]),
    tool("present_file", "Hand a file you made to the user: it goes to them (or their application) with your reply, with a download link. Writing a file does not share it. Write the file first, then call this once per file to share.",
      { path: path("File path"), caption: { type: "string", maxLength: 1000, description: "A line about the file, shown with it" } }, ["path"]),
    tool("ls", "List a directory's entries with sizes and versions. / lists the mounts.", { path: path("Directory path") }, []),
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

function writable(target: Resolved) {
  if (target.mount.mode !== "rw") throw new Error(`${target.mount.path} is mounted read-only`);
}

/** Say what a failed precondition means for the model, in its own paths. */
function conflict(error: unknown, shown: string, expected: unknown, verb: string): never {
  if ((error as HttpError).status !== 412) throw error;
  const current = (error as { current?: number }).current;
  throw new Error(`${verb} rejected: ${shown} changed since you read it (you had version ${expected}; it is now ${current ? `version ${current}` : "deleted"}). Read it again, then retry against its current content.`);
}

const decoder = () => new TextDecoder("utf-8", { fatal: false });
const binary = (data: Buffer) => data.subarray(0, 8000).includes(0);

export async function runVolumeTool(volumes: VolumeService, context: ToolContext, name: string, args: Record<string, any>, signal: AbortSignal): Promise<unknown> {
  signal.throwIfAborted();
  const { tenant, mounts } = context;
  if (name === "fs.list") name = "ls";
  const target = name === "ls" ? resolve(mounts, args.path) : resolve(mounts, args.path ?? (name === "grep" || name === "glob" ? undefined : ""));
  if (name === "ls" && !target) return { path: "/", entries: mounts.map(mount => ({ name: mount.path.slice(1), type: "directory", mode: mount.mode })) };
  if (!target) throw new Error("/ holds only the mounts; name a path inside one");
  const call = (op: string, extra: Record<string, unknown> = {}) => volumes.call(target.mount.volumeId, tenant, op, { path: target.path, ...extra });
  const shown = target.show(target.path);
  const file = async (): Promise<FileEntry> => {
    const stat = await call("stat").catch(error => { throw (error as HttpError).status === 404 ? new Error((error as Error).message.replace(target.path, shown)) : error; });
    if (stat.type !== "file") throw new Error(`${shown} is a directory; use ls`);
    return stat;
  };

  if (name === "read") {
    const entry = await file();
    const offset = args.offset ?? 0;
    // A file from before types were recorded is labeled by its name here, rather than a chunk read to sniff it.
    const contentType = entry.contentType ?? guessContentType(target.path);
    const about = { path: shown, version: entry.version, size: entry.size, contentType };
    const type = essence(contentType);
    if (args.encoding !== "base64" && (type.startsWith("image/") || type === "application/pdf")) {
      const model = context.model?.();
      // Shown natively: the result carries a reference the agent host turns into the image or document.
      if (model && (type !== "application/pdf" || supportsDocuments(model)) && !offset) {
        const ref = await fileRef(volumes, tenant, target.mount.volumeId, shown, { ...entry, contentType });
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
  if (name === "write" || name === "edit") {
    writable(target);
    let content: string;
    let expected = args.version;
    let contentType: string | undefined = args.contentType;
    if (name === "write") content = args.content;
    else {
      const entry = await file();
      if (args.version !== undefined && args.version !== entry.version) conflict(Object.assign(new HttpError(412, ""), { current: entry.version }), shown, args.version, "Edit");
      if (entry.size > FILE_TOOL_LIMITS.editBytes) throw new Error(`${shown} is larger than ${FILE_TOOL_LIMITS.editBytes} bytes; edit only works on smaller files`);
      const data = await volumes.readRange(tenant, entry, 0, entry.size);
      if (binary(data)) throw new Error(`${shown} is a binary file`);
      const text = decoder().decode(data);
      const count = text.split(args.old).length - 1;
      if (!count) throw new Error(`The old text was not found in ${shown}; read the file again and copy the exact text`);
      if (count > 1 && !args.replaceAll) throw new Error(`The old text appears ${count} times in ${shown}; include more surrounding text, or set replaceAll`);
      content = args.replaceAll ? text.split(args.old).join(args.new) : text.replace(args.old, () => args.new);
      // The rewrite is conditional on the version edited, so a write in between is not lost.
      expected = entry.version;
      contentType = entry.contentType;
    }
    if (args.encoding === "base64" && !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) throw new Error("content is not base64");
    signal.throwIfAborted();
    const committed = await volumes.put(tenant, target.mount.volumeId, target.path, Buffer.from(content, args.encoding === "base64" ? "base64" : "utf8"), { contentType, ifMatch: expected, by: context.agent })
      .catch(error => conflict(error, shown, args.version ?? expected, name === "write" ? "Write" : "Edit"));
    const written = { path: shown, version: committed.version, size: committed.size, contentType: committed.contentType! };
    context.onWrite?.(written);
    return written;
  }
  // js_exec's fs: whole files as bytes (base64 across the sandbox boundary) or text, within the same mount rules.
  if (name === "fs.readFile") {
    const entry = await file();
    if (entry.size > FILE_LIMITS.scriptFileBytes) throw new Error(`${shown} is larger than ${FILE_LIMITS.scriptFileBytes} bytes; read it in windows with tools.read and offset`);
    const data = await volumes.readRange(tenant, entry, 0, entry.size);
    return ["utf8", "utf-8"].includes(args.encoding) ? { text: decoder().decode(data) } : { data: data.toString("base64") };
  }
  if (name === "fs.writeFile") {
    writable(target);
    const data = typeof args.text === "string" ? Buffer.from(args.text, "utf8") : typeof args.data === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(args.data) ? Buffer.from(args.data, "base64") : undefined;
    if (!data) throw new Error("fs.writeFile takes a string or a Uint8Array");
    if (data.length > FILE_LIMITS.scriptFileBytes) throw new Error(`fs.writeFile writes at most ${FILE_LIMITS.scriptFileBytes} bytes at a time`);
    signal.throwIfAborted();
    const { path: _path, chunks: _chunks, by: _by, ...entry } = await volumes.put(tenant, target.mount.volumeId, target.path, data, { contentType: args.contentType, by: context.agent });
    context.onWrite?.({ path: shown, version: entry.version, size: entry.size, contentType: entry.contentType! });
    return { path: shown, ...entry };
  }
  if (name === "fs.stat") {
    const stat = await call("stat").catch(error => { throw (error as HttpError).status === 404 ? new Error(`${shown} does not exist`) : error; });
    if (stat.type !== "file") return { path: shown, type: "directory" };
    return { path: shown, type: "file", size: stat.size, version: stat.version, updatedAt: stat.updatedAt, contentType: await volumes.contentType(tenant, target.path, stat) };
  }
  if (name === "fs.remove") {
    writable(target);
    const removed = await call("remove", { by: context.agent }).catch(error => { throw (error as HttpError).status === 404 ? new Error(`${shown} does not exist`) : error; });
    return { path: shown, deleted: true, seq: removed.seq };
  }
  if (name === "present_file") {
    const entry = await file();
    const contentType = await volumes.contentType(tenant, target.path, entry);
    const presented = { type: "file" as const, path: shown, volume: target.mount.volumeId, version: entry.version, size: entry.size, contentType, chunks: entry.chunks, ...(typeof args.caption === "string" ? { caption: args.caption } : {}) };
    context.onPresent?.(presented, target.path);
    return { path: shown, version: entry.version, size: entry.size, contentType, presented: true };
  }
  if (name === "ls") {
    const listing = await call("ls").catch(error => { throw (error as HttpError).status === 404 ? new Error((error as Error).message.replace(target.path, shown)) : error; });
    return { path: shown, entries: listing.entries, ...(listing.truncated ? { truncated: true } : {}) };
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
