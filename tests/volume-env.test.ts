import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { VolumeEnv } from "../src/volume-env.ts";
import { FILE_TOOL_LIMITS, runVolumeTool, volumeToolDefinitions, type WrittenFile } from "../src/volume-tools.ts";
import { HttpError } from "../src/http.ts";
import type { FileEntry, VolumeService } from "../src/volumes.ts";
import { contentResult, scriptValue } from "../src/mcp-results.ts";
import { fileServer } from "../src/tool-servers.ts";

/** Exercise the real Pi tools and volume adapter without a database; entries retain immutable bytes. */
function fixture() {
  let version = 0;
  const files = new Map<string, FileEntry>();
  const bytes = new Map<number, Buffer>();
  const writes: WrittenFile[] = [];
  const seed = (path: string, content: string | Buffer, contentType = "text/plain") => {
    const data = Buffer.from(content);
    const entry = { version: ++version, size: data.length, chunks: [], updatedAt: version, contentType };
    files.set(path, entry);
    bytes.set(version, data);
    return entry;
  };
  let beforePut: (() => void) | undefined;
  const volumes = {
    call: async (_id: string, _tenant: string, op: string, args: any) => {
      const entry = files.get(args.path);
      if (op === "stat") {
        if (entry) return { ...entry, type: "file", path: args.path };
        if (args.path === "/" || [...files.keys()].some(path => path.startsWith(`${args.path}/`))) return { type: "directory", path: args.path };
        throw new HttpError(404, `${args.path} does not exist`);
      }
      throw new Error(`Unexpected ${op}`);
    },
    readRange: async (_tenant: string, entry: FileEntry, offset: number, length: number) => bytes.get(entry.version)!.subarray(offset, offset + length),
    put: async (_tenant: string, _id: string, path: string, content: Buffer, options: any) => {
      beforePut?.();
      if (options.ifMatch !== undefined && files.get(path)?.version !== options.ifMatch) throw new HttpError(412, "stale");
      return seed(path, content, options.contentType);
    },
  } as unknown as VolumeService;
  const owner = { tenant: "t", agent: "a", mounts: [{ volumeId: "v", path: "/workspace", mode: "rw" as const }], seen: new Map<string, number>(), onWrite: (file: WrittenFile) => writes.push(file) };
  const signal = new AbortController().signal;
  const call = (name: string, args: Record<string, unknown>) => runVolumeTool(volumes, owner, name, args, signal) as Promise<any>;
  return { volumes, owner, seed, call, writes, text: (path: string) => bytes.get(files.get(path)!.version)!.toString(), race: (fn: () => void) => { beforePut = fn; } };
}

test("Pi edits several original spans, matches fuzzy whitespace and returns diffs", async () => {
  const f = fixture();
  f.seed("/plan.txt", "first  \nsecond\nthird\n");
  const result = await f.call("edit", { path: "/workspace/plan.txt", edits: [{ oldText: "first\n", newText: "FIRST\n" }, { oldText: "third", newText: "THIRD" }] });
  assert.equal(f.text("/plan.txt"), "FIRST\nsecond\nTHIRD\n");
  assert.match(result.content[0].text, /2 block/);
  assert.match(result.details.diff, /FIRST/);
  assert.match(result.details.patch, /THIRD/);
  assert.equal(f.writes.length, 1);
  await assert.rejects(f.call("edit", { path: "/workspace/plan.txt", edits: [{ oldText: "missing", newText: "x" }] }), /Could not find/);
});

test("Pi edit refuses a change between its read and conditional write", async () => {
  const f = fixture();
  f.seed("/plan.txt", "old");
  f.race(() => f.seed("/plan.txt", "someone else's work"));
  await assert.rejects(f.call("edit", { path: "/workspace/plan.txt", edits: [{ oldText: "old", newText: "new" }] }), /changed since you last read it; read it again/);
  assert.equal(f.text("/plan.txt"), "someone else's work");
  assert.equal(f.writes.length, 0);
});

test("text windows use lines; missing files and directories remain readable errors", async () => {
  const f = fixture();
  f.seed("/dir/plan.txt", "one\ntwo\nthree\nfour");
  const result = await f.call("read", { path: "dir/plan.txt", offset: 2, limit: 2 });
  assert.equal(result.content[0].text, "two\nthree");
  assert.match(result.content[1].text, /offset=4/);
  assert.equal(scriptValue(contentResult({ content: result.content, structuredContent: result.details })).content, "two\nthree");
  await assert.rejects(f.call("read", { path: "/workspace/missing.txt" }), /does not exist/);
  await assert.rejects(f.call("read", { path: "/workspace/dir" }), /is a directory/);
});

test("writes create implicit directories and retain stale-read protection", async () => {
  const f = fixture();
  await f.call("write", { path: "/workspace/new/dir/plan.txt", content: "created" });
  assert.equal(f.text("/new/dir/plan.txt"), "created");
  assert.equal(f.writes[0].path, "/workspace/new/dir/plan.txt");
  f.seed("/new/dir/plan.txt", "changed");
  await assert.rejects(f.call("write", { path: "/workspace/new/dir/plan.txt", content: "stale" }), /changed since/);
  await f.call("read", { path: "/workspace/new/dir/plan.txt" });
  await f.call("write", { path: "/workspace/new/dir/plan.txt", content: "fresh" });
  assert.equal(f.text("/new/dir/plan.txt"), "fresh");
});

test("a removed mount rejects the next write and a new mount accepts it", async () => {
  const f = fixture();
  await f.call("write", { path: "/workspace/one.txt", content: "one" });
  f.owner.mounts = [{ volumeId: "new-volume", path: "/new", mode: "rw" }];
  await assert.rejects(f.call("write", { path: "/workspace/two.txt", content: "two" }), /is not inside a mount/);
  assert.equal(f.writes.length, 1, "the rejected call writes nothing");
  const result = await f.call("write", { path: "/new/two.txt", content: "two" });
  assert.equal(result.content[0].text, "Successfully wrote to /new/two.txt");
  assert.equal(f.writes.length, 2);
  assert.equal(f.writes[1].path, "/new/two.txt");
});

test("base64 reads and writes retain byte offsets, content type and notifications", async () => {
  const f = fixture();
  const data = Buffer.from([0, 1, 2, 255]);
  await f.call("write", { path: "/workspace/raw.bin", content: data.toString("base64"), encoding: "base64", contentType: "application/x-test" });
  const result = await f.call("read", { path: "/workspace/raw.bin", encoding: "base64", offset: 1, length: 2 });
  assert.equal(result.data, data.subarray(1, 3).toString("base64"));
  assert.equal(result.nextOffset, 3);
  assert.equal(result.contentType, "application/x-test");
  assert.equal(f.writes[0].contentType, "application/x-test");
});

test("read output and edits stay bounded; aborted and unsupported env calls fail", async () => {
  const f = fixture();
  f.seed("/large.txt", ("x".repeat(100) + "\n").repeat(20_000));
  const read = await f.call("read", { path: "/workspace/large.txt" });
  assert.ok(Buffer.byteLength(read.content[0].text) <= FILE_TOOL_LIMITS.readBytes);
  assert.equal(read.details.content, read.content[0].text);
  assert.equal(read.details.truncated, true);
  f.seed("/huge.txt", "x".repeat(FILE_TOOL_LIMITS.editBytes + 1));
  await assert.rejects(f.call("edit", { path: "/workspace/huge.txt", edits: [{ oldText: "x", newText: "y" }] }), /larger than/);
  const env = new VolumeEnv(f.volumes, f.owner);
  const listing = await env.listDir("/", BACKGROUND_CONTEXT);
  assert.equal(listing.ok, false);
  if (!listing.ok) assert.equal(listing.error.code, "not_supported");
  const shell = await env.exec();
  assert.equal(shell.ok, false);
  if (!shell.ok) assert.equal(shell.error.code, "shell_unavailable");
  const unsupported = await env.createTempDir(undefined, BACKGROUND_CONTEXT);
  if (!unsupported.ok) assert.equal(unsupported.error.code, "not_supported");
  const controller = new AbortController(); controller.abort();
  const aborted = await env.writeFile("/workspace/no.txt", "no", withAbortSignal(controller.signal, BACKGROUND_CONTEXT));
  assert.equal(aborted.ok, false);
  if (!aborted.ok) assert.equal(aborted.error.code, "aborted");
});

test("an open reader retains its version across a replacement and scans UTF-8 lines", async () => {
  const f = fixture();
  const text = "\ufeffone\né😀\nthree";
  f.seed("/plan.txt", text);
  const env = new VolumeEnv(f.volumes, f.owner);
  const opened = await env.openBinaryReader("/workspace/plan.txt", undefined, BACKGROUND_CONTEXT);
  assert.ok(opened.ok);
  const reader = opened.value;
  f.seed("/plan.txt", "replacement");
  const scan = await reader.scanLines({ startLine: 1, endLine: 2 }, BACKGROUND_CONTEXT);
  assert.ok(scan.ok);
  const selected = await reader.read(scan.value.start, scan.value.end - scan.value.start, BACKGROUND_CONTEXT);
  assert.ok(selected.ok);
  assert.equal(Buffer.from(selected.value).toString(), "é😀");
  assert.equal(scan.value.newlines, 2);
  const info = await reader.info(BACKGROUND_CONTEXT);
  assert.ok(info.ok);
  assert.equal(info.value.size, Buffer.byteLength(text));
  await reader.close(BACKGROUND_CONTEXT);
});

test("file server forwards Pi content and edit details through the existing pipeline", async () => {
  const f = fixture();
  f.seed("/plan.txt", "old");
  const definitions = volumeToolDefinitions();
  const edit = definitions.find(tool => tool.name === "edit")!;
  assert.equal(edit.exposure, "both");
  assert.equal(edit.executionMode, "sequential");
  assert.deepEqual((edit.parameters as any).required, ["path", "edits"]);
  const server = fileServer(definitions, call => f.call(call.name, call.args));
  const result = await server.call({ name: "edit", args: { path: "/workspace/plan.txt", edits: [{ oldText: "old", newText: "new" }] }, signal: new AbortController().signal });
  assert.match(result.content![0].text, /Successfully replaced/);
  assert.match((result.structuredContent as any).diff, /new/);
});
