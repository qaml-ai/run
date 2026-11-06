import { DurableObject } from "cloudflare:workers";
import {
  ContainerProvider,
  computerSpec,
  operate,
  type ComputerRequest,
  type ComputerSnapshot,
} from "./provider.ts";

type ComputerObjectEnv = { COMPUTER_IMAGE?: string; COMPUTER_INSTANCE?: string };

// An optional, dedicated per-agent computer, not the agent's own DO. It owns
// one container through ctx.container (Cloudflare's `durable_object` scheduling
// policy) and picks image and size each time it starts one. One queue excludes
// simultaneous writes while taking or restoring a snapshot.
export class ContainerComputer extends DurableObject<ComputerObjectEnv> {
  private queue: Promise<unknown> = Promise.resolve();
  private provider() {
    if (!this.ctx.container)
      throw new Error("Computer container binding unavailable");
    return new ContainerProvider(
      this.ctx.container,
      this.ctx.storage,
      computerSpec(this.env),
    );
  }
  private serial<T>(run: () => Promise<T>) {
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }
  operate(request: ComputerRequest) {
    return this.serial(() => {
      const timeout =
        request.op === "exec" ? (request.timeoutMs ?? 30_000) : 30_000;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30_000)
        throw new Error("Invalid computer timeout");
      return operate(this.provider(), request, AbortSignal.timeout(timeout));
    });
  }
  /** Take a snapshot now and return its handle. */
  takeSnapshot(name: string): Promise<ComputerSnapshot> {
    return this.serial(() =>
      this.provider().snapshot(name, AbortSignal.timeout(30_000)),
    );
  }
  /** A named snapshot's handle, for another computer to start from (fork). */
  snapshotHandle(name: string): Promise<ComputerSnapshot> {
    return this.serial(() => this.provider().snapshotNamed(name));
  }
  /** Replace this computer's filesystem with a snapshot taken by any computer. */
  startFromSnapshot(handle: ComputerSnapshot): Promise<ComputerSnapshot> {
    return this.serial(() =>
      this.provider().startFrom(handle, AbortSignal.timeout(30_000)),
    );
  }
  /** Stop the container and forget every snapshot handle (agent deletion). */
  purge(): Promise<{ purged: true }> {
    return this.serial(async () => {
      if (this.ctx.container?.running) await this.ctx.container.destroy();
      await this.ctx.storage.deleteAll();
      return { purged: true as const };
    });
  }
}
