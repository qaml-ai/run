import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startFixture } from "./fixture.ts";

// docs/design/job-hosts-plan.md, slice 5, in fake mode against the fixture's local R2: a job on a host saves its disk as
// a snapshot (a multipart upload through the runtime, here in 5 MiB parts), the next job starts from it on the host that
// holds it (placement prefers the holder), another tenant's job and a wrong token read nothing, a newer save of the same
// name deletes the older, the sweep deletes an expired one, and an upload a host abandons is aborted.
const AGENT = fileURLToPath(new URL("../../../jobhost/agent.ts", import.meta.url));
const PART = 5 * 1024 * 1024, TTL_SECONDS = 90;

async function setup(t: { after(fn: () => unknown): void }, vars: Record<string, string> = {}) {
  const secret = "jobhost-fixture-secret-with-at-least-32-characters", otherToken = "tenant-b-integration-token-with-at-least-32-characters";
  const fixture = await startFixture({
    entrypoint: join(process.cwd(), "test/jobs-entry.ts"),
    tenants: [{ id: "camelrun-proto-local", token: "local-integration-only-token-with-at-least-32-characters" }, { id: "tenant-b", token: otherToken }],
    vars: { JOB_HOST_ATTESTORS: "test", JOB_HOST_TEST_SECRET: secret, JOB_HOST_WAIT_SECONDS: "8", ADMIN_TENANTS: "camelrun-proto-local", ...vars },
  });
  t.after(() => fixture.stop());
  const log = { agents: "" };
  const call = async (path: string, body?: unknown, token = fixture.token) => {
    const response = await fetch(fixture.url + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(1_200_000) });
    const text = await response.text();
    assert.ok(response.ok, `${path}: ${response.status} ${text}\n${fixture.worker.logs().slice(-3000)}\n${log.agents.slice(-3000)}`);
    return JSON.parse(text);
  };
  const until = async <T>(read: () => Promise<T | false | undefined>, what: string, ms = 60_000) => {
    for (const end = Date.now() + ms; Date.now() < end;) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 250)); }
    throw new Error(`Timed out: ${what}\n${fixture.worker.logs().slice(-3000)}\n${log.agents.slice(-3000)}`);
  };
  // A host in fake mode, its VMs' directories under its own work directory (so a job's `pwd` says which host ran it).
  const work: Record<string, string> = {};
  const host = async (name: string, env: Record<string, string> = {}) => {
    work[name] = await mkdtemp(join(tmpdir(), `${name}-`));
    t.after(() => Promise.all([rm(work[name]!, { recursive: true, force: true }), rm(`${work[name]}-cache`, { recursive: true, force: true })]).then(() => {}));
    const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", AGENT, "--fake", "--attestor", "test", "--runtime", fixture.url, "--name", name, "--slots", "2", "--disk-low", "0",
      "--work", work[name]!, "--cache", `${work[name]}-cache`], { env: { ...process.env, JOB_HOST_TEST_SECRET: secret, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", chunk => { log.agents += chunk; });
    child.stderr.on("data", chunk => { log.agents += chunk; });
    t.after(() => { child.kill("SIGKILL"); });
    await until(async () => (await call("/__test/job-hosts") as { name: string; free: number; slots: number; revoked: number }[]).some(entry => entry.name === name && !entry.revoked && entry.free === entry.slots && entry.slots > 0), `${name}'s registration`);
  };
  const revoke = async (name: string) => assert.equal((await fetch(`${fixture.url}/v1/job-hosts/${name}`, { method: "DELETE", headers: { authorization: `Bearer ${fixture.token}` } })).status, 200);
  const payer = async (token: string) => {
    const definition = await call("/v1/definitions", { name: "Snapshot jobs" }, token);
    return (await call("/v1/agents", { definition: definition.id }, token)).id as string;
  };
  const stored = async (tenant: string) => await call(`/__test/r2?prefix=${encodeURIComponent(`snapshots/${tenant}/`)}`) as { key: string; size: number }[];
  return { fixture, call, until, host, revoke, payer, stored, log, otherToken,
    ranOn: (stdout: string) => Object.keys(work).find(name => stdout.includes(work[name]!)),
    text: (value: { bytes: string }) => Buffer.from(value.bytes, "base64").toString() };
}

type Handle = { id: string; name: string; size: number; image: string; createdAt: number; expiresAt: number };

test("snapshots on job hosts: saved in parts to R2, started from on the holder, scoped, superseded, swept, aborted", { timeout: 600_000 }, async t => {
  const { fixture, call, until, host, revoke, payer, stored, log, otherToken, ranOn, text } = await setup(t, {
    JOB_HOST_SNAPSHOT_PART_BYTES: String(PART), JOB_HOST_SNAPSHOT_TTL_SECONDS: String(TTL_SECONDS),
  });
  const tenant = "camelrun-proto-local", owner = { tenant, agent: await payer(fixture.token) };
  const idOf = (handle: Handle) => /^host:(hs_[A-Za-z0-9_-]+):([0-9a-f]{64})$/.exec(handle.id)!;

  // One host: the save lands there. 12 MiB of random bytes do not compress, so the archive goes up in 3 parts of 5 MiB
  // (the last shorter); it is stored under the payer's tenant at the size the handle says.
  await host("host-b");
  const saved = await call("/__test/jobs", { id: "save-1", payer: owner, command: "head -c 12582912 /dev/urandom > blob.bin; echo warm > state.txt; pwd", saveSnapshot: "warm", timeoutSeconds: 120 });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(saved.exitCode, 0, text(saved.stderr));
  assert.equal(saved.snapshotError, undefined);
  assert.equal(ranOn(text(saved.stdout)), "host-b");
  const first = saved.snapshot as Handle, [, firstId] = idOf(first);
  assert.equal(first.name, "warm");
  assert.equal(first.image, "workspace");
  assert.equal(first.expiresAt - first.createdAt, TTL_SECONDS * 1000);
  assert.deepEqual(await stored(tenant), [{ key: `snapshots/${tenant}/${firstId}.gz`, size: first.size }]);
  const parts = Number(/"type":"jobhost_snapshot_uploaded","bytes":\d+,"parts":(\d+)/.exec(log.agents)?.[1]);
  assert.ok(parts >= 3, `${parts} parts`);
  assert.equal(parts, Math.ceil(first.size / PART));

  // A second host, first by name: a plain job goes to it. A job from the snapshot goes to host-b, which holds it.
  await host("host-a");
  const plain = await call("/__test/jobs", { id: "plain-1", payer: owner, command: "pwd; test ! -e state.txt", timeoutSeconds: 60 });
  assert.equal(plain.exitCode, 0, text(plain.stdout));
  assert.equal(ranOn(text(plain.stdout)), "host-a", "with no snapshot, the first host by name");
  const resumed = await call("/__test/jobs", { id: "from-1", payer: owner, snapshot: first, command: "cat state.txt; stat -c %s blob.bin; pwd", timeoutSeconds: 60 });
  assert.equal(resumed.exitCode, 0, JSON.stringify(resumed));
  assert.match(text(resumed.stdout), /^warm\n12582912\n/);
  assert.equal(ranOn(text(resumed.stdout)), "host-b", "placed on the host that holds the snapshot");

  // Another tenant with the same handle: its key is its own tenant's, where there is none. A wrong token reads nothing;
  // a tampered digest, an expired handle and a container's never start.
  const stranger = { tenant: "tenant-b", agent: await payer(otherToken) };
  const forged = await call("/__test/jobs", { id: "forged-1", payer: stranger, snapshot: first, command: "cat state.txt", timeoutSeconds: 60 });
  assert.equal(forged.code, "start_failed", JSON.stringify(forged));
  assert.match(forged.message, /no longer exists .*not this tenant's/);
  for (const token of ["", "guess"]) {
    const response = await fetch(`${fixture.url}/v1/internal/job-hosts/snapshots/from-1`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const part = await fetch(`${fixture.url}/v1/internal/job-hosts/snapshots/save-1/parts/1`, { method: "PUT", headers: { authorization: `Bearer ${token}` }, body: "abc" });
    assert.equal(part.status, 401);
  }
  const tampered = await call("/__test/jobs", { id: "tampered-1", payer: owner, snapshot: { ...first, id: `host:${firstId}:${"0".repeat(64)}` }, command: "true", timeoutSeconds: 60 });
  assert.match(tampered.message, /does not match/);
  assert.match((await call("/__test/jobs", { id: "expired-1", payer: owner, snapshot: { ...first, expiresAt: Date.now() - 1 }, command: "true", timeoutSeconds: 60 })).message, /expired/);
  assert.match((await call("/__test/jobs", { id: "container-1", payer: owner, snapshot: { ...first, id: "cloudflare-snapshot-id" }, command: "true", timeoutSeconds: 60 })).message, /taken on Cloudflare Containers/);
  // A failed command saves nothing.
  const failed = await call("/__test/jobs", { id: "fail-1", payer: owner, command: "exit 3", saveSnapshot: "never", timeoutSeconds: 60 });
  assert.equal(failed.exitCode, 3);
  assert.equal(failed.snapshot, undefined);

  // A newer save of the same name by the same payer deletes the older one; a job from the older handle is refused.
  const again = await call("/__test/jobs", { id: "save-2", payer: owner, snapshot: first, command: "echo hotter > state.txt", saveSnapshot: "warm", timeoutSeconds: 120 });
  assert.equal(again.exitCode, 0, JSON.stringify(again));
  const second = again.snapshot as Handle, [, secondId] = idOf(second);
  assert.deepEqual((await stored(tenant)).map(entry => entry.key), [`snapshots/${tenant}/${secondId}.gz`], "the older one is gone");
  const stale = await call("/__test/jobs", { id: "stale-1", payer: owner, snapshot: first, command: "true", timeoutSeconds: 60 });
  assert.match(stale.message, /no longer exists \(a newer save of that name replaced it/);

  // Without host-b, a job from the newer snapshot goes to host-a, which downloads it, checks it and starts from it.
  await revoke("host-b");
  const downloaded = await call("/__test/jobs", { id: "from-2", payer: owner, snapshot: second, command: "cat state.txt; pwd", timeoutSeconds: 60 });
  assert.equal(downloaded.exitCode, 0, JSON.stringify(downloaded));
  assert.match(text(downloaded.stdout), /^hotter\n/);
  assert.equal(ranOn(text(downloaded.stdout)), "host-a");
  assert.match(log.agents, /"type":"jobhost_snapshot_downloaded","bytes":\d+/);

  // A host that dies part-way through an upload (here it stops after one part): the job's result stands, with why; the
  // job object aborts the R2 upload when the job ends, and nothing new is stored.
  await revoke("host-a");
  await host("host-c", { JOBHOST_TEST_SAVE_PARTS: "1" });
  const abandoned = await call("/__test/jobs", { id: "abandon-1", payer: owner, command: "head -c 12582912 /dev/urandom > blob.bin", saveSnapshot: "other", timeoutSeconds: 120 });
  assert.equal(abandoned.exitCode, 0, JSON.stringify(abandoned));
  assert.equal(abandoned.snapshot, undefined);
  assert.match(abandoned.snapshotError, /stopped after 1 parts/);
  await until(async () => fixture.worker.logs().includes('"type":"host_snapshot_upload_aborted","job":"abandon-1"'), "the abandoned upload aborted");
  assert.deepEqual((await stored(tenant)).map(entry => entry.key), [`snapshots/${tenant}/${secondId}.gz`]);

  // Past its expiry, the sweep deletes it; a job from it is refused.
  await until(async () => (await stored(tenant)).length === 0, "the expired snapshot swept", (second.expiresAt - Date.now()) + 60_000);
  assert.match(fixture.worker.logs(), /"type":"host_snapshots_deleted","why":"expired","count":1/);
  assert.match((await call("/__test/jobs", { id: "swept-1", payer: owner, snapshot: second, command: "true", timeoutSeconds: 60 })).message, /expired/);
});

// The transfer's throughput, when asked (JOB_HOST_SNAPSHOT_BENCH_MB): a snapshot of that many MB of random bytes saved
// in 64 MiB parts, then started from on a second host, which downloads it. Prints both rates as the host measured them.
test("snapshot transfer throughput (JOB_HOST_SNAPSHOT_BENCH_MB)", { timeout: 1_800_000, skip: !process.env.JOB_HOST_SNAPSHOT_BENCH_MB && "set JOB_HOST_SNAPSHOT_BENCH_MB to run" }, async t => {
  const mb = Number(process.env.JOB_HOST_SNAPSHOT_BENCH_MB);
  const { fixture, call, host, revoke, payer, log } = await setup(t);
  const owner = { tenant: "camelrun-proto-local", agent: await payer(fixture.token) };
  await host("bench-a");
  const saved = await call("/__test/jobs", { id: "bench-save", payer: owner, command: `head -c ${mb * 1_000_000} /dev/urandom > blob.bin`, saveSnapshot: "bench", timeoutSeconds: 1200 });
  assert.ok(saved.snapshot, JSON.stringify(saved).slice(0, 2000));
  await revoke("bench-a");
  await host("bench-b");
  const from = await call("/__test/jobs", { id: "bench-load", payer: owner, snapshot: saved.snapshot, command: "stat -c %s blob.bin", timeoutSeconds: 1200 });
  assert.equal(from.exitCode, 0, JSON.stringify(from).slice(0, 2000));
  const rate = (type: string) => {
    const match = new RegExp(`"type":"${type}","bytes":(\\d+)(?:,"parts":\\d+)?,"ms":(\\d+)`).exec(log.agents);
    return match ? { bytes: Number(match[1]), ms: Number(match[2]), mbPerSecond: Math.round(Number(match[1]) / 1e6 / (Number(match[2]) / 1000)) } : undefined;
  };
  const up = rate("jobhost_snapshot_uploaded"), down = rate("jobhost_snapshot_downloaded");
  console.log(JSON.stringify({ type: "snapshot_bench", mb, upload: up, download: down }));
  assert.ok(up && down);
});
