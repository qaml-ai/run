import { secretPlaceholder } from "../../../../src/core/vault.ts";
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
import type { NativeForkAnswer, NativeForkOrigin, NativeForkedFrom } from "./native-fork.ts";
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
    const grants = [...(setup?.settings.egress ?? []), ...(setup?.settings.networking?.type === "limited" || setup?.settings.secrets?.length ? [{ host: "*" }] : [])], instance = setup?.settings.instance, idle = setup?.settings.idle;
    // The key names what a running container was started with; another key replaces it (ContainerProvider.ready).
    if (!grants.length) return { key: instance ? JSON.stringify([[], null, instance]) : "", egress: [], idleMs, ...idle ? { idle } : {} };
    const gateway = (this.ctx as unknown as { exports: { ComputerEgress: EgressBinding } }).exports.ComputerEgress;
    return {
      // The identity is part of the key: a gateway's props carry it, so a new one needs new intercepts.
      key: JSON.stringify([grants, setup!.identity.claims, instance ?? null, setup!.settings.secrets, setup!.settings.networking, setup!.settings.mcpHosts]),
      limited: setup!.settings.networking?.type === "limited",
      secrets: Object.fromEntries((setup!.settings.secrets ?? []).map(ref => [ref.name, secretPlaceholder(ref.name)])),
      egress: grants.map(grant => ({ grant, gateway: gateway({ props: { grant, identity: setup!.identity, secrets: setup!.settings.secrets, networking: setup!.settings.networking, mcpHosts: setup!.settings.mcpHosts } }) })),
      idleMs,
      ...idle ? { idle } : {},
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
    return new ContainerProvider(this.ctx.container, this.ctx.storage, spec, Date.now, network, bound, at => this.wake(at));
  }
  /** The alarm at `at`, unless one is set sooner (the meter's and the idle sleep's share it; each alarm re-arms both). */
  private async wake(at: number) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
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
      return operate(this.provider(setup), request, AbortSignal.timeout(timeout));
    });
  }
  // Forking (native-fork.ts). Errors a caller acts on cross RPC as values: an HttpError's code does not survive it.
  /** The parent's side: the snapshot every child of `batch` starts from, taken (or reused) now. */
  forkSnapshot(batch: string, setup?: OperateSetup): Promise<NativeForkAnswer> {
    return this.serial(async () => {
      try { return await this.provider(setup).forkSnapshot(batch, AbortSignal.timeout(180_000)); }
      catch (error) {
        if ((error as { code?: string }).code === "COMPUTER_STARTING") return { ok: false as const, code: "COMPUTER_STARTING" as const, message: (error as Error).message };
        throw error;
      }
    });
  }
  adopt(batch: string, child: string): Promise<void> {
    return this.serial(() => this.provider().adopt(batch, child));
  }
  unref(batch: string, child: string): Promise<void> {
    return this.serial(() => this.provider().unref(batch, child));
  }
  /** The child's side: start from the parent's snapshot from now on, and tell the parent's computer. */
  /** Whether this computer has a disk of its own (running, or a saved base): the fork route refuses to overwrite it. */
  hasDisk(): Promise<boolean> {
    return this.serial(() => this.provider().hasDisk());
  }
  async seed(snapshot: ComputerSnapshot, origin: NativeForkOrigin, setup?: OperateSetup): Promise<void> {
    await this.serial(() => this.provider(setup).seed(snapshot, origin));
    await this.env.COMPUTER_CONTAINERS?.getByName(origin.parent).adopt(origin.batch, this.ctx.id.toString());
  }
  forkedFrom(): Promise<NativeForkedFrom | null> {
    return this.serial(() => this.provider().forkedFrom());
  }
  /**
   * A child's work ended. purge: its container and handles go (as on deletion), and its parent's computer is told.
   * sleep: its disk is saved as its base, then the container stops: a later turn resumes it, and compute stops now.
   */
  async release(mode: "purge" | "sleep"): Promise<void> {
    if (mode === "purge") { await this.purge(); return; }
    await this.serial(async () => { await this.provider().sleep(true); });
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
  async purge(): Promise<{ purged: true }> {
    const origin = await this.serial(async () => {
      let origin: NativeForkedFrom | null = null;
      if (this.ctx.container) {
        const provider = this.provider();
        origin = await provider.forkedFrom();
        // Stopping through the provider takes a last CPU reading for the meter (no snapshot: the disk goes).
        await provider.halt();
      }
      const meter = this.meter();
      await meter.stopped();
      if (await meter.settled()) await this.ctx.storage.deleteAll();
      else for (const key of (await this.ctx.storage.list()).keys())
        if (!key.startsWith("meter:")) await this.ctx.storage.delete(key);
      return origin;
    });
    // A forked child: its parent's computer drops the batch's snapshot once no child of it is left. Best effort.
    if (origin) await this.env.COMPUTER_CONTAINERS?.getByName(origin.parent).unref(origin.batch, this.ctx.id.toString())
      .catch((error: unknown) => console.error(JSON.stringify({ type: "computer_unref_failed", error: error instanceof Error ? error.message.slice(0, 200) : "unknown" })));
    return { purged: true as const };
  }
  /**
   * Put a computer that sleeps when idle to sleep once its idle time is up, settle a session that idled out, retry
   * charges that failed, and drop fork snapshots no child adopted.
   */
  async alarm() {
    await this.serial(async () => {
      const provider = this.ctx.container ? this.provider() : undefined;
      const next = await provider?.sleepIfIdle().catch((error: unknown) => {
        console.error(JSON.stringify({ type: "computer_idle_sleep_failed", error: error instanceof Error ? error.message.slice(0, 200) : "unknown" }));
        return undefined;
      });
      await this.meter().alarm(!!this.ctx.container?.running);
      await provider?.dropStale().catch(() => {});
      if (next !== undefined) await this.wake(next);
    });
  }
}
