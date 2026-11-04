import { DurableObject } from "cloudflare:workers";
import { DirectoryBackup, DirectoryBackupGateway, Files, type DirectoryBackupGatewayBinding, type DirectoryBackupRecord } from "@cloudflare/sandbox";
import { readBounded } from "../src/computers/provider.ts";

type Size = "lite" | "basic";
type Operation = { op: "status" | "exec" | "snapshot" | "restore" | "stop" | "cleanup"; size: Size; argv?: string[]; name?: string; timeoutMs?: number; idleMs?: number };
interface Env { API_TOKEN: string; NATIVE: DurableObjectNamespace<NativeComputer>; SANDBOX: DurableObjectNamespace<SdkComputer>; BACKUPS: R2Bucket }
const MAX_OPERATION_MS = 180_000;
const MAX_LIFETIME_MS = 15 * 60_000;
const SNAPSHOT_NAME = /^camelrun-proto-[a-z0-9-]{1,70}$/;

class BenchmarkComputer extends DurableObject<Env> {
  protected sdk = false;
  private queue: Promise<unknown> = Promise.resolve();
  private get container() {
    if (!this.ctx.container) throw new Error("Container binding missing");
    return this.ctx.container;
  }
  private backups() {
    return new DirectoryBackup(this.container,
      (this.ctx.exports as unknown as Record<string, DirectoryBackupGatewayBinding>)["camelrun-proto-computer-gateway"],
      { binding: "BACKUPS", prefix: `camelrun-proto/${this.ctx.id}/` });
  }
  operate(input: Operation): Promise<unknown> {
    const result = this.queue.then(() => this.perform(input));
    this.queue = result.catch(() => {});
    return result;
  }
  async alarm() { await this.container.destroy(); }
  private async perform(input: Operation): Promise<unknown> {
    const started = performance.now();
    const wasRunning = this.container.running;
    if (input.op === "status") return { running: wasRunning, info: await this.container.inspect(), deadline: await this.ctx.storage.get("deadline") };
    if (input.op === "stop") { await this.container.destroy(); return { stopped: true }; }
    if (input.op === "cleanup") {
      await this.container.destroy();
      const records = await this.ctx.storage.list<DirectoryBackupRecord>({prefix:"backup:"});
      for (const record of records.values()) await this.backups().delete(record, {signal:AbortSignal.timeout(MAX_OPERATION_MS)});
      // Native snapshot handles are retained for the account-level cleanup audit.
      // The Container API has no snapshot-delete method.
      const nativeSnapshots = [...(await this.ctx.storage.list<ContainerSnapshot>({prefix:"snapshot:"})).values()];
      await this.ctx.storage.deleteAll();
      return { stopped: true, deletedBackups: records.size, nativeSnapshots };
    }
    const deadline = await this.ctx.storage.get<number>("deadline") ?? Date.now() + MAX_LIFETIME_MS;
    if (Date.now() >= deadline) throw new Error("Benchmark lifetime cap reached; cleanup required");
    await this.ctx.storage.put("deadline", deadline);
    await this.ctx.storage.setAlarm(deadline);
    const timeoutMs = input.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_OPERATION_MS) throw new Error("Invalid timeout");
    const idleMs = input.idleMs ?? 60_000;
    if (!Number.isInteger(idleMs) || idleMs < 5_000 || idleMs > 60_000) throw new Error("Invalid idle timeout");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Operation timed out")), timeoutMs);
    const signal = controller.signal;
    try {
      if (input.op === "restore") {
        if (!input.name || !SNAPSHOT_NAME.test(input.name)) throw new Error("Invalid snapshot name");
        if (this.sdk) {
          const backup = await this.ctx.storage.get<DirectoryBackupRecord>(`backup:${input.name}`);
          if (!backup) throw new Error("Unknown backup");
          await this.ready(input.size, idleMs, signal);
          await this.backups().restore(backup, {signal});
        } else {
          const snapshot = await this.ctx.storage.get<ContainerSnapshot>(`snapshot:${input.name}`);
          if (!snapshot) throw new Error("Unknown snapshot");
          await this.container.destroy();
          this.container.start({containerSnapshot:snapshot, instance:input.size, enableInternet:false});
          await this.container.setInactivityTimeout(idleMs);
          // exec waits until startup completes; start() alone does not.
          await this.exec(["true"], signal);
        }
        return { restored:true, elapsedMs:performance.now()-started, wasRunning };
      }
      await this.ready(input.size, idleMs, signal);
      if (input.op === "snapshot") {
        if (!input.name || !SNAPSHOT_NAME.test(input.name)) throw new Error("Invalid snapshot name");
        if (this.sdk) {
          const backup = await this.backups().backup({dir:"/workspace", name:input.name, signal});
          await this.ctx.storage.put(`backup:${input.name}`, backup);
          return { captured:true, elapsedMs:performance.now()-started, wasRunning, backup };
        }
        const snapshot = await this.container.snapshotContainer({name:input.name});
        await this.ctx.storage.put(`snapshot:${input.name}`, snapshot);
        return { captured:true, elapsedMs:performance.now()-started, wasRunning, snapshot };
      }
      if (input.op !== "exec" || !Array.isArray(input.argv) || input.argv.length < 1 || input.argv.length > 20 || input.argv.some(arg => typeof arg !== "string" || arg.includes("\0") || arg.length > 16_384)) throw new Error("Invalid operation");
      const result = await this.exec(input.argv, signal);
      return { ...result, elapsedMs:performance.now()-started, wasRunning, size:input.size, sdk:this.sdk };
    } finally {
      clearTimeout(timer);
    }
  }
  private async ready(size: Size, idleMs: number, signal: AbortSignal) {
    if (!this.container.running) {
      this.container.start({image:this.container.images.workspace, instance:size, enableInternet:false});
      const result = await this.exec(["mkdir", "-p", "/workspace"], signal);
      if (result.exitCode !== 0) throw new Error("Workspace initialization failed");
    }
    await this.container.setInactivityTimeout(idleMs);
    if (this.sdk) {
      // Exercise the installed SDK Files API without materializing a large file.
      await new Files(this.container).mkdir("/workspace", {recursive:true, signal});
    }
  }
  private async exec(argv: string[], signal: AbortSignal) {
    const process = await this.container.exec(argv, {cwd:"/", signal, stdout:"pipe", stderr:"pipe"});
    try {
      const [stdout, stderr, exitCode] = await Promise.all([readBounded(process.stdout, 64*1024), readBounded(process.stderr, 64*1024), process.exitCode]);
      return {stdout, stderr, exitCode};
    } catch (error) { process.kill(9); throw error; }
  }
}
class NativeComputer extends BenchmarkComputer {}
class SdkComputer extends BenchmarkComputer { protected override sdk = true; }
export { NativeComputer as "camelrun-proto-computer-native", SdkComputer as "camelrun-proto-computer-sdk", DirectoryBackupGateway as "camelrun-proto-computer-gateway" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Even status, unknown paths and unsupported methods require authentication.
    if (!env.API_TOKEN || env.API_TOKEN.length < 32 || request.headers.get("authorization") !== `Bearer ${env.API_TOKEN}`) return Response.json({error:"Unauthorized"},{status:401});
    const match = /^\/v1\/(native|sdk)\/(lite|basic)$/.exec(new URL(request.url).pathname);
    if (!match || request.method !== "POST") return Response.json({error:"Unknown endpoint"},{status:404});
    if (Number(request.headers.get("content-length") ?? 0) > 64*1024) return Response.json({error:"Body too large"},{status:413});
    try {
      const text = await readBounded(request.body, 64*1024);
      const input = JSON.parse(text) as Operation;
      input.size = match[2] as Size;
      if (!["status","exec","snapshot","restore","stop","cleanup"].includes(input.op)) return Response.json({error:"Invalid operation"},{status:400});
      const namespace = match[1] === "native" ? env.NATIVE : env.SANDBOX;
      const value = await namespace.getByName(`camelrun-proto-${match[2]}`).operate(input);
      return Response.json(value);
    } catch (error) {
      return Response.json({error:error instanceof Error ? error.message : "Benchmark failed"},{status:500});
    }
  },
};
