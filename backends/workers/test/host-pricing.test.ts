import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { DEFAULT_HOST_MARKUP, HOST_POOL_PRICES, hostInstance, hostPool, hostRates, hostSecondRate, hostSessionCost, hostShare, parseHostInstance, TEST_POOL_MAX } from "../src/jobs/host-pricing.ts";
import { hostRoles, hostShape } from "../src/jobs/host-pricing.ts";
import { jobSpec } from "../src/jobs/job.ts";
import { ComputerMeter, CONTAINER_RATES, type ComputerCharge, type MeterStore } from "../src/computers/meter.ts";

const close = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) <= Math.abs(b) * 1e-9, `${what}: ${a} vs ${b}`);

test("a host recovers its cost times the markup when sold out on its dominant resource; a build job pays the whole host", () => {
  for (const pool of ["build", "test"] as const) close(hostRates(pool).hostSecond * 3600, HOST_POOL_PRICES[pool].hostUsdPerHour * DEFAULT_HOST_MARKUP, `${pool} host hour`);
  const full = hostRates("test").hostSecond;
  // Test hosts fill on memory (24 GiB of sandbox memory; vCPUs are shared): six 1 vCPU / 4 GiB jobs are the whole host.
  close(6 * hostSecondRate("test", { vcpus: 1, memoryMiB: 4096, diskMiB: 0 }), full, "memory-full host");
  // CPU-heavy jobs pay by vCPU: four 4 vCPU / 2 GiB jobs are the whole host's vCPUs.
  close(4 * hostSecondRate("test", { vcpus: 4, memoryMiB: 2048, diskMiB: 0 }), full, "vCPU-full host");
  // The design doc's 4 vCPU / 8 GiB shard: a third of the host by memory.
  close(hostSecondRate("test", { vcpus: 4, memoryMiB: 8192, diskMiB: 0 }), full / 3, "a shard");
  close(hostSecondRate("build", { vcpus: 2, memoryMiB: 4096, diskMiB: 0 }), hostRates("build").hostSecond, "build job");
  // Never more than a whole host.
  close(hostShare("test", { vcpus: 64, memoryMiB: 1 << 20, diskMiB: 0 }), 1, "capped at a host");
});

test("about what a job costs at the defaults", () => {
  const hour = (shape: { vcpus: number; memoryMiB: number }) => hostSecondRate("test", { ...shape, diskMiB: 0 }) * 3600;
  assert.ok(Math.abs(hour({ vcpus: 2, memoryMiB: 8192 }) - 0.33) < 0.01, `${hour({ vcpus: 2, memoryMiB: 8192 })}`);
  assert.ok(Math.abs(hostRates("build").hostSecond * 3600 - 1.48) < 0.01);
  // Cloudflare's for the same 2 vCPU / 8 GiB, at its provisioned rates, for comparison: hosts serve the larger jobs.
  assert.ok(2 * CONTAINER_RATES.vcpuSecond * 3600 + 8 * CONTAINER_RATES.memoryGiBSecond * 3600 < hour({ vcpus: 2, memoryMiB: 8192 }));
});

test("the pools' sandbox memory is what the image reserves (versions.env)", () => {
  const pins = readFileSync(new URL("../../../infra/job-hosts/image/versions.env", import.meta.url), "utf8");
  const gib = (name: string) => Number(pins.split("\n").find(line => line.startsWith(`NE_MEMPOOL_${name}=`))?.split("=")[1]?.replace(/G$/, ""));
  assert.equal(gib("TEST"), HOST_POOL_PRICES.test.memoryGiB);
  assert.equal(gib("BUILD"), HOST_POOL_PRICES.build.memoryGiB);
});

test("a job's VM: its limits, else its instance type's resources, in whole vCPUs; its pool by size", () => {
  const spec = (limits?: object) => jobSpec({ id: "j", command: "true", timeoutSeconds: 5, payer: { tenant: "t", agent: "a" }, ...(limits ? { limits } : {}) });
  assert.deepEqual(hostShape(spec()), { vcpus: 1, memoryMiB: 4096, diskMiB: Math.ceil(8e9 / 2 ** 20) }, "standard-1");
  assert.deepEqual(hostShape(spec({ cpus: 1.5 })), { vcpus: 2, memoryMiB: 8192, diskMiB: Math.ceil(16e9 / 2 ** 20) }, "fractional cpus round up; the instance that fits them (standard-3)");
  assert.equal(hostShape(spec({ memoryMiB: 2048 })).memoryMiB, 2048);
  assert.equal(hostPool(hostShape(spec({ cpus: 4, memoryMiB: 12288 }))), "test");
});

test("JOB_HOST_ROLE_ARNS: pool=arn entries; anything else fails the whole setting closed", () => {
  assert.deepEqual(hostRoles("build=arn:aws:iam::1:role/b, test=arn:aws:iam::1:role/t"), [{ pool: "build", arn: "arn:aws:iam::1:role/b" }, { pool: "test", arn: "arn:aws:iam::1:role/t" }]);
  for (const bad of [undefined, "", "arn:aws:iam::1:role/t", "gpu=arn:aws:iam::1:role/g", "test=", "test=arn:aws:iam::1:role/t,oops"]) assert.equal(hostRoles(bad), undefined, String(bad));
});

test("the markup and each pool's host price are settings; a setting that does not parse refuses, never charges nothing", () => {
  close(hostRates("test", { JOB_HOST_PRICE_MARKUP: "1" }).hostSecond * 3600, HOST_POOL_PRICES.test.hostUsdPerHour, "at cost");
  close(hostRates("build", { JOB_HOST_PRICE_BUILD_HOUR_USD: "2", JOB_HOST_PRICE_MARKUP: "1.5" }).hostSecond * 3600, 3, "build overridden");
  close(hostRates("test", { JOB_HOST_PRICE_BUILD_HOUR_USD: "2" }).hostSecond, hostRates("test").hostSecond, "another pool's setting");
  for (const bad of ["abc", "0.5", "-1", "11", "NaN"]) assert.throws(() => hostRates("test", { JOB_HOST_PRICE_MARKUP: bad }), /JOB_HOST_PRICE_MARKUP/);
  assert.throws(() => hostRates("test", { JOB_HOST_PRICE_TEST_HOUR_USD: "0" }), /JOB_HOST_PRICE_TEST_HOUR_USD/);
});

test("a job goes to the test pool up to a shard's size, and to the build pool above it", () => {
  assert.equal(hostPool({ vcpus: 4, memoryMiB: 12 * 1024, diskMiB: 0 }), "test");
  assert.equal(hostPool({ vcpus: TEST_POOL_MAX.vcpus, memoryMiB: TEST_POOL_MAX.memoryMiB, diskMiB: 0 }), "test");
  assert.equal(hostPool({ vcpus: TEST_POOL_MAX.vcpus + 1, memoryMiB: 1024, diskMiB: 0 }), "build");
  assert.equal(hostPool({ vcpus: 1, memoryMiB: TEST_POOL_MAX.memoryMiB + 1, diskMiB: 0 }), "build");
});

test("the meter's instance name carries the pool and shape, so a charge after a restart prices the same VM", () => {
  const name = hostInstance("test", { vcpus: 2, memoryMiB: 6144, diskMiB: 12000 });
  assert.equal(name, "test-2vcpu-6144mib");
  assert.deepEqual(parseHostInstance(name), { pool: "test", shape: { vcpus: 2, memoryMiB: 6144, diskMiB: 0 } });
  for (const bad of ["standard-2", "test-2vcpu", "gpu-2vcpu-1mib", "test-1000vcpu-1mib"]) assert.equal(parseHostInstance(bad), undefined, bad);
  close(hostSessionCost(name, 60), 60 * hostSecondRate("test", { vcpus: 2, memoryMiB: 6144, diskMiB: 0 }), "a minute");
  assert.throws(() => hostSessionCost("standard-2", 60), /Not a host job instance/);
});

test("the meter charges a host job through its pricing, from start to stop, once", async () => {
  const data = new Map<string, unknown>(), charges: ComputerCharge[] = [];
  let now = 1_000_000;
  const store: MeterStore = {
    async get<T>(key: string) { return structuredClone(data.get(key)) as T | undefined; },
    async put(key, value) { data.set(key, structuredClone(value)); },
    async delete(key) { return data.delete(key); },
    async list<T>({ prefix }: { prefix: string }) { return new Map([...data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value) as T])); },
  };
  const meter = new ComputerMeter({ store, idleMs: 3_600_000, now: () => now, schedule: async () => {},
    billing: { async admit() {}, async charge(charge) { if (!charges.some(c => c.id === charge.id)) charges.push(charge); } },
    price: (instance, seconds) => hostSessionCost(instance, seconds) });
  const instance = hostInstance("test", { vcpus: 2, memoryMiB: 4096, diskMiB: 0 });
  await meter.started({ tenant: "t1", agent: "a1" }, instance, 3_600_000, 0, "job:j1");
  now += 90_000;
  await meter.stopped();
  assert.equal(charges.length, 1);
  assert.equal(charges[0]!.instance, instance);
  assert.equal(charges[0]!.seconds, 90);
  close(charges[0]!.costUsd, hostSessionCost(instance, 90), "the job's charge");
  close(meter.spentUsd(), charges[0]!.costUsd, "spent");
});

test("a session's rate fixed at its start, and its span as reported, are what it is charged", async () => {
  const data = new Map<string, unknown>(), charges: ComputerCharge[] = [];
  let now = 2_000_000;
  const store: MeterStore = {
    async get<T>(key: string) { return structuredClone(data.get(key)) as T | undefined; },
    async put(key, value) { data.set(key, structuredClone(value)); },
    async delete(key) { return data.delete(key); },
    async list<T>({ prefix }: { prefix: string }) { return new Map([...data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value) as T])); },
  };
  // A price hook that would fail (a setting broken since the start) is never called: the fixed rate is used.
  const meter = new ComputerMeter({ store, idleMs: 3_600_000, now: () => now, schedule: async () => {},
    billing: { async admit() {}, async charge(charge) { charges.push(charge); } },
    price: () => { throw new Error("JOB_HOST_PRICE_MARKUP must be a number"); } });
  now += 60_000;
  await meter.started({ tenant: "t1", agent: "a1" }, "test-1vcpu-4096mib", 3_600_000, 0, "job:j2", { at: now - 50_000, rate: 0.001 });
  await meter.stopped(undefined, now - 20_000);
  assert.equal(charges.length, 1);
  assert.equal(charges[0]!.seconds, 30, "from the reported start to the reported end");
  close(charges[0]!.costUsd, 0.03, "30 s at the fixed rate");
  // A start reported in the future is now; an end before it, nothing.
  await meter.started({ tenant: "t1", agent: "a1" }, "test-1vcpu-4096mib", 3_600_000, 0, "job:j3", { at: now + 10_000, rate: 0.001 });
  await meter.stopped(undefined, now - 1_000);
  assert.equal(charges.length, 1);
});
