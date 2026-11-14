import type { HostJob } from "./hosts.ts";
import { jobSpec, type JobResult, type JobSpec } from "./job.ts";

/** A host job's Durable Object name. */
export const jobObjectName = (id: string) => `job:${id}`;

/** Jobs on our own hosts (hosts.ts): one HostJob object per job, which places it on a connected host. */
export class HostsJobDriver {
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
