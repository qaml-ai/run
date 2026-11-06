import assert from "node:assert/strict";
import test from "node:test";
import {
  ContainerProvider,
  SandboxProvider,
  operate,
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

test("native lifecycle blocks egress; snapshots survive reopen; failed capture preserves prior handle", async () => {
  const f = fixture(),
    p = new ContainerProvider(f.container, f.store);
  await operate(p, { op: "exec", argv: ["echo", "x"] });
  assert.equal(f.starts[0].enableInternet, false);
  assert.ok(f.signal());
  await operate(p, { op: "snapshot", name: "save" });
  f.failCapture();
  await assert.rejects(
    operate(p, { op: "snapshot", name: "save" }),
    /capture failed/,
  );
  await operate(p, { op: "sleep" });
  await operate(new ContainerProvider(f.container, f.store), {
    op: "restore",
    name: "save",
  });
  assert.deepEqual(f.starts.at(-1), {
    containerSnapshot: { id: "snapshot-1", size: 42 },
    enableInternet: false,
  });
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

test("SDK provider restores a durable R2 record and delegates files through the SDK interface", async () => {
  const f = fixture(),
    files = new Map<string, string>();
  const snapshots = new Map<string, Map<string, string>>();
  const sdkFiles = {
    async readFile(path: string) {
      return new Response(files.get(path));
    },
    async writeFile(path: string, content: unknown) {
      files.set(path, String(content));
    },
    async mkdir() {},
  };
  const backup = {
    id: "backup-1",
    dir: "/workspace",
    size: 10,
    sha256: "fake",
    format: "tar+zstd/1" as const,
  };
  const backups = {
    async backup() {
      snapshots.set(backup.id, new Map(files));
      return backup;
    },
    async restore(record: typeof backup) {
      assert.deepEqual(record, backup);
      files.clear();
      for (const [k, v] of snapshots.get(record.id)!) files.set(k, v);
    },
  };
  const p = new SandboxProvider(f.container, f.store, sdkFiles, backups);
  await operate(p, { op: "write", path: "file.txt", content: "saved" });
  await operate(p, { op: "snapshot", name: "backup" });
  await operate(p, { op: "write", path: "file.txt", content: "changed" });
  await operate(p, { op: "sleep" });
  const reopened = new SandboxProvider(f.container, f.store, sdkFiles, backups);
  await operate(reopened, { op: "restore", name: "backup" });
  assert.deepEqual(await operate(reopened, { op: "read", path: "file.txt" }), {
    content: "saved",
  });
  assert.equal(
    f.starts.every((x) => x.enableInternet === false),
    true,
  );
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
