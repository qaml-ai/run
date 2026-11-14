// What a job on our own hosts costs (docs/design/job-hosts-plan.md, slice 8), from what the host costs us.
//
// Two pools (infra/job-hosts/terraform):
// - build: `r8gd.4xlarge`. A host runs one build sandbox and nothing else, so a build job has the whole host and is
//   charged the whole host's time;
// - test: `c8gd.4xlarge`. Its sandboxes share the host, so a test job is charged its share of the host: the larger of its
//   share of the host's vCPUs and its share of the memory its sandboxes may have (dominant-resource pricing). Test VMs
//   share vCPUs (CPU overcommit) but not memory, so hosts fill on memory: pricing by vCPU and memory apart would leave
//   most of a memory-full host's vCPUs unsold, and the host's cost unrecovered.
// The host's cost is its on-demand list price (us-west-2) plus what comes with it while it runs (its public IPv4 address
// and root volume), times the markup (JOB_HOST_PRICE_MARKUP): idle hosts, partly packed hosts, boots and the bucket are
// ours to cover. Each pool's hourly host cost can be set (JOB_HOST_PRICE_<POOL>_HOUR_USD) when AWS's prices change.
// A job's price never depends on how busy the host was: the same job costs the same on any host of its pool.

import { INSTANCE_RESOURCES } from "../computers/meter.ts";
import type { JobSpec } from "./job.ts";

// MONEY: host jobs and pulled VM usage use the same billing provider.
export const HOSTS_PROVIDER = "camelrun-hosts";

export type HostPool = "build" | "test";
export const HOST_POOLS: readonly HostPool[] = ["build", "test"];

/** A job VM's shape on a host: whole vCPUs, memory and disk in MiB. */
export type HostShape = { vcpus: number; memoryMiB: number; diskMiB: number };

/**
 * Each pool's host and what it costs an hour (on-demand list, us-west-2, 2026-11; check before relying on it):
 * the instance, plus its public IPv4 address ($0.005/h) and its 30 GiB gp3 root volume ($2.40 a month, $0.0033/h).
 * `vcpus` is the host's, and `memoryGiB` the memory pool its image reserves for sandboxes (infra/job-hosts/image/
 * versions.env NE_MEMPOOL_BUILD and NE_MEMPOOL_TEST: a test checks they agree). They are also what placement packs a
 * host to (hosts.ts) and what a host must have to join its pool.
 */
export const HOST_POOL_PRICES: Readonly<Record<HostPool, { instance: string; hostUsdPerHour: number; vcpus: number; memoryGiB: number; wholeHost: boolean }>> = {
  build: { instance: "r8gd.4xlarge", hostUsdPerHour: 1.176 + 0.005 + 0.0033, vcpus: 16, memoryGiB: 100, wholeHost: true },
  test: { instance: "c8gd.4xlarge", hostUsdPerHour: 0.784 + 0.005 + 0.0033, vcpus: 16, memoryGiB: 24, wholeHost: false },
};
/** The default markup over the host's cost: about 80% of hosts' time sold breaks even. */
export const DEFAULT_HOST_MARKUP = 1.25;

export type HostPriceEnv = { JOB_HOST_PRICE_MARKUP?: string; JOB_HOST_PRICE_BUILD_HOUR_USD?: string; JOB_HOST_PRICE_TEST_HOUR_USD?: string };

const setting = (value: string | undefined, name: string, fallback: number, min: number, max: number) => {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  // A price that does not parse is a configuration error, refused loudly: never a job charged nothing.
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${name} must be a number from ${min} to ${max}`);
  return number;
};

/** A pool's rate per second for a whole host, with the markup. */
export function hostRates(pool: HostPool, env: HostPriceEnv = {}) {
  const base = HOST_POOL_PRICES[pool];
  const markup = setting(env.JOB_HOST_PRICE_MARKUP, "JOB_HOST_PRICE_MARKUP", DEFAULT_HOST_MARKUP, 1, 10);
  const hour = setting(pool === "build" ? env.JOB_HOST_PRICE_BUILD_HOUR_USD : env.JOB_HOST_PRICE_TEST_HOUR_USD,
    `JOB_HOST_PRICE_${pool.toUpperCase()}_HOUR_USD`, base.hostUsdPerHour, 0.01, 100);
  return { hostSecond: hour * markup / 3600, wholeHost: base.wholeHost };
}

/** A job VM's share of a host of its pool: the whole host on build, else the larger of its vCPU and memory shares. */
export function hostShare(pool: HostPool, shape: HostShape) {
  const base = HOST_POOL_PRICES[pool];
  return base.wholeHost ? 1 : Math.min(1, Math.max(shape.vcpus / base.vcpus, shape.memoryMiB / (base.memoryGiB * 1024)));
}

/** What a job VM of `shape` costs per second on `pool`. */
export function hostSecondRate(pool: HostPool, shape: HostShape, env: HostPriceEnv = {}) {
  return hostRates(pool, env).hostSecond * hostShare(pool, shape);
}

/**
 * The meter's name for a host job's VM (usage rows' model): its pool and shape, e.g. `test-2vcpu-4096mib`. The meter
 * keeps it with the open session, so a charge made after a restart prices the same shape.
 */
export function hostInstance(pool: HostPool, shape: Pick<HostShape, "vcpus" | "memoryMiB">) {
  return `${pool}-${shape.vcpus}vcpu-${shape.memoryMiB}mib`;
}
export function parseHostInstance(instance: string): { pool: HostPool; shape: HostShape } | undefined {
  const match = /^(build|test)-(\d{1,3})vcpu-(\d{1,7})mib$/.exec(instance);
  if (!match) return undefined;
  return { pool: match[1] as HostPool, shape: { vcpus: Number(match[2]), memoryMiB: Number(match[3]), diskMiB: 0 } };
}

/** A host job session's cost: its VM's rate for its time (a VM holds its vCPUs whether or not they compute). */
export function hostSessionCost(instance: string, seconds: number, env: HostPriceEnv = {}) {
  const parsed = parseHostInstance(instance);
  if (!parsed) throw new Error(`Not a host job instance: ${instance}`);
  return seconds * hostSecondRate(parsed.pool, parsed.shape, env);
}

/**
 * The largest test-pool job: a test shard's size (4 vCPU and 8–16 GiB in the design doc). Anything larger goes to the
 * build pool, where it has a whole host.
 */
export const TEST_POOL_MAX = Object.freeze({ vcpus: 8, memoryMiB: 16 * 1024 });
export function hostPool(shape: HostShape): HostPool {
  return shape.vcpus <= TEST_POOL_MAX.vcpus && shape.memoryMiB <= TEST_POOL_MAX.memoryMiB ? "test" : "build";
}

/**
 * JOB_HOST_ROLE_ARNS: comma-separated `pool=arn` entries, one role per pool (infra/job-hosts/terraform), so the attested
 * role says which pool a host serves. An entry without a known pool fails the whole setting closed (undefined).
 */
export function hostRoles(value: string | undefined): { pool: HostPool; arn: string }[] | undefined {
  const entries = (value ?? "").split(",").map(entry => entry.trim()).filter(Boolean).map(entry => {
    const at = entry.indexOf("="), pool = entry.slice(0, at).trim(), arn = entry.slice(at + 1).trim();
    return at > 0 && HOST_POOLS.includes(pool as HostPool) && arn.startsWith("arn:") ? { pool: pool as HostPool, arn } : undefined;
  });
  return entries.length && entries.every(Boolean) ? entries as { pool: HostPool; arn: string }[] : undefined;
}

/**
 * A job's VM on a host: its limits where it gives them, else its instance type's resources (what the same job gets in a
 * Cloudflare container), in whole vCPUs.
 */
export function hostShape(spec: JobSpec & { instance: keyof typeof INSTANCE_RESOURCES }): HostShape {
  const resources = INSTANCE_RESOURCES[spec.instance];
  return {
    vcpus: Math.max(1, Math.ceil(spec.limits?.cpus ?? resources.vcpu)),
    memoryMiB: spec.limits?.memoryMiB ?? resources.memoryGiB * 1024,
    diskMiB: spec.limits?.diskMiB ?? Math.ceil(resources.diskGB * 1e9 / 2 ** 20),
  };
}


/**
 * The span a host job is charged, from dispatch to its result (`resultAt`): from its host's `started` report, or, for a
 * result that says it ran, what its timings say (so a `started` lost on a reconnect, or held by a job object that was
 * evicted, never makes a job that ran free); until its result, or until its host was last heard from if it went away.
 * A VM that never started (no report, no result that ran) spans nothing; a result that ran spans at least a second.
 */
export function chargedSpan(wire: { ok: boolean; timings?: { totalMs: number; startMs: number }; ranFrom?: number; ranUntil?: number }, dispatchedAt: number, resultAt: number) {
  // Any result that says its VM started carries timings (a failure after boot too): a job that ran is never free.
  const ranFrom = wire.ranFrom ?? (wire.timings ? resultAt - Math.max(0, wire.timings.totalMs - wire.timings.startMs) : undefined);
  if (ranFrom === undefined && !wire.ok) return { from: resultAt, until: resultAt };
  const until = Math.max(dispatchedAt, Math.min(resultAt, wire.ranUntil ?? resultAt));
  let from = Math.min(until, Math.max(dispatchedAt, ranFrom ?? dispatchedAt));
  // A job that ran is charged at least a second: its VM booted and ran its command.
  if (wire.ok) from = Math.min(from, until - 1000);
  return { from, until };
}

