// Job host snapshots (docs/design/job-hosts-plan.md, slice 5), the host's side: its cache (download with the job's token,
// check, unpack, LRU by bytes), the save (export, a multipart upload through the runtime, adopt), and the launchers'
// export and boot from a snapshot.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { SnapshotCache, uploadSnapshot } from "../jobhost/snapshots.ts";
import { HostAgent } from "../jobhost/agent.ts";
import { fakeLauncher, type Vm, type VmLauncher } from "../jobhost/vm.ts";
import { ext4Bytes, firecrackerLauncher } from "../jobhost/firecracker.ts";
import type { HostMessage, WireJob } from "../shared/job-host-protocol.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const scratch = async (t: { after(fn: () => unknown): void }, prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
/** A directory as a gzipped tar (a fake host's snapshot archive). */
async function tarball(dir: string, files: Record<string, string>) {
  const root = join(dir, `tree-${Math.random().toString(36).slice(2)}`);
  for (const [path, text] of Object.entries(files)) { await mkdir(join(root, path, ".."), { recursive: true }); await writeFile(join(root, path), text); }
  const archive = `${root}.tar.gz`;
  execFileSync("tar", ["-czf", archive, "-C", root, "."]);
  return new Uint8Array(await readFile(archive));
}
const ID = (n: number) => `tenant-a/hs_${String(n).padStart(22, "0")}`;

test("the snapshot cache: downloaded once, checked, unpacked; a bad download is refused; LRU by bytes, never a pinned entry", async t => {
  const dir = await scratch(t, "snapcache-");
  const archives = new Map<string, Uint8Array>();
  let fetches = 0;
  const tokens: string[] = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    fetches++;
    tokens.push(String((init.headers as Record<string, string>).authorization));
    const body = archives.get(url);
    return body ? new Response(body as BodyInit) : Response.json({ error: "The snapshot is gone" }, { status: 404 });
  }) as typeof fetch;
  const cache = new SnapshotCache({ dir: join(dir, "cache"), kind: "fake", fetcher, maxBytes: 250 });
  const one = await tarball(dir, { "repo/kept.txt": "x".repeat(100) });
  archives.set("https://s3/one", one);
  const ref = { id: ID(1), url: "https://s3/one", token: "t0ken", sha256: sha(one), size: one.length };
  // Two jobs from one snapshot at once: one download.
  const [a, b] = await Promise.all([cache.acquire(ref), cache.acquire(ref)]);
  assert.equal(fetches, 1);
  assert.deepEqual(tokens, ["Bearer t0ken"], "the job's token, as a bearer");
  assert.equal(a.path, b.path);
  assert.equal(await readFile(join(a.path, "repo/kept.txt"), "utf8"), "x".repeat(100));
  a.release(); b.release(); b.release();
  assert.deepEqual(cache.ids(), [ID(1)]);
  assert.equal(cache.bytes(), 100);
  // A handle naming the held id with another digest is not that snapshot: refused, never served from the copy.
  await assert.rejects(cache.acquire({ ...ref, sha256: "f".repeat(64) }), /integrity/);
  assert.equal(fetches, 1);
  // Wrong digest, wrong size, a refusal: nothing cached.
  await assert.rejects(cache.acquire({ ...ref, id: ID(2), sha256: "0".repeat(64) }), /integrity/);
  await assert.rejects(cache.acquire({ ...ref, id: ID(2), size: one.length - 1 }), /larger than its handle/);
  await assert.rejects(cache.acquire({ ...ref, id: ID(2), size: one.length + 1 }), /integrity/);
  await assert.rejects(cache.acquire({ ...ref, id: ID(2), url: "https://s3/missing" }), error => /^the runtime answered 404: The snapshot is gone$/.test((error as Error).message));
  await assert.rejects(cache.acquire({ ...ref, id: "../../etc" }), /Invalid snapshot reference/);
  assert.deepEqual(cache.ids(), [ID(1)]);
  // Past its bound (250 bytes), the least recently used unpinned entry goes; a pinned one stays even over the bound.
  const two = await tarball(dir, { "repo/b.txt": "y".repeat(100) }), three = await tarball(dir, { "repo/c.txt": "z".repeat(100) });
  archives.set("https://s3/two", two); archives.set("https://s3/three", three);
  const pinned = await cache.acquire({ id: ID(2), url: "https://s3/two", token: "t", sha256: sha(two), size: two.length });
  (await cache.acquire(ref)).release(); // one is used again: two is now the least recent, but pinned
  const third = await cache.acquire({ id: ID(3), url: "https://s3/three", token: "t", sha256: sha(three), size: three.length });
  assert.deepEqual(cache.ids().sort(), [ID(2), ID(3)], "one went: the least recently used that was not pinned");
  await assert.rejects(stat(a.path));
  third.release(); pinned.release();
  assert.equal(cache.bytes(), 200);
  assert.deepEqual(cache.ids(), [ID(3), ID(2)], "most recently used first");
});

test("the agent saves a job's disk after exit 0 (export, upload with its length, a copy kept) and starts the next job from it", async t => {
  const dir = await scratch(t, "snapagent-");
  const boots: { id: string; from?: string }[] = [], exported: string[] = [];
  let exportFails = false;
  const launcher: VmLauncher = {
    kind: "fake",
    async boot(id, _shape, options = {}) {
      boots.push({ id, ...(options.from ? { from: options.from } : {}) });
      const kept = options.from ? await readFile(join(options.from, "repo/state.txt"), "utf8").catch(() => "") : "";
      return {
        id, destroy: async () => {},
        async export(dest) {
          exported.push(id);
          if (exportFails) throw new Error("disk busy");
          const tree = join(dir, `tree-${id}`);
          await mkdir(join(tree, "repo"), { recursive: true });
          await writeFile(join(tree, "repo/state.txt"), `saved by ${id}`);
          execFileSync("tar", ["-czf", dest, "-C", tree, "."]);
        },
        async request(request) {
          if (request.op === "free") return { ok: true, freeBytes: 1e12 };
          if (request.op === "run") return { ok: true, exitCode: String(request.command) === "false" ? 1 : 0, timedOut: false, stdout: { data: Buffer.from(kept).toString("base64"), size: kept.length, truncated: false }, stderr: { data: "", size: 0, truncated: false }, commandMs: 1 };
          if (request.op === "collect") return { ok: true, outputs: {}, missing: [], collectMs: 0 };
          return { ok: true, syncMs: 0 };
        },
      } satisfies Vm;
    },
  };
  // The runtime's snapshot routes, faked: parts collected per URL, completed into one archive.
  const parts = new Map<string, Uint8Array[]>(), completed: { url: string; size: number; sha256: string; parts: number; bytes: Uint8Array }[] = [];
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    const part = /^(.*)\/parts\/(\d+)$/.exec(url);
    if (part && init.method === "PUT") {
      if (url.includes("refuse")) return Response.json({ error: "Unauthorized" }, { status: 401 });
      const list = parts.get(part[1]!) ?? [];
      list[Number(part[2]) - 1] = new Uint8Array(await new Response(init.body).arrayBuffer());
      parts.set(part[1]!, list);
      return Response.json({ part: Number(part[2]) });
    }
    if (url.endsWith("/complete") && init.method === "POST") {
      const base = url.slice(0, -"/complete".length), list = parts.get(base) ?? [], body = JSON.parse(String(init.body));
      const bytes = Buffer.concat(list);
      completed.push({ url: base, size: body.size, sha256: body.sha256, parts: list.length, bytes });
      return Response.json({ ok: true });
    }
    return Response.json({ error: "no" }, { status: 404 });
  }) as typeof fetch;
  const agent = new HostAgent({ runtime: "http://127.0.0.1:1", attest: async () => { throw new Error("offline"); }, slots: 2, vcpus: 2, memoryMiB: 4096, launcher, fetcher,
    cache: new SnapshotCache({ dir: join(dir, "cache"), kind: "fake", fetcher }) });
  // What it would send the runtime, in order (no socket here).
  const outbox: HostMessage[] = [];
  (agent as unknown as { send(message: HostMessage): void }).send = message => { outbox.push(message); };
  const resultOf = (id: string) => outbox.find((message): message is Extract<HostMessage, { type: "result" }> => message.type === "result" && message.id === id)!.result;
  const job = (command: string, extra: Partial<WireJob> = {}): WireJob => ({ command, timeoutSeconds: 10, outputs: [], limits: {}, internet: false, files: [], ...extra });

  // A part size smaller than the archive: it goes up in several parts, every one but the last that size.
  const save = (n: number, url = `https://run/snapshots/job-${n}`) => ({ id: ID(n), url, token: "tok", partBytes: 64 });
  await agent.run("save-1", job("build", { save: save(7) }));
  const saved = resultOf("save-1");
  assert.ok(saved.ok && saved.exitCode === 0);
  assert.ok(saved.ok && saved.snapshot, JSON.stringify(saved));
  assert.equal(completed.length, 1);
  const upload = completed[0]!;
  assert.ok(upload.parts >= 2, `${upload.parts} parts`);
  assert.ok(parts.get(upload.url)!.slice(0, -1).every(part => part.length === 64));
  assert.equal(upload.bytes.length, upload.size);
  assert.equal(sha(upload.bytes), upload.sha256, "the parts make the archive whose size and sha256 it said");
  assert.deepEqual(saved.ok && saved.snapshot, { id: ID(7), size: upload.size, sha256: upload.sha256 });
  assert.deepEqual(agent.cache.ids(), [ID(7)], "the saving host keeps a copy");
  // Its heartbeat, sent before its result, says so: the next job from it is placed here.
  const beat = outbox.findLast(message => message.type === "heartbeat") as Extract<HostMessage, { type: "heartbeat" }>;
  assert.deepEqual(beat.cached, [ID(7)]);
  assert.ok(outbox.indexOf(beat) < outbox.findIndex(message => message.type === "result" && message.id === "save-1"));

  // A job from it: no download (the copy), its base cloned, the saved file there.
  await agent.run("from-1", job("cat", { snapshot: { id: ID(7), url: "https://run/snapshots/from-1", token: "tok", sha256: saved.ok ? saved.snapshot!.sha256 : "", size: saved.ok ? saved.snapshot!.size : 0 } }));
  const from = resultOf("from-1");
  assert.ok(from.ok);
  assert.equal(Buffer.from(from.ok ? from.stdout.data : "", "base64").toString(), "saved by save-1");
  assert.ok(boots.at(-1)!.from);
  // A snapshot it does not hold and cannot fetch: start_failed, and no VM is booted.
  const before = boots.length;
  await agent.run("from-2", job("cat", { snapshot: { id: ID(8), url: "https://run/snapshots/from-2", token: "tok", sha256: "a".repeat(64), size: 10 } }));
  const missing = resultOf("from-2");
  assert.equal(!missing.ok && missing.code, "start_failed");
  assert.match(!missing.ok ? missing.message : "", /^Snapshot: the runtime answered 404/);
  assert.equal(boots.length, before);

  // Not saved after a failed command; a failed export or upload leaves the result standing, with why.
  await agent.run("fail-1", job("false", { save: save(9) }));
  assert.equal(exported.includes("fail-1"), false);
  const failed = resultOf("fail-1");
  assert.ok(failed.ok && failed.exitCode === 1 && !failed.snapshot && !failed.snapshotError);
  exportFails = true;
  await agent.run("busy-1", job("build", { save: save(10) }));
  const busy = resultOf("busy-1");
  assert.ok(busy.ok && busy.exitCode === 0 && !busy.snapshot);
  assert.equal(busy.ok && busy.snapshotError, "The snapshot was not saved: disk busy");
  exportFails = false;
  await agent.run("refused-1", job("build", { save: save(11, "https://run/snapshots/refuse-11") }));
  const refused = resultOf("refused-1");
  assert.equal(refused.ok && refused.snapshotError, "The snapshot was not saved: part 1: the runtime answered 401: Unauthorized");
  assert.ok(!agent.cache.ids().includes(ID(11)), "a snapshot the store refused is not kept");
});

test("the fake launcher exports a VM's directory and boots another from it", async t => {
  const dir = await scratch(t, "snapfake-");
  const launcher = fakeLauncher({ work: join(dir, "work") });
  const vm = await launcher.boot("first", { vcpus: 1, memoryMiB: 512, diskMiB: 512 });
  const ran = await vm.request({ op: "run", command: "echo warm > cache.txt", timeoutSeconds: 10 });
  assert.equal(ran.exitCode, 0);
  const archive = join(dir, "first.tar.gz");
  await vm.export(archive);
  await assert.rejects(vm.request({ op: "free" }), "a VM takes no request after its export");
  await vm.destroy();
  await assert.rejects(stat(join(dir, "work", "first")));
  const cache = new SnapshotCache({ dir: join(dir, "cache"), kind: "fake" });
  await cache.adopt(ID(1), archive, sha(await readFile(archive)));
  const base = await cache.acquire({ id: ID(1), url: "https://unused", token: "t", sha256: sha(await readFile(archive)), size: (await stat(archive)).size });
  const next = await launcher.boot("second", { vcpus: 1, memoryMiB: 512, diskMiB: 512 }, { from: base.path });
  base.release();
  const read = await next.request({ op: "run", command: "cat cache.txt", timeoutSeconds: 10 });
  assert.equal(Buffer.from(String((read.stdout as { data: string }).data), "base64").toString(), "warm\n");
  await next.destroy();
  assert.equal(await readFile(join(base.path, "repo/cache.txt"), "utf8"), "warm\n", "the cached base is cloned, never changed");
});

test("the Firecracker launcher exports a synced, checked and shrunk disk, gzipped, and boots a job from a snapshot's ext4", async t => {
  const dir = await scratch(t, "snapfc-");
  const commands: string[] = [], requests: { op: string; command?: string }[] = [];
  let servers: ReturnType<typeof createServer>[] = [];
  t.after(() => { for (const server of servers) server.close(); });
  const launcher = firecrackerLauncher({
    firecracker: "/fc", kernel: "/k", initrd: "/i", image: join(dir, "base.ext4"), work: dir, policyDir: join(dir, "egress"),
    exec: async (file, args) => {
      commands.push([file, ...args].join(" "));
      if (file === "cp") await writeFile(args[2]!, "disk-bytes-and-then-empty-space");
      if (file === "e2fsck") throw Object.assign(new Error("fixed"), { code: 1 }); // a replayed journal: still fine
      if (file === "dumpe2fs") return { stdout: "Filesystem volume name:   <none>\nBlock count:              4\nBlock size:               4\n" };
      if (file === "truncate" && args[0] === "-s" && /^\d+$/.test(args[1]!)) await writeFile(args[2]!, (await readFile(args[2]!)).subarray(0, Number(args[1])));
      return { stdout: "" };
    },
    start: async (_file, args) => {
      const config = JSON.parse(await readFile(args[2]!, "utf8"));
      const server = createServer(socket => {
        let buffer = "", connected = false;
        socket.on("data", chunk => {
          buffer += chunk;
          for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
            const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
            if (!connected) { connected = true; socket.write("OK 1\n"); continue; }
            const request = JSON.parse(line); requests.push(request);
            socket.write(`${JSON.stringify({ ok: true, exitCode: 0 })}\n`);
          }
        });
      });
      server.listen(config.vsock.uds_path); await once(server, "listening");
      servers.push(server);
      const { EventEmitter } = await import("node:events");
      const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, kill: () => { child.exitCode = 0; queueMicrotask(() => child.emit("exit", 0)); return true; } });
      return child as never;
    },
  });
  const vm = await launcher.boot("job-s", { vcpus: 1, memoryMiB: 1024, diskMiB: 4096 });
  const archive = join(dir, "job-s.ext4.gz"), disk = join(dir, "job-s.ext4");
  await vm.export(archive);
  assert.deepEqual(requests.map(request => request.command), ["sync"]);
  assert.deepEqual(commands.slice(-4), [`e2fsck -fy ${disk}`, `resize2fs -M ${disk}`, `dumpe2fs -h ${disk}`, `truncate -s 16 ${disk}`]);
  assert.equal(gunzipSync(await readFile(archive)).toString(), "disk-bytes-and-t", "the disk cut to its filesystem, gzipped");
  await vm.destroy();
  await assert.rejects(stat(disk));
  // A job from a cached snapshot clones that ext4, not the base image.
  await mkdir(join(dir, "cache"), { recursive: true });
  await writeFile(join(dir, "cache", "abc.ext4"), "fs");
  const next = await launcher.boot("job-t", { vcpus: 1, memoryMiB: 1024, diskMiB: 4096 }, { from: join(dir, "cache", "abc.ext4") });
  assert.ok(commands.includes(`cp --reflink=always ${join(dir, "cache", "abc.ext4")} ${join(dir, "job-t.ext4")}`));
  await next.destroy();
  // One whose filesystem is past the job's disk is refused, not cut short.
  await writeFile(join(dir, "cache", "big.ext4"), Buffer.alloc(2 * 1024 * 1024));
  await assert.rejects(launcher.boot("job-u", { vcpus: 1, memoryMiB: 1024, diskMiB: 1 }, { from: join(dir, "cache", "big.ext4") }), /larger than this job's 1 MiB disk/);
  assert.equal(ext4Bytes("Block count:              262144\nBlock size:               4096\n"), 1024 ** 3);
  assert.throws(() => ext4Bytes("nothing"), /size/);
});

test("an upload goes in parts from disk, a lost part tried again, a refusal final; a test host can stop part-way", async t => {
  const dir = await scratch(t, "snapupload-");
  const file = join(dir, "a.gz");
  await writeFile(file, "twenty-three bytes long");
  const seen: string[] = [];
  let flaky = 1;
  const fetcher = (async (url: string, init: RequestInit = {}) => {
    seen.push(`${init.method} ${url.replace("https://run/s/j", "")} ${init.body instanceof Blob ? init.body.size : ""}`.trim());
    if (url.endsWith("/parts/2") && flaky-- > 0) return Response.json({ error: "busy" }, { status: 503 });
    return Response.json({ ok: true });
  }) as typeof fetch;
  const result = await uploadSnapshot(file, { url: "https://run/s/j", token: "t", partBytes: 10 }, { fetcher });
  assert.deepEqual(seen, ["PUT /parts/1 10", "PUT /parts/2 10", "PUT /parts/2 10", "PUT /parts/3 3", "POST /complete"]);
  assert.deepEqual(result, { sha256: sha(new TextEncoder().encode("twenty-three bytes long")), size: 23 });
  await assert.rejects(uploadSnapshot(file, { url: "https://run/s/j", token: "t", partBytes: 10 }, { fetcher: (async () => Response.json({ error: "A part is 1 to 10 bytes" }, { status: 400 })) as typeof fetch }), /part 1: the runtime answered 400: A part is 1 to 10 bytes/);
  seen.length = 0;
  await assert.rejects(uploadSnapshot(file, { url: "https://run/s/j", token: "t", partBytes: 10 }, { fetcher, failAfterParts: 1 }), /stopped after 1 parts/);
  assert.deepEqual(seen, ["PUT /parts/1 10"], "no completion");
});

test("a build host keeps one pre-started VM: a job that fits takes it at once, the next is started when idle", async t => {
  const dir = await mkdtemp(join(tmpdir(), "jobhost-warm-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // The fake launcher, counting boots and egress changes.
  const real = fakeLauncher({ work: dir }), boots: { id: string; warm: boolean }[] = [], egress: { vm: string; job: string; internet: boolean }[] = [], destroyed: string[] = [];
  const launcher: VmLauncher = {
    kind: "fake",
    async boot(id, shape, options = {}) {
      boots.push({ id, warm: !!options.warm });
      const vm = await real.boot(id, shape, options);
      return { ...vm, request: vm.request.bind(vm), destroy: async () => { destroyed.push(id); await vm.destroy(); }, egress: async (job: string, internet: boolean) => { egress.push({ vm: id, job, internet }); } };
    },
  };
  const agent = new HostAgent({ runtime: "http://127.0.0.1:1", attest: async () => { throw new Error("offline"); }, slots: 1, vcpus: 16, memoryMiB: 98304, launcher,
    prestart: { vcpus: 16, memoryMiB: 98304, diskMiB: 65536 }, cache: new SnapshotCache({ dir: join(dir, "cache"), kind: "fake" }) });
  const outbox: HostMessage[] = [];
  (agent as unknown as { send(message: HostMessage): void }).send = message => { outbox.push(message); };
  const resultOf = (id: string) => outbox.find((message): message is Extract<HostMessage, { type: "result" }> => message.type === "result" && message.id === id)?.result;
  t.after(() => agent.close());
  // Started as it starts (no runtime here: start() also dials, which fails quietly and retries).
  (agent as unknown as { prestartNext(): void }).prestartNext();
  const warmReady = async () => { for (let i = 0; i < 100 && !(await (agent as unknown as { warm?: Promise<Vm | undefined> }).warm); i++) await new Promise(resolve => setTimeout(resolve, 20)); };
  await warmReady();
  assert.deepEqual(boots.map(boot => boot.warm), [true]);
  // A build job within the warm shape: it takes the warm VM (no boot of its own), with its own egress.
  await agent.run("build-1", { command: "echo built", timeoutSeconds: 10, outputs: [], limits: { cpus: 16, memoryMiB: 98304, diskMiB: 65536 }, internet: true, files: [] });
  assert.equal(resultOf("build-1")?.ok, true, JSON.stringify(resultOf("build-1")));
  assert.deepEqual(egress, [{ vm: boots[0]!.id, job: "build-1", internet: true }]);
  assert.equal(boots.filter(boot => !boot.warm).length, 0, "the job booted nothing of its own");
  // Idle again: the next warm VM.
  await warmReady();
  assert.deepEqual(boots.map(boot => boot.warm), [true, true]);
  // One that does not fit (a bigger disk) gives the warm VM up and boots its own: one sandbox at a time.
  await agent.run("build-2", { command: "true", timeoutSeconds: 10, outputs: [], limits: { cpus: 16, memoryMiB: 98304, diskMiB: 200_000 }, internet: false, files: [] });
  assert.equal(resultOf("build-2")?.ok, true);
  assert.ok(destroyed.includes(boots[1]!.id), "the unused warm VM was destroyed before the job's own booted");
  assert.deepEqual(boots.slice(2, 3), [{ id: "build-2", warm: false }]);
});
