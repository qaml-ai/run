import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { createServer, connect, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { baseRules, guestNetArgs, jobAddress, tapCommands, PROXY_PORT, PROXY_UID } from "../jobhost/network.ts";
import { allowed, publicAddress, egressProxy, writePolicy, removePolicy, DEFAULT_EGRESS } from "../jobhost/egress-proxy.ts";
import { firecrackerLauncher, vsockChannel } from "../jobhost/firecracker.ts";
import { isolationSuite } from "../jobhost/isolation-suite.ts";
import type { Vm, VmLauncher } from "../jobhost/vm.ts";

const IMAGE = new URL("../infra/job-hosts/image/", import.meta.url);

test("each job slot has its own tap, /30 and MAC, and the guest learns its network from its kernel arguments", () => {
  assert.deepEqual(jobAddress(0), { slot: 0, tap: "cj0", hostIp: "10.200.0.1", guestIp: "10.200.0.2", mac: "06:00:0a:c8:00:02", prefix: 30 });
  assert.equal(jobAddress(17).mac, "06:00:0a:c8:11:02");
  assert.throws(() => jobAddress(250));
  assert.throws(() => jobAddress(-1));
  assert.equal(guestNetArgs(jobAddress(3), false), "camel.ip=10.200.3.2/30 camel.gw=10.200.3.1");
  assert.equal(guestNetArgs(jobAddress(3), true), `camel.ip=10.200.3.2/30 camel.gw=10.200.3.1 camel.proxy=http://10.200.3.1:${PROXY_PORT}`);
  assert.deepEqual(tapCommands(jobAddress(1)).up[1], ["ip", "addr", "add", "10.200.1.1/30", "dev", "cj1"]);
});

test("the image's base rules are the ones the code describes, and name the proxy by its fixed uid", async () => {
  assert.equal(await readFile(new URL("files/camel-host.nft", IMAGE), "utf8"), baseRules(), "regenerate files/camel-host.nft from jobhost/network.ts baseRules()");
  assert.match(baseRules(), new RegExp(`meta skuid ${PROXY_UID} jump proxy_out`));
  // nft parses them, where nft and root are at hand (infra/job-hosts/image/test-netns.sh runs them for real).
  const check = spawnSync("nft", ["-c", "-f", new URL("files/camel-host.nft", IMAGE).pathname], { encoding: "utf8" });
  if (check.error || /Operation not permitted|permission/i.test(check.stderr)) return;
  assert.equal(check.status, 0, check.stderr);
});

test("the egress allowlist: exact names and *.suffix, never the suffix itself, an IP, or a malformed name", () => {
  const allow = ["registry.npmjs.org", "*.github.com"];
  assert.equal(allowed("registry.npmjs.org", allow), true);
  assert.equal(allowed("REGISTRY.npmjs.org", allow), true);
  assert.equal(allowed("api.github.com", allow), true);
  assert.equal(allowed("github.com", allow), false);
  assert.equal(allowed("evilgithub.com", allow), false);
  assert.equal(allowed("registry.npmjs.org.evil.example", allow), false);
  assert.equal(allowed("169.254.169.254", ["169.254.169.254"]), false);
  assert.equal(allowed("a..b.com", ["a..b.com"]), false);
  assert.ok(DEFAULT_EGRESS.includes("github.com"));
});

test("only public addresses are dialled", () => {
  for (const address of ["169.254.169.254", "10.0.0.2", "172.16.5.4", "192.168.1.1", "127.0.0.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fd00:ec2::254", "fe80::1", "::ffff:169.254.169.254", "64:ff9b::a9fe:a9fe", "not-an-ip"])
    assert.equal(publicAddress(address), false, address);
  for (const address of ["140.82.112.3", "104.16.0.1", "203.0.113.10", "2606:4700::6810:1"]) assert.equal(publicAddress(address), true, address);
});

async function listen(server: Server, host = "127.0.0.1") { server.listen(0, host); await once(server, "listening"); return (server.address() as { port: number }).port; }
/** A CONNECT through the proxy: its status line, and what the upstream sent back for "ping". */
async function through(port: number, target: string) {
  const socket = connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  let data = "";
  return await new Promise<{ status: string; body: string }>(resolve => {
    socket.on("data", chunk => {
      data += chunk;
      if (/^HTTP\/1.1 200[^\r]*\r\n\r\n$/.test(data)) socket.write("ping");
      if (data.includes("pong") || /^HTTP\/1.1 403/.test(data)) { socket.destroy(); resolve({ status: data.split("\r\n")[0]!, body: data.includes("pong") ? "pong" : "" }); }
    });
    socket.on("close", () => resolve({ status: data.split("\r\n")[0] ?? "", body: "" }));
  });
}

test("the egress proxy lets a job reach its allowlist on 443 at a checked public address, and refuses everything else", async t => {
  const dir = await mkdtemp(join(tmpdir(), "egress-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const upstream = createServer(socket => socket.on("data", () => socket.end("pong")));
  const upstreamPort = await listen(upstream);
  const dialled: string[] = [], logs: Record<string, unknown>[] = [];
  const names: Record<string, string[]> = { "allowed.test": ["203.0.113.10"], "rebind.test": ["203.0.113.10", "169.254.169.254"], "other.test": ["203.0.113.11"] };
  const proxy = egressProxy({
    policyDir: dir, lookup: async host => names[host] ?? [], log: line => logs.push(line),
    // Every dial goes to the local upstream; the address it was asked for is recorded.
    dial: (address, port) => { dialled.push(`${address}:${port}`); return connect(upstreamPort, "127.0.0.1"); },
  });
  const port = await listen(proxy);
  t.after(() => { proxy.closeAllConnections(); proxy.close(); upstream.close(); });
  // The test's client connects from 127.0.0.1, standing in for a guest address.
  await writePolicy(dir, "127.0.0.1", { job: "job-1", allow: ["allowed.test", "rebind.test"] });
  assert.deepEqual(await through(port, "allowed.test:443"), { status: "HTTP/1.1 200 Connection Established", body: "pong" });
  assert.deepEqual(dialled, ["203.0.113.10:443"], "it dials the address it checked");
  for (const [target, reason] of [["other.test:443", "not_allowed"], ["rebind.test:443", "private_address"], ["allowed.test:80", "port"], ["169.254.169.254:443", "not_allowed"], ["nope.test:443", "not_allowed"]] as const) {
    assert.equal((await through(port, target)).status, "HTTP/1.1 403 Forbidden", target);
    assert.equal(logs.at(-1)?.reason, reason, target);
  }
  assert.equal(dialled.length, 1, "nothing refused was dialled");
  // Plain HTTP is never proxied.
  const plain = await fetch(`http://127.0.0.1:${port}/`, { headers: { host: "allowed.test" } });
  assert.equal(plain.status, 403);
  // Without a policy (the job ended, or none written), nothing.
  await removePolicy(dir, "127.0.0.1");
  assert.equal((await through(port, "allowed.test:443")).status, "HTTP/1.1 403 Forbidden");
  assert.equal(logs.at(-1)?.reason, "no_policy");
});

/** A stand-in for Firecracker's vsock UDS: "CONNECT <port>" answered "OK", then camel-guest's NDJSON. */
async function fakeVsock(path: string, options: { refuseFirst?: number } = {}) {
  let refusals = options.refuseFirst ?? 0;
  const requests: unknown[] = [];
  const server = createServer(socket => {
    let buffer = "", connected = false;
    socket.on("data", chunk => {
      buffer += chunk;
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        if (!connected) {
          if (refusals-- > 0) { socket.destroy(); return; }
          assert.equal(line, "CONNECT 5000"); connected = true; socket.write("OK 1073741824\n"); continue;
        }
        const request = JSON.parse(line); requests.push(request);
        if (request.op === "run") socket.write(`${JSON.stringify({ event: "log", stream: "stdout", data: "aGk=" })}\n`);
        socket.write(`${JSON.stringify({ ok: true, echo: request.op })}\n`);
      }
    });
  });
  server.listen(path); await once(server, "listening");
  return { server, requests };
}

test("the vsock channel waits for the guest, asks for its port, then speaks camel-guest's NDJSON", async t => {
  const dir = await mkdtemp(join(tmpdir(), "vsock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "vm.vsock");
  const fake = await fakeVsock(path, { refuseFirst: 2 });
  t.after(() => fake.server.close());
  const channel = await vsockChannel(path, 5000, 5_000);
  const logs: string[] = [];
  assert.deepEqual(await channel.request({ op: "run", command: "true" }, (_stream, data) => logs.push(data)), { ok: true, echo: "run" });
  assert.deepEqual(logs, ["aGk="]);
  assert.deepEqual(await channel.request({ op: "free" }), { ok: true, echo: "free" });
  channel.close();
  await assert.rejects(vsockChannel(join(dir, "missing.vsock"), 5000, 300), /did not answer on vsock/);
});

test("the Firecracker launcher clones, wires the tap and policy, boots with the job's network and tears it all down", async t => {
  const dir = await mkdtemp(join(tmpdir(), "fc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const policies = join(dir, "egress"), image = join(dir, "base.ext4");
  await writeFile(image, "image");
  const commands: string[] = [];
  let config: any;
  const fakes: Awaited<ReturnType<typeof fakeVsock>>[] = [];
  t.after(() => { for (const fake of fakes) fake.server.close(); });
  const launcher = firecrackerLauncher({
    firecracker: "/usr/local/bin/firecracker", kernel: "/k", initrd: "/i", image, work: dir, policyDir: policies, runtimeHost: "run.example",
    exec: async (file, args) => { commands.push([file, ...args].join(" ")); if (file === "cp") await writeFile(args[2]!, "clone"); },
    start: async (file, args) => {
      config = JSON.parse(await readFile(args[2]!, "utf8"));
      assert.deepEqual(args.slice(0, 2), ["--no-api", "--config-file"]);
      fakes.push(await fakeVsock(config.vsock.uds_path));
      const { EventEmitter } = await import("node:events");
      const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, kill: () => { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0)); return true; } });
      return child as never;
    },
  });
  const vm: Vm = await launcher.boot("job-1", { vcpus: 2, memoryMiB: 2048, diskMiB: 8192 }, { internet: true });
  assert.deepEqual(commands.slice(0, 3), [`cp --reflink=always ${image} ${join(dir, "job-1.ext4")}`, `truncate -s 8192M ${join(dir, "job-1.ext4")}`, `resize2fs -f ${join(dir, "job-1.ext4")}`]);
  assert.ok(commands.includes("ip tuntap add dev cj0 mode tap"));
  assert.match(config["boot-source"].boot_args, /root=\/dev\/vda rw camel\.ip=10\.200\.0\.2\/30 camel\.gw=10\.200\.0\.1 camel\.proxy=http:\/\/10\.200\.0\.1:3128$/);
  assert.equal(config["network-interfaces"][0].host_dev_name, "cj0");
  assert.deepEqual(config.enclave, { direct_mode: true, cpu_overcommit: true });
  assert.equal(config.drives[0].io_engine, "Async");
  const policy = JSON.parse(await readFile(join(policies, "10.200.0.2.json"), "utf8"));
  assert.deepEqual(policy, { job: "job-1", allow: [...DEFAULT_EGRESS, "run.example"] });
  assert.deepEqual(await vm.request({ op: "free" }), { ok: true, echo: "free" });
  // A second job takes the next slot, without internet: an empty allowlist.
  let second: any;
  const otherStart = launcher.boot("job-2", { vcpus: 1, memoryMiB: 1024, diskMiB: 4096 }, { internet: false }).then(value => { second = value; });
  await otherStart;
  assert.deepEqual(JSON.parse(await readFile(join(policies, "10.200.1.2.json"), "utf8")).allow, []);
  assert.doesNotMatch(config["boot-source"].boot_args, /camel\.proxy/);
  await vm.destroy(); await vm.destroy();
  await second.destroy();
  assert.ok(commands.includes("ip link del dev cj0"));
  await assert.rejects(stat(join(policies, "10.200.0.2.json")));
  await assert.rejects(stat(join(dir, "job-1.ext4")));
  // A job id that could escape the work directory is refused before anything is made.
  await assert.rejects(launcher.boot("../x", { vcpus: 1, memoryMiB: 1, diskMiB: 1 }), /Invalid job id/);
});

test("the isolation suite reports each property, and fails one that leaks", async () => {
  // A scripted host: every probe is refused except the allowlisted fetch, the pid cap bites, and the disk fills.
  const launcher = (leak?: RegExp): VmLauncher => ({
    kind: "firecracker",
    async boot(id) {
      const ip = id.includes("online") ? "10.200.0.2" : "10.200.1.2";
      return {
        id, destroy: async () => {},
        async request(request) {
          if (request.op === "free") return { ok: true, freeBytes: 1024 };
          const command = String(request.command);
          const out = (text: string, code: number) => ({ ok: true, exitCode: code, stdout: { data: Buffer.from(text).toString("base64") }, stderr: { data: "" } });
          if (command.startsWith("ip -4")) return out(`${ip}\n`, 0);
          if (leak?.test(command)) return out("200", 0);
          if (command.includes("registry.npmjs.org/'") && command.startsWith("curl -sS -o /dev/null -m 15")) return out("200", 0);
          if (command.includes("seq 300")) return out("bash: fork: Resource temporarily unavailable", 0);
          if (command.includes("fallocate")) return out("", 0);
          return out("", 7);
        },
      } satisfies Vm;
    },
  });
  const clean = await isolationSuite(launcher());
  assert.ok(clean.length >= 14);
  assert.deepEqual(clean.filter(check => !check.ok), []);
  const leaky = await isolationSuite(launcher(/169\.254\.169\.254/));
  assert.deepEqual(leaky.filter(check => !check.ok).map(check => check.name).sort(), ["IMDS is unreachable directly", "IMDS is unreachable through the proxy"]);
});

test("the image's scripts parse, and its pins are well-formed", async () => {
  for (const script of ["provision/host-setup.sh", "provision/guest-rootfs.sh", "check-image.sh", "test-netns.sh", "files/camel-init", "files/camel-host-prep"])
    execFileSync("bash", ["-n", new URL(script, IMAGE).pathname]);
  const pins = await readFile(new URL("versions.env", IMAGE), "utf8");
  assert.match(pins, /^FIRECRACKER_VERSION=v1\.18\.0$/m);
  assert.match(pins, /^FIRECRACKER_TGZ_SHA256=[0-9a-f]{64}$/m);
  assert.match(pins, /^FIRECRACKER_BIN_SHA256=[0-9a-f]{64}$/m);
  const packer = await readFile(new URL("host.pkr.hcl", IMAGE), "utf8");
  assert.match(packer, /enable_nitro_enclave\s*=\s*true/);
  assert.match(packer, /http_tokens\s*=\s*"required"/);
  assert.match(packer, /ssh_interface\s*=\s*"session_manager"/);
});

test("a guest line past the cap ends the channel instead of growing the host's memory", async () => {
  const { boundedLines } = await import("../jobhost/vm.ts");
  const { PassThrough } = await import("node:stream");
  const stream = new PassThrough();
  const lines = boundedLines(stream, 1024);
  stream.write('{"ok":true}\n{"a":');
  assert.deepEqual(await lines.next(), { value: '{"ok":true}', done: false });
  stream.write("x".repeat(600)); stream.write("x".repeat(600));
  await assert.rejects(lines.next(), /over 1024 bytes/);
  assert.equal(stream.destroyed, true);
  // Lines split across chunks, and \r\n, come out whole.
  const other = new PassThrough(), read = boundedLines(other, 1024);
  other.write('{"a"'); other.write(':1}\r\n'); other.end();
  assert.deepEqual(await read.next(), { value: '{"a":1}', done: false });
  assert.deepEqual(await read.next(), { value: undefined, done: true });
});

test("host-side sync: each file fetched with the job's token, checked, and written into the VM in pieces", async () => {
  const { pullFiles, SYNC_PIECE_BYTES } = await import("../jobhost/agent.ts");
  const { createHash } = await import("node:crypto");
  const big = new Uint8Array(SYNC_PIECE_BYTES * 2 + 5).fill(7), small = new TextEncoder().encode("hi");
  const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  const served: Record<string, Uint8Array> = { "/0": big, "/1": small };
  const seen: string[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    seen.push(String((init.headers as Record<string, string>).authorization));
    const body = served[new URL(url).pathname.replace("/sync/job", "")];
    return body ? new Response(body as BodyInit) : new Response("no", { status: 404 });
  }) as typeof fetch;
  const writes: { path: string; bytes: number; append?: boolean }[] = [];
  const vm = { request: async (request: any) => { for (const file of request.files) writes.push({ path: file.path, bytes: Buffer.from(file.data, "base64").length, ...(file.append ? { append: true } : {}) }); return { ok: true }; } };
  const files = [{ path: "data/big.bin", size: big.length, sha256: sha(big) }, { path: "notes.txt", size: 2, sha256: sha(small) }];
  await pullFiles(vm, { url: "https://run.example/sync/job", token: "t0ken", files }, fetcher);
  assert.deepEqual(seen, ["Bearer t0ken", "Bearer t0ken"]);
  assert.deepEqual(writes.filter(write => write.path === "data/big.bin").map(write => write.append ?? false), [false, true, true]);
  assert.equal(writes.filter(write => write.path === "data/big.bin").reduce((sum, write) => sum + write.bytes, 0), big.length);
  assert.deepEqual(writes.filter(write => write.path === "notes.txt"), [{ path: "notes.txt", bytes: 2 }]);
  // A file that does not match its manifest fails the sync: wrong bytes, or more than it says.
  await assert.rejects(pullFiles(vm, { url: "https://run.example/sync/job", token: "t", files: [{ path: "notes.txt", size: 2, sha256: "0".repeat(64) }] }, (async () => new Response(small as BodyInit)) as typeof fetch), /integrity/);
  await assert.rejects(pullFiles(vm, { url: "https://run.example/sync/job", token: "t", files: [{ path: "notes.txt", size: 1, sha256: sha(small) }] }, (async () => new Response(small as BodyInit)) as typeof fetch), /larger than its manifest/);
  await assert.rejects(pullFiles(vm, { url: "https://run.example/sync/job", token: "t", files: [{ path: "x", size: 1, sha256: "" }] }, (async () => new Response("no", { status: 401 })) as typeof fetch), /answered 401/);
});

test("host-side sync ends at the job's deadline, whatever is still in flight", async () => {
  const { pullFiles } = await import("../jobhost/agent.ts");
  const vm = { request: async () => ({ ok: true }) };
  // A runtime that never finishes sending: the sync gives up at `until`, not after each file's own timeout.
  const stalled = ((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch;
  const began = Date.now();
  await assert.rejects(pullFiles(vm, { url: "https://run.example/sync/job", token: "t", files: [{ path: "a", size: 1, sha256: "" }, { path: "b", size: 1, sha256: "" }], until: Date.now() + 300 }, stalled), /past the job's deadline/);
  assert.ok(Date.now() - began < 3_000);
});
