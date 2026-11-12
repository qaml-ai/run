import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { chmod, mkdtemp, mkdir, readFile, lstat, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { HostAgent } from "../jobhost/agent.ts";
import { type Camelfsd } from "../jobhost/camelfsd.ts";
import { fakeLauncher, type VmLauncher } from "../jobhost/vm.ts";
import { FrameReader, WIRE, checkPath, encodeFrame, jsonFrame } from "../jobhost/camelfs-wire.ts";
import { Frames, base64Text, type HostMessage, type WireJob, type WireResult } from "../shared/job-host-protocol.ts";

async function host(t: TestContext, camelfsd?: Camelfsd, launcher = fakeLauncher()): Promise<{ agent: HostAgent; hello: Extract<HostMessage, { type: "hello" }>; result: Promise<WireResult>; logs: Record<string, unknown>[] }> {
  const server = createServer((_req, res) => res.end(JSON.stringify({ host: "test-host", credential: "test-only", expiresAt: Date.now() + 3600_000 })));
  const sockets = new WebSocketServer({ server });
  const hello = Promise.withResolvers<Extract<HostMessage, { type: "hello" }>>(), result = Promise.withResolvers<WireResult>();
  sockets.on("connection", socket => {
    const frames = new Frames();
    socket.on("message", data => {
      const message = frames.add(String(data)) as HostMessage | undefined;
      if (message?.type === "hello") { hello.resolve(message); socket.send(JSON.stringify({ type: "registered", host: "test-host" })); }
      if (message?.type === "result") result.resolve(message.result);
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const logs: Record<string, unknown>[] = [];
  const agent = new HostAgent({ runtime: `http://127.0.0.1:${(server.address() as { port: number }).port}`, attest: async () => ({ kind: "test", host: "test-host", secret: "test-only" }), slots: 1, vcpus: 1, memoryMiB: 512, diskLowBytes: 0, camelfsd, launcher, log: line => logs.push(line) });
  t.after(async () => { await agent.close(); for (const socket of sockets.clients) socket.terminate(); await new Promise<void>(resolve => sockets.close(() => resolve())); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await agent.start();
  return { agent, hello: await hello.promise, result: result.promise, logs };
}

const tree = "a".repeat(40), header = { v: 1, kind: "apply", jobId: "job-1", fromTree: tree, toTree: tree };
const spec: WireJob = { command: "true", files: [], outputs: [], internet: false, limits: {}, timeoutSeconds: 5, camelfs: { lineage: "test", tree } };
const entry = (path: string, mode = "100644", size = 3) => ({ path, mode, size, sha1: tree });

test("codec round trip, fragmented frames, bounds and JSON objects", async () => {
  const stream = new PassThrough(), reader = new FrameReader(stream);
  const bytes = Buffer.concat([encodeFrame({ hello: "world" }), encodeFrame(Buffer.from("raw"))]);
  for (const byte of bytes) stream.write(Buffer.from([byte]));
  stream.end();
  assert.deepEqual(jsonFrame((await reader.next())!), { hello: "world" });
  assert.equal((await reader.next())!.toString(), "raw"); assert.equal(await reader.next(), null);
  const oversized = new PassThrough(), bad = new FrameReader(oversized), prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(WIRE.frameMax + 1); oversized.write(prefix);
  await assert.rejects(bad.next(), /frameMax/); oversized.destroy();
  assert.throws(() => jsonFrame(Buffer.from(JSON.stringify({ a: "x".repeat(WIRE.jsonMax) }))), /jsonMax/);
  for (const value of ["null", "[]", "1"]) assert.throws(() => jsonFrame(Buffer.from(value)), /plain object/);
  const truncated = new PassThrough(), short = new FrameReader(truncated);
  truncated.end(Buffer.from([0, 0])); await assert.rejects(short.next(), /EOF/);
});

test("checkPath byte and component rules", () => {
  assert.equal(checkPath("a/b.ts"), "a/b.ts");
  for (const path of ["", "/a", "a/../b", "./a", "a//b", "a\0b", ".git", ".git/config", "a".repeat(256), "a/".repeat(2048) + "x", "é".repeat(128), "\ud800"])
    assert.throws(() => checkPath(path), JSON.stringify(path));
});

async function setup(t: TestContext, frames: unknown[], options: { prepare?: (repo: string, root: string) => Promise<void>; command?: string; timeoutMs?: number; close?: boolean; silent?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "cfs-apply-")), repo = join(dir, "disk");
  await mkdir(repo); await options.prepare?.(repo, dir);
  const reply = Promise.withResolvers<Record<string, unknown> | null>(), peers = new Set<Socket>();
  const server = createNetServer({ allowHalfOpen: true }, socket => {
    peers.add(socket); socket.on("error", () => {}); socket.on("close", () => peers.delete(socket));
    void new FrameReader(socket).next().then(value => reply.resolve(value ? jsonFrame(value) : null), () => reply.resolve(null));
    if (!options.silent) {
      socket.write(Buffer.concat(frames.map(frame => encodeFrame(frame as object))));
      if (options.close) socket.end();
    }
    socket.on("end", () => socket.end());
  });
  await new Promise<void>(resolve => server.listen(join(dir, "job-1.vsock_5201"), resolve));
  t.after(async () => { for (const peer of peers) peer.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const launcher = fakeLauncher({ work: dir });
  let index: unknown;
  const wrapped: VmLauncher = { ...launcher, async boot(...args) {
    const vm = await launcher.boot(...args);
    return { ...vm, request: request => vm.request(request.op === "camelfs_apply" && options.timeoutMs ? { ...request, timeoutMs: options.timeoutMs } : request), async destroy() {
      index = await readFile(join(dir, "job-1/.camelfs/index.json"), "utf8").then(JSON.parse).catch(() => undefined);
      await vm.destroy();
    } };
  } };
  const daemon: Camelfsd = { mount: async () => ({ image: repo, warm: true, root: tree, tree, mountMs: 1, hydrating: false }), release: async () => {}, health: async () => { throw new Error("unused"); }, status: async () => { throw new Error("unused"); } };
  const h = await host(t, daemon, wrapped);
  await h.agent.run("job-1", { ...spec, command: options.command ?? "true" });
  return { result: await h.result, reply: await reply.promise, repo, index, dir };
}

test("HostAgent applies repo bytes, links, modes, deletes and persists indexed stats", async t => {
  const frames = [header, { index: [entry("bin/tool", "100755"), entry("hello"), entry("link", "120000", 5)] }, { indexEnd: true, count: 3 },
    { op: "put", path: "bin/tool", mode: "100755", size: 3 }, Buffer.from("run"),
    { op: "put", path: "hello", mode: "100644", size: 3 }, Buffer.from("new"),
    { op: "del", path: "old/nested" }, { op: "link", path: "link", target: "hello" },
    { op: "mode", path: "hello", mode: "100755" }, { end: true }];
  const r = await setup(t, frames, { command: "cat hello link", prepare: async repo => {
    await mkdir(join(repo, "old")); await writeFile(join(repo, "old/nested"), "old"); await writeFile(join(repo, ".camelfs-tmp-1"), "crash");
  } });
  assert.equal(r.result.ok, true); if (!r.result.ok) return;
  assert.equal(r.result.exitCode, 0); assert.equal(base64Text(r.result.stdout.data), "newnew");
  assert.equal(typeof r.result.camelfs?.applyMs, "number"); assert.equal(r.reply?.applied, true);
  assert.equal(await readFile(join(r.repo, "bin/tool"), "utf8"), "run");
  for (const path of ["bin/tool", "hello"]) assert.equal((await lstat(join(r.repo, path))).mode & 0o777, 0o755);
  assert.ok((await lstat(join(r.repo, "link"))).isSymbolicLink());
  for (const path of ["old", ".camelfs-tmp-1"]) await assert.rejects(lstat(join(r.repo, path)), { code: "ENOENT" });
  const index = r.index as { tree: string; entries: Record<string, unknown>[] };
  assert.equal(index.tree, tree); assert.equal(index.entries.length, 3);
  for (const entry of index.entries) for (const field of ["ino", "size", "mtimeNs", "ctimeNs"]) assert.match(entry[field] as string, /^\d+$/);
});

const empty = [{ indexEnd: true, count: 0 }];
for (const [name, frames, reason, close] of [
  ["wrong jobId", [{ ...header, jobId: "other" }], /jobId/],
  ["count mismatch", [header, { indexEnd: true, count: 1 }], /count mismatch/],
  ["missing delete", [header, ...empty, { op: "del", path: "missing" }], /ENOENT/],
  ["symlink put mode", [header, ...empty, { op: "put", path: "x", mode: "120000", size: 0 }], /120000/],
  ["bad path", [header, ...empty, { op: "del", path: "../x" }], /path/],
  ["trailer error", [header, ...empty, { end: true, error: "daemon failed" }], /daemon failed/],
  ["mid-stream EOF", [header, ...empty, { op: "put", path: "x", mode: "100644", size: 4 }, Buffer.from("ab")], /EOF/, true],
  ["raw crosses size", [header, ...empty, { op: "put", path: "x", mode: "100644", size: 1 }, Buffer.from("ab")], /crosses declared size/],
] as const) test(`apply refuses ${name} with a failure reply`, async t => {
  const r = await setup(t, [...frames], { close });
  assert.equal(r.result.ok, false); if (r.result.ok) return;
  assert.equal(r.result.code, "sync_failed"); assert.match(r.result.message, /camelFS apply failed/); assert.match(r.result.message, reason);
  assert.equal(r.reply?.applied, false); assert.match(r.reply?.error as string, reason);
});

test("apply never traverses a symlink parent", async t => {
  let outside = "";
  const r = await setup(t, [header, ...empty, { op: "put", path: "evil/f", mode: "100644", size: 1 }, Buffer.from("x")], { prepare: async (repo, root) => {
    outside = join(root, "outside"); await mkdir(outside); await symlink(outside, join(repo, "evil"));
  } });
  assert.equal(r.result.ok, false); if (r.result.ok) return;
  assert.equal(r.result.code, "sync_failed"); assert.match(r.result.message, /camelFS apply failed.*symlink/);
  assert.equal(r.reply?.applied, false); await assert.rejects(lstat(join(outside, "f")), { code: "ENOENT" });
});

test("silent daemon is bounded by the op timeout", async t => {
  const r = await setup(t, [], { silent: true, timeoutMs: 50 });
  assert.equal(r.result.ok, false); if (r.result.ok) return;
  assert.equal(r.result.code, "sync_failed"); assert.match(r.result.message, /camelFS apply failed.*timed out/);
  assert.equal(r.reply?.applied, false);
});

test("put replaces a final symlink and handles empty files named like temporary files", async t => {
  let outside = "";
  const r = await setup(t, [header, ...empty,
    { op: "put", path: "link", mode: "100644", size: 3 }, Buffer.from("new"),
    { op: "put", path: ".camelfs-tmp-2", mode: "100644", size: 0 }, { end: true },
  ], { prepare: async (repo, root) => {
    outside = join(root, "outside"); await writeFile(outside, "original"); await symlink(outside, join(repo, "link"));
  } });
  assert.equal(r.result.ok, true); assert.equal(r.reply?.applied, true);
  assert.equal(await readFile(outside, "utf8"), "original");
  assert.equal(await readFile(join(r.repo, "link"), "utf8"), "new");
  assert.equal((await lstat(join(r.repo, "link"))).mode & 0o777, 0o644);
  assert.equal((await lstat(join(r.repo, ".camelfs-tmp-2"))).size, 0);
});

test("mode refuses a final symlink", async t => {
  const r = await setup(t, [header, ...empty, { op: "mode", path: "link", mode: "100755" }], { prepare: async repo => {
    await writeFile(join(repo, "file"), "bytes"); await chmod(join(repo, "file"), 0o644); await symlink("file", join(repo, "link"));
  } });
  assert.equal(r.result.ok, false); if (r.result.ok) return;
  assert.equal(r.result.code, "sync_failed"); assert.match(r.result.message, /symlink/);
  assert.equal(r.reply?.applied, false); assert.equal((await lstat(join(r.repo, "file"))).mode & 0o777, 0o644);
});
