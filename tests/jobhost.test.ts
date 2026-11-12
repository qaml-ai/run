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
  assert.equal(firecrackerConfig({ id: "j", kernel: "", initrd: "", disk: "", vsockPath: "", tap: "", mac: "" }, { vcpus: 14, memoryMiB: 98304, diskMiB: 1 }, true).enclave.cpu_overcommit, false, "a build sandbox has dedicated vCPUs");
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
