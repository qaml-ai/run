import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { camelSync, inlineFiles, tarEnd, tarEntry, volumeFiles } from "../src/jobs/camel-sync.ts";
import { readCapped, runContainerJob, type JobMeter } from "../src/jobs/container-job.ts";
import { jobDriver, jobObjectName } from "../src/jobs/driver.ts";
import { JOB_LIMITS, JobSpecError, jobInstance, jobSpec, jobVolume, type JobResult } from "../src/jobs/job.ts";
import { SNAPSHOT_TTL_MS, type ComputerSnapshot } from "../src/computers/provider.ts";

const encoder = new TextEncoder(), decoder = new TextDecoder();
const bytes = (text: string) => encoder.encode(text);
const concat = (chunks: Uint8Array[]) => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
};
const stream = (data?: Uint8Array | string) => data === undefined ? null : new ReadableStream<Uint8Array>({
  start(c) { const b = typeof data === "string" ? bytes(data) : data; for (let i = 0; i < b.byteLength; i += 1 << 20) c.enqueue(b.subarray(i, i + (1 << 20))); c.close(); },
});

type Exec = { argv: string[]; options?: ContainerExecOptions; stdin?: Uint8Array };
type Answer = { stdout?: string | Uint8Array; exitCode?: number; hang?: boolean };
/** A Container whose exec answers by argv, recording every call; `command` answers the job's own command. */
function fakeContainer(answers: { df?: string; pids?: number; tar?: number; command?: (exec: Exec) => Answer; outputs?: Record<string, string | Uint8Array>; startFails?: boolean } = {}) {
  const calls: Exec[] = [], starts: ContainerStartupOptions[] = [], events: string[] = [];
  const container = {
    running: false,
    images: { workspace: "registry/workspace@sha256:1" } as Record<string, string>,
    start(options?: ContainerStartupOptions) { starts.push(options!); events.push("start"); this.running = true; },
    async setInactivityTimeout(_ms: number | bigint) {},
    async destroy() { events.push("destroy"); this.running = false; },
    async snapshotContainer(options: { name: string }) { events.push(`snapshot:${options.name}`); return { id: "snap-new", size: 99 }; },
    async interceptOutboundHttps() {},
    async exec(argv: string[], options?: ContainerExecOptions): Promise<ExecProcess> {
      const call: Exec = { argv, options };
      calls.push(call);
      let answer: Answer = {};
      if (argv[0] === "mkdir") answer = { exitCode: answers.startFails ? 1 : 0 };
      else if (argv[0] === "df") answer = { stdout: answers.df ?? "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda 20000000 1000000 19000000 5% /\n" };
      else if (argv[0] === "sh") answer = { exitCode: answers.pids ?? 0 };
      else if (argv[0] === "tar") answer = { exitCode: answers.tar ?? 0 };
      else if (argv[0] === "bash") answer = answers.command?.(call) ?? { stdout: "ok\n" };
      else if (argv[0] === "cat" && argv[1] === "--") {
        const name = argv[2].slice("/out/".length), output = answers.outputs?.[name];
        answer = output === undefined ? { exitCode: 1 } : { stdout: output };
      } else if (argv[0] === "cat") answer = { stdout: "usage_usec 4200000\n" };
      let kill!: () => void;
      const killed = new Promise<void>(resolve => { kill = resolve; });
      const chunks: Uint8Array[] = [];
      const stdin = options?.stdin === "pipe" ? new WritableStream<Uint8Array>({
        write(chunk) { chunks.push(chunk); },
        close() { call.stdin = concat(chunks); },
      }) : null;
      const exitCode = answer.hang ? killed.then(() => 137) : Promise.resolve(answer.exitCode ?? 0);
      return {
        stdin: stdin as WritableStream<Uint8Array>,
        stdout: options?.stdout === "pipe" ? (answer.hang ? new ReadableStream({ start(c) { void killed.then(() => c.close()); } }) : stream(answer.stdout ?? "")) : null,
        stderr: options?.stderr === "pipe" ? stream("") : null,
        pid: 1, isPty: false, exitCode,
        output: async () => { throw new Error("unbounded output API must not be used"); },
        kill: () => { events.push(`kill:${argv[0]}`); kill(); },
        resize() {},
      } as unknown as ExecProcess;
    },
  };
  return { container, calls, starts, events };
}
function recordingMeter(refuse = false) {
  const events: string[] = [];
  const meter: JobMeter = {
    async admit(instance) { events.push(`admit:${instance}`); if (refuse) throw new Error("Spending limit reached"); },
    async started(instance, idleMs) { events.push(`started:${instance}:${idleMs}`); },
    async used(cpu) { events.push(`used:${cpu}`); },
    async stopped(cpu) { events.push(`stopped:${cpu}`); return 0.0125; },
  };
  return { meter, events };
}
/** Unpack tar bytes with the system tar into a temporary directory. */
function untar(archive: Uint8Array) {
  const dir = mkdtempSync(join(tmpdir(), "camel-sync-"));
  execFileSync("tar", ["-x", "-f", "-", "-C", dir], { input: archive });
  return { dir, read: (path: string) => readFileSync(join(dir, path), "utf8"), done: () => rmSync(dir, { recursive: true, force: true }) };
}
/** Node's AbortSignal.timeout does not hold the event loop open (a Worker's does): hold it while a job waits on one. */
function keepAlive(t: { after(fn: () => void): void }) {
  const timer = setInterval(() => {}, 1000);
  t.after(() => clearInterval(timer));
}
const ok = (result: JobResult) => { if (!result.ok) assert.fail(`${result.code}: ${result.message}`); return result; };

const PAYER = { tenant: "t", agent: "a" };
test("a job spec is checked before any compute starts, and picks the smallest instance its limits fit", () => {
  assert.equal(jobInstance(), "standard-1");
  assert.equal(jobInstance({ cpus: 4, memoryMiB: 12288, diskMiB: 16384 }), "standard-4", "the design's example");
  assert.equal(jobInstance({ cpus: 1 }), "standard-2");
  assert.equal(jobInstance({ memoryMiB: 8192 }), "standard-3");
  assert.throws(() => jobInstance({ cpus: 16 }), JobSpecError);
  assert.throws(() => jobInstance({ diskMiB: 32 * 1024 }), /largest has 4 vCPUs/);
  const spec = jobSpec({ payer: PAYER, id: "test-1", command: "bun test", timeoutSeconds: 60, outputs: ["junit.xml", "/junit.xml", "logs/a.txt"], files: { "/src/a.ts": bytes("a") } });
  assert.deepEqual(spec.outputs, ["junit.xml", "logs/a.txt"]);
  assert.deepEqual(Object.keys(spec.files!), ["src/a.ts"]);
  assert.equal(spec.image, "workspace");
  assert.throws(() => jobSpec({ id: "j", command: "x", timeoutSeconds: 1 }), /needs a payer/, "a job without a payer is refused");
  // A workflow payer: its tenant pays under the workflow's id, which must be one.
  assert.deepEqual(jobSpec({ payer: { tenant: PAYER.tenant, agent: "wf_abc", kind: "workflow" }, id: "w", command: "x", timeoutSeconds: 1 }).payer, { tenant: PAYER.tenant, agent: "wf_abc", kind: "workflow" });
  assert.throws(() => jobSpec({ payer: { tenant: PAYER.tenant, agent: "client_x", kind: "workflow" }, id: "w", command: "x", timeoutSeconds: 1 }), /payer kind is "workflow"/);
  assert.throws(() => jobSpec({ payer: { ...PAYER, kind: "account" }, id: "w", command: "x", timeoutSeconds: 1 }), /payer kind is "workflow"/);
  // A checked spec checks again unchanged (the driver checks, the container object checks what it is sent).
  const checked = jobSpec({ payer: PAYER, id: "rt", command: "x", timeoutSeconds: 5, outputs: ["a.txt"], limits: { cpus: 2, pids: 128 }, files: { "a.txt": bytes("a") }, saveSnapshot: "warm" });
  assert.deepEqual(jobSpec(checked), checked);
  assert.deepEqual(jobSpec(structuredClone(checked)), checked, "as it arrives over RPC");
  assert.throws(() => jobSpec({ ...checked, instance: "standard-4" }), /derived from limits/);
  assert.throws(() => jobSpec({ id: "j", command: "x", timeoutSeconds: 1, volume: { tenant: "other", volume: "v", snapshot: "s" }, payer: PAYER }), /payer's tenant only/);
  for (const bad of [
    { payer: PAYER, id: "job:1", command: "x", timeoutSeconds: 1 },
    { payer: PAYER, id: "j", command: "", timeoutSeconds: 1 },
    { payer: PAYER, id: "j", command: "x", timeoutSeconds: 0 },
    { payer: PAYER, id: "j", command: "x", timeoutSeconds: 3601 },
    { payer: PAYER, id: "j", command: "x", timeoutSeconds: 1, outputs: ["../etc/passwd"] },
    { payer: PAYER, id: "j", command: "x", timeoutSeconds: 1, files: { "a/../../b": bytes("x") } },
    { payer: PAYER, id: "j", command: "x", timeoutSeconds: 1, files: { "a": "text" } },
    { payer: PAYER, id: "j", command: "x", timeoutSeconds: 1, files: {}, volume: { tenant: "t", volume: "v", snapshot: "s" } },
    { payer: PAYER, id: "j", command: "x", timeoutSeconds: 1, limits: { pids: 1 } },
    { payer: PAYER, id: "j", command: "x", timeoutSeconds: 1, limits: { gpus: 1 } },
    { payer: PAYER, id: "j", command: "x", timeoutSeconds: 1, snapshot: { id: "s" } },
    { id: "j", command: "x", timeoutSeconds: 1, volume: { tenant: "a", volume: "v", snapshot: "s" }, payer: { tenant: "b", agent: "x" } },
    { payer: PAYER, id: "j", command: "x", timeoutSeconds: 1, extra: true },
    { payer: PAYER, id: "j", command: "x", timeoutSeconds: 1, files: { a: new Uint8Array(JOB_LIMITS.inlineBytes + 1) } },
    { id: "j", command: "x", timeoutSeconds: 1 },
    { id: "j", command: "x", timeoutSeconds: 1, payer: { tenant: "t" } },
  ]) assert.throws(() => jobSpec(bad), JobSpecError, JSON.stringify(bad).slice(0, 120));
});

test("commit checkpoints only a volume's tree", () => {
  const base = { payer: PAYER, id: "checkpoint", command: "true", timeoutSeconds: 5 };
  const volume = { tenant: "t", volume: "v", snapshot: "s" };
  assert.equal(jobSpec({ ...base, volume, commit: true }).commit, true);
  assert.equal(jobSpec({ ...base, commit: false }).commit, undefined);
  assert.throws(() => jobSpec({ ...base, commit: true }), { code: "JOB_INVALID", message: "A job commits only a volume's tree: commit needs volume" });
  for (const commit of ["true", 1, null]) assert.throws(() => jobSpec({ ...base, volume, commit }), JobSpecError);
});

test("camel-sync writes a tar the system tar unpacks, long and non-ASCII paths included", async () => {
  const long = `${"deep/".repeat(30)}file.txt`;
  const archive = concat([...tarEntry("a.txt", bytes("alpha")), ...tarEntry(long, bytes("long")), ...tarEntry("ünï/cödé.ts", bytes("utf8")), ...tarEntry("empty", new Uint8Array()), tarEnd()]);
  assert.equal(archive.byteLength % 512, 0);
  const out = untar(archive);
  try {
    assert.equal(out.read("a.txt"), "alpha");
    assert.equal(out.read(long), "long");
    assert.equal(out.read("ünï/cödé.ts"), "utf8");
    assert.equal(out.read("empty"), "");
  } finally { out.done(); }
  // Through a container: one tar process in /repo, fed on stdin.
  const { container, calls } = fakeContainer();
  const synced = await camelSync(container as never, inlineFiles({ "b.txt": bytes("bee"), "a.txt": bytes("ay") }), AbortSignal.timeout(5000));
  assert.deepEqual(synced, { files: 2, bytes: 5 });
  const tar = calls.find(call => call.argv[0] === "tar")!;
  assert.deepEqual(tar.argv.slice(0, 6), ["tar", "-x", "-f", "-", "-C", "/repo"]);
  const unpacked = untar(tar.stdin!);
  try { assert.equal(unpacked.read("a.txt"), "ay"); assert.equal(unpacked.read("b.txt"), "bee"); } finally { unpacked.done(); }
  // A path that climbs out is refused even when it reaches the sync without the spec check.
  await assert.rejects(camelSync(fakeContainer().container as never, (async function* () { yield { path: "../x", bytes: bytes("x") }; })(), AbortSignal.timeout(5000)), /Invalid job file path/);
  await assert.rejects(camelSync(fakeContainer({ tar: 2 }).container as never, inlineFiles({ a: bytes("a") }), AbortSignal.timeout(5000)), /tar exited 2/);
});

test("a volume snapshot is synced from the keys it pins, each checked against its digest", async () => {
  const hash = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map(x => x.toString(16).padStart(2, "0")).join("");
  const objects = new Map<string, Uint8Array>([["k1", bytes("one")], ["k2", bytes("two")]]);
  const entries = [{ path: "/src/one.ts", key: "k1", size: 3, sha256: await hash(bytes("one")) }, { path: "/two.ts", key: "k2", size: 3, sha256: await hash(bytes("two")) }];
  const asked: string[] = [];
  const env = {
    VOLUMES: { getByName: (name: string) => ({ readSet: async (prefix?: string, snapshot?: string) => { asked.push(`${name} ${prefix} ${snapshot}`); return { files: entries }; } }) },
    BUCKET: { get: async (key: string) => objects.has(key) ? { arrayBuffer: async () => objects.get(key)!.slice().buffer } : null },
  };
  const files = [];
  for await (const file of volumeFiles(env, { tenant: "t1", volume: "vol", snapshot: "snap" })) files.push([file.path, decoder.decode(file.bytes)]);
  assert.deepEqual(asked, ["t1:vol / snap"]);
  assert.deepEqual(files, [["/src/one.ts", "one"], ["/two.ts", "two"]]);
  objects.set("k2", bytes("TWO"));
  await assert.rejects(async () => { for await (const _ of volumeFiles(env, { tenant: "t1", volume: "vol", snapshot: "snap" })); }, /integrity check failed/);
  objects.delete("k1");
  await assert.rejects(async () => { for await (const _ of volumeFiles(env, { tenant: "t1", volume: "vol", snapshot: "snap" })); }, /file object missing/);
  await assert.rejects(async () => { for await (const _ of volumeFiles({}, { tenant: "t1", volume: "vol", snapshot: "snap" })); }, /not bound/);
});

test("a job starts, syncs, runs one command in /repo, collects its outputs and is destroyed, metered start to stop", async () => {
  const big = new Uint8Array(JOB_LIMITS.streamBytes + 1000).fill(65);
  const { container, calls, starts, events } = fakeContainer({
    command: () => ({ stdout: big }),
    outputs: { "junit.xml": "<testsuite/>", "big.bin": new Uint8Array(JOB_LIMITS.outputBytes + 5) },
  });
  const { meter, events: metered } = recordingMeter();
  const spec = jobSpec({ payer: PAYER, id: "run-1", command: "bun test", timeoutSeconds: 60, outputs: ["junit.xml", "nope.txt", "big.bin"], files: { "a.txt": bytes("a") }, limits: { cpus: 2, pids: 4096 } });
  const result = ok(await runContainerJob(spec, { container: container as never, meter, files: inlineFiles(spec.files!) }));
  assert.equal(result.instance, "standard-3");
  assert.deepEqual(starts, [{ image: "registry/workspace@sha256:1", instance: "standard-3", enableInternet: false }]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout.size, big.byteLength);
  assert.equal(result.stdout.bytes.byteLength, JOB_LIMITS.streamBytes);
  assert.equal(result.stdout.truncated, true);
  assert.equal(decoder.decode(result.outputs["junit.xml"].bytes), "<testsuite/>");
  assert.equal(result.outputs["big.bin"].truncated, true);
  assert.equal(result.outputs["big.bin"].bytes.byteLength, JOB_LIMITS.outputTotalBytes - "<testsuite/>".length, "outputs share one total");
  assert.deepEqual(result.missing, ["nope.txt"]);
  assert.equal(result.pids, "cgroup");
  assert.deepEqual(calls.map(call => call.argv[0]), ["mkdir", "df", "sh", "tar", "bash", "cat", "cat", "cat", "cat"]);
  const command = calls.find(call => call.argv[0] === "bash")!;
  assert.deepEqual(command.argv, ["bash", "-lc", "bun test"]);
  assert.equal(command.options?.cwd, "/repo");
  assert.deepEqual(command.options?.env, { JOB_ID: "run-1", JOB_OUT: "/out" });
  assert.match(calls.find(call => call.argv[0] === "sh")!.argv[2], /^echo 4096 > \/sys\/fs\/cgroup\/pids.max$/);
  assert.equal(events.at(-1), "destroy");
  assert.equal(container.running, false);
  assert.deepEqual(metered, ["admit:standard-3", `started:standard-3:${(60 + 600 + 120) * 1000}`, "stopped:4200000"]);
  assert.equal(result.costUsd, 0.0125, "the result says what its container time cost, as the meter charged it");
  for (const key of ["startMs", "syncMs", "commandMs", "collectMs", "totalMs"] as const) assert.ok(result.timings[key] >= 0);
});

test("a container with less than 2 GiB free fails disk_low before the command, naming the snapshot", async () => {
  const snapshot: ComputerSnapshot = { id: "snap-1", name: "bun-rust-warm", size: 1, image: "registry/workspace@sha256:1", createdAt: Date.now(), expiresAt: Date.now() + SNAPSHOT_TTL_MS };
  const { container, calls, starts } = fakeContainer({ df: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda 8000000 7000000 1048576 90% /\n" });
  const result = await runContainerJob(jobSpec({ payer: PAYER, id: "d", snapshot, command: "make", timeoutSeconds: 10 }), { container: container as never });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.code, "disk_low");
  assert.equal(!result.ok && result.freeBytes, 1024 ** 3);
  assert.match(!result.ok ? result.message : "", /Snapshot bun-rust-warm leaves 1\.00 GiB free/);
  assert.deepEqual(starts, [{ containerSnapshot: { id: "snap-1" }, instance: "standard-1", enableInternet: false }]);
  assert.ok(!calls.some(call => call.argv[0] === "bash"), "the command never ran");
  assert.equal(container.running, false);
});

test("a command past its timeout is killed, keeps its outputs, and the container is destroyed", async (t) => {
  keepAlive(t);
  const { container, events } = fakeContainer({ command: () => ({ hang: true }), outputs: { "partial.txt": "half" } });
  const result = ok(await runContainerJob(jobSpec({ payer: PAYER, id: "t", command: "sleep 100", timeoutSeconds: 1, outputs: ["partial.txt"] }), { container: container as never }));
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
  assert.equal(decoder.decode(result.outputs["partial.txt"].bytes), "half");
  assert.ok(events.includes("kill:bash"));
  assert.equal(events.at(-1), "destroy");
});

test("stop() ends a running job as stopped; refused admission starts nothing", async (t) => {
  keepAlive(t);
  const controller = new AbortController();
  const { container, events } = fakeContainer({ command: () => { setTimeout(() => controller.abort(), 10); return { hang: true }; } });
  const { meter, events: metered } = recordingMeter();
  const stopped = await runContainerJob(jobSpec({ payer: PAYER, id: "s", command: "sleep 100", timeoutSeconds: 60 }), { container: container as never, meter, stop: controller.signal });
  assert.equal(!stopped.ok && stopped.code, "stopped");
  assert.equal(events.at(-1), "destroy");
  assert.equal(metered.at(-1), "stopped:4200000");

  const refused = fakeContainer(), refusing = recordingMeter(true);
  const result = await runContainerJob(jobSpec({ payer: PAYER, id: "r", command: "true", timeoutSeconds: 60 }), { container: refused.container as never, meter: refusing.meter });
  assert.equal(!result.ok && result.code, "admission_refused");
  assert.match(!result.ok ? result.message : "", /Spending limit/);
  assert.deepEqual(refused.starts, []);
  assert.deepEqual(refusing.events, ["admit:standard-1"]);
});

test("snapshots: one from another image version is refused; saveSnapshot saves only after exit 0", async () => {
  const old: ComputerSnapshot = { id: "snap-old", name: "warm", size: 1, image: "registry/workspace@sha256:0", createdAt: 1, expiresAt: Date.now() + 1000 };
  const mismatch = fakeContainer();
  const refused = await runContainerJob(jobSpec({ payer: PAYER, id: "m", snapshot: old, command: "true", timeoutSeconds: 5 }), { container: mismatch.container as never });
  assert.equal(!refused.ok && refused.code, "start_failed");
  assert.match(!refused.ok ? refused.message : "", /another image version/);
  assert.deepEqual(mismatch.starts, []);

  const saved = fakeContainer();
  const result = ok(await runContainerJob(jobSpec({ payer: PAYER, id: "w", command: "bun install", timeoutSeconds: 5, saveSnapshot: "bun-warm" }), { container: saved.container as never }));
  assert.equal(result.snapshot?.id, "snap-new");
  assert.equal(result.snapshot?.image, "registry/workspace@sha256:1", "a saved snapshot records the image its disk came from");
  assert.ok(saved.events.indexOf("snapshot:bun-warm") < saved.events.lastIndexOf("destroy"));

  const failing = fakeContainer({ command: () => ({ exitCode: 1 }) });
  const failed = ok(await runContainerJob(jobSpec({ payer: PAYER, id: "f", command: "false", timeoutSeconds: 5, saveSnapshot: "bun-warm" }), { container: failing.container as never }));
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.snapshot, undefined);
  assert.ok(!failing.events.some(event => event.startsWith("snapshot:")));
});

test("start and sync failures are results, and the container never outlives them", async () => {
  const notReady = fakeContainer({ startFails: true });
  const start = await runContainerJob(jobSpec({ payer: PAYER, id: "n", command: "true", timeoutSeconds: 5 }), { container: notReady.container as never, imageWaitMs: 100, startWaitMs: 100 });
  assert.equal(!start.ok && start.code, "start_failed");
  assert.equal(notReady.container.running, false);
  const sync = fakeContainer({ tar: 2 });
  const synced = await runContainerJob(jobSpec({ payer: PAYER, id: "y", command: "true", timeoutSeconds: 5 }), { container: sync.container as never, files: inlineFiles({ a: bytes("a") }) });
  assert.equal(!synced.ok && synced.code, "sync_failed");
  assert.ok(!sync.calls.some(call => call.argv[0] === "bash"));
  assert.equal(sync.container.running, false);
  const unconfigured = fakeContainer();
  const image = await runContainerJob(jobSpec({ payer: PAYER, id: "i", image: "other", command: "true", timeoutSeconds: 5 }), { container: unconfigured.container as never });
  assert.match(!image.ok ? image.message : "", /Job image other is not configured/);
  const unenforced = fakeContainer({ pids: 1 });
  assert.equal(ok(await runContainerJob(jobSpec({ payer: PAYER, id: "p", command: "true", timeoutSeconds: 5, limits: { pids: 64 } }), { container: unenforced.container as never })).pids, "unenforced");
});

test("readCapped keeps the first bytes and counts the rest", async () => {
  const read = await readCapped(stream("abcdefghij"), 4);
  assert.deepEqual([decoder.decode(read.bytes), read.size, read.truncated], ["abcd", 10, true]);
  const whole = await readCapped(stream("abc"), 4);
  assert.deepEqual([decoder.decode(whole.bytes), whole.size, whole.truncated], ["abc", 3, false]);
});

test("jobDriver: JOBS_UNAVAILABLE without the container binding; with it, one object per job", async () => {
  const none = jobDriver({});
  assert.equal(none.ok, false);
  assert.equal(!none.ok && none.code, "JOBS_UNAVAILABLE");
  const names: string[] = [], specs: unknown[] = [];
  const namespace = { getByName: (name: string) => ({
    runJob: async (spec: unknown) => { specs.push(spec); return { ok: true, id: "x" }; },
    stopJob: async () => ({ stopped: true }),
  }) };
  const found = jobDriver({ COMPUTER_CONTAINERS: { getByName: (name: string) => { names.push(name); return namespace.getByName(name); } } as never });
  assert.ok(found.ok);
  const driver = found.driver;
  await driver.run({ payer: PAYER, id: "abc", command: "true", timeoutSeconds: 5 });
  assert.deepEqual(await driver.stop("abc"), { stopped: true });
  assert.deepEqual(names, [jobObjectName("abc"), "job:abc"]);
  assert.equal(specs.length, 1);
  assert.deepEqual(jobSpec(specs[0]), specs[0], "the object is sent the checked spec, which it accepts");
  await assert.rejects(driver.run({ payer: PAYER, id: "bad id", command: "true", timeoutSeconds: 5 }), JobSpecError);
  assert.equal(specs.length, 1, "a bad spec never reaches the container object");
});

test("JOB_PROVIDER: containers, hosts or auto, each only where configured; auto sends a job to the one that suits it", async () => {
  const calls: string[] = [];
  const containerNs = { getByName: (name: string) => ({
    runJob: async (spec: any) => { calls.push(`container ${name} ${spec.instance}`); return { ok: true, id: spec.id }; },
    stopJob: async () => { calls.push(`container stop ${name}`); return { stopped: false }; },
  }) } as never;
  const hostNs = { getByName: (name: string) => ({
    run: async (spec: any) => { calls.push(`host ${name} ${spec.instance} ${spec.limits?.cpus ?? ""}`); return { ok: true, id: spec.id }; },
    stop: async () => { calls.push(`host stop ${name}`); return { stopped: true }; },
  }) } as never;
  const hostEnv = { JOB_HOST_ATTESTORS: "test", HOST_JOBS: hostNs, JOB_HOSTS: {} as never, JOB_HOST_REGISTRY: {} as never };
  // Unset: hosts where they are configured, else containers; asked for and missing, unavailable, never another.
  assert.equal((jobDriver({ COMPUTER_CONTAINERS: containerNs, ...hostEnv }) as any).driver.provider, "camelrun-hosts");
  assert.equal((jobDriver({ COMPUTER_CONTAINERS: containerNs }) as any).driver.provider, "cloudflare-containers");
  assert.equal((jobDriver({ COMPUTER_CONTAINERS: containerNs, ...hostEnv, JOB_PROVIDER: "containers" }) as any).driver.provider, "cloudflare-containers");
  for (const env of [{ JOB_PROVIDER: "hosts", COMPUTER_CONTAINERS: containerNs }, { JOB_PROVIDER: "auto", COMPUTER_CONTAINERS: containerNs }, { JOB_PROVIDER: "auto", ...hostEnv }, { JOB_PROVIDER: "gpu", COMPUTER_CONTAINERS: containerNs, ...hostEnv }]) {
    const found = jobDriver(env as never);
    assert.equal(!found.ok && found.code, "JOBS_UNAVAILABLE", JSON.stringify(Object.keys(env)));
  }
  const auto = jobDriver({ COMPUTER_CONTAINERS: containerNs, ...hostEnv, JOB_PROVIDER: "auto" });
  assert.ok(auto.ok);
  // Fits a container: a container. Past it: a host, with its limits. Needs a snapshot or another image: a container.
  await auto.driver.run({ payer: PAYER, id: "small", command: "true", timeoutSeconds: 5, limits: { cpus: 2 } });
  await auto.driver.run({ payer: PAYER, id: "big", command: "true", timeoutSeconds: 5, limits: { cpus: 16, memoryMiB: 64 * 1024 } });
  await auto.driver.run({ payer: PAYER, id: "snap", command: "true", timeoutSeconds: 5, saveSnapshot: "warm" });
  assert.deepEqual(calls, ["container job:small standard-3", "host job:big standard-4 16", "container job:snap standard-1"]);
  const commitSpec = { payer: PAYER, id: "checkpoint", command: "true", timeoutSeconds: 5, volume: { tenant: "t", volume: "v", snapshot: "s" }, commit: true };
  await auto.driver.run(commitSpec);
  assert.equal(calls.at(-1), "host job:checkpoint standard-1 ");
  for (const extra of [{ saveSnapshot: "warm" }, { image: "custom" }, { snapshot: { id: "s", name: "warm", size: 1, image: "workspace", createdAt: 1, expiresAt: Date.now() + SNAPSHOT_TTL_MS } }])
    await assert.rejects(auto.driver.run({ ...commitSpec, ...extra }), { code: "JOB_INVALID", message: "commit cannot be combined with a snapshot or a custom image" });
  // Past even a build host: the spec error, before any object.
  await assert.rejects(auto.driver.run({ payer: PAYER, id: "huge", command: "true", timeoutSeconds: 5, limits: { cpus: 32 } }), /No job host has these limits/);
  // A stop reaches whichever driver ran it.
  calls.length = 0;
  assert.deepEqual(await auto.driver.stop("big"), { stopped: true });
  assert.deepEqual(calls.sort(), ["container stop job:big", "host stop job:big"]);
  // Containers alone still refuse what does not fit one.
  const containersOnly = jobDriver({ COMPUTER_CONTAINERS: containerNs });
  assert.ok(containersOnly.ok);
  await assert.rejects(containersOnly.driver.run(commitSpec), { code: "JOB_INVALID", message: "commit needs camelFS job hosts; Cloudflare containers cannot checkpoint a job's tree" });
  await assert.rejects(containersOnly.driver.run({ payer: PAYER, id: "big2", command: "true", timeoutSeconds: 5, limits: { cpus: 16 } }), /largest has 4 vCPUs/);
});

test("a job at a volume that is gone says so, naming the volume and why a workflow's fork would be", async () => {
  const gone = jobVolume(async () => { throw Object.assign(new Error("FILE_404:Unknown volume"), { status: 404 }); }, "vol_fork");
  await assert.rejects(gone, (error: unknown) => error instanceof JobSpecError && /No volume vol_fork: .*forks are deleted when the workflow ends/.test((error as Error).message));
  await assert.rejects(jobVolume(async () => { throw Object.assign(new Error("down"), { status: 503 }); }, "vol_x"), /down/, "anything else is not a missing volume");
  assert.equal(await jobVolume(async () => "the volume", "vol_ok"), "the volume");
});
