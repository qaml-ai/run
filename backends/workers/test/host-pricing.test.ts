import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_HOST_MARKUP, HOST_POOL_PRICES, hostInstance, hostPool, hostRates, hostSecondRate, hostShare, TEST_POOL_MAX } from "../src/jobs/host-pricing.ts";
import { hostShape } from "../src/jobs/host-pricing.ts";

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
});

test("VM shape uses resource overrides and falls back to the instance defaults", () => {
  const spec = (limits?: { cpus?: number; memoryMiB?: number }, instance: "standard-1" | "standard-3" = "standard-1") => ({ limits, instance });
  assert.deepEqual(hostShape(spec()), { vcpus: 1, memoryMiB: 4096, diskMiB: Math.ceil(8e9 / 2 ** 20) }, "standard-1");
  assert.deepEqual(hostShape(spec({ cpus: 1.5 }, "standard-3")), { vcpus: 2, memoryMiB: 8192, diskMiB: Math.ceil(16e9 / 2 ** 20) }, "fractional vCPUs round up; memory and disk use the instance defaults");
  assert.equal(hostShape(spec({ memoryMiB: 2048 })).memoryMiB, 2048);
  assert.equal(hostPool(hostShape(spec({ cpus: 4, memoryMiB: 12288 }))), "test");
  assert.equal(hostPool(hostShape(spec({ cpus: 2, memoryMiB: 32768 }))), "build");
  assert.equal(hostPool(hostShape(spec({ cpus: 16 }))), "build");
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

test("the meter's instance name carries the pool and shape", () => {
  const name = hostInstance("test", { vcpus: 2, memoryMiB: 6144, diskMiB: 12000 });
  assert.equal(name, "test-2vcpu-6144mib");
});
