import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createNetServer, type Socket } from "node:net";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, lstat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { HostAgent } from "../jobhost/agent.ts";
import { camelfsdClient, type Camelfsd } from "../jobhost/camelfsd.ts";
import { fakeLauncher, type GuestReply, type VmLauncher } from "../jobhost/vm.ts";
import { FrameReader, WIRE, encodeFrame, jsonFrame } from "../jobhost/camelfs-wire.ts";
import { Guest } from "../jobhost/guest.ts";
import { Frames, type HostMessage, type WireJob, type WireResult } from "../shared/job-host-protocol.ts";

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

const tree = "a".repeat(40), newTree = "b".repeat(40);
const published = { commit: "c".repeat(40), tree: newTree, root: "new-root", parentRoot: "old-root", checkpointMs: 17,
  changedChunks: 2, uploadedChunks: 1, changedBytes: 9, reflinkMs: 1, fiemapMs: 2, hashMs: 3, uploadMs: 4 };
type Stream = { header: Record<string, unknown>; ops: Record<string, unknown>[]; data: Record<string, string>; trailer: Record<string, unknown> };

async function setup(t: TestContext, options: { command?: string; scenario?: string; second?: boolean; postDelayMs?: number; timeoutSeconds?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "cfs-cp-")), repo = join(dir, "disk"), vsock = join(dir, "job-1.vsock");
  await mkdir(repo);
  const streams: Stream[] = [], peers = new Set<Socket>(), servers: ReturnType<typeof createNetServer>[] = [];
  let pending: import("node:http").ServerResponse | undefined;
  let unarmed = 0, checkpointSpanMs = 0;
  const bodies: unknown[] = [];
  const unarmedConnection = Promise.withResolvers<void>();
  let posts = 0, before: unknown, after: unknown, second: GuestReply | undefined;
  const track = (socket: Socket) => { peers.add(socket); socket.on("error", () => {}); socket.on("close", () => peers.delete(socket)); };
  const listen = async (port: number, handler: (socket: Socket) => void) => {
    const server = createNetServer({ allowHalfOpen: true }, socket => { track(socket); handler(socket); }); servers.push(server);
    await new Promise<void>(resolve => server.listen(vsock + "_" + port, resolve));
  };
  const receive = async (socket: Socket) => {
    const reader = new FrameReader(socket), next = async () => jsonFrame((await reader.next())!);
    const stream: Stream = { header: await next(), ops: [], data: {}, trailer: {} }; streams.push(stream);
    for (;;) {
      const op = await next();
      if (op.end) { stream.trailer = op; break; }
      stream.ops.push(op);
      if (op.op === "put") {
        let remaining = Number(op.size); const chunks: Buffer[] = [];
        while (remaining) { const raw = (await reader.next())!; assert.ok(raw.length && raw.length <= WIRE.rawMax && raw.length <= remaining); chunks.push(raw); remaining -= raw.length; }
        stream.data[String(op.path)] = Buffer.concat(chunks).toString();
      }
    }
    socket.end(encodeFrame(options.scenario === "nack" ? { ack: false, error: "bad" } : { ack: true }));
  };
  await listen(5200, socket => {
    const response = pending;
    if (!response) { unarmed++; unarmedConnection.resolve(); socket.destroy(); return; }
    socket.write(encodeFrame({ ready: true }));
    void receive(socket).then(() => {
      response.statusCode = options.scenario === "fenced" ? 409 : 200;
      response.end(JSON.stringify(options.scenario === "fenced" ? { error: "fenced" } : published));
    }).catch(error => { response.statusCode = 422; response.end(JSON.stringify({ error: "bad-stream", detail: String(error) })); })
      .finally(() => { pending = undefined; });
  });
  const api = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
      if (req.url === "/v0/mounts") {
        await listen(5201, socket => {
          socket.resume(); socket.on("end", () => socket.end());
          const entries = ["edit", "delete", "exec"].map(path => ({ path, mode: "100644", size: 3, sha1: tree }));
          const frames: (object | Buffer)[] = [{ v: 1, kind: "apply", jobId: "job-1", fromTree: tree, toTree: tree }, { index: entries }, { indexEnd: true, count: entries.length }];
          for (const entry of entries) frames.push({ op: "put", path: entry.path, mode: entry.mode, size: 3 }, Buffer.from("old"));
          frames.push({ end: true }); socket.write(Buffer.concat(frames.map(encodeFrame)));
        });
        res.end(JSON.stringify({ image: repo, warm: true, root: "old-root", tree, mountMs: 1, hydrating: false }));
      } else if (req.url?.endsWith("/checkpoint")) {
        posts++; bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
        if (options.postDelayMs) {
          await unarmedConnection.promise;
          await new Promise(resolve => setTimeout(resolve, options.postDelayMs));
        }
        assert.equal(pending, undefined); pending = res;
      } else res.end("{}");
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>(resolve => api.listen(join(dir, "api.sock"), resolve));
  t.after(async () => {
    for (const socket of peers) socket.destroy();
    for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
    api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); await rm(dir, { recursive: true, force: true });
  });
  const launcher = fakeLauncher({ work: dir });
  const index = () => readFile(join(dir, "job-1/.camelfs/index.json"), "utf8").then(JSON.parse);
  const wrapped: VmLauncher = { ...launcher, async boot(...args) {
    const vm = await launcher.boot(...args);
    return { ...vm, async request(request) {
      if (request.op === "camelfs_checkpoint") before = await index();
      const started = Date.now(), reply = await vm.request(request);
      if (request.op === "camelfs_checkpoint") checkpointSpanMs = Date.now() - started;
      return reply;
    }, async destroy() {
      after = await index();
      if (options.second) {
        const daemon = camelfsdClient(join(dir, "api.sock")).checkpoint("job-1", 600_000).catch(() => undefined);
        // Wait until this POST arms the existing listener before sending the direct guest op.
        while (!pending) await new Promise(resolve => setTimeout(resolve, 1));
        second = await vm.request({ op: "camelfs_checkpoint", jobId: "job-1", timeoutMs: 1000 });
        await daemon;
        await vm.request({ op: "camelfs_checkpointed", error: "test cleanup" });
      }
      await vm.destroy();
    } };
  } };
  const h = await host(t, camelfsdClient(join(dir, "api.sock")), wrapped);
  await h.agent.run("job-1", { command: options.command ?? "printf new > edit; printf created > created; rm delete; ln -s edit link; chmod +x exec", files: [], outputs: [], internet: false, limits: {}, timeoutSeconds: options.timeoutSeconds ?? 5, camelfs: { lineage: "test", tree, commit: true } });
  return { result: await h.result, streams, before, after, second, posts, repo, unarmed, bodies, checkpointSpanMs };
}

test("round trip publishes index, exact operations and metrics; next checkpoint is empty", async t => {
  const r = await setup(t, { second: true });
  assert.equal(r.result.ok, true); if (!r.result.ok) return;
  const c = r.result.camelfs!;
  assert.deepEqual(r.bodies, [{ timeoutMs: 600_000, trailers: { kind: "job", job: "job-1", exitCode: 0 } }, { timeoutMs: 600_000 }]);
  assert.equal(c.checkpointError, undefined); assert.equal(c.commit, published.commit); assert.equal(c.tree, newTree); assert.equal(c.root, published.root); assert.equal(c.checkpointMs, 17);
  for (const key of ["walkMs", "streamMs", "freezeMs", "files", "bytes", "skipped"] as const) assert.equal(typeof c.checkpoint?.[key], "number");
  for (const key of ["changedChunks", "uploadedChunks", "changedBytes", "reflinkMs", "fiemapMs", "hashMs", "uploadMs"] as const) assert.equal(c.checkpoint?.[key], published[key]);
  const s = r.streams[0]!;
  assert.deepEqual(s.header, { v: 1, kind: "checkpoint", jobId: "job-1", baseTree: tree, walkMs: c.checkpoint!.walkMs });
  assert.deepEqual(s.ops.sort((a, b) => String(a.path).localeCompare(String(b.path))), [
    { path: "created", op: "put", mode: "100644", size: 7 }, { path: "delete", op: "del" }, { path: "edit", op: "put", mode: "100644", size: 3 }, { path: "exec", op: "mode", mode: "100755" }, { path: "link", op: "link", target: "edit" },
  ]);
  assert.deepEqual(s.data, { created: "created", edit: "new" }); assert.equal(s.trailer.files, 5); assert.equal(s.trailer.bytes, 10);
  const index = r.after as { tree: string; entries: Record<string, unknown>[] }; assert.equal(index.tree, newTree); assert.equal(index.entries.length, 4);
  for (const entry of index.entries) {
    const info = await lstat(join(r.repo, String(entry.path)), { bigint: true });
    for (const key of ["ino", "size", "mtimeNs", "ctimeNs"] as const) assert.equal(entry[key], String(info[key]));
    assert.equal(entry.sha1, "");
  }
  assert.equal(r.second?.ok, true); assert.equal(r.streams[1]!.ops.length, 0); assert.equal(r.streams[1]!.header.baseTree, newTree);
});
test("daemon publication failure preserves index and resends changes", async t => {
  const r = await setup(t, { scenario: "fenced", second: true });
  assert.equal(r.result.ok, true); if (!r.result.ok) return;
  assert.match(r.result.camelfs!.checkpointError!, /^daemon: .*fenced/); assert.deepEqual(r.after, r.before);
  assert.deepEqual(r.streams[1]!.ops, r.streams[0]!.ops); assert.equal(r.streams[1]!.header.baseTree, tree);
});
test("nack is a guest error and leaves index unchanged", async t => {
  const r = await setup(t, { scenario: "nack" }); assert.equal(r.result.ok, true); if (!r.result.ok) return;
  assert.match(r.result.camelfs!.checkpointError!, /^guest: .*bad/); assert.deepEqual(r.after, r.before);
});
test("nonzero command checkpoints its tree and keeps its exit code", async t => {
  const r = await setup(t, { command: "printf failed > created; exit 2" }); assert.equal(r.result.ok, true); if (!r.result.ok) return;
  assert.equal(r.result.exitCode, 2); assert.equal(r.posts, 1);
  assert.deepEqual(r.streams[0]!.data, { created: "failed" });
  assert.equal(r.result.camelfs!.checkpointError, undefined); assert.equal(r.result.camelfs!.tree, newTree);
  assert.deepEqual(r.bodies, [{ timeoutMs: 600_000, trailers: { kind: "job", job: "job-1", exitCode: 2 } }]);
});
test("FIFO is counted; git and temporary names are skipped", async t => {
  const r = await setup(t, { command: "mkfifo fifo; mkdir .git; echo x > .git/x; echo x > .camelfs-tmp-9" });
  assert.equal(r.result.ok, true); if (!r.result.ok) return;
  assert.equal(r.result.camelfs!.checkpoint?.skipped, 1); assert.deepEqual(r.streams[0]!.ops, []);
});
test("unreadable file fails loudly", { skip: process.getuid?.() === 0 }, async t => {
  const r = await setup(t, { command: "echo x > unreadable; chmod 000 unreadable" });
  assert.equal(r.result.ok, true); if (!r.result.ok) return; assert.match(r.result.camelfs!.checkpointError!, /^guest: .*EACCES/);
});
test("missing index and pending checkpoint are rejected", async () => {
  const guest = new Guest("/unused", () => {});
  assert.deepEqual(await guest.handle({ op: "camelfs_checkpointed", tree }), { ok: false, error: "no pending checkpoint" });
  assert.deepEqual(await guest.handle({ op: "camelfs_checkpoint", jobId: "job-1", timeoutMs: 100 }), { ok: false, error: "no camelFS index: apply did not run" });
});
test("silent ack is bounded by guest deadline", async t => {
  const dir = await mkdtemp(join(tmpdir(), "cfs-deadline-")); await mkdir(join(dir, "repo"));
  const old = process.env.CAMEL_VSOCK_UDS; process.env.CAMEL_VSOCK_UDS = join(dir, "vsock");
  const peers: Socket[] = [], server = createNetServer(socket => { peers.push(socket); socket.write(encodeFrame({ ready: true })); socket.resume(); });
  await new Promise<void>(resolve => server.listen(join(dir, "vsock_5200"), resolve));
  t.after(async () => { if (old === undefined) delete process.env.CAMEL_VSOCK_UDS; else process.env.CAMEL_VSOCK_UDS = old; for (const peer of peers) peer.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const guest = new Guest(dir, () => {}); guest.camelfsIndex = { tree, entries: [] };
  const result = await guest.handle({ op: "camelfs_checkpoint", jobId: "job-1", timeoutMs: 80 }) as GuestReply;
  assert.equal(result.ok, false); assert.match(result.error!, /checkpoint timed out/);
  assert.deepEqual(await guest.handle({ op: "camelfs_checkpointed", tree }), { ok: false, error: "no pending checkpoint" });
});

test("connections before the delayed POST retry readiness and stream exactly once", async t => {
  const r = await setup(t, { postDelayMs: 300 });
  assert.equal(r.result.ok, true); if (!r.result.ok) return;
  assert.ok(r.unarmed > 0); assert.equal(r.streams.length, 1); assert.equal(r.posts, 1);
  assert.equal(r.result.camelfs!.checkpointError, undefined); assert.equal(r.result.camelfs!.tree, newTree);
  assert.ok(r.checkpointSpanMs - r.result.camelfs!.checkpoint!.freezeMs >= 250, "connect wait must be excluded from freezeMs");
});
test("timed out command checkpoints with exitCode -1 in commit trailers", async t => {
  const r = await setup(t, { command: "printf partial > created; sleep 2", timeoutSeconds: 1 });
  assert.equal(r.result.ok, true); if (!r.result.ok) return;
  assert.equal(r.result.timedOut, true); assert.equal(r.result.exitCode, null);
  assert.deepEqual(r.streams[0]!.data, { created: "partial" });
  assert.equal(r.result.camelfs!.checkpointError, undefined); assert.equal(r.result.camelfs!.tree, newTree);
  assert.deepEqual(r.bodies, [{ timeoutMs: 600_000, trailers: { kind: "job", job: "job-1", exitCode: -1 } }]);
});
