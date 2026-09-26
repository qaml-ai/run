import { Worker } from "node:worker_threads";
import type { ToolDefinition } from "./protocol.ts";
import { HttpError } from "./http.ts";
import { normalizePath, type FileEntry, type Mount, type VolumeService } from "./volumes.ts";

/**
 * File tools over an agent's mounts: read, write, edit, ls, glob and grep. They
 * run in the runtime (never the sandbox), as direct tools and from js_exec. Paths
 * are mount paths (`/workspace/notes.md`); results stay small, so large files are
 * read in windows and searched without entering the model's context.
 */
export const FILE_TOOL_LIMITS = Object.freeze({
  readBytes: 32 * 1024, maxReadBytes: 128 * 1024, editBytes: 1024 * 1024,
  globResults: 200, maxGlobResults: 1000,
  grepMatches: 50, maxGrepMatches: 200, grepFiles: 1000, grepFileBytes: 4 * 1024 * 1024, grepBytes: 32 * 1024 * 1024, grepLine: 240, grepMs: 10_000,
});
export type ToolContext = { tenant: string; agent: string; mounts: Mount[] };

const path = (description: string) => ({ type: "string", description });
export function volumeToolDefinitions(mounts: Mount[]): ToolDefinition[] {
  const where = `Mounted: ${mounts.map(mount => `${mount.path} (${mount.mode === "ro" ? "read-only" : "read-write"})`).join(", ")}. Relative paths resolve against ${mounts[0]?.path}.`;
  const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition => ({
    name, description: `${description} ${where}`, exposure: "both", executionMode: name === "write" || name === "edit" ? "sequential" : "parallel",
    parameters: { type: "object", additionalProperties: false, properties, required },
  });
  const version = { type: "integer", minimum: 0, description: "Only succeed if the file is still at this version (from read or ls); 0 means it must not exist yet" };
  return [
    tool("read", `Read a text file. Returns up to ${FILE_TOOL_LIMITS.readBytes} bytes from offset (at most ${FILE_TOOL_LIMITS.maxReadBytes}); nextOffset is set when more remains. Returns its version, for edit and write.`,
      { path: path("File path"), offset: { type: "integer", minimum: 0 }, length: { type: "integer", minimum: 1, maximum: FILE_TOOL_LIMITS.maxReadBytes } }, ["path"]),
    tool("write", "Create or replace a text file.", { path: path("File path"), content: { type: "string" }, version }, ["path", "content"]),
    tool("edit", "Replace an exact text span in a file (old must appear once unless replaceAll). Pass the version from your last read so an edit based on a stale read is rejected.",
      { path: path("File path"), old: { type: "string", minLength: 1 }, new: { type: "string" }, replaceAll: { type: "boolean" }, version }, ["path", "old", "new"]),
    tool("ls", "List a directory's entries with sizes and versions. / lists the mounts.", { path: path("Directory path") }, []),
    tool("glob", `Find files by glob (*, ?, **, {a,b}) relative to path; at most ${FILE_TOOL_LIMITS.maxGlobResults} results.`,
      { pattern: { type: "string" }, path: path("Directory to search"), limit: { type: "integer", minimum: 1, maximum: FILE_TOOL_LIMITS.maxGlobResults } }, ["pattern"]),
    tool("grep", `Search file contents line by line for text (or a regular expression with regex: true). Returns at most ${FILE_TOOL_LIMITS.maxGrepMatches} matching lines; files over ${FILE_TOOL_LIMITS.grepFileBytes} bytes and binary files are skipped.`,
      { pattern: { type: "string", minLength: 1, maxLength: 512 }, path: path("File or directory to search"), glob: { type: "string" }, regex: { type: "boolean" }, ignoreCase: { type: "boolean" }, limit: { type: "integer", minimum: 1, maximum: FILE_TOOL_LIMITS.maxGrepMatches } }, ["pattern"]),
  ];
}

type Resolved = { mount: Mount; path: string; show: (volumePath: string) => string };
function resolve(mounts: Mount[], input: unknown): Resolved | undefined {
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
    if (offset > entry.size) throw new Error(`offset ${offset} is past the end of ${shown} (${entry.size} bytes)`);
    const data = await volumes.readRange(tenant, entry, offset, args.length ?? FILE_TOOL_LIMITS.readBytes);
    if (binary(data)) return { path: shown, version: entry.version, size: entry.size, binary: true, note: "Binary file; its content is not shown" };
    // A window may end inside a UTF-8 sequence: stop before it, and continue from there.
    const content = decoder().decode(data, { stream: offset + data.length < entry.size });
    const next = offset + Buffer.byteLength(content);
    return { path: shown, version: entry.version, size: entry.size, offset, content, ...(next < entry.size ? { nextOffset: next } : {}) };
  }
  if (name === "write" || name === "edit") {
    writable(target);
    let content: string;
    let expected = args.version;
    let contentType: string | undefined;
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
    signal.throwIfAborted();
    const committed = await volumes.put(tenant, target.mount.volumeId, target.path, Buffer.from(content, "utf8"), { contentType, ifMatch: expected, by: context.agent })
      .catch(error => conflict(error, shown, args.version ?? expected, name === "write" ? "Write" : "Edit"));
    return { path: shown, version: committed.version, size: committed.size, contentType: committed.contentType };
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
