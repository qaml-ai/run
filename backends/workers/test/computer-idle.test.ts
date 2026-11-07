import assert from "node:assert/strict";
import test from "node:test";
import { computerSettingsInput } from "../src/computers/egress.ts";
import { ContainerProvider, IDLE_SLEEP_BACKSTOP_MS, operate, type ComputerNetwork, type SnapshotStore } from "../src/computers/provider.ts";

const encoder = new TextEncoder();
/** A fake ctx.container with a clock: `onExec` runs inside each exec (a long command moves the clock). */
function machine(idle?: "stop" | "sleep") {
  const data = new Map<string, unknown>(), starts: Record<string, unknown>[] = [], snapshots: string[] = [], timeouts: number[] = [], wakes: number[] = [];
  const clock = { now: 1_000, onExec: () => {} };
  const store: SnapshotStore = {
    async get<T>(key: string) { return data.get(key) as T | undefined; },
    async put(key, value) { data.set(key, value); },
    async delete(key) { return data.delete(key); },
    async list<T>({ prefix }: { prefix: string }) { return new Map([...data].filter(([key]) => key.startsWith(prefix))) as Map<string, T>; },
  };
  const container = {
    running: false,
    images: { workspace: "img" },
    start(options?: ContainerStartupOptions) { starts.push(options as never); this.running = true; },
    async setInactivityTimeout(ms: number) { timeouts.push(ms); },
    async destroy() { this.running = false; },
    async interceptOutboundHttps() {},
    async snapshotContainer(options?: { name?: string }) { snapshots.push(options?.name ?? ""); return { id: `snap-${snapshots.length}`, size: 7 }; },
    async exec(): Promise<ExecProcess> {
      clock.onExec();
      const pipe = () => new ReadableStream({ start(c) { c.enqueue(encoder.encode("ok")); c.close(); } });
      return { stdin: new WritableStream(), stdout: pipe(), stderr: null, pid: 1, isPty: false, exitCode: Promise.resolve(0), output: async () => { throw new Error("unused"); }, kill() {}, resize() {} };
    },
  };
  const network: ComputerNetwork = { key: "", egress: [], idleMs: 60_000, ...idle ? { idle } : {} };
  const provider = () => {
    const p = new ContainerProvider(container as never, store, undefined, () => clock.now, network, undefined, async at => { wakes.push(at); });
    p.startWaitMs = 50; p.imageWaitMs = 50;
    return p;
  };
  return { container, data, starts, snapshots, timeouts, wakes, clock, provider };
}

test('idle: "sleep" saves the disk when the idle time is up, and the next start (or a fork) resumes it', async () => {
  const m = machine("sleep"), p = m.provider();
  await operate(p, { op: "write", path: "repo.txt", content: "cloned" });
  // The DO's alarm is asked for at the idle point; the container's own timeout is only a backstop past it.
  assert.equal(m.wakes.at(-1), 61_000);
  assert.ok(m.timeouts.length && m.timeouts.every(ms => ms === 60_000 + IDLE_SLEEP_BACKSTOP_MS));
  m.clock.now = 30_000;
  assert.equal(await p.sleepIfIdle(), 61_000, "not yet: look again at the idle point");
  assert.equal(m.snapshots.length, 0);
  m.clock.now = 61_000;
  assert.equal(await p.sleepIfIdle(), undefined);
  assert.deepEqual(m.snapshots, ["camelrun-sleep"]);
  assert.equal(m.container.running, false);
  assert.equal((m.data.get("computer:base") as { kind: string }).kind, "sleep");
  assert.equal(await p.sleepIfIdle(), undefined, "asleep: nothing more to do");
  // Forking a sleeping computer copies its saved disk without starting it.
  const fork = await p.forkSnapshot("run:m1", AbortSignal.timeout(1000));
  assert.ok(fork.ok && fork.snapshot.id === "snap-1");
  assert.equal(m.container.running, false);
  // The next operation resumes the saved disk.
  const resumed = await operate(p, { op: "exec", argv: ["true"] }) as Record<string, any>;
  assert.deepEqual(m.starts.at(-1)!.containerSnapshot, { id: "snap-1" });
  assert.equal(resumed.computer.restoredFrom, "sleep");
  assert.equal(resumed.computer.note, undefined, "a sleep saved everything: nothing to warn about");
  // Stopped again without a save (a crash): the restart says what was lost.
  m.container.running = false;
  const again = await operate(p, { op: "exec", argv: ["true"] }) as Record<string, any>;
  assert.match(again.computer.note, /changes made after that snapshot were lost/);
});

test("a long command counts as use until it ends", async () => {
  const m = machine("sleep"), p = m.provider();
  await operate(p, { op: "exec", argv: ["true"] });
  m.clock.onExec = () => { m.clock.now = 200_000; };
  await operate(p, { op: "exec", argv: ["sleep", "199"] });
  assert.equal(m.wakes.at(-1), 260_000);
  m.clock.now = 210_000;
  assert.equal(await p.sleepIfIdle(), 260_000);
  assert.equal(m.container.running, true);
});

test('the default ("stop") keeps idling out as before: no alarm, no snapshot', async () => {
  const m = machine(), p = m.provider();
  await operate(p, { op: "exec", argv: ["true"] });
  assert.deepEqual(m.wakes, []);
  assert.ok(m.timeouts.every(ms => ms === 60_000));
  m.clock.now = 1_000_000;
  assert.equal(await p.sleepIfIdle(), undefined);
  assert.equal(m.snapshots.length, 0);
  assert.equal(m.container.running, true);
});

test("computer.idle is stop or sleep", () => {
  const check = (value: unknown) => new URL(String(value));
  assert.deepEqual(computerSettingsInput({ idle: "sleep", idleSeconds: 300 }, check, "acme"), { idle: "sleep", idleSeconds: 300 });
  assert.throws(() => computerSettingsInput({ idle: "nap" }, check, "acme"), /computer.idle must be "stop" or "sleep"/);
});
