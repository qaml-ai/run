import type { ContainerComputer } from "../computers/objects.ts";
import type { HostJob, JobHostsEnv } from "./hosts.ts";
import { fitsContainer, jobSpec, type JobResult, type JobSpec } from "./job.ts";

/**
 * The seam every job host sits behind (docs/design/swarm-workflows.md, "Our own job hosts"). Phase 1 has one driver,
 * Cloudflare Containers, and it is pilot-only: the `containers` block and the COMPUTER_CONTAINERS binding exist only in
 * wrangler.pilot.jsonc (and the local computers test config). Elsewhere jobDriver() answers JOBS_UNAVAILABLE.
 *
 * `run` is the whole lifecycle in one call (start, sync, command, collect, optional snapshot, stop): the container's
 * object stops it in a `finally`, so no caller that dies between steps can leave one running.
 */
export interface JobDriver {
  readonly provider: "cloudflare-containers" | "camelrun-hosts";
  /** Run one job to its end. A bad spec throws JobSpecError before any compute starts; every other outcome is a result. */
  run(spec: JobSpec): Promise<JobResult>;
  /** Stop a running job: its run() answers `stopped`, and its container is destroyed. */
  stop(id: string): Promise<{ stopped: boolean }>;
}
export type JobsUnavailable = { ok: false; code: "JOBS_UNAVAILABLE"; message: string };
export type JobDriverEnv = { COMPUTER_CONTAINERS?: DurableObjectNamespace<ContainerComputer>; JOB_PROVIDER?: string } & Pick<JobHostsEnv, "JOB_HOST_ATTESTORS" | "HOST_JOBS" | "JOB_HOSTS" | "JOB_HOST_REGISTRY">;

/** The container object a job runs in: one per job, of the same class (and image) as agents' native computers. */
export const jobObjectName = (id: string) => `job:${id}`;

class CloudflareContainersJobDriver implements JobDriver {
  readonly provider = "cloudflare-containers" as const;
  private namespace: DurableObjectNamespace<ContainerComputer>;
  constructor(namespace: DurableObjectNamespace<ContainerComputer>) {
    this.namespace = namespace;
  }
  async run(spec: JobSpec): Promise<JobResult> {
    const checked = jobSpec(spec);
    return await this.namespace.getByName(jobObjectName(checked.id)).runJob(checked) as JobResult;
  }
  async stop(id: string) {
    return await this.namespace.getByName(jobObjectName(id)).stopJob() as { stopped: boolean };
  }
}

/** Jobs on our own hosts (hosts.ts): one HostJob object per job, which places it on a connected host. */
class HostsJobDriver implements JobDriver {
  readonly provider = "camelrun-hosts" as const;
  private namespace: DurableObjectNamespace<HostJob>;
  constructor(namespace: DurableObjectNamespace<HostJob>) { this.namespace = namespace; }
  async run(spec: JobSpec): Promise<JobResult> {
    // A host takes jobs past a container's limits, up to a build host's (job.ts HOST_JOB_MAX).
    const checked = jobSpec(spec, { beyondContainers: true });
    return await this.namespace.getByName(jobObjectName(checked.id)).run(checked) as JobResult;
  }
  async stop(id: string) { return await this.namespace.getByName(jobObjectName(id)).stop() as { stopped: boolean }; }
}

/**
 * What only Cloudflare Containers do for a job today: start from a saved snapshot, save one, or run an image other than
 * the workspace image. Our hosts have one base image and no snapshots yet (slice 5).
 */
export function needsContainer(spec: Pick<JobSpec, "snapshot" | "saveSnapshot" | "image">) {
  return !!spec.snapshot || !!spec.saveSnapshot || (spec.image !== undefined && spec.image !== "workspace");
}

/**
 * Both, each job to the one that suits it (JOB_PROVIDER=auto): a job that fits a container, or needs one (a snapshot, an
 * image), runs in a Cloudflare container; a larger one on our hosts. A container starts in seconds and is billed only
 * while it runs, so it is the better home for anything it can hold while the host pools scale from zero.
 */
class RoutingJobDriver implements JobDriver {
  readonly provider = "cloudflare-containers" as const;
  private readonly containers: CloudflareContainersJobDriver;
  private readonly hosts: HostsJobDriver;
  constructor(containers: CloudflareContainersJobDriver, hosts: HostsJobDriver) { this.containers = containers; this.hosts = hosts; }
  /** Which driver runs `spec`; a spec neither can take throws the spec error, as a single driver's run would. */
  route(spec: JobSpec): JobDriver {
    const checked = jobSpec(spec, { beyondContainers: true });
    if (needsContainer(checked)) return this.containers;
    return fitsContainer(checked.limits) ? this.containers : this.hosts;
  }
  async run(spec: JobSpec) { return await this.route(spec).run(spec); }
  /** A job's id names its object under either driver; at most one of them has it running. */
  async stop(id: string) {
    const [containers, hosts] = await Promise.all([this.containers.stop(id), this.hosts.stop(id)]);
    return { stopped: containers.stopped || hosts.stopped };
  }
}

export type JobProvider = "containers" | "hosts" | "auto";

/**
 * This deployment's job driver, by JOB_PROVIDER:
 * - "containers": Cloudflare Containers (the COMPUTER_CONTAINERS binding);
 * - "hosts": our own hosts (the host bindings and JOB_HOST_ATTESTORS);
 * - "auto": both, each job to the one that suits it (RoutingJobDriver).
 * Unset: our hosts where they are configured (test configs only, until phase 2's pools exist), else containers. A
 * provider asked for but not configured, or an unknown value, is JOBS_UNAVAILABLE: never a silent fallback.
 */
export function jobDriver(env: JobDriverEnv): { ok: true; driver: JobDriver } | JobsUnavailable {
  const hosts = env.JOB_HOST_ATTESTORS && env.HOST_JOBS && env.JOB_HOSTS && env.JOB_HOST_REGISTRY ? new HostsJobDriver(env.HOST_JOBS) : undefined;
  const containers = env.COMPUTER_CONTAINERS ? new CloudflareContainersJobDriver(env.COMPUTER_CONTAINERS) : undefined;
  const unavailable = (message: string): JobsUnavailable => ({ ok: false, code: "JOBS_UNAVAILABLE", message });
  const mode = env.JOB_PROVIDER || (hosts ? "hosts" : "containers");
  if (mode === "hosts") return hosts ? { ok: true, driver: hosts } : unavailable("Jobs on our own hosts need the job host bindings and JOB_HOST_ATTESTORS.");
  if (mode === "containers")
    return containers ? { ok: true, driver: containers } : unavailable("Jobs need Cloudflare Containers, which this deployment does not have (pilot only in phase 1).");
  if (mode === "auto") {
    if (!hosts || !containers) return unavailable("JOB_PROVIDER=auto needs both Cloudflare Containers and the job host bindings.");
    return { ok: true, driver: new RoutingJobDriver(containers, hosts) };
  }
  return unavailable(`Unknown JOB_PROVIDER ${JSON.stringify(mode).slice(0, 40)}: containers, hosts or auto.`);
}
