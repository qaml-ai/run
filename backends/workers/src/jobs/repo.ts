import { needsK5 } from "../repos/http-client.ts";
import { repoContext, type RepoEnv, type RepoContext } from "../repos/registry.ts";
import { RepoError } from "../repos/repo-policy.ts";
import type { JobSpec, JobResult } from "./job.ts";

export const JOB_LEASE_MS = 10 * 60_000;
export type RepoDispatch = { repo: NonNullable<JobSpec["repo"]>; expect: string; tree: string; lineage: string; fence: { holder: string; epoch: number }; result?: Extract<JobResult, { ok: true }>["camelfs"]; finished?: boolean };
type Measure = <T>(name: string, run: () => Promise<T>) => Promise<T>;
const log = (type: string, id: string, error: unknown) => console.error(JSON.stringify({ type, job: id, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) }));

// TEMPORARY(K5): hosts need tier-issued lease fences before they can mount a repo.
export async function prepareRepo(): Promise<never> {
  throw needsK5();
}
export const openJobRepo = (env: unknown, repo: NonNullable<JobSpec["repo"]>) => repoContext(env as RepoEnv, repo.tenant, repo.repo);
export async function renewJobRepo(env: unknown, id: string, saved: RepoDispatch) {
  const ctx = await openJobRepo(env, saved.repo);
  await ctx.repo.renew({ ref: `job/${id}`, ...saved.fence }, JOB_LEASE_MS);
}
export async function releaseJobRepo(env: unknown, id: string, saved: RepoDispatch) {
  try { const ctx = await openJobRepo(env, saved.repo); await ctx.repo.release({ ref: `job/${id}`, ...saved.fence }); }
  catch (error) { log("host_job_lease_release_failed", id, error); }
}
export async function finishJobRepo(ctx: RepoContext, spec: JobSpec, saved: RepoDispatch, result: JobResult, measure: Measure) {
  if (result.ok && spec.commit && result.camelfs?.commit) {
    try {
      // The host's checkpoint commit is the job's result as it is (host authority): never re-committed here. It is
      // marked by the daemon's own trailers (Camel-Checkpoint: job, Camel-Job); Camel-Op on it is the daemon's to add.
      const ref = `job/${spec.id}`;
      const head = await measure("advanceMs", () => ctx.repo.ref(ref));
      if (head?.version !== saved.expect) throw new RepoError("stale", 412, "stale", { current: head?.version ?? null });
      throw needsK5();
    } catch (error) { result.camelfs.checkpointError = (`cas: ${error instanceof Error ? error.message : String(error)}`).slice(0, 300); }
  }
}
