import { DurableObject } from "cloudflare:workers";
import { Workspace, WorkspaceProxy, WorkspaceServiceProxy } from "@cloudflare/computer";
import { ContainerBackend, withWorkspaceContainer } from "@cloudflare/computer/backends/container";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import curlCommands from "@cloudflare/computer/shell/curl";
import type { BenchmarkOperation } from "../native.ts";
import { readBounded } from "../../../src/computers/provider.ts";

interface Env { LOADER: WorkerLoader }
type Operation = Omit<BenchmarkOperation, "op"> & { op: BenchmarkOperation["op"] | "diagnose"; backend?: "container-shell" | "worker-shell" };
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

class ComputerBenchmarkMachine extends withWorkspaceContainer(class extends DurableObject<Env> {}) {
  readonly backend = new ContainerBackend({
    container: () => this,
    workspace: { binding: "MACHINE", id: this.ctx.id.toString() },
    egress: { mode: "direct" },
    instance: "standard-2",
    name: "workspace",
    containerEnv: { COMPUTERD_DB: "/tmp/camelrun-proto-bench-computer.sqlite" },
    // Dependencies and build artifacts stay on the container disk and are
    // included by snapshotContainer. Avoid copying compiler products into DO SQLite.
    ignore: ["**/node_modules", "**/target"],
    connectTimeoutMs: 90_000,
  });
  readonly workspace = new Workspace({
    storage: this.ctx.storage,
    backends: [this.backend, new WorkerShellBackend({
      loader: this.env.LOADER,
      workspace: { binding: "MACHINE", id: this.ctx.id.toString() },
      ctx: this.ctx,
      egress: { mode: "direct" },
      commands: [curlCommands],
    })],
  });
  async __getWorkspaceStub() { return this.workspace.stub(); }
  override async fetch(request: Request) { return this.backend.handleFetch(request); }
  async alarm() { await this.ctx.container?.destroy(); }

  async operate(input: Operation): Promise<unknown> {
    const begin = performance.now();
    const container = this.ctx.container;
    if (!container) throw new Error("Computer container binding missing");
    const backend = input.backend ?? "container-shell";
    const meta = () => ({ elapsedMs: performance.now() - begin, backend, instance: "standard-2" });
    if (input.op === "diagnose") {
      // Operator-only: the model's tool schema does not expose this operation.
      await this.workspace.close();
      await container.destroy();
      container.start({ image: container.images.workspace, entrypoint: ["sleep", "infinity"], instance: "standard-2", enableInternet: true });
      await container.setInactivityTimeout(60_000);
      const process = await container.exec(["/bin/bash", "-lc", "ls -l /dev/fuse; timeout 8s env RPC_CLIENT_SECRET=local-benchmark-diagnostic /usr/local/bin/computerd"], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([readBounded(process.stdout, 64 * 1024), readBounded(process.stderr, 64 * 1024), process.exitCode]);
      await container.destroy();
      return { ...meta(), stdout, stderr, exitCode };
    }
    if (input.op === "status") return { ...meta(), running: container.running, info: await container.inspect() };
    if (input.op === "stop") {
      await this.workspace.close();
      await container.destroy();
      await this.ctx.storage.deleteAlarm();
      return { ...meta(), stopped: true };
    }
    const deadline = await this.ctx.storage.get<number>("deadline") ?? Date.now() + 2 * 60 * 60_000;
    if (Date.now() > deadline) throw new Error("Two-hour benchmark lifetime cap reached");
    await this.ctx.storage.put("deadline", deadline);
    await this.ctx.storage.setAlarm(deadline);
    const idle = input.idleMs ?? 20 * 60_000;
    if (input.op === "sleep") {
      // Close the backend heartbeat so the inactivity timer can actually fire.
      await this.workspace.close();
      await container.setInactivityTimeout(idle);
      return { ...meta(), sleepAfterMs: idle, running: container.running };
    }
    if (input.op === "snapshot") {
      if (!input.name?.startsWith("camelrun-proto-bench-")) throw new Error("Invalid snapshot name");
      const snapshot = await container.snapshotContainer({ name: input.name });
      await this.ctx.storage.put(`snapshot:${input.name}`, snapshot);
      return { ...meta(), snapshot, capturedAt: new Date().toISOString(), expiresAfterLastRestoreDays: 30 };
    }
    if (input.op === "restore") {
      const snapshot = await this.ctx.storage.get<ContainerSnapshot>(`snapshot:${input.name}`);
      if (!snapshot) throw new Error("Unknown snapshot");
      await this.workspace.close();
      // Use the backend's host surface so it reinstalls the scoped RPC secret,
      // runtime identity and exit monitor along with the snapshot.
      await this.getWorkspaceContainer().restart({
        containerSnapshot: snapshot, instance: "standard-2", enableInternet: true, name: "workspace",
        env: { PORT: "8080", MOUNT_POINT: "/workspace", MOUNT_IGNORE: "**/node_modules,**/target", COMPUTERD_DB: "/tmp/camelrun-proto-bench-computer.sqlite" },
      });
      await container.setInactivityTimeout(idle);
      const probe = await container.exec(["/bin/true"]);
      if (await probe.exitCode !== 0) throw new Error("Computer restore readiness probe failed");
      return { ...meta(), snapshot, restored: true };
    }
    if (input.op === "start") {
      await this.workspace.ready(backend);
      if (backend === "container-shell") await container.setInactivityTimeout(idle);
      return { ...meta(), ready: true };
    }
    if (input.op === "read") {
      const path = input.path?.startsWith("/") ? input.path : `/workspace/${input.path}`;
      return { ...meta(), content: await this.workspace.fs.readFile(path, "utf8") };
    }
    if (input.op === "write") {
      const path = input.path?.startsWith("/") ? input.path : `/workspace/${input.path}`;
      if (typeof input.content !== "string") throw new Error("Missing content");
      await this.workspace.fs.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      await this.workspace.fs.writeFile(path, input.content);
      return { ...meta(), written: true };
    }
    if (input.op !== "exec" || !input.argv?.length) throw new Error("Invalid computer operation");
    const handle = await this.workspace.runtime.exec(input.argv.map(quote).join(" "), {
      backend, cwd: "/workspace", encoding: "utf8", timeoutMs: input.timeoutMs ?? 60_000,
      env: { HOME: "/root", LANG: "C.UTF-8" }, sync: "defer",
    });
    try {
      const result = await handle.result();
      if (backend === "container-shell") await container.setInactivityTimeout(idle);
      return { ...result, ...meta() };
    } finally { handle[Symbol.dispose](); }
  }
}

// The installed backend addresses this named loopback entrypoint internally.
// It is not an independently created Cloudflare resource.
export { WorkspaceProxy, WorkspaceServiceProxy };
export { ComputerBenchmarkMachine as "camelrun-proto-bench-computer-machine" };
export { CloneBuildAgent as "camelrun-proto-bench-computer-agent", CloneBuildDirectory as "camelrun-proto-bench-computer-directory", default } from "../agent-worker.ts";
