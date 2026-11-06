import type { InstanceType } from "./provider.ts";
import type { ComputerSetup } from "./egress.ts";

/** The setup a runtime-made call (a managed session, a fork) gives a computer: no settings, only who pays. */
export const payerSetup = (payer: { tenant: string; agent: string }): ComputerSetup => ({
  settings: {},
  identity: { issuer: "", claims: payer } as unknown as ComputerSetup["identity"],
});

/**
 * Cloudflare Containers' list rates (Workers Paid, after included usage): per vCPU-second, per GiB-second of memory
 * and per GB-second of disk (developers.cloudflare.com/containers/pricing). Cloudflare bills memory and disk on what
 * the instance provisions and CPU only while it is used, and camelRun passes platform costs through at cost
 * (docs/operations/billing.md), so a session is charged the same way: provisioned memory and disk for its time, plus
 * the CPU-seconds the container's cgroup counted (cpu.stat usage_usec, read after each operation and before each
 * stop). Time no reading covers (the tail after the last reading of a container that idled out or crashed) is charged
 * at the provisioned vCPU: the reading cannot be taken, and that is at most what Cloudflare bills.
 */
export const CONTAINER_RATES = { vcpuSecond: 0.00002, memoryGiBSecond: 0.0000025, diskGBSecond: 0.00000007 };
/** Each instance type's provisioned vCPU, memory (GiB) and disk (GB), from Cloudflare's limits page. */
export const INSTANCE_RESOURCES: Record<InstanceType, { vcpu: number; memoryGiB: number; diskGB: number }> = {
  lite: { vcpu: 1 / 16, memoryGiB: 0.25, diskGB: 2 },
  "standard-1": { vcpu: 0.5, memoryGiB: 4, diskGB: 8 },
  "standard-2": { vcpu: 1, memoryGiB: 6, diskGB: 12 },
  "standard-3": { vcpu: 2, memoryGiB: 8, diskGB: 16 },
  "standard-4": { vcpu: 4, memoryGiB: 12, diskGB: 20 },
};
/** USD per second a running instance of this type costs at its provisioned vCPU: the most it can cost. */
export function secondRate(instance: InstanceType) {
  return holdRate(instance) + INSTANCE_RESOURCES[instance].vcpu * CONTAINER_RATES.vcpuSecond;
}
/** USD per second for what a running instance holds whether or not it computes: its memory and disk. */
export function holdRate(instance: InstanceType) {
  const r = INSTANCE_RESOURCES[instance];
  return r.memoryGiB * CONTAINER_RATES.memoryGiBSecond + r.diskGB * CONTAINER_RATES.diskGBSecond;
}
/**
 * A session's cost: memory and disk for `seconds`, CPU for the measured vCPU-seconds, and the provisioned vCPU for
 * the `unmeasuredSeconds` no reading covers.
 */
export function sessionCost(instance: InstanceType, seconds: number, cpuSeconds: number, unmeasuredSeconds: number) {
  const vcpu = INSTANCE_RESOURCES[instance].vcpu;
  return seconds * holdRate(instance) + (cpuSeconds + unmeasuredSeconds * vcpu) * CONTAINER_RATES.vcpuSecond;
}

/** Who pays for a computer's time: the agent (and its tenant) whose tool or session uses it. */
export type ComputerPayer = { tenant: string; agent: string };
/** One container's run, from its start until it stops or idles out. */
/** `idleMs` is the inactivity timeout this container was started with (a definition's `computer.idleSeconds`). */
/**
 * CPU: `cpuBaseUsec` is the container's cgroup usage when the session began (0 for a container it started),
 * `cpuUsec` the latest reading and `cpuAt` when it was taken (the start, until the first reading).
 */
export type ComputerSession = ComputerPayer & { id: string; instance: InstanceType; startedAt: number; usedAt: number; idleMs?: number;
  cpuBaseUsec?: number; cpuUsec?: number; cpuAt?: number };
/** A finished session's charge. `id` makes it exactly-once: charging the same session twice records it once. */
export type ComputerCharge = ComputerPayer & { id: string; instance: InstanceType; startedAt: number; endedAt: number; seconds: number; costUsd: number;
  /** vCPU-seconds the cgroup counted, and seconds charged at the provisioned vCPU because no reading covers them. */
  cpuSeconds?: number; unmeasuredSeconds?: number };
export interface MeterStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}
export interface MeterBilling {
  /** Refuse (throw) when the payer may not start platform compute: an agent spend limit, or spent prepaid credit. */
  admit(payer: ComputerPayer): Promise<void>;
  /** Record and charge a finished session, once per `id`. */
  charge(charge: ComputerCharge): Promise<void>;
}

const OPEN = "meter:session";
const UNSETTLED = "meter:unsettled:";
const RETRIES = "meter:retries";
/** When the open session would idle out, plus this margin, an alarm settles it. */
export const SETTLE_MARGIN_MS = 5_000;
/** A session in use this long is charged so far and continues as a new one, so credit and spend limits see it. */
export const CHECKPOINT_MS = 5 * 60_000;
/** Failed charges are retried after 1, 2, 4… minutes, at most an hour apart. */
const retryDelay = (failures: number) => Math.min(3_600_000, 60_000 * 2 ** Math.min(failures, 6));
/** A charge the database refuses for good (its agent is gone, or its receipt conflicts) is logged and dropped. */
const terminal = (error: unknown) => [404, 409].includes(Number((error as { status?: number })?.status));

/**
 * Container time, kept in the computer DO's storage. A container is billed from its start until it is destroyed or
 * its inactivity timeout stops it, whichever comes first: `idleMs` after the last use. One that stopped on its own (a
 * crash) is billed until it would have idled out, at most `idleMs` more than it ran. A session in use for
 * CHECKPOINT_MS is charged and continues as a new one. A finished session waits under `meter:unsettled:` until its
 * charge commits, so a failed charge is retried (with backoff, by the next stop or the alarm) and never lost; the
 * charge's id makes the retry free.
 */
export class ComputerMeter {
  private store: MeterStore;
  private billing: MeterBilling;
  /** The idle timeout for a session that does not record its own. */
  private idleMs: number;
  private now: () => number;
  private schedule: (at: number) => Promise<void>;
  constructor(options: { store: MeterStore; billing: MeterBilling; idleMs: number; now?: () => number; schedule: (at: number) => Promise<void> }) {
    this.store = options.store;
    this.billing = options.billing;
    this.idleMs = options.idleMs;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule;
  }
  admit(payer: ComputerPayer) {
    return this.billing.admit(payer);
  }
  /**
   * A container is starting for this payer. Call before `start()`, so a DO that dies in between leaves a session
   * (billed until it idles out) rather than an unmetered container. Any earlier session ended.
   */
  async started(payer: ComputerPayer, instance: InstanceType, idleMs = this.idleMs, cpuBaseUsec = 0) {
    await this.close();
    const at = this.now();
    await this.store.put<ComputerSession>(OPEN, { ...payer, id: crypto.randomUUID(), instance, startedAt: at, usedAt: at, idleMs,
      cpuBaseUsec, cpuUsec: cpuBaseUsec, cpuAt: at });
    await this.schedule(at + idleMs + SETTLE_MARGIN_MS);
  }
  private idle(session: ComputerSession) {
    return session.idleMs ?? this.idleMs;
  }
  async isOpen() {
    return !!(await this.store.get(OPEN));
  }
  /** The container was used just now: its idle clock starts over. `cpuUsec` is its cgroup CPU reading, if one was taken. */
  async used(cpuUsec?: number) {
    await this.reading(cpuUsec);
    const open = await this.checkpoint(true);
    if (!open) return;
    const at = this.now();
    await this.store.put<ComputerSession>(OPEN, { ...open, usedAt: Math.max(open.usedAt, at) });
    await this.schedule(at + this.idle(open) + SETTLE_MARGIN_MS);
  }
  /** The container was destroyed just now (sleep, restore, purge), with its last CPU reading if one was taken. */
  async stopped(cpuUsec?: number) {
    await this.reading(cpuUsec);
    await this.close();
    await this.settle();
  }
  /**
   * The alarm: settle the open session once it must have idled out (`running` says whether a container still runs:
   * a running one is checkpointed and checked again), then retry unsettled charges.
   */
  async alarm(running: boolean) {
    const open = await this.checkpoint(running);
    if (open) {
      const idleAt = open.usedAt + this.idle(open), now = this.now();
      if (!running && now >= idleAt) await this.close();
      // Past its idle time but still running (a late stop): billing already ends at idleAt, so check rarely.
      else await this.schedule(now >= idleAt ? now + this.idle(open) : idleAt + SETTLE_MARGIN_MS);
    }
    await this.settle();
  }
  /** Keep a CPU reading on the open session. The counter only grows while one container runs. */
  private async reading(cpuUsec?: number) {
    if (cpuUsec === undefined || !Number.isFinite(cpuUsec) || cpuUsec < 0) return;
    const open = await this.store.get<ComputerSession>(OPEN);
    if (!open) return;
    await this.store.put<ComputerSession>(OPEN, { ...open, cpuUsec: Math.max(open.cpuUsec ?? 0, cpuUsec), cpuAt: this.now() });
  }
  /** Charge an open session that has run CHECKPOINT_MS and, while the container runs, continue it as a new one. */
  private async checkpoint(running: boolean) {
    const open = await this.store.get<ComputerSession>(OPEN);
    if (!open) return undefined;
    const now = this.now();
    if (now - open.startedAt < CHECKPOINT_MS) return open;
    await this.close();
    if (!running) { await this.settle(); return undefined; }
    // Time past the old session's idle point stays unbilled: the new one is billed from now only while in use.
    // CPU continues from the last reading; the time since it stays unmeasured in the new session too.
    const next: ComputerSession = { ...open, id: crypto.randomUUID(), startedAt: now, usedAt: Math.max(open.usedAt, now),
      cpuBaseUsec: open.cpuUsec ?? open.cpuBaseUsec ?? 0, cpuAt: Math.max(now, open.cpuAt ?? now) };
    await this.store.put(OPEN, next);
    await this.settle();
    return next;
  }
  /** End the open session: now, or when it idled out if that was earlier. */
  private async close() {
    const open = await this.store.get<ComputerSession>(OPEN);
    if (!open) return;
    const now = this.now(), idleAt = open.usedAt + this.idle(open);
    const endedAt = Math.max(open.startedAt, Math.min(now, idleAt));
    const seconds = (endedAt - open.startedAt) / 1000;
    // A session from before CPU readings (no cpuAt) is unmeasured throughout.
    const measuredUntil = Math.min(endedAt, Math.max(open.startedAt, open.cpuAt ?? open.startedAt));
    const unmeasuredSeconds = (endedAt - measuredUntil) / 1000;
    // Never more than the provisioned vCPU over the measured time, which is what Cloudflare can bill (an unthrottled
    // host, like local Docker, can count more).
    const measuredSeconds = (measuredUntil - open.startedAt) / 1000;
    const cpuSeconds = Math.min(INSTANCE_RESOURCES[open.instance].vcpu * measuredSeconds,
      Math.max(0, (open.cpuUsec ?? 0) - (open.cpuBaseUsec ?? 0)) / 1e6);
    const charge: ComputerCharge = { id: open.id, tenant: open.tenant, agent: open.agent, instance: open.instance,
      startedAt: open.startedAt, endedAt, seconds, cpuSeconds, unmeasuredSeconds,
      costUsd: sessionCost(open.instance, seconds, cpuSeconds, unmeasuredSeconds) };
    // A session that ended as it started costs nothing and records nothing.
    if (seconds > 0) await this.store.put(`${UNSETTLED}${open.id}`, charge);
    await this.store.delete(OPEN);
  }
  /** Charge every finished session; one that fails stays for the next attempt, later each time. */
  async settle() {
    const pending = await this.store.list<ComputerCharge>({ prefix: UNSETTLED });
    let failed = false;
    for (const [key, charge] of pending) {
      try {
        await this.billing.charge(charge);
        await this.store.delete(key);
      } catch (error) {
        const reason = error instanceof Error ? error.message.slice(0, 200) : "unknown";
        if (terminal(error)) {
          console.error(JSON.stringify({ type: "computer_charge_dropped", reason, charge }));
          await this.store.delete(key);
          continue;
        }
        failed = true;
        console.error(JSON.stringify({ type: "computer_charge_failed", agent: charge.agent, session: charge.id, error: reason }));
      }
    }
    if (!failed) {
      if (pending.size) await this.store.delete(RETRIES);
      return;
    }
    const failures = (await this.store.get<number>(RETRIES)) ?? 0;
    await this.store.put(RETRIES, failures + 1);
    await this.schedule(this.now() + retryDelay(failures));
  }
  /** Nothing open or unsettled: safe to forget this computer's storage. */
  async settled() {
    return !(await this.store.get(OPEN)) && (await this.store.list({ prefix: UNSETTLED })).size === 0;
  }
}
