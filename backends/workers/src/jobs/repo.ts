import { HttpRepoClient, needsK5 } from "../repos/http-client.ts";
import { repoContext, type RepoEnv, type RepoContext } from "../repos/registry.ts";
import { branch, advanceRef } from "../repos/write.ts";
import type { JobSpec, JobResult } from "./job.ts";

export const JOB_LEASE_MS = 10 * 60_000;
export type RepoDispatch = { repo: NonNullable<JobSpec["repo"]>; expect: string; tree: string; lineage: string; fence: { holder: string; epoch: number }; result?: Extract<JobResult, { ok: true }>["camelfs"]; finished?: boolean };
type Measure = <T>(name: string, run: () => Promise<T>) => Promise<T>;
const log = (type: string, id: string, error: unknown) => console.error(JSON.stringify({ type, job: id, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) }));

export async function prepareRepo(ctx: RepoContext, spec: JobSpec, host: string, measure: Measure): Promise<RepoDispatch> {
  if (ctx.repo instanceof HttpRepoClient) throw needsK5();
  const repo = spec.repo!, ref = `job/${spec.id}`;
  const target = await measure("resolveMs", async () => await ctx.repo.resolve(repo.ref ?? repo.version ?? "main"));
  const head = await measure("branchMs", async () => await ctx.repo.ref(ref) ?? await branch(ctx, { name: ref, from: { version: target.version }, owner: repo.owner, who: `job:${spec.id}` }));
  if (!head) throw new Error("Job branch was not created");
  const holder = `host:${host}/${spec.id}`;
  const lease = await measure("leaseMs", () => ctx.repo.acquire({ ref, holder, ttlMs: JOB_LEASE_MS }));
  return { repo, expect: head.version, tree: head.tree, lineage: ctx.lineage, fence: { holder, epoch: lease.epoch } };
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
      const advanced = await measure("advanceMs", () => advanceRef(ctx, { ref: `job/${spec.id}`, expect: saved.expect, commit: result.camelfs!.commit!, root: result.camelfs!.root, fence: saved.fence, who: `job:${spec.id}`, why: "job checkpoint" }));
      const version = advanced.version;
      result.camelfs.ref = `job/${spec.id}`;
      result.camelfs.version = result.camelfs.commit = version;
    } catch (error) { result.camelfs.checkpointError = (`cas: ${error instanceof Error ? error.message : String(error)}`).slice(0, 300); }
  }
}
