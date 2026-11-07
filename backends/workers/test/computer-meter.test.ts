import assert from "node:assert/strict";
import test from "node:test";
import { CHECKPOINT_MS, ComputerMeter, SETTLE_MARGIN_MS, CONTAINER_RATES, holdRate, secondRate, type ComputerCharge, type MeterStore } from "../src/computers/meter.ts";
import { ContainerProvider, operate, type ProviderMeter } from "../src/computers/provider.ts";

const payer = { tenant: "t1", agent: "a1" };
function harness(options: { failCharges?: number; failStatus?: number } = {}) {
  const data = new Map<string, unknown>(), charges: ComputerCharge[] = [], alarms: number[] = [];
  let now = 1_000_000, failures = options.failCharges ?? 0, refuse = false;
  const store: MeterStore = {
    async get<T>(key: string) { return structuredClone(data.get(key)) as T | undefined; },
    async put(key, value) { data.set(key, structuredClone(value)); },
    async delete(key) { return data.delete(key); },
    async list<T>({ prefix }: { prefix: string }) {
      return new Map([...data].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value) as T]));
    },
  };
  const meter = new ComputerMeter({
    store, idleMs: 60_000, now: () => now, schedule: async at => { alarms.push(at); },
    billing: {
      async admit() { if (refuse) throw Object.assign(new Error("credit spent"), { status: 402 }); },
      async charge(charge) {
        if (failures > 0) { failures--; throw Object.assign(new Error("database unavailable"), options.failStatus ? { status: options.failStatus } : {}); }
        // Exactly once per session id, as the durable receipt makes it.
        if (!charges.some(c => c.id === charge.id)) charges.push(charge);
      },
    },
  });
  return { meter, data, charges, alarms, advance: (ms: number) => { now += ms; }, now: () => now, refuse: () => { refuse = true; } };
}

test("a container is charged from its start until it is destroyed, at its instance's rate", async () => {
  const h = harness();
  await h.meter.started(payer, "standard-1");
  h.advance(20_000);
  await h.meter.used();
  h.advance(10_000);
  await h.meter.stopped();
  assert.equal(h.charges.length, 1);
  const [charge] = h.charges;
  assert.equal(charge.seconds, 30);
  assert.equal(charge.instance, "standard-1");
  assert.deepEqual([charge.tenant, charge.agent], ["t1", "a1"]);
  // 1/2 vCPU, 4 GiB, 8 GB at Cloudflare's list rates.
  assert.ok(Math.abs(secondRate("standard-1") - (0.5 * 0.00002 + 4 * 0.0000025 + 8 * 0.00000007)) < 1e-15);
  assert.ok(Math.abs(charge.costUsd - 30 * secondRate("standard-1")) < 1e-12);
  assert.equal(await h.meter.settled(), true);
});

test("a container that idled out is charged until its idle timeout, not until someone notices", async () => {
  const h = harness();
  await h.meter.started(payer, "lite");
  h.advance(10_000);
  await h.meter.used();
  assert.equal(h.alarms.at(-1), h.now() + 60_000 + SETTLE_MARGIN_MS);
  // The alarm while the container may still run leaves the session open.
  h.advance(30_000);
  await h.meter.alarm(true);
  assert.equal(h.charges.length, 0);
  h.advance(3_600_000);
  await h.meter.alarm(false);
  assert.equal(h.charges.length, 1);
  assert.equal(h.charges[0].seconds, 70, "10 s of use, then 60 s until it idled out");
  // The next start (the container had stopped) opens a new session; nothing is charged twice.
  await h.meter.started(payer, "lite");
  h.advance(5_000);
  await h.meter.stopped();
  assert.deepEqual(h.charges.map(c => c.seconds), [70, 5]);
});

test("a start after an unnoticed idle-out closes the old session at its idle time", async () => {
  const h = harness();
  await h.meter.started(payer, "lite");
  h.advance(600_000);
  await h.meter.started(payer, "lite");
  await h.meter.stopped();
  assert.deepEqual(h.charges.map(c => c.seconds), [60], "a zero-length session records nothing");
});

test("a charge that fails stays unsettled and is retried once, never lost or doubled", async () => {
  const h = harness({ failCharges: 2 });
  await h.meter.started(payer, "lite");
  h.advance(4_000);
  await h.meter.stopped();
  assert.equal(h.charges.length, 0);
  assert.equal(await h.meter.settled(), false);
  assert.equal(h.alarms.at(-1), h.now() + 60_000, "a retry is scheduled");
  await h.meter.alarm(false);
  assert.equal(h.charges.length, 0);
  await h.meter.alarm(false);
  assert.equal(h.charges.length, 1);
  assert.equal(h.charges[0].seconds, 4);
  await h.meter.alarm(false);
  assert.equal(h.charges.length, 1);
  assert.equal(await h.meter.settled(), true);
});

test("the provider asks the meter before every start and reports use and stops", async () => {
  const events: string[] = [];
  let refuse = false;
  const meter: ProviderMeter = {
    async admit() { events.push("admit"); if (refuse) throw new Error("credit spent"); },
    async started(instance) { events.push(`started:${instance}`); },
    async used() { events.push("used"); },
    async stopped() { events.push("stopped"); },
  };
  const starts: unknown[] = [];
  const container = {
    running: false,
    images: { workspace: "img" } as Record<string, string>,
    start(options?: ContainerStartupOptions) { starts.push(options); this.running = true; },
    async setInactivityTimeout() {},
    async destroy() { this.running = false; },
    async snapshotContainer() { return { id: "s1", size: 1 }; },
    async exec(): Promise<ExecProcess> {
      const empty = () => new ReadableStream({ start(c) { c.close(); } });
      return { stdin: null, stdout: empty(), stderr: empty(), pid: 1, isPty: false, exitCode: Promise.resolve(0), output: async () => { throw new Error("unused"); }, kill() {}, resize() {} };
    },
  };
  const data = new Map<string, unknown>();
  const store = { async get<T>(key: string) { return data.get(key) as T | undefined; }, async put(key: string, value: unknown) { data.set(key, value); } };
  const provider = new ContainerProvider(container, store, { image: "workspace", instance: "standard-2" }, Date.now, undefined, meter);
  await operate(provider, { op: "exec", argv: ["true"] });
  assert.deepEqual(events, ["admit", "started:standard-2", "used", "used"]);
  events.length = 0;
  await operate(provider, { op: "sleep" });
  // Sleep saves the disk first: a paid operation on the running container, then the stop.
  assert.deepEqual(events, ["admit", "used", "stopped"]);
  refuse = true;
  events.length = 0;
  await assert.rejects(operate(provider, { op: "exec", argv: ["true"] }), /credit spent/);
  assert.deepEqual(events, ["admit"], "a refused start starts nothing");
  assert.equal(starts.length, 1);
  // A running computer is admitted again on every operation: a refusal stops further use.
  refuse = false;
  await operate(provider, { op: "exec", argv: ["true"] });
  refuse = true;
  events.length = 0;
  await assert.rejects(operate(provider, { op: "exec", argv: ["true"] }), /credit spent/);
  assert.deepEqual(events, ["admit"]);
});

test("a session in constant use is charged every checkpoint, and continues as a new one", async () => {
  const h = harness();
  await h.meter.started(payer, "lite");
  for (let elapsed = 0; elapsed < CHECKPOINT_MS + 30_000; elapsed += 30_000) {
    h.advance(30_000);
    await h.meter.used();
  }
  assert.equal(h.charges.length, 1, "the first checkpoint charged");
  assert.equal(h.charges[0].seconds, (CHECKPOINT_MS + 30_000) / 1000 - 30);
  h.advance(10_000);
  await h.meter.stopped();
  assert.equal(h.charges.length, 2);
  const total = h.charges.reduce((sum, c) => sum + c.seconds, 0);
  assert.equal(total, (CHECKPOINT_MS + 30_000 + 10_000) / 1000, "checkpoints neither lose nor add time");
  assert.notEqual(h.charges[0].id, h.charges[1].id);
});

test("a container that outlives its idle time is checked an idle period later, not every few seconds", async () => {
  const h = harness();
  await h.meter.started(payer, "lite");
  h.advance(65_000);
  await h.meter.alarm(true);
  assert.equal(h.alarms.at(-1), h.now() + 60_000);
  assert.equal(h.charges.length, 0);
});

test("failed charges back off; a charge the database refuses for good is dropped and logged", async () => {
  const h = harness({ failCharges: 3 });
  await h.meter.started(payer, "lite");
  h.advance(1_000);
  await h.meter.stopped();
  const delays: number[] = [h.alarms.at(-1)! - h.now()];
  for (let i = 0; i < 2; i++) { await h.meter.alarm(false); delays.push(h.alarms.at(-1)! - h.now()); }
  assert.deepEqual(delays, [60_000, 120_000, 240_000]);
  await h.meter.alarm(false);
  assert.equal(h.charges.length, 1);
  const gone = harness({ failCharges: 1, failStatus: 404 });
  await gone.meter.started(payer, "lite");
  gone.advance(1_000);
  await gone.meter.stopped();
  assert.equal(await gone.meter.settled(), true, "an agent that no longer exists is not retried forever");
  assert.equal(gone.charges.length, 0);
});

test("a container that does not come up is destroyed and reported: no blank computer passes for a restore", async () => {
  const events: string[] = [];
  const meter: ProviderMeter = { async admit() {}, async started() { events.push("started"); }, async used() {}, async stopped() { events.push("stopped"); } };
  const container = {
    running: false,
    images: { workspace: "img" } as Record<string, string>,
    start() { this.running = true; },
    async setInactivityTimeout() {},
    async destroy() { this.running = false; },
    async snapshotContainer() { return { id: "s1", size: 1 }; },
    async exec(): Promise<ExecProcess> {
      return { stdin: null, stdout: null, stderr: null, pid: 1, isPty: false, exitCode: Promise.resolve(1), output: async () => { throw new Error("unused"); }, kill() {}, resize() {} };
    },
  };
  const data = new Map<string, unknown>([["computer:image", "img-before"]]);
  const store = { async get<T>(key: string) { return data.get(key) as T | undefined; }, async put(key: string, value: unknown) { data.set(key, value); } };
  const provider = new ContainerProvider(container, store, undefined, Date.now, undefined, meter);
  const handle = { id: "s1", name: "base", size: 1, image: "img", createdAt: Date.now(), expiresAt: Date.now() + 1000 };
  await assert.rejects(provider.startFrom(handle, AbortSignal.timeout(1000)), /did not start/);
  assert.equal(container.running, false);
  assert.equal(data.get("computer:image"), "img-before", "the lineage is not rewritten for a restore that failed");
  assert.equal(data.has("snapshot:base"), false, "no refreshed handle for a restore that failed");
  await assert.rejects(operate(provider, { op: "exec", argv: ["true"] }), /did not start/);
  assert.equal(container.running, false, "a first start whose readiness failed leaves nothing running");
  assert.deepEqual(events, ["started", "stopped", "started", "stopped"]);
});

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test("an idle session is charged its memory and disk only; a busy one adds the CPU-seconds it used", async () => {
  // An hour on standard-4 with readings after each use and before the stop: 0.2 vCPU-seconds of CPU in all.
  const idle = harness();
  await idle.meter.started(payer, "standard-4");
  for (let minute = 1; minute <= 4; minute++) { idle.advance(15_000); await idle.meter.used(50_000 * minute); }
  idle.advance(15_000);
  await idle.meter.stopped(200_000);
  const [quiet] = idle.charges;
  assert.equal(quiet.seconds, 75);
  assert.equal(quiet.cpuSeconds, 0.2);
  assert.equal(quiet.unmeasuredSeconds, 0);
  near(quiet.costUsd, 75 * holdRate("standard-4") + 0.2 * CONTAINER_RATES.vcpuSecond);
  assert.ok(quiet.costUsd < 0.3 * 75 * secondRate("standard-4"), "an idle standard-4 costs far less than its provisioned vCPU");
  // The same time spent computing: 4 vCPUs for 75 s.
  const busy = harness();
  await busy.meter.started(payer, "standard-4");
  busy.advance(75_000);
  await busy.meter.used(300_000_000);
  await busy.meter.stopped(300_000_000);
  near(busy.charges[0].costUsd, 75 * holdRate("standard-4") + 300 * CONTAINER_RATES.vcpuSecond);
});

test("time no reading covers is charged at the provisioned vCPU: the tail of a session that idled out", async () => {
  const h = harness();
  await h.meter.started(payer, "standard-1");
  h.advance(10_000);
  await h.meter.used(1_000_000);
  h.advance(600_000);
  await h.meter.alarm(false);
  const [charge] = h.charges;
  assert.equal(charge.seconds, 70);
  assert.equal(charge.cpuSeconds, 1);
  assert.equal(charge.unmeasuredSeconds, 60, "after the last reading the container idled for 60 s, unread");
  near(charge.costUsd, 70 * holdRate("standard-1") + (1 + 60 * 0.5) * CONTAINER_RATES.vcpuSecond);
});

test("a checkpoint continues CPU from the last reading, so no CPU-second is charged twice", async () => {
  const h = harness();
  await h.meter.started(payer, "standard-1");
  let cpu = 0;
  for (let elapsed = 0; elapsed < CHECKPOINT_MS + 30_000; elapsed += 30_000) {
    h.advance(30_000);
    cpu += 3_000_000;
    await h.meter.used(cpu);
  }
  h.advance(10_000);
  cpu += 1_000_000;
  await h.meter.stopped(cpu);
  assert.equal(h.charges.length, 2);
  near(h.charges.reduce((sum, c) => sum + (c.cpuSeconds ?? 0), 0), cpu / 1e6);
  assert.equal(h.charges.reduce((sum, c) => sum + (c.unmeasuredSeconds ?? 0), 0), 0);
});

test("measured CPU is capped at the provisioned vCPU: never more than Cloudflare can bill", async () => {
  const h = harness();
  await h.meter.started(payer, "lite");
  h.advance(10_000);
  // An unthrottled host (local Docker) let it use 2 full CPUs: lite is 1/16 vCPU.
  await h.meter.used(20_000_000);
  await h.meter.stopped(20_000_000);
  assert.equal(h.charges[0].cpuSeconds, 10 / 16);
  near(h.charges[0].costUsd, 10 * secondRate("lite"));
});
