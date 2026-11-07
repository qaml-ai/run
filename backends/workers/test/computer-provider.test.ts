import assert from "node:assert/strict";
import test from "node:test";
import {
  ContainerProvider,
  SNAPSHOT_TTL_MS,
  computerSpec,
  operate,
  type ComputerSnapshot,
  type SnapshotStore,
} from "../src/computers/provider.ts";
const encoder = new TextEncoder();
function fixture() {
  const data = new Map<string, unknown>(),
    starts: ContainerStartupOptions[] = [];
  const store: SnapshotStore = {
    async get<T>(key: string) {
      return data.get(key) as T | undefined;
    },
    async put(key, value) {
      data.set(key, value);
    },
  };
  let failSnapshot = false,
    killed = false,
    signal: AbortSignal | undefined,
    output = "ok";
  const container = {
    running: false,
    images: { workspace: "test-image" },
    start(options?: ContainerStartupOptions) {
      starts.push(options!);
      this.running = true;
    },
    async setInactivityTimeout(ms: number | bigint) {
      assert.equal(ms, 60_000);
    },
    async destroy() {
      this.running = false;
    },
    async snapshotContainer() {
      if (failSnapshot) throw new Error("capture failed");
      return { id: "snapshot-1", size: 42 };
    },
    async exec(
      _argv: string[],
      options?: ContainerExecOptions,
    ): Promise<ExecProcess> {
      signal = options?.signal;
      const pipe = () =>
        new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode(output));
            c.close();
          },
        });
      return {
        stdin: new WritableStream(),
        stdout: pipe(),
        stderr: null,
        pid: 1,
        isPty: false,
        exitCode: Promise.resolve(0),
        output: async () => {
          throw new Error("unbounded output API must not be used");
        },
        kill: () => {
          killed = true;
        },
        resize() {},
      };
    },
  };
  return {
    container,
    store,
    data,
    starts,
    failCapture: () => {
      failSnapshot = true;
    },
    bomb: () => {
      output = "x".repeat(65537);
    },
    killed: () => killed,
    signal: () => signal,
  };
}

test("native lifecycle picks image and size at start, blocks egress; snapshots survive reopen; failed capture preserves prior handle", async () => {
  const f = fixture(),
    p = new ContainerProvider(f.container, f.store, {
      image: "workspace",
      instance: "standard-1",
    });
  await operate(p, { op: "exec", argv: ["echo", "x"] });
  assert.deepEqual(f.starts[0], {
    image: "test-image",
    instance: "standard-1",
    enableInternet: true,
  });
  assert.ok(f.signal());
  await operate(p, { op: "snapshot", name: "save" });
  const saved = f.data.get("snapshot:save") as ComputerSnapshot;
  f.failCapture();
  await assert.rejects(
    operate(p, { op: "snapshot", name: "save" }),
    /capture failed/,
  );
  assert.deepEqual(f.data.get("snapshot:save"), saved);
  // Sleep saves the disk first: a failed save keeps the container running; forced (a released child), it stops.
  await assert.rejects(operate(p, { op: "sleep" }), /capture failed/);
  assert.equal(f.container.running, true);
  assert.deepEqual(await p.sleep(true), { saved: false });
  assert.equal(f.container.running, false);
  await operate(new ContainerProvider(f.container, f.store), {
    op: "restore",
    name: "save",
  });
  assert.deepEqual(f.starts.at(-1), {
    containerSnapshot: { id: "snapshot-1" },
    instance: "lite",
    enableInternet: true,
  });
});

test("a snapshot handle records its image and TTL; another computer starts from it (fork)", async () => {
  let now = 1_000;
  const clock = () => now;
  const origin = fixture(),
    p = new ContainerProvider(origin.container, origin.store, undefined, clock);
  const handle = await p.snapshot("base", AbortSignal.timeout(1000));
  assert.deepEqual(handle, {
    id: "snapshot-1",
    name: "base",
    size: 42,
    image: "test-image",
    createdAt: 1_000,
    expiresAt: 1_000 + SNAPSHOT_TTL_MS,
  });
  // A fork: a different DO (its own container and storage) starts from the handle.
  const target = fixture();
  target.container.running = true;
  const fork = new ContainerProvider(target.container, target.store, undefined, clock);
  now = 5_000;
  const restored = await fork.startFrom(handle, AbortSignal.timeout(1000));
  assert.equal(target.starts.length, 1, "a running container is replaced");
  assert.deepEqual(target.starts[0].containerSnapshot, { id: "snapshot-1" });
  assert.equal(restored.expiresAt, 5_000 + SNAPSHOT_TTL_MS, "a restore refreshes the 30-day TTL");
  assert.deepEqual(target.data.get("snapshot:base"), restored);
  // A snapshot of the forked computer keeps the original image lineage.
  const again = await fork.snapshot("child", AbortSignal.timeout(1000));
  assert.equal(again.image, "test-image");
  // Image coupling: after a deploy changes the image digest, old snapshots are refused.
  const updated = fixture();
  updated.container.images = { workspace: "test-image-v2" };
  await assert.rejects(
    new ContainerProvider(updated.container, updated.store, undefined, clock).startFrom(handle, AbortSignal.timeout(1000)),
    /another image version/,
  );
  // Expiry awareness: past its TTL a handle is refused before any start.
  now = handle.expiresAt;
  const late = fixture();
  await assert.rejects(
    new ContainerProvider(late.container, late.store, undefined, clock).startFrom(handle, AbortSignal.timeout(1000)),
    /expired/,
  );
  await assert.rejects(
    fork.startFrom({ ...handle, id: "" }, AbortSignal.timeout(1000)),
    /Invalid computer snapshot/,
  );
  assert.equal(updated.starts.length + late.starts.length, 0);
});

test("the deployment's variables select image and instance; unknown sizes fall back", () => {
  assert.deepEqual(computerSpec({}), { image: "workspace", instance: "lite" });
  assert.deepEqual(computerSpec({ COMPUTER_IMAGE: "big", COMPUTER_INSTANCE: "standard-4" }), { image: "big", instance: "standard-4" });
  assert.deepEqual(computerSpec({ COMPUTER_INSTANCE: "basic" }), { image: "workspace", instance: "lite" });
});

test("native output is bounded and the process is killed on overflow", async () => {
  const f = fixture();
  f.bomb();
  await assert.rejects(
    operate(new ContainerProvider(f.container, f.store), {
      op: "exec",
      argv: ["yes"],
    }),
    /output limit/,
  );
  assert.equal(f.killed(), true);
});

test("invalid paths, snapshot names and commands are refused before starting a VM", async () => {
  const f = fixture(),
    p = new ContainerProvider(f.container, f.store);
  for (const path of ["../escape", "/etc/passwd", "a/../b", "a\u0000b"])
    await assert.rejects(operate(p, { op: "read", path }));
  await assert.rejects(
    operate(p, { op: "snapshot", name: "../another-agent" }),
  );
  await assert.rejects(operate(p, { op: "exec", argv: [] }));
  await assert.rejects(operate(p, { op: "restore", name: "unknown" }));
  assert.equal(f.starts.length, 0);
});
