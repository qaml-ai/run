import assert from "node:assert/strict";
import test from "node:test";
import { ContainerProvider, SNAPSHOT_TTL_MS, operate, type ComputerSnapshot, type ForkEntry, type SnapshotStore } from "../src/computers/provider.ts";
import { FORK_LIMITS } from "../../../src/core/computer-fork.ts";

const encoder = new TextEncoder();
/** A fake ctx.container: snapshots get new ids, execs can hang until aborted, monitor() can reject. */
function machine(image = "img") {
  const data = new Map<string, unknown>(), starts: Record<string, unknown>[] = [], snapshots: string[] = [];
  let hang = 0, refuse: string | undefined;
  const store: SnapshotStore = {
    async get<T>(key: string) { return data.get(key) as T | undefined; },
    async put(key, value) { data.set(key, value); },
    async delete(key) { return data.delete(key); },
    async list<T>({ prefix }: { prefix: string }) { return new Map([...data].filter(([key]) => key.startsWith(prefix))) as Map<string, T>; },
  };
  const container = {
    running: false,
    images: { workspace: image },
    start(options?: ContainerStartupOptions) { starts.push(options as never); this.running = true; },
    async setInactivityTimeout() {},
    async destroy() { this.running = false; },
    async interceptOutboundHttps() {},
    async snapshotContainer(options?: { name?: string }) { snapshots.push(options?.name ?? ""); return { id: `snap-${snapshots.length}`, size: 7 }; },
    monitor() { return refuse ? Promise.reject(new Error(refuse)) : new Promise<void>(() => {}); },
    async exec(_argv: string[], options?: ContainerExecOptions): Promise<ExecProcess> {
      if (hang > 0) {
        hang--;
        return new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      const pipe = () => new ReadableStream({ start(c) { c.enqueue(encoder.encode("ok")); c.close(); } });
      return { stdin: new WritableStream(), stdout: pipe(), stderr: null, pid: 1, isPty: false, exitCode: Promise.resolve(0), output: async () => { throw new Error("unused"); }, kill() {}, resize() {} };
    },
  };
  const provider = (now = Date.now) => { const p = new ContainerProvider(container as never, store, undefined, now); p.startWaitMs = 50; return p; };
  return { container, store, data, starts, snapshots, provider, hang: (n: number) => { hang = n; }, refuse: (why?: string) => { refuse = why; } };
}
const origin = (batch: string) => ({ parent: "parent-computer", agent: "agt_parent", batch, at: 1 });

test("one snapshot per batch: of the running container, else the saved base, else NO_SESSION", async () => {
  const parent = machine(), p = parent.provider();
  const none = await p.forkSnapshot("run:m1", AbortSignal.timeout(1000));
  assert.ok(!none.ok && none.code === "NO_SESSION");
  assert.equal(parent.starts.length, 0, "nothing to fork starts nothing");
  await operate(p, { op: "write", path: "repo.txt", content: "parent" });
  const first = await p.forkSnapshot("run:m2", AbortSignal.timeout(1000));
  const again = await p.forkSnapshot("run:m2", AbortSignal.timeout(1000));
  assert.ok(first.ok && again.ok);
  assert.equal(first.snapshot.id, again.snapshot.id, "the children of one call share one snapshot");
  assert.equal(parent.snapshots.length, 1);
  assert.match(parent.snapshots[0], /^fork-[0-9a-f]{32}$/);
  const other = await p.forkSnapshot("run:m3", AbortSignal.timeout(1000));
  assert.ok(other.ok && other.snapshot.id !== first.snapshot.id, "a later call takes its own");
  // Asleep: the snapshot its sleep saved is what a fork copies, with no new snapshot.
  assert.deepEqual(await operate(p, { op: "sleep" }), { sleeping: true, saved: true });
  assert.equal(parent.container.running, false);
  const asleep = await p.forkSnapshot("run:m4", AbortSignal.timeout(1000));
  assert.ok(asleep.ok);
  assert.equal(asleep.snapshot.id, `snap-${parent.snapshots.length}`);
  assert.equal(parent.snapshots.length, 3, "no snapshot of a stopped computer");
  assert.equal(parent.container.running, false, "forking a sleeping computer does not start it");
});

test("a seeded computer boots from the fork, refreshes its TTL, and says so; a later restart says what was lost", async () => {
  let now = 1_000;
  const child = machine(), p = child.provider(() => now);
  const handle: ComputerSnapshot = { id: "parent-snap", name: "fork-x", size: 9, image: "img", createdAt: 500, expiresAt: 500 + SNAPSHOT_TTL_MS };
  await p.seed(handle, origin("run:m1"));
  assert.deepEqual(await p.forkedFrom(), { ...origin("run:m1"), snapshot: "parent-snap" });
  now = 2_000;
  const first = await operate(p, { op: "exec", argv: ["true"] }) as Record<string, any>;
  assert.deepEqual(child.starts[0].containerSnapshot, { id: "parent-snap" });
  assert.deepEqual(first.computer, { restoredFrom: "fork" });
  assert.equal((child.data.get("computer:base") as ComputerSnapshot).expiresAt, 2_000 + SNAPSHOT_TTL_MS, "a restore resets the 30-day TTL");
  // The container idled out: the next operation restores the fork again and says unsaved work is gone.
  child.container.running = false;
  const later = await operate(p, { op: "exec", argv: ["true"] }) as Record<string, any>;
  assert.equal(later.computer.restoredFrom, "fork");
  assert.match(later.computer.note, /changes made after that snapshot were lost/);
  // Once running, no notice.
  assert.equal((await operate(p, { op: "exec", argv: ["true"] }) as Record<string, any>).computer, undefined);
  // Refused before anything starts: expired or another image's.
  await assert.rejects(machine().provider(() => handle.expiresAt).seed(handle, origin("b")), /expired/);
  await assert.rejects(machine("img-v2").provider(() => 1_000).seed(handle, origin("b")), /another image version/);
});

test("sleep saves the disk as the next start's base; a base from an old image starts empty and says why", async () => {
  const m = machine(), p = m.provider();
  await operate(p, { op: "exec", argv: ["true"] });
  await operate(p, { op: "sleep" });
  assert.deepEqual(m.snapshots, ["camelrun-sleep"]);
  const resumed = await operate(p, { op: "exec", argv: ["true"] }) as Record<string, any>;
  assert.deepEqual(m.starts.at(-1)!.containerSnapshot, { id: "snap-1" });
  assert.equal(resumed.computer.restoredFrom, "sleep");
  // Sleeping a stopped computer saves nothing.
  m.container.running = false;
  assert.deepEqual(await operate(p, { op: "sleep" }), { sleeping: true, saved: false });
  // After a deploy the base's image is gone: the computer starts from the image and tells the model.
  m.container.images = { workspace: "img-v2" };
  const fresh = await operate(p, { op: "exec", argv: ["true"] }) as Record<string, any>;
  assert.equal(m.starts.at(-1)!.image, "img-v2");
  assert.equal(fresh.computer.resumed, false);
  assert.match(fresh.computer.reason, /older image version/);
  assert.equal(m.data.get("computer:base"), null);
});

test("a start that does not answer is retried once, then 'still starting'; the next call waits for it instead of booting another", async () => {
  const m = machine(), p = m.provider();
  m.hang(1);
  await operate(p, { op: "exec", argv: ["true"] });
  assert.equal(m.starts.length, 2, "the slow start was destroyed and tried once more");
  const n = machine(), q = n.provider();
  n.hang(2);
  await assert.rejects(operate(q, { op: "exec", argv: ["true"] }), (error: Error & { code?: string }) => error.code === "COMPUTER_STARTING" && /still starting/.test(error.message));
  assert.equal(n.starts.length, 2);
  assert.equal(n.container.running, true, "the last try keeps coming up");
  assert.ok(n.data.get("computer:starting"));
  await operate(q, { op: "exec", argv: ["true"] });
  assert.equal(n.starts.length, 2, "the next call waited for it");
  assert.equal(n.data.get("computer:starting"), null);
});

test("a start over the account's limits fails at once with monitor()'s reason, not after a wait or a retry", async () => {
  const m = machine(), p = m.provider();
  p.startWaitMs = 60_000;
  m.hang(1);
  m.refuse("Container exceeds account limits (vcpu: 8 requested, no more than 4)");
  const started = Date.now();
  await assert.rejects(operate(p, { op: "exec", argv: ["true"] }), /could not start: Container exceeds account limits/);
  assert.ok(Date.now() - started < 5_000);
  assert.equal(m.starts.length, 1);
  assert.equal(m.container.running, false);
});

test("the registry drops a batch's snapshot when its last child goes, or when no child adopted it in time", async () => {
  let now = 10_000;
  const m = machine(), p = m.provider(() => now), logged: Record<string, unknown>[] = [], error = console.error;
  console.error = (line: string) => { try { logged.push(JSON.parse(line)); } catch { error(line); } };
  try {
    await operate(p, { op: "exec", argv: ["true"] });
    const taken = await p.forkSnapshot("run:m1", AbortSignal.timeout(1000));
    assert.ok(taken.ok);
    await p.adopt("run:m1", "child-a");
    await p.adopt("run:m1", "child-b");
    assert.deepEqual((m.data.get("fork:run:m1") as ForkEntry).children, ["child-a", "child-b"]);
    await p.unref("run:m1", "child-a");
    assert.ok(m.data.has("fork:run:m1"), "a child still uses it");
    await p.unref("run:m1", "child-b");
    assert.ok(m.data.has("fork:run:m1"), "within the grace a sibling of the call may still be seeding from it");
    now += FORK_LIMITS.dropGraceMs;
    await p.dropStale();
    assert.equal(m.data.has("fork:run:m1"), false);
    assert.deepEqual(logged.filter(line => line.type === "computer_snapshot_unused").map(line => line.id), [taken.snapshot.id]);
    assert.ok(m.data.get(`dropped:${taken.snapshot.id}`), "kept for cleanup: Cloudflare cannot delete it from a Worker");
    // No child adopted this one (its creation failed): dropped once the grace passes.
    const orphan = await p.forkSnapshot("run:m2", AbortSignal.timeout(1000));
    assert.ok(orphan.ok);
    await p.dropStale();
    assert.ok(m.data.has("fork:run:m2"));
    now += FORK_LIMITS.dropGraceMs;
    await p.dropStale();
    assert.equal(m.data.has("fork:run:m2"), false);
    // A batch of a sleeping computer shares its base: dropping that batch keeps the base, and logs nothing.
    await operate(p, { op: "sleep" });
    const base = await p.forkSnapshot("run:m3", AbortSignal.timeout(1000));
    assert.ok(base.ok);
    await p.adopt("run:m3", "child-c");
    const before = logged.length;
    await p.unref("run:m3", "child-c");
    assert.equal(logged.length, before);
  } finally { console.error = error; }
});

test("a computer that was used has a disk the fork route never overwrites; one still starting is not forked", async () => {
  const m = machine(), p = m.provider(() => 10_000);
  assert.equal(await p.hasDisk(), false, "never used");
  await operate(p, { op: "exec", argv: ["true"] });
  assert.equal(await p.hasDisk(), true);
  await operate(p, { op: "sleep" });
  assert.equal(await p.hasDisk(), true, "its saved base");
  m.data.set("computer:starting", { from: "image", at: 10_000 });
  const starting = await p.forkSnapshot("run:m9", AbortSignal.timeout(1000));
  assert.equal(starting.ok ? undefined : starting.code, "COMPUTER_STARTING");
});
