import { Files } from "@cloudflare/sandbox";
import { NativeBenchmarkComputer, type BenchmarkOperation } from "../native.ts";
import { readBounded } from "../../../src/computers/provider.ts";

// SDK 1.0.3 leaves execution and lifecycle to the native Container API.
// This variant deliberately omits instance selection and uses SDK Files.
class SdkBenchmarkComputer extends NativeBenchmarkComputer {
  protected override instance = undefined;
  protected override exec(argv: string[], timeoutMs: number, maxBytes = 64 * 1024, stdin?: string, cwd = "/workspace") {
    // The native abort kills the shell but can leave its child process holding
    // stdout open. GNU timeout owns the process group and escalates after 5s.
    return super.exec(["timeout", "--signal=TERM", "--kill-after=5s", `${timeoutMs / 1000}s`, ...argv], timeoutMs + 6_000, maxBytes, stdin, cwd);
  }
  override async operate(input: BenchmarkOperation): Promise<unknown> {
    if (input.op === "status") return { running: this.container.running, info: await this.container.inspect(), sdk: "1.0.3" };
    if (input.op === "stop") {
      await this.container.destroy();
      await this.ctx.storage.deleteAlarm();
      return { stopped: true, sdk: "1.0.3" };
    }
    if (input.op !== "read" && input.op !== "write") return super.operate(input);
    const started = performance.now();
    await super.operate({ op: "start", timeoutMs: input.timeoutMs, idleMs: input.idleMs });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("SDK file operation timed out")), input.timeoutMs ?? 60_000);
    try {
      const path = this.path(input.path);
      const files = new Files(this.container);
      if (input.op === "read") {
        const response = await files.readFile(path, { signal: controller.signal });
        return { content: await readBounded(response.body, 1024 * 1024), elapsedMs: performance.now() - started, sdk: "1.0.3" };
      }
      if (typeof input.content !== "string" || new TextEncoder().encode(input.content).length > 1024 * 1024) throw new Error("Write exceeds 1 MiB");
      await files.mkdir(path.slice(0, path.lastIndexOf("/")) || "/", { recursive: true, signal: controller.signal });
      await files.writeFile(path, input.content, { signal: controller.signal });
      return { written: true, elapsedMs: performance.now() - started, sdk: "1.0.3" };
    } finally { clearTimeout(timer); }
  }
}

export { SdkBenchmarkComputer as "camelrun-proto-bench-sdk-machine" };
export { CloneBuildAgent as "camelrun-proto-bench-sdk-agent", CloneBuildDirectory as "camelrun-proto-bench-sdk-directory", default } from "../agent-worker.ts";
