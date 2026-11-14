import assert from "node:assert/strict";
import test from "node:test";
import { volumeFiles } from "../src/jobs/camel-sync.ts";
import { JOB_LIMITS, JobSpecError, jobInstance, jobSpec } from "../src/jobs/job.ts";

const PAYER = { tenant: "t", agent: "a" };
const bytes = (text: string) => new TextEncoder().encode(text);
const decoder = new TextDecoder();

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
