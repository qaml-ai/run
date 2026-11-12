import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_HOST_MARKUP, HOST_POOL_PRICES, hostInstance, hostPool, hostRates, hostSecondRate, hostSessionCost, parseHostInstance, TEST_POOL_MAX } from "../src/jobs/host-pricing.ts";
import { ComputerMeter, CONTAINER_RATES, type ComputerCharge, type MeterStore } from "../src/computers/meter.ts";

const close = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) <= Math.abs(b) * 1e-9, `${what}: ${a} vs ${b}`);

test("a fully sold host recovers its cost times the markup: a build host whole, a test host by vCPU and memory", () => {
  for (const pool of ["build", "test"] as const) {
    const base = HOST_POOL_PRICES[pool], rates = hostRates(pool);
    close(rates.hostSecond * 3600, base.hostUsdPerHour * DEFAULT_HOST_MARKUP, `${pool} host hour`);
    close((rates.vcpuSecond * base.vcpus + rates.memoryGiBSecond * base.memoryGiB) * 3600, base.hostUsdPerHour * DEFAULT_HOST_MARKUP, `${pool} sold out`);
  }
  // A build job has the whole host, whatever its shape.
  close(hostSecondRate("build", { vcpus: 2, memoryMiB: 4096, diskMiB: 0 }), hostRates("build").hostSecond, "build job");
  // A test job pays for its VM: twice the vCPUs and memory, twice the price.
  const small = hostSecondRate("test", { vcpus: 2, memoryMiB: 4096, diskMiB: 0 }), large = hostSecondRate("test", { vcpus: 4, memoryMiB: 8192, diskMiB: 0 });
  close(large, 2 * small, "test scales with its shape");
});

test("the rates against Cloudflare's: a test job's vCPU and memory cost less than a container's at the default markup", () => {
  const test = hostRates("test");
  assert.ok(test.vcpuSecond < CONTAINER_RATES.vcpuSecond, `${test.vcpuSecond} per vCPU-second`);
  assert.ok(test.memoryGiBSecond < CONTAINER_RATES.memoryGiBSecond * 2, `${test.memoryGiBSecond} per GiB-second`);
  // About: a 2 vCPU / 8 GiB test job, an hour.
  const hour = hostSecondRate("test", { vcpus: 2, memoryMiB: 8192, diskMiB: 0 }) * 3600;
  assert.ok(hour > 0.1 && hour < 0.2, `${hour} an hour`);
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
