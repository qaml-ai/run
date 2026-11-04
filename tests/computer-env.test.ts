import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ComputerEnv, ComputerFiles, type ComputerMount } from "../src/computer-env.ts";
import { runVolumeTool, FILE_TOOL_LIMITS, volumeToolDefinitions, type ToolContext } from "../src/volume-tools.ts";
import { environmentSummary } from "../src/system-prompt.ts";
import { fileReceipts } from "../src/computers/providers.ts";
import { COMPUTER_TOOLS } from "../src/computers/service.ts";
import { PNG } from "./file-fixtures.ts";
import { guessContentType } from "../src/files.ts";
import { HttpError } from "../src/http.ts";
import type { VolumeService } from "../src/volumes.ts";

const exec = promisify(execFile);
async function fixture(t: any) {
  const home = await mkdtemp(join(tmpdir(), "computer-env-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  // The driver contract is Linux. On macOS use local GNU utilities, without a VM or network.
  const core = existsSync("/opt/homebrew/opt/coreutils/libexec/gnubin") ? "/opt/homebrew/opt/coreutils/libexec/gnubin:" : "";
  const find = process.platform !== "darwin" ? "" : `find() { python3 -c 'import os,sys; root=sys.argv[1]; shallow="-maxdepth" in sys.argv; files="-type" in sys.argv\nfor p,ds,fs in os.walk(root):\n for n in (fs if files else ds+fs):\n  sys.stdout.buffer.write((os.path.relpath(os.path.join(p,n),root)+"\\0").encode())\n if shallow: break' "$@"; }; `;
  const data = new Map<string, any>(); let seq = 0, copies = 0;
  const seed = (id: string, path: string, text: string | Buffer) => { const bytes = Buffer.from(text); const entry = { path, type: "file", version: ++seq, size: bytes.length, updatedAt: seq, contentType: guessContentType(path), chunks: [], bytes }; data.set(`${id}:${path}`, entry); return entry; };
  const volumes = {
    async call(id: string, _tenant: string, op: string, args: any) {
      const key = `${id}:${args.path}`, entry = data.get(key);
      const children = [...data].filter(([key]) => key.startsWith(`${id}:${args.path === "/" ? "" : args.path}/`)).map(([, entry]) => entry);
      if (op === "stat") { if (entry) return entry; if (children.length || args.path === "/") return { path: args.path, type: "directory" }; throw new HttpError(404, "missing"); }
      if (op === "list") return { files: entry ? [entry] : children.slice(0, args.limit), next: children.length > args.limit };
      if (op === "remove") { if (args.ifMatch !== undefined && entry?.version !== args.ifMatch) throw new HttpError(412, "changed"); data.delete(key); return {}; }
      if (op === "copy" || op === "rename") { copies++; const written = (entry ? [entry] : children).map(source => seed(id, args.to + source.path.slice(args.path.length), source.bytes)); if (op === "rename") for (const source of entry ? [entry] : children) data.delete(`${id}:${source.path}`); return { files: written }; }
      throw new Error(op);
    },
    async put(_tenant: string, id: string, path: string, source: any, options: any = {}) { const parts: Buffer[] = []; if (source instanceof Uint8Array) parts.push(Buffer.from(source)); else for await (const chunk of source) parts.push(chunk); const current = data.get(`${id}:${path}`); if (options.ifMatch !== undefined && (current?.version ?? 0) !== options.ifMatch) throw new HttpError(412, "changed"); return seed(id, path, Buffer.concat(parts)); },
    async readRange(_tenant: string, entry: any, offset: number, length: number) { return entry.bytes.subarray(offset, offset + length); },
    async *stream(_tenant: string, entry: any) { yield entry.bytes; },
  } as unknown as VolumeService;
  let transfers = 0;
  const computer: ComputerMount = {
    id: "session-one",
    async exec(command) {
      try { const result = await exec("bash", ["-c", find + command], { env: { ...process.env, HOME: home, PATH: core + process.env.PATH }, maxBuffer: 70000 }); return { exitCode: 0, stdout: result.stdout.slice(0, 65536), truncated: result.stdout.length > 65536 }; }
      catch (error: any) { return { exitCode: error.code, stdout: error.stdout, stderr: error.stderr }; }
    },
    async transfer(context, upload, args) {
      transfers++;
      const local = upload ? args.from : args.to;
      const mount = context.mounts.find(m => local.startsWith(m.path + "/"))!;
      const path = local.slice(mount.path.length);
      const remote = join(home, upload ? args.to : args.from);
      if (upload) { await mkdir(join(remote, ".."), { recursive: true }); await writeFile(remote, data.get(`${mount.volumeId}:${path}`).bytes); }
      else await volumes.put("t", mount.volumeId, path, await readFile(remote));
      const bytes = await readFile(remote);
      return { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    },
  };
  const owner: ToolContext = { tenant: "t", agent: "a", mounts: [{ path: "/workspace", volumeId: "v", mode: "rw" }, { path: "/other", volumeId: "w", mode: "rw" }], computer: async () => computer, seen: new Map() };
  const call = (name: string, args: any) => runVolumeTool(volumes, owner, name, args, new AbortController().signal) as Promise<any>;
  return { home, computer, owner, volumes, call, seed, data, copies: () => copies, transfers: () => transfers };
}

test("computer Pi read/write/edit round trip, windows, conflict, binary and missing files", async t => {
  const f = await fixture(t);
  await f.call("write", { path: "/computer/new/plan.txt", content: "one\ntwo\nthree" });
  assert.equal((await f.call("read", { path: "/computer/new/plan.txt", offset: 2, limit: 1 })).content[0].text, "two");
  await f.call("edit", { path: "/computer/new/plan.txt", edits: [{ oldText: "two", newText: "TWO" }] });
  assert.equal(await readFile(join(f.home, "new/plan.txt"), "utf8"), "one\nTWO\nthree");
  await writeFile(join(f.home, "new/plan.txt"), "one\nNEW\nthree");
  await assert.rejects(f.call("edit", { path: "/computer/new/plan.txt", edits: [{ oldText: "NEW", newText: "stale" }] }), /changed since/);
  await assert.rejects(f.call("read", { path: "/computer/missing" }), /does not exist/);
  const bytes = Buffer.alloc(40000, 255);
  await f.call("write", { path: "/computer/data.bin", content: bytes.toString("base64"), encoding: "base64" });
  assert.equal((await f.call("read", { path: "/computer/data.bin", encoding: "base64", offset: 15000, length: 13000 })).data, bytes.subarray(15000, 28000).toString("base64"));
  await assert.rejects(f.call("write", { path: "/computer/large", content: "x".repeat(FILE_TOOL_LIMITS.editBytes + 1) }), /limited|larger/);
  await writeFile(join(f.home, "large"), Buffer.alloc(FILE_TOOL_LIMITS.editBytes + 1));
  const env = new ComputerEnv(f.computer, f.owner);
  assert.equal((await env.readTextFile("/computer/large", BACKGROUND_CONTEXT)).ok, false);
  assert.equal((await env.exists("/computer/missing", BACKGROUND_CONTEXT)).ok, true);
});

test("routing covers mounts, stopped and absent computers, reads and writes, listings and searches", async t => {
  const f = await fixture(t);
  f.seed("v", "/local", "local");
  assert.equal((await f.call("read", { path: "local" })).content[0].text, "local");
  await f.call("write", { path: "/computer/sub/hello.txt", content: "hello\nworld" });
  assert.equal((await f.call("read", { path: "/computer/sub/hello.txt" })).content[0].text, "hello\nworld");
  assert.equal((await f.call("ls", { path: "/computer" })).entries.find((entry: any) => entry.name === "sub").type, "directory");
  assert.equal((await f.call("ls", { path: "/" })).entries.at(-1).name, "computer");
  assert.equal((await f.call("ls", { path: "/computer/sub" })).entries[0].name, "hello.txt");
  assert.deepEqual((await f.call("glob", { path: "/computer", pattern: "**/*.{txt,md}" })).paths, ["/computer/sub/hello.txt"]);
  assert.deepEqual((await f.call("grep", { path: "/computer", pattern: "WORLD", ignoreCase: true })).matches, [{ path: "/computer/sub/hello.txt", line: 2, text: "world" }]);
  f.owner.computer = async () => null;
  await assert.rejects(f.call("read", { path: "/computer/sub/hello.txt" }), /your computer isn't running; call computer_start/);
  assert.equal((await f.call("ls", { path: "/" })).entries.length, 2);
  f.owner.computer = async () => undefined;
  await assert.rejects(f.call("read", { path: "/computer/sub/hello.txt" }), /not inside a mount/);
});

test("cp and mv cover every pair, directory recursion, exact destinations and read-only mounts", async t => {
  const f = await fixture(t);
  f.seed("v", "/source", "bytes");
  assert.deepEqual(await f.call("cp", { from: "/workspace/source", to: "/workspace/copy" }), { from: "/workspace/source", to: "/workspace/copy", files: 1, bytes: 5 });
  assert.equal(f.copies(), 1);
  await f.call("mv", { from: "/workspace/copy", to: "/other/moved" });
  assert.equal(f.data.has("v:/copy"), false);
  await f.call("cp", { from: "/other/moved", to: "/computer/copied" });
  await f.call("mv", { from: "/computer/copied", to: "/computer/renamed" });
  await f.call("cp", { from: "/computer/renamed", to: "/computer/again" });
  await f.call("mv", { from: "/computer/renamed", to: "/workspace/back" });
  assert.equal(f.transfers(), 2);
  assert.equal(f.data.get("v:/back").bytes.toString(), "bytes");
  await assert.rejects(readFile(join(f.home, "renamed")), /ENOENT/);
  await assert.rejects(f.call("cp", { from: "/workspace/source", to: "/workspace/back" }), /Destination exists/);
  f.seed("v", "/dir/a", "a"); f.seed("v", "/dir/sub/b", "bb");
  await assert.rejects(f.call("cp", { from: "/workspace/dir", to: "/computer/dir" }), /recursive/);
  assert.equal((await f.call("cp", { from: "/workspace/dir", to: "/computer/dir", recursive: true })).files, 2);
  await f.call("mv", { from: "/computer/dir", to: "/computer/tree" });
  await f.call("cp", { from: "/computer/tree", to: "/other/tree", recursive: true });
  assert.equal(f.data.get("w:/tree/sub/b").bytes.toString(), "bb");
  f.owner.mounts[1].mode = "ro";
  await assert.rejects(f.call("cp", { from: "/workspace/source", to: "/other/no" }), /read-only/);
  await assert.rejects(f.call("mv", { from: "/other/moved", to: "/workspace/no" }), /read-only/);
  await assert.rejects(f.call("cp", { from: "/computer/tree", to: "/computer/tree/sub", recursive: true }), /inside/);
});

test("computer errors are sanitized and removed tools are not registered", async () => {
  const files = new ComputerFiles({ id: "x", exec: async () => { throw new Error("secret provider URL"); }, transfer: async () => {} });
  await assert.rejects(files.stat("/x"), error => !String(error).includes("secret"));
  assert.equal(COMPUTER_TOOLS.has("computer_upload"), false);
  assert.equal(COMPUTER_TOOLS.has("computer_download"), false);
  for (const name of ["mv", "cp"]) { const tool = volumeToolDefinitions().find(t => t.name === name)!; assert.equal(tool.exposure, "both"); assert.equal(tool.executionMode, "sequential"); }
});

test("copy bounds and failed transfers never delete their source", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 1001; i++) f.seed("v", `/many/${i}`, "x");
  await assert.rejects(f.call("cp", { from: "/workspace/many", to: "/other/many", recursive: true }), /1000 files/);
  assert.equal(f.data.has("w:/many/0"), false);
  f.seed("v", "/source", "retain me");
  f.computer.transfer = async () => { throw new Error("Receipt mismatch"); };
  await assert.rejects(f.call("mv", { from: "/workspace/source", to: "/computer/dest" }), /Receipt mismatch/);
  assert.equal(f.data.get("v:/source").bytes.toString(), "retain me");
});

test("atomic writes preserve the old file when the final conflict check fails", async t => {
  const f = await fixture(t);
  await f.call("write", { path: "/computer/file", content: "original" });
  const execute = f.computer.exec;
  let changed = false;
  f.computer.exec = async (command, receipts) => {
    if (!changed && command.includes("mv -fT")) { changed = true; await writeFile(join(f.home, "file"), "concurrent"); }
    return execute(command, receipts);
  };
  await assert.rejects(f.call("write", { path: "/computer/file", content: "replace" }), /changed since/);
  assert.equal(await readFile(join(f.home, "file"), "utf8"), "concurrent");
});


test("the prompt describes computer lifetime and receipts omit provider output", () => {
  const prompt = environmentSummary({ model: { input: ["text"] } as any, tools: [], mounts: [{ path: "/computer", mode: "rw", computer: true }] });
  assert.match(prompt!, /home directory/);
  assert.match(prompt!, /gone after it expires/);
  assert.doesNotMatch(prompt!, /Attachments are saved/);
  assert.deepEqual(fileReceipts({ exitCode: 0, stdout: "provider secret\nCAMEL_OK aGVsbG8=\n", stderr: "signed URL secret" }), { exitCode: 0, stdout: "CAMEL_OK aGVsbG8=", truncated: false });
});

test("small computer bytes use one inline data command; large reads and writes transfer and clean scratch", async t => {
  const f = await fixture(t);
  const commands: string[] = [];
  const execute = f.computer.exec;
  f.computer.exec = async (command, receipts) => { commands.push(command); return execute(command, receipts); };
  const small = Buffer.alloc(32 * 1024, 255);
  await f.call("write", { path: "/computer/small", content: small.toString("base64"), encoding: "base64" });
  assert.equal(f.transfers(), 0);
  assert.equal(commands.filter(c => c.includes("base64 -d")).length, 1);
  commands.length = 0;
  assert.equal((await f.call("read", { path: "/computer/small", encoding: "base64" })).data, small.toString("base64"));
  assert.equal(commands.filter(c => c.includes("tail -c")).length, 1);
  assert.ok(commands.every(c => !c.includes("dd ") && !c.includes("base64 -w0 | base64")));
  assert.equal(f.transfers(), 0);
  const large = Buffer.alloc(1024 * 1024, 253);
  commands.length = 0;
  const files = new ComputerFiles(f.computer, { volumes: f.volumes, context: f.owner });
  await files.put("t", "", "/large", large);
  assert.equal(f.transfers(), 1);
  assert.ok(commands.every(c => c.length < 2000));
  const entry = await files.stat("/large");
  assert.deepEqual(await files.readRange("t", entry, 123, large.length - 246), large.subarray(123, -123));
  assert.equal(f.transfers(), 2);
  assert.equal([...f.data.keys()].filter(k => k.includes("/.camel/computer/")).length, 0);
  assert.deepEqual((await readdir(f.home)).sort(), ["large", "small"]);
});

test("failed transfer receipts and concurrent large writes clean scratch and preserve destination", async t => {
  const f = await fixture(t);
  await f.call("write", { path: "/computer/file", content: "original" });
  const transfer = f.computer.transfer;
  f.computer.transfer = async (...args) => { await transfer(...args); return { size: 40000, sha256: "bad" }; };
  await assert.rejects(f.call("write", { path: "/computer/file", content: Buffer.alloc(40000).toString("base64"), encoding: "base64" }), /receipt mismatch/);
  assert.equal(await readFile(join(f.home, "file"), "utf8"), "original");
  assert.equal(f.data.size, 0);
  assert.deepEqual(await readdir(f.home), ["file"]);
  f.computer.transfer = async (...args) => { const result = await transfer(...args); if (args[1]) await writeFile(join(f.home, "file"), "concurrent"); return result; };
  await assert.rejects(f.call("write", { path: "/computer/file", content: "x".repeat(40000) }), /changed since/);
  assert.equal(await readFile(join(f.home, "file"), "utf8"), "concurrent");
  assert.equal(f.data.size, 0);
  assert.deepEqual(await readdir(f.home), ["file"]);
});

test("computer image scratch is removed and presented copies remain hidden", async t => {
  const f = await fixture(t);
  await writeFile(join(f.home, "image.png"), PNG);
  let pinned = 0;
  (f.volumes as any).pin = async () => { assert.equal(f.data.size, 1); pinned++; };
  f.owner.model = () => ({ input: ["text", "image"] }) as any;
  const read = await f.call("read", { path: "/computer/image.png" });
  assert.equal(read.file.media.kind, "image");
  assert.equal(pinned, 1);
  assert.equal(f.data.size, 0);
  (f.volumes as any).contentType = async () => "image/png";
  const result = await f.call("present_file", { path: "/computer/image.png" });
  assert.match(result.path, /^\/workspace\/\.camel\/computer\/[^/]+\/image\.png$/);
  assert.equal(f.data.size, 1);
});

test("large reads check the version after transfer and clean up failed downloads", async t => {
  const f = await fixture(t);
  await writeFile(join(f.home, "file"), Buffer.alloc(40000, 1));
  const files = new ComputerFiles(f.computer, { volumes: f.volumes, context: f.owner });
  const entry = await files.stat("/file");
  const transfer = f.computer.transfer;
  f.computer.transfer = async (...args) => {
    const result = await transfer(...args);
    await writeFile(join(f.home, "file"), Buffer.alloc(40001, 2));
    return result;
  };
  await assert.rejects(files.readRange("t", entry, 0, entry.size), /changed since/);
  assert.equal(f.data.size, 0);
  const current = await files.stat("/file");
  f.computer.transfer = async (...args) => { await transfer(...args); throw new Error("Transfer failed"); };
  await assert.rejects(files.readRange("t", current, 0, current.size), /Transfer failed/);
  assert.equal(f.data.size, 0);
});
