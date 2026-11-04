import { DurableObject } from "cloudflare:workers";
import { readBounded } from "../../src/computers/provider.ts";

export type BenchmarkInstance = "basic" | "standard-2" | "standard-4";
export type BenchmarkOperation = {
  op: "start" | "exec" | "read" | "write" | "snapshot" | "restore" | "sleep" | "status" | "stop";
  argv?: string[];
  timeoutMs?: number;
  idleMs?: number;
  path?: string;
  content?: string;
  name?: string;
};

// Benchmark-only adapter. Images contain tools, never repositories or build outputs.
// Public admission and bearer validation belong to the shared Worker wrapper.
export class NativeBenchmarkComputer extends DurableObject {
  protected instance: BenchmarkInstance | undefined = "basic";
  private queue: Promise<unknown> = Promise.resolve();
  protected get container(): Container {
    if (!this.ctx.container) throw new Error("Benchmark container binding missing");
    return this.ctx.container;
  }
  operate(input: BenchmarkOperation): Promise<unknown> {
    const result = this.queue.then(() => this.perform(input));
    this.queue = result.catch(() => {});
    return result;
  }
  async alarm(): Promise<void> { await this.container.destroy(); }
  private async perform(input: BenchmarkOperation): Promise<unknown> {
    const started = performance.now();
    const wasRunning = this.container.running;
    const meta = () => ({ elapsedMs: performance.now() - started, wasRunning, instance: this.instance });
    if (input.op === "status") {
      return { ...meta(), running: wasRunning, info: await this.container.inspect(), deadline: await this.ctx.storage.get("deadline") };
    }
    if (input.op === "stop") {
      await this.container.destroy();
      await this.ctx.storage.deleteAlarm();
      return { ...meta(), stopped: true };
    }
    const deadline = await this.ctx.storage.get<number>("deadline") ?? Date.now() + 2 * 60 * 60_000;
    if (Date.now() >= deadline) throw new Error("Two-hour benchmark lifetime cap reached");
    await this.ctx.storage.put("deadline", deadline);
    await this.ctx.storage.setAlarm(deadline);
    const timeoutMs = input.timeoutMs ?? 60_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20 * 60_000) throw new Error("Invalid benchmark timeout");
    const idleMs = input.idleMs ?? 20 * 60_000;
    if (!Number.isInteger(idleMs) || idleMs < 1_000 || idleMs > 20 * 60_000) throw new Error("Invalid benchmark idle timeout");
    if (input.op === "restore") {
      const name = this.snapshotName(input.name);
      const snapshot = await this.ctx.storage.get<ContainerSnapshot>(`snapshot:${name}`);
      if (!snapshot) throw new Error("Unknown benchmark snapshot");
      await this.container.destroy();
      this.container.start({ containerSnapshot: snapshot, ...(this.instance ? { instance: this.instance } : {}), enableInternet: true });
      await this.container.setInactivityTimeout(idleMs);
      const probe = await this.exec(["/bin/true"], timeoutMs);
      if (probe.exitCode !== 0) throw new Error("Restore readiness probe failed");
      await this.ctx.storage.put(`snapshot-restored:${name}`, new Date().toISOString());
      return { ...meta(), restored: true, snapshot };
    }
    if (input.op === "sleep") {
      if (!this.container.running) throw new Error("Cannot set sleepAfter on stopped benchmark container");
      await this.container.setInactivityTimeout(idleMs);
      return { ...meta(), sleepAfterMs: idleMs, running: true };
    }
    await this.ready(idleMs, timeoutMs);
    if (input.op === "start") return { ...meta(), ready: true };
    if (input.op === "snapshot") {
      const name = this.snapshotName(input.name);
      const snapshot = await this.container.snapshotContainer({ name });
      await this.ctx.storage.put(`snapshot:${name}`, snapshot);
      return { ...meta(), snapshot, capturedAt: new Date().toISOString(), expiresAfterLastRestoreDays: 30 };
    }
    if (input.op === "read") {
      const result = await this.exec(["/bin/cat", "--", this.path(input.path)], timeoutMs, 1024 * 1024);
      return { ...meta(), ...result, content: result.stdout };
    }
    if (input.op === "write") {
      if (typeof input.content !== "string" || new TextEncoder().encode(input.content).length > 1024 * 1024) throw new Error("Write exceeds 1 MiB");
      const path = this.path(input.path);
      const result = await this.exec(["node", "-e", 'const f=require("fs");f.mkdirSync(require("path").dirname(process.argv[1]),{recursive:true});f.writeFileSync(process.argv[1],f.readFileSync(0))', path], timeoutMs, 64 * 1024, input.content);
      return { ...meta(), ...result, written: result.exitCode === 0 };
    }
    if (input.op !== "exec" || !Array.isArray(input.argv) || input.argv.length < 1 || input.argv.length > 100 || input.argv.some(arg => typeof arg !== "string" || arg.includes("\0") || arg.length > 65_536)) throw new Error("Invalid benchmark exec");
    return { ...await this.exec(input.argv, timeoutMs), ...meta() };
  }
  protected async ready(idleMs: number, timeoutMs: number): Promise<void> {
    if (!this.container.running) {
      this.container.start({ image: this.container.images.workspace, ...(this.instance ? { instance: this.instance } : {}), enableInternet: true });
      const probe = await this.exec(["/bin/mkdir", "-p", "/workspace"], timeoutMs, 64 * 1024, undefined, "/");
      if (probe.exitCode !== 0) throw new Error("Start readiness probe failed");
    }
    await this.container.setInactivityTimeout(idleMs);
  }
  protected async exec(argv: string[], timeoutMs: number, maxBytes = 64 * 1024, stdin?: string, cwd = "/workspace") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Benchmark exec timed out")), timeoutMs);
    let exited = false;
    try {
      const process = await this.container.exec(argv, {
        cwd, env: { HOME: "/root", LANG: "C.UTF-8" },
        signal: controller.signal, stdin: stdin === undefined ? undefined : "pipe", stdout: "pipe", stderr: "pipe",
      });
      const exit = process.exitCode.then(code => { exited = true; clearTimeout(timer); return code; });
      const input = async () => {
        if (stdin === undefined) return;
        if (!process.stdin) throw new Error("Benchmark stdin unavailable");
        const writer = process.stdin.getWriter();
        try { await writer.write(new TextEncoder().encode(stdin)); await writer.close(); }
        finally { writer.releaseLock(); }
      };
      try {
        const [stdout, stderr, exitCode] = await Promise.all([readBounded(process.stdout, maxBytes), readBounded(process.stderr, 64 * 1024), exit, input()]);
        return { stdout, stderr, exitCode };
      } catch (error) {
        if (!exited) process.kill(9);
        throw error;
      }
    } finally { clearTimeout(timer); }
  }
  protected path(path: string | undefined): string {
    if (!path || path.includes("\0") || path.length > 4096) throw new Error("Invalid benchmark path");
    return path.startsWith("/") ? path : `/workspace/${path}`;
  }
  private snapshotName(name: string | undefined): string {
    if (!name || !/^camelrun-proto-bench-[a-z0-9-]{1,60}$/.test(name)) throw new Error("Invalid benchmark snapshot name");
    return name;
  }
}
