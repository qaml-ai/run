import { DurableObject } from "cloudflare:workers";
import {
  ContainerProvider,
  computerSpec,
  operate,
  type ComputerNetwork,
  type ComputerRequest,
  type ComputerSnapshot,
} from "./provider.ts";
import { COMPUTER_LIMITS, type ComputerSetup } from "./egress.ts";
import type { EgressProps } from "./egress-gateway.ts";

type ComputerObjectEnv = { COMPUTER_IMAGE?: string; COMPUTER_INSTANCE?: string; COMPUTER_CONTAINERS?: DurableObjectNamespace<ContainerComputer> };
/**
 * What the agent sends with an operation: its definition's computer settings and identity, and, for a sub-agent, the
 * name of its parent's computer object, which the runtime takes from the signed parent link.
 */
export type OperateSetup = ComputerSetup & { parent?: string };
type EgressBinding = (options: { props: EgressProps }) => Fetcher;

// An optional, dedicated per-agent computer, not the agent's own DO. It owns
// one container through ctx.container (Cloudflare's `durable_object` scheduling
// policy) and picks image and size each time it starts one. One queue excludes
// simultaneous writes while taking or restoring a snapshot.
export class ContainerComputer extends DurableObject<ComputerObjectEnv> {
  private queue: Promise<unknown> = Promise.resolve();
  private network(setup?: OperateSetup): ComputerNetwork {
    const idleMs = (setup?.settings.idleSeconds ?? COMPUTER_LIMITS.idleSeconds.default) * 1000;
    const grants = setup?.settings.egress ?? [], instance = setup?.settings.instance;
    // The key names what a running container was started with; another key replaces it (ContainerProvider.ready).
    if (!grants.length) return { key: instance ? JSON.stringify([[], null, instance]) : "", egress: [], idleMs };
    const gateway = (this.ctx as unknown as { exports: { ComputerEgress: EgressBinding } }).exports.ComputerEgress;
    return {
      // The identity is part of the key: a gateway's props carry it, so a new one needs new intercepts.
      key: JSON.stringify([grants, setup!.identity.claims, instance ?? null]),
      egress: grants.map(grant => ({ grant, gateway: gateway({ props: { grant, identity: setup!.identity } }) })),
      idleMs,
    };
  }
  private provider(setup?: OperateSetup) {
    if (!this.ctx.container)
      throw new Error("Computer container binding unavailable");
    return new ContainerProvider(
      this.ctx.container,
      this.ctx.storage,
      { ...computerSpec(this.env), ...(setup?.settings.instance ? { instance: setup.settings.instance } : {}) },
      Date.now,
      this.network(setup),
    );
  }
  private serial<T>(run: () => Promise<T>) {
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }
  operate(request: ComputerRequest, setup?: OperateSetup) {
    return this.serial(async () => {
      const timeout =
        request.op === "exec" ? (request.timeoutMs ?? 30_000) : 30_000;
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > COMPUTER_LIMITS.execMs)
        throw new Error("Invalid computer timeout");
      let parent: ComputerSnapshot | undefined;
      if (request.op === "restore" && request.from === "parent") {
        // The parent is the runtime's signed link, never the model's choice; its handle is a plain value.
        if (!setup?.parent || !this.env.COMPUTER_CONTAINERS) throw new Error("This agent has no parent computer to restore from");
        try { parent = await this.env.COMPUTER_CONTAINERS.getByName(setup.parent).snapshotHandle(request.name); }
        catch { throw new Error(`The parent's computer has no snapshot named ${request.name}: the parent saves one with snapshot first`); }
      }
      return operate(this.provider(setup), request, AbortSignal.timeout(timeout), parent);
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
