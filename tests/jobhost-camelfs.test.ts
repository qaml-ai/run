import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer } from "node:net";
import { encodeFrame } from "../jobhost/camelfs-wire.ts";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WebSocketServer } from "ws";
import { CAMELFS_HEARTBEAT_MS, HostAgent } from "../jobhost/agent.ts";
import { camelfsdClient, serveImportProxy, type Camelfsd } from "../jobhost/camelfsd.ts";
import { firecrackerLauncher } from "../jobhost/firecracker.ts";
import { fakeLauncher, firecrackerConfig, type VmLauncher } from "../jobhost/vm.ts";
import { Frames, base64Text, type HostMessage, type WireJob, type WireResult } from "../shared/job-host-protocol.ts";

const spec: WireJob = { command: "cat hello.txt", files: [], outputs: [], internet: false, limits: {}, timeoutSeconds: 5, camelfs: { lineage: "a:b", tree: "tree-1" } };
async function daemon(t: TestContext, mode = "ok") {
  const dir = await mkdtemp(join(tmpdir(), "camelfsd-")), socketPath = join(dir, "api.sock");
  const calls: { method?: string; path?: string; body: string; authorization?: string; contentType?: string }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ method: req.method, path: req.url, body: Buffer.concat(chunks).toString(), authorization: req.headers.authorization, contentType: req.headers["content-type"] });
    res.setHeader("content-type", "application/json");
    if (req.method === "POST" && req.url === "/v0/mounts") {
      if (mode === "fail") { res.writeHead(500); res.end(JSON.stringify({ error: "mount_failed", detail: "boom" })); return; }
      const image = await mkdtemp(join(dir, "image-"));
      await writeFile(join(image, "hello.txt"), "hello from camelFS\n");
      const { vsock, jobId } = JSON.parse(Buffer.concat(chunks).toString());
      if (vsock) {
        await mkdir(dirname(vsock), { recursive: true });
        const apply = createNetServer(socket => {
          socket.on("error", () => {}); socket.resume();
          socket.write(Buffer.concat([
            encodeFrame({ v: 1, kind: "apply", jobId, fromTree: "a".repeat(40), toTree: "b".repeat(40) }),
            encodeFrame({ indexEnd: true, count: 0 }), encodeFrame({ end: true }),
          ]));
          socket.on("end", () => socket.end());
        });
        await new Promise<void>(resolve => apply.listen(vsock + "_5201", resolve));
        t.after(() => new Promise<void>(resolve => apply.close(() => resolve())));
      }
      res.end(JSON.stringify({ image, warm: true, root: "root-1", tree: "tree-1", mountMs: 12, hydrating: false }));
    } else if (req.url?.endsWith("/heartbeat")) {
      if (mode === "heartbeat-fail") { res.writeHead(500); res.end(JSON.stringify({ error: "e".repeat(300) })); }
      else res.end("{}");
    } else if (req.method === "DELETE") res.end(JSON.stringify({ released: true, promoted: false }));
    else if (req.url === "/v0/health") {
      if (mode === "health-fail") { res.writeHead(503); res.end(JSON.stringify({ error: "unavailable", detail: "store offline" })); }
      else res.end(JSON.stringify({ ok: mode !== "health-false", version: "0.1.0", data: dir, store: "local", hostId: "test-host" }));
    }
    else if (req.method === "GET") res.end(JSON.stringify({ state: "mounted", image: "/image", root: "root-1", hydratedRegions: 42, totalRegions: 100, leaseEpoch: 1 }));
    else { res.writeHead(409); res.end(JSON.stringify({ received: Buffer.concat(chunks).toString() })); }
  });
  server.listen(socketPath); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  return { dir, socketPath, calls, client: camelfsdClient(socketPath) };
}
async function host(t: TestContext, camelfsd?: Camelfsd, launcher = fakeLauncher(), camelfsHeartbeatMs?: number): Promise<{ agent: HostAgent; hello: Extract<HostMessage, { type: "hello" }>; result: Promise<WireResult>; logs: Record<string, unknown>[] }> {
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
  const agent = new HostAgent({ runtime: `http://127.0.0.1:${(server.address() as { port: number }).port}`, attest: async () => ({ kind: "test", host: "test-host", secret: "test-only" }), slots: 1, vcpus: 1, memoryMiB: 512, diskLowBytes: 0, camelfsd, camelfsHeartbeatMs, launcher, log: line => logs.push(line) });
  t.after(async () => { await agent.close(); for (const socket of sockets.clients) socket.terminate(); await new Promise<void>(resolve => sockets.close(() => resolve())); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await agent.start();
  return { agent, hello: await hello.promise, result: result.promise, logs };
}

test("hello advertises camelFS only with a daemon and a guest that mounts the repo", async t => {
  const d = await daemon(t);
  assert.deepEqual((await host(t, d.client)).hello.features, ["camelfs"]);
  assert.equal(Object.hasOwn((await host(t)).hello, "features"), false);
  for (const mountsRepo of [undefined, false]) assert.equal(Object.hasOwn((await host(t, d.client, { ...fakeLauncher(), mountsRepo })).hello, "features"), false);
});

test("a camelFS job mounts its repo, skips sync, reports timings and releases after VM destruction", async t => {
  const d = await daemon(t), launcher = fakeLauncher({ work: d.dir });
  const events: string[] = [], ops: unknown[] = [];
  const wrapped: VmLauncher = { ...launcher, async boot(...args) {
    const vm = await launcher.boot(...args);
    return { ...vm, request: async request => { ops.push(request.op); return vm.request(request); }, destroy: async () => { await vm.destroy(); events.push("destroy"); } };
  } };
  const h = await host(t, { ...d.client, release: async id => { events.push("release"); await d.client.release(id); } }, wrapped);
  await h.agent.run("job-1", { ...spec, sync: { url: "http://invalid", token: "unused", files: [] } });
  const result = await h.result;
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.exitCode, 0);
  assert.equal(base64Text(result.stdout.data), "hello from camelFS\n");
  assert.equal(result.camelfs?.warm, true);
  assert.equal(result.camelfs?.mountMs, 12);
  assert.equal(typeof result.camelfs?.applyMs, "number");
  assert.equal(ops[0], "camelfs_apply");
  assert.equal(ops.includes("files"), false);
  assert.deepEqual(d.calls.map(call => [call.method, call.path]), [["POST", "/v0/mounts"], ["DELETE", "/v0/mounts/job-1"]]);
  assert.deepEqual(JSON.parse(d.calls[0]!.body), { jobId: "job-1", lineage: "a:b", tree: "tree-1", vsock: join(d.dir, "job-1.vsock") });
  assert.deepEqual(events, ["destroy", "release"]);
});

test("camelFS refuses a failed mount", async t => {
  const d = await daemon(t, "fail"), h = await host(t, d.client);
  await h.agent.run("job-1", spec);
  assert.deepEqual(await h.result, { ok: false, code: "start_failed", message: "camelfsd 500: mount_failed: boom" });
  assert.deepEqual(d.calls.map(call => call.method), ["POST", "DELETE"]);
});

test("camelFS requires a daemon", async t => {
  const h = await host(t);
  await h.agent.run("job-1", spec);
  assert.deepEqual(await h.result, { ok: false, code: "start_failed", message: "This host has no camelFS daemon" });
});

test("cancel during mount releases without booting", async t => {
  const d = await daemon(t), entered = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  const h = await host(t, { ...d.client, mount: async input => { entered.resolve(); await resume.promise; return d.client.mount(input); } }, { kind: "fake", mountsRepo: true, boot: async () => { throw new Error("must not boot"); } });
  const run = h.agent.run("job-1", spec);
  await entered.promise;
  // Drive the same receive path as a runtime cancel while the mount is in flight.
  (h.agent as unknown as { receive(message: unknown): void }).receive({ type: "cancel", id: "job-1" });
  resume.resolve(); await run;
  assert.deepEqual(await h.result, { ok: false, code: "stopped", message: "The job was stopped" });
  assert.deepEqual(d.calls.map(call => call.method), ["POST", "DELETE"]);
});

test("a boot failure still releases; a release failure is logged without replacing the result", async t => {
  const d = await daemon(t), h = await host(t, { ...d.client, release: async () => { throw new Error("release failed"); } }, { kind: "fake", mountsRepo: true, boot: async () => { throw new Error("boot failed"); } });
  await h.agent.run("job-1", spec);
  assert.deepEqual(await h.result, { ok: false, code: "start_failed", message: "boot failed" });
  assert.ok(h.logs.some(line => line.type === "jobhost_camelfs_release_failed" && line.id === "job-1"));
});

test("Firecracker config adds only the opaque repo drive", () => {
  const job = { id: "j", kernel: "/k", initrd: "/i", disk: "/d", vsockPath: "/v", tap: "tap0", mac: "02:00:00:00:00:01" }, shape = { vcpus: 1, memoryMiB: 512, diskMiB: 1024 };
  assert.equal(firecrackerConfig(job, shape).drives.length, 1);
  assert.deepEqual(firecrackerConfig(job, shape, false, "/dev/mapper/repo").drives[1], { drive_id: "repo", path_on_host: "/dev/mapper/repo", is_root_device: false, is_read_only: false, io_engine: "Async" });
});

test("daemon client status and idempotent release encode the job id", async t => {
  const d = await daemon(t);
  assert.deepEqual(await d.client.status("a:b"), { state: "mounted", image: "/image", root: "root-1", hydratedRegions: 42, totalRegions: 100, leaseEpoch: 1 });
  await d.client.release("a:b");
  assert.deepEqual(d.calls.map(call => call.path), ["/v0/mounts/a%3Ab", "/v0/mounts/a%3Ab"]);
});

test("import proxy authenticates, limits routes and streams imports without the bearer", async t => {
  const d = await daemon(t), proxy = await serveImportProxy({ socketPath: d.socketPath, token: "test-only", host: "127.0.0.1", port: 0 });
  t.after(() => proxy.close());
  const url = `http://127.0.0.1:${proxy.port}`, headers = { authorization: "Bearer test-only", "content-type": "application/octet-stream" };
  for (const authorization of [undefined, "Bearer wrong", "Bearer same-size"]) {
    const response = await fetch(`${url}/v0/trees`, { method: "POST", headers: authorization ? { authorization } : {} });
    assert.equal(response.status, 401); await response.text();
  }
  for (const path of ["/v0/mounts", "/v0/trees/other", `/v0/blobs/${"a".repeat(64)}`]) {
    const response = await fetch(url + path, { headers }); assert.equal(response.status, 404); await response.text();
  }
  assert.equal(d.calls.length, 0);
  for (const [method, path, body] of [["POST", "/v0/trees", '{"lineage":"a:b"}'], ["PUT", `/v0/blobs/${"a".repeat(64)}?lineage=a:b`, "blob bytes\n"]]) {
    const response = await fetch(url + path, { method, headers, body });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { received: body });
    assert.deepEqual(d.calls.at(-1), { method, path, body, authorization: undefined, contentType: "application/octet-stream" });
  }
});


test("daemon responses stop at 1 MiB and errors keep only 300 daemon characters", async t => {
  const dir = await mkdtemp(join(tmpdir(), "camelfsd-bounds-")), socketPath = join(dir, "api.sock");
  const server = createServer((req, res) => {
    if (req.method === "DELETE") { res.writeHead(404); res.end(); }
    else if (req.url?.endsWith("large")) res.end("x".repeat(1024 * 1024 + 1));
    else { res.writeHead(503); res.end(JSON.stringify({ error: "e".repeat(400) })); }
  });
  server.listen(socketPath); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const client = camelfsdClient(socketPath);
  await client.release("already-gone");
  await assert.rejects(client.status("large"), /response exceeds 1 MiB/);
  await assert.rejects(client.status("error"), { message: `camelfsd 503: ${"e".repeat(300)}` });
});

test("import proxy rejects an oversized declared body before forwarding", async t => {
  const d = await daemon(t), proxy = await serveImportProxy({ socketPath: d.socketPath, token: "test-only", host: "127.0.0.1", port: 0 });
  t.after(() => proxy.close());
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: proxy.port, method: "POST", path: "/v0/trees", headers: { authorization: "Bearer test-only", "content-length": 512 * 1024 * 1024 + 1 } }, res => { res.resume(); res.on("end", () => { resolve(res.statusCode); req.destroy(); }); });
    req.on("error", reject); req.flushHeaders();
  });
  assert.equal(status, 413);
  assert.deepEqual(d.calls, []);
});


test("daemon health and invalid job ids", async t => {
  const d = await daemon(t);
  assert.deepEqual(await d.client.health(), { ok: true, version: "0.1.0", data: d.dir, store: "local", hostId: "test-host" });
  const before = d.calls.length;
  for (const id of ["", "a/b", "x".repeat(65), "job?x", "job x"]) {
    await assert.rejects(d.client.mount({ jobId: id, lineage: "a:b", tree: "tree", vsock: "" }), /Invalid camelFS job id/);
    await assert.rejects(d.client.release(id), /Invalid camelFS job id/);
    await assert.rejects(d.client.heartbeat(id), /Invalid camelFS job id/);
    await assert.rejects(d.client.status(id), /Invalid camelFS job id/);
  }
  assert.equal(d.calls.length, before);
});


for (const mode of ["health-false", "health-fail"]) test(`CLI refuses a daemon with ${mode}`, async t => {
  const d = await daemon(t, mode);
  await assert.rejects(promisify(execFile)(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../jobhost/agent.ts", import.meta.url)), "--fake", "--attestor", "test", "--camelfs-socket", d.socketPath], { env: { ...process.env, JOB_HOST_TEST_SECRET: "test-only" }, timeout: 5000 }), (error: unknown) => {
    assert.match((error as { stderr: string }).stderr, mode === "health-false" ? /camelFS daemon is unhealthy/ : /camelfsd 503: unavailable: store offline/);
    return true;
  });
  assert.deepEqual(d.calls.map(call => [call.method, call.path]), [["GET", "/v0/health"]]);
});


test("Firecracker repo mounting is disabled until the guest image supports it", () => {
  const options = { firecracker: "/fc", kernel: "/k", initrd: "/i", image: "/image", work: "/work", policyDir: "/policies" };
  assert.equal(fakeLauncher().mountsRepo, true);
  assert.equal(firecrackerLauncher(options).mountsRepo, false);
  assert.equal(firecrackerLauncher({ ...options, mountsRepo: true }).mountsRepo, true);
});

for (const mountsRepo of [undefined, false]) test(`a guest with mountsRepo=${mountsRepo} refuses camelFS before mounting or booting`, async t => {
  const d = await daemon(t), h = await host(t, d.client, { kind: "firecracker", mountsRepo, boot: async () => { assert.fail("must not boot"); } });
  await h.agent.run("job-1", spec);
  assert.deepEqual(await h.result, { ok: false, code: "start_failed", message: "This host cannot attach a camelFS repo disk yet" });
  assert.deepEqual(d.calls, []);
});

test("a mount that acquired a lease but failed to return is released", async t => {
  const d = await daemon(t), h = await host(t, { ...d.client, mount: async input => { await d.client.mount(input); throw new Error("mount timed out"); } });
  await h.agent.run("job-1", spec);
  assert.deepEqual(await h.result, { ok: false, code: "start_failed", message: "mount timed out" });
  assert.deepEqual(d.calls.map(call => [call.method, call.path]), [["POST", "/v0/mounts"], ["DELETE", "/v0/mounts/job-1"]]);
});


test("daemon heartbeat posts an empty JSON body and encodes the job id", async t => {
  const d = await daemon(t);
  await d.client.heartbeat("a:b");
  assert.deepEqual(d.calls, [{ method: "POST", path: "/v0/mounts/a%3Ab/heartbeat", body: "{}", authorization: undefined, contentType: "application/json" }]);
});

for (const mode of ["ok", "heartbeat-fail"]) test(`mount heartbeats continue during a command (${mode}) and stop before release`, async t => {
  assert.equal(CAMELFS_HEARTBEAT_MS, 30_000);
  const interval = 40, d = await daemon(t, mode);
  const h = await host(t, d.client, fakeLauncher({ work: d.dir }), interval);
  await h.agent.run("job-1", { ...spec, command: "sleep 0.14" });
  const result = await h.result;
  assert.equal(result.ok, true); if (!result.ok) return;
  assert.equal(result.exitCode, 0);
  const beats = d.calls.filter(call => call.path?.endsWith("/heartbeat"));
  assert.ok(beats.length >= 2, `received ${beats.length} heartbeats`);
  assert.equal(d.calls.at(-1)?.method, "DELETE");
  const count = d.calls.length;
  await new Promise(resolve => setTimeout(resolve, interval * 3));
  assert.equal(d.calls.length, count);
  const failures = h.logs.filter(line => line.type === "jobhost_camelfs_heartbeat_failed");
  if (mode === "heartbeat-fail") {
    assert.equal(failures.length, beats.length);
    for (const line of failures) assert.deepEqual(line, { type: "jobhost_camelfs_heartbeat_failed", id: "job-1", error: (`camelfsd 500: ${"e".repeat(300)}`).slice(0, 200) });
  } else assert.deepEqual(failures, []);
});

test("mount heartbeats never overlap and release waits for an in-flight heartbeat", async t => {
  const d = await daemon(t);
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  let calls = 0, released = false;
  const h = await host(t, { ...d.client,
    heartbeat: async () => { calls++; entered.resolve(); await finish.promise; assert.equal(released, false); },
    release: async id => { released = true; await d.client.release(id); },
  }, fakeLauncher({ work: d.dir }), 10);
  const running = h.agent.run("job-1", { ...spec, command: "sleep 0.08" });
  await entered.promise;
  try {
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(calls, 1);
    assert.equal(released, false);
  } finally { finish.resolve(); }
  await running;
  assert.equal((await h.result).ok, true);
  assert.equal(released, true);
});
