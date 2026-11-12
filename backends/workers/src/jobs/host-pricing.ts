// What a job on our own hosts costs (docs/design/job-hosts-plan.md, slice 8), from what the host costs us.
//
// Two pools (infra/job-hosts/terraform):
// - build: `r8gd.4xlarge`. A host runs one build sandbox and nothing else, so a build job has the whole host and is
//   charged the whole host's time;
// - test: `c8gd.4xlarge`. Its sandboxes share the host, so a test job is charged its VM's vCPUs and memory, priced so
//   that a host whose allocatable vCPUs and memory are all sold recovers what the host costs.
// The host's cost is its on-demand list price (us-west-2) plus what comes with it while it runs (its public IPv4 address
// and root volume), times the markup (JOB_HOST_PRICE_MARKUP): idle hosts, partly packed hosts, boots and the bucket are
// ours to cover. Each pool's hourly host cost can be set (JOB_HOST_PRICE_<POOL>_HOUR_USD) when AWS's prices change.
// A job's price never depends on how busy the host was: the same job costs the same on any host of its pool.

export type HostPool = "build" | "test";
export const HOST_POOLS: readonly HostPool[] = ["build", "test"];

/** A job VM's shape on a host: whole vCPUs, memory and disk in MiB. */
export type HostShape = { vcpus: number; memoryMiB: number; diskMiB: number };

/**
 * Each pool's host and what it costs an hour (on-demand list, us-west-2, 2026-11; check before relying on it):
 * the instance, plus its public IPv4 address ($0.005/h) and its 30 GiB gp3 root volume ($2.40 a month, $0.0033/h).
 * `vcpus` and `memoryGiB` are what a host can give its sandboxes (the memory pool its image reserves, infra/job-hosts/
 * image/versions.env), and `vcpuShare` the part of the host's price its vCPUs stand for: AWS prices a vCPU and a GiB
 * the same in the c and r families (c8gd.4xlarge and r8gd.4xlarge solve to about $0.0411 per vCPU-hour and $0.0041
 * per GiB-hour), so on a c8gd the 16 vCPUs are about 83% of the price and its 32 GiB the rest.
 */
export const HOST_POOL_PRICES: Readonly<Record<HostPool, { instance: string; hostUsdPerHour: number; vcpus: number; memoryGiB: number; vcpuShare: number; wholeHost: boolean }>> = {
  build: { instance: "r8gd.4xlarge", hostUsdPerHour: 1.176 + 0.005 + 0.0033, vcpus: 16, memoryGiB: 100, vcpuShare: 0.56, wholeHost: true },
  test: { instance: "c8gd.4xlarge", hostUsdPerHour: 0.784 + 0.005 + 0.0033, vcpus: 16, memoryGiB: 24, vcpuShare: 0.83, wholeHost: false },
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

/** A pool's rates per second: the whole host, or per vCPU and per GiB of memory, with the markup. */
export function hostRates(pool: HostPool, env: HostPriceEnv = {}) {
  const base = HOST_POOL_PRICES[pool];
  const markup = setting(env.JOB_HOST_PRICE_MARKUP, "JOB_HOST_PRICE_MARKUP", DEFAULT_HOST_MARKUP, 1, 10);
  const hour = setting(pool === "build" ? env.JOB_HOST_PRICE_BUILD_HOUR_USD : env.JOB_HOST_PRICE_TEST_HOUR_USD,
    `JOB_HOST_PRICE_${pool.toUpperCase()}_HOUR_USD`, base.hostUsdPerHour, 0.01, 100);
  const hostSecond = hour * markup / 3600;
  return {
    hostSecond,
    vcpuSecond: hostSecond * base.vcpuShare / base.vcpus,
    memoryGiBSecond: hostSecond * (1 - base.vcpuShare) / base.memoryGiB,
    wholeHost: base.wholeHost,
  };
}

/** What a job VM of `shape` costs per second on `pool`. */
export function hostSecondRate(pool: HostPool, shape: HostShape, env: HostPriceEnv = {}) {
  const rates = hostRates(pool, env);
  return rates.wholeHost ? rates.hostSecond : shape.vcpus * rates.vcpuSecond + (shape.memoryMiB / 1024) * rates.memoryGiBSecond;
}

/**
 * The meter's name for a host job's VM (usage rows' model): its pool and shape, e.g. `test-2vcpu-4096mib`. The meter
 * keeps it with the open session, so a charge made after a restart prices the same shape.
 */
export function hostInstance(pool: HostPool, shape: HostShape) {
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
