import { DurableObject } from "cloudflare:workers";
import {
  ContainerProvider,
  computerSpec,
  operate,
  type ComputerNetwork,
  type ComputerRequest,
  type ComputerSnapshot,
  type ProviderMeter,
} from "./provider.ts";
import { COMPUTER_LIMITS, type ComputerSetup } from "./egress.ts";
import type { EgressProps } from "./egress-gateway.ts";
import { ComputerMeter, type ComputerPayer } from "./meter.ts";
export { payerSetup } from "./meter.ts";
import { meterBilling } from "./meter-billing.ts";
import type { KeyEnv } from "../security-services.ts";
import type { WebhookEnv } from "../webhooks.ts";

type ComputerObjectEnv = KeyEnv & WebhookEnv & { COMPUTER_IMAGE?: string; COMPUTER_INSTANCE?: string; COMPUTER_CONTAINERS?: DurableObjectNamespace<ContainerComputer> };
/**
 * What the agent sends with an operation: its definition's computer settings and identity, and, for a sub-agent, the
 * name of its parent's computer object, which the runtime takes from the signed parent link.
 */
export type OperateSetup = ComputerSetup & { parent?: string };
type EgressBinding = (options: { props: EgressProps }) => Fetcher;
/** Who pays for an operation's container time: the identity's tenant and agent. */
function payerOf(setup?: OperateSetup): ComputerPayer | undefined {
  const claims = setup?.identity.claims as { tenant?: unknown; agent?: unknown } | undefined;
  return typeof claims?.tenant === "string" && typeof claims.agent === "string" ? { tenant: claims.tenant, agent: claims.agent } : undefined;
}

// An optional, dedicated per-agent computer, not the agent's own DO. It owns
// one container through ctx.container (Cloudflare's `durable_object` scheduling
// policy) and picks image and size each time it starts one. One queue excludes
// simultaneous writes while taking or restoring a snapshot. Container time is
// metered to the payer each call's setup names (computers/meter.ts); a call
// without one (the cloud probe) runs unmetered.
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
  private meter() {
    return new ComputerMeter({
      store: this.ctx.storage,
      billing: meterBilling(this.env),
      idleMs: COMPUTER_LIMITS.idleSeconds.default * 1000,
      schedule: at => this.ctx.storage.setAlarm(at),
    });
  }
  private provider(setup?: OperateSetup) {
    if (!this.ctx.container)
      throw new Error("Computer container binding unavailable");
    const spec = { ...computerSpec(this.env), ...(setup?.settings.instance ? { instance: setup.settings.instance } : {}) };
    const network = this.network(setup), meter = this.meter(), payer = payerOf(setup);
    const bound: ProviderMeter = {
      admit: async () => { if (payer) await meter.admit(payer); },
      // Unmetered starts still end any earlier session.
      started: (instance, idleMs) => payer ? meter.started(payer, instance, idleMs) : meter.stopped(),
      // A running container with no open session (a DO that died mid-start, or one started unmetered) is billed from
      // now to whoever uses it (its CPU from the current reading on).
      used: async (cpuUsec) => {
        if (payer && this.ctx.container?.running && !(await meter.isOpen())) await meter.started(payer, spec.instance, network.idleMs, cpuUsec ?? 0);
        else await meter.used(cpuUsec);
      },
      stopped: (cpuUsec) => meter.stopped(cpuUsec),
    };
    return new ContainerProvider(this.ctx.container, this.ctx.storage, spec, Date.now, network, bound);
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
  takeSnapshot(name: string, setup?: OperateSetup): Promise<ComputerSnapshot> {
    return this.serial(() =>
      this.provider(setup).snapshot(name, AbortSignal.timeout(30_000)),
    );
  }
  /** A named snapshot's handle, for another computer to start from (fork). */
  snapshotHandle(name: string): Promise<ComputerSnapshot> {
    return this.serial(() => this.provider().snapshotNamed(name));
  }
  /** Replace this computer's filesystem with a snapshot taken by any computer. */
  startFromSnapshot(handle: ComputerSnapshot, setup?: OperateSetup): Promise<ComputerSnapshot> {
    return this.serial(() =>
      this.provider(setup).startFrom(handle, AbortSignal.timeout(30_000)),
    );
  }
  /**
   * Stop the container and forget every snapshot handle (agent deletion). Its time is charged first; a charge that
   * cannot commit yet keeps only the meter's records, which the alarm retries.
   */
  purge(): Promise<{ purged: true }> {
    return this.serial(async () => {
      // Stopping through the provider takes a last CPU reading for the meter.
      if (this.ctx.container) await this.provider().sleep();
      const meter = this.meter();
      await meter.stopped();
      if (await meter.settled()) await this.ctx.storage.deleteAll();
      else for (const key of (await this.ctx.storage.list()).keys())
        if (!key.startsWith("meter:")) await this.ctx.storage.delete(key);
      return { purged: true as const };
    });
  }
  /** Settle a session that idled out, and retry charges that failed. */
  async alarm() {
    await this.serial(() => this.meter().alarm(!!this.ctx.container?.running));
  }
}
