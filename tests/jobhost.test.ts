import { test } from "node:test";
import assert from "node:assert/strict";
import { frames, Frames, FRAME_CHARS, ASSEMBLIES_MAX, textBase64, base64Text } from "../shared/job-host-protocol.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fakeLauncher, firecrackerConfig } from "../jobhost/vm.ts";
import { inside } from "../jobhost/guest.ts";

test("a message bigger than a frame crosses as frames and is assembled whole; a bad frame is refused", () => {
  const big = { type: "job", id: "j", spec: { files: [{ path: "a", data: "x".repeat(FRAME_CHARS * 2 + 5) }] } };
  const sent = frames(big);
  assert.equal(sent.length, 3);
  assert.ok(sent.every(frame => frame.length < FRAME_CHARS + 200));
  const assembler = new Frames();
  assert.equal(assembler.add(sent[0]!), undefined);
  assert.equal(assembler.add(sent[1]!), undefined);
  assert.deepEqual(assembler.add(sent[2]!), big);
  assert.deepEqual(new Frames().add(frames({ type: "heartbeat", running: [], free: 2 })[0]!), { type: "heartbeat", running: [], free: 2 });
  assert.throws(() => new Frames().add(JSON.stringify({ t: "part", n: "x", i: 5, of: 2, data: "" })), /Invalid job host frame/);
});

test("the guest, in a fake VM: files in, a command under its timeout with its streams, outputs collected, the disk dropped", async () => {
  const vm = await fakeLauncher().boot("job-1", { vcpus: 1, memoryMiB: 512, diskMiB: 1024 });
  try {
    assert.deepEqual((await vm.request({ op: "files", files: [{ path: "src/hello.txt", data: textBase64("hello") }] })).ok, true);
    const logs: string[] = [];
    const ran = await vm.request({ op: "run", command: 'cat src/hello.txt; echo oops >&2; mkdir -p "$JOB_OUT/logs"; echo 21 > "$JOB_OUT/logs/n.txt"; exit 3', timeoutSeconds: 30, env: { SECRET_X: "s" } },
      (_stream, data) => logs.push(base64Text(data)));
    assert.equal(ran.ok, true);
    assert.equal(ran.exitCode, 3);
    assert.equal(ran.timedOut, false);
    assert.equal(base64Text((ran.stdout as { data: string }).data), "hello");
    assert.equal(base64Text((ran.stderr as { data: string }).data), "oops\n");
    assert.ok(logs.join("").includes("hello"), "its output streamed as it ran");
    const collected = await vm.request({ op: "collect", outputs: ["logs/n.txt", "missing.txt"] });
    assert.equal(base64Text((collected.outputs as Record<string, { data: string }>)["logs/n.txt"]!.data), "21\n");
    assert.deepEqual(collected.missing, ["missing.txt"]);
    const slow = await vm.request({ op: "run", command: "sleep 30", timeoutSeconds: 1 });
    assert.equal(slow.timedOut, true);
    assert.equal(slow.exitCode, null);
    const escape = await vm.request({ op: "files", files: [{ path: "../../etc/x", data: "" }] });
    assert.equal(escape.ok, false);
  } finally { await vm.destroy(); }
});

test("a path stays inside its root; the Firecracker config is direct mode with the Async engine", () => {
  assert.equal(inside("/vm/repo", "/a/b.txt"), "/vm/repo/a/b.txt");
  for (const bad of ["../x", "a/../../x", "", "."]) assert.throws(() => inside("/vm/repo", bad), /Invalid path/);
  const config = firecrackerConfig({ id: "j", kernel: "/k", initrd: "/i", disk: "/d", vsockPath: "/v.sock", tap: "tap0", mac: "02:00:00:00:00:01" }, { vcpus: 2, memoryMiB: 4096, diskMiB: 8192 });
  assert.equal(config.drives[0]!.io_engine, "Async");
  assert.deepEqual(config.enclave, { direct_mode: true, cpu_overcommit: true });
  assert.match(config["boot-source"].boot_args, /\bquiet\b/);
  assert.deepEqual(firecrackerConfig({ id: "j", kernel: "", initrd: "", disk: "", vsockPath: "", tap: "", mac: "" }, { vcpus: 14, memoryMiB: 98304, diskMiB: 1 }, true).enclave, { direct_mode: true, cpu_overcommit: false }, "a build sandbox has dedicated vCPUs");
});

test("plain KVM omits only the enclave block; an absent or empty initrd omits initrd_path", () => {
  const job = { id: "j", kernel: "/k", initrd: "/i", disk: "/d", vsockPath: "/v.sock", tap: "tap0", mac: "02:00:00:00:00:01" };
  const shape = { vcpus: 2, memoryMiB: 4096, diskMiB: 8192 };
  for (const build of [false, true]) {
    for (const repo of [undefined, "/repo"]) {
      const { enclave, ...rest } = firecrackerConfig(job, shape, build, repo);
      assert.deepEqual(enclave, { direct_mode: true, cpu_overcommit: !build });
      const kvm = firecrackerConfig(job, shape, build, repo, true);
      assert.equal(Object.hasOwn(kvm, "enclave"), false);
      assert.deepEqual(kvm, rest);
      for (const initrd of [undefined, ""]) {
        for (const plainKvm of [false, true]) {
          const { initrd_path, ...boot } = firecrackerConfig(job, shape, build, repo, plainKvm)["boot-source"];
          assert.equal(initrd_path, "/i");
          const config = firecrackerConfig({ ...job, initrd }, shape, build, repo, plainKvm);
          assert.equal(Object.hasOwn(config["boot-source"], "initrd_path"), false);
          assert.deepEqual(config["boot-source"], boot);
        }
      }
    }
  }
});

test("frames are bounded: a frame over its size, or more messages open than allowed, is refused", () => {
  assert.throws(() => new Frames().add(JSON.stringify({ t: "part", n: "x", i: 0, of: 2, data: "x".repeat(FRAME_CHARS + 1) })), /Invalid job host frame/);
  const open = new Frames();
  for (let k = 0; k < ASSEMBLIES_MAX; k++) assert.equal(open.add(JSON.stringify({ t: "part", n: `m${k}`, i: 0, of: 2, data: "{" })), undefined);
  assert.throws(() => open.add(JSON.stringify({ t: "part", n: "one-more", i: 0, of: 2, data: "{" })), /Too many job host messages/);
});

test("destroying a VM mid-command ends the command's whole process group: nothing is left running", async () => {
  const work = await (await import("node:fs/promises")).mkdtemp(join(tmpdir(), "jobhost-cancel-"));
  const vm = await fakeLauncher({ work }).boot("job-cancel", { vcpus: 1, memoryMiB: 512, diskMiB: 1024 });
  await vm.request({ op: "files", files: [] });
  // A command that starts its own background child, then waits: both must go.
  void vm.request({ op: "run", command: "sleep 300 & echo $! > child.pid; sleep 300", timeoutSeconds: 3600 }).catch(() => {});
  let group = NaN;
  for (let i = 0; i < 100 && !Number.isInteger(group); i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    group = Number(await readFile(join(work, "job-cancel", ".job.pgid"), "utf8").catch(() => "x"));
  }
  assert.ok(Number.isInteger(group) && group > 1, "the guest wrote the command's group");
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(alive(-group));
  await vm.destroy();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(alive(-group), false, "the command's group is gone, its background child included");
});

test("host results survive repeated reconnects until acknowledged and expire after a day", async t => {
  const { createServer } = await import("node:http");
  const { WebSocketServer } = await import("ws");
  const { HostAgent } = await import("../jobhost/agent.ts");
  const server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ host: "test", credential: "fixture-only", expiresAt: Date.now() + 3600_000 })); });
  const sockets = new WebSocketServer({ server });
  server.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  let connection = 0, results = 0, boots = 0;
  const stream = { data: "", size: 0, truncated: false };
  const launcher = { kind: "fake" as const, async boot() { boots++; return { id: "replay", async destroy() {}, async request() { return { ok: true, exitCode: 0, timedOut: false, stdout: stream, stderr: stream, freeBytes: 1e12 }; } }; } };
  let current: import("ws").WebSocket;
  sockets.on("connection", socket => {
    current = socket; connection++;
    socket.on("message", data => {
      const message = JSON.parse(String(data));
      if (message.type === "hello") {
        socket.send(JSON.stringify({ type: "registered", host: "test" }));
        if (connection === 1) socket.send(JSON.stringify({ type: "job", id: "replay", spec: { command: "true", files: [], outputs: [], timeoutSeconds: 5, limits: {}, internet: false } }));
      }
      if (message.type === "result") {
        results++;
        if (results < 3) socket.close();
        else socket.send(JSON.stringify({ type: "ack", id: message.id }));
      }
    });
  });
  const agent = new HostAgent({ runtime: `http://127.0.0.1:${(server.address() as { port: number }).port}`, attest: async () => ({ kind: "test", host: "test", secret: "fixture-only" }), slots: 1, vcpus: 1, memoryMiB: 512, diskLowBytes: 0, launcher, log: () => {} });
  t.after(async () => { await agent.close(); for (const socket of sockets.clients) socket.terminate(); await new Promise<void>(resolve => sockets.close(() => server.close(() => resolve()))); });
  await agent.start();
  const until = async (check: () => boolean) => { for (let n = 0; n < 400 && !check(); n++) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(check()); };
  await until(() => results === 3 && (agent as any).results.size === 0);
  current!.close();
  await until(() => connection === 4);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(results, 3); assert.equal(boots, 1);
  (agent as any).results.set("old", { at: Date.now() - 25 * 3600_000, message: { type: "result", id: "old", result: { ok: false, code: "stopped", message: "old" } } });
  current!.close(); await until(() => connection === 5);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(results, 3); assert.equal((agent as any).results.size, 0);
});
