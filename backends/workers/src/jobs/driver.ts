import type { ContainerComputer } from "../computers/objects.ts";
import type { HostJob, JobHostsEnv } from "./hosts.ts";
import { jobSpec, type JobResult, type JobSpec } from "./job.ts";

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
export type JobDriverEnv = { COMPUTER_CONTAINERS?: DurableObjectNamespace<ContainerComputer> } & Pick<JobHostsEnv, "JOB_HOST_TOKEN" | "HOST_JOBS" | "JOB_HOSTS" | "JOB_HOST_REGISTRY">;

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
    const checked = jobSpec(spec);
    return await this.namespace.getByName(jobObjectName(checked.id)).run(checked) as JobResult;
  }
  async stop(id: string) { return await this.namespace.getByName(jobObjectName(id)).stop() as { stopped: boolean }; }
}

/**
 * This deployment's job driver: our own hosts where they are configured (the host bindings and JOB_HOST_TOKEN: test
 * configs only, until phase 2's pools exist), else Cloudflare Containers, else JOBS_UNAVAILABLE.
 */
export function jobDriver(env: JobDriverEnv): { ok: true; driver: JobDriver } | JobsUnavailable {
  if (env.JOB_HOST_TOKEN && env.HOST_JOBS && env.JOB_HOSTS && env.JOB_HOST_REGISTRY) return { ok: true, driver: new HostsJobDriver(env.HOST_JOBS) };
  if (!env.COMPUTER_CONTAINERS)
    return { ok: false, code: "JOBS_UNAVAILABLE", message: "Jobs need Cloudflare Containers, which this deployment does not have (pilot only in phase 1)." };
  return { ok: true, driver: new CloudflareContainersJobDriver(env.COMPUTER_CONTAINERS) };
}
