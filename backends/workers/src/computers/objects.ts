import { DurableObject } from "cloudflare:workers";
import {
  DirectoryBackup,
  Files,
  type DirectoryBackupGatewayBinding,
} from "@cloudflare/sandbox";
import {
  ContainerProvider,
  SandboxProvider,
  operate,
  type ComputerProvider,
  type ComputerRequest,
} from "./provider.ts";

// These are optional, dedicated per-agent computers, not the agent's own DO.
// One queue excludes simultaneous writes while taking/restoring a snapshot.
class ComputerObject extends DurableObject {
  private queue: Promise<unknown> = Promise.resolve();
  protected provider(): ComputerProvider {
    if (!this.ctx.container)
      throw new Error("Computer container binding unavailable");
    return new ContainerProvider(this.ctx.container, this.ctx.storage);
  }
  operate(request: ComputerRequest) {
    const run = this.queue.then(() => {
      const timeout =
        request.op === "exec" ? (request.timeoutMs ?? 30_000) : 30_000;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000)
        throw new Error("Invalid computer timeout");
      return operate(this.provider(), request, AbortSignal.timeout(timeout));
    });
    this.queue = run.catch(() => {});
    return run;
  }
}
export class ContainerComputer extends ComputerObject {}
export class SandboxComputer extends ComputerObject {
  protected override provider(): ComputerProvider {
    const container = this.ctx.container;
    if (!container) throw new Error("Computer container binding unavailable");
    const gateway = this.ctx.exports
      .DirectoryBackupGateway as DirectoryBackupGatewayBinding;
    return new SandboxProvider(
      container,
      this.ctx.storage,
      new Files(container),
      new DirectoryBackup(container, gateway, {
        binding: "COMPUTER_BACKUPS",
        prefix: `${this.ctx.id}/`,
      }),
    );
  }
}
