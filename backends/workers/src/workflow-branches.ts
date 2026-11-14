import { repoContext, type RepoEnv } from './repos/registry.ts';
import { branch } from './repos/write.ts';
import { RepoError, repoErrorFrom } from './repos/repo-policy.ts';
import { createHash } from 'node:crypto';
import type { RepoAt } from './repos/target.ts';
export { repoAt, type RepoAt } from './repos/target.ts';

export type WorkflowFork = { repo: string; ref: string; base: { ref?: string; version: string } };
export async function childBranch(env: RepoEnv, tenant: string, storage: Pick<DurableObjectStorage, 'put' | 'get'>, effect: { workflow: string; key: string; attempt: number }, at: RepoAt, cached?: string): Promise<WorkflowFork> {
  const ctx = await repoContext(env, tenant, at.repo);
  // The workflow id is in the hash: two workflows with the same effect key on one repo get different branches.
  const name = `fork/${createHash('sha256').update(`${effect.workflow}\0${effect.key}`).digest('hex').slice(0, 16)}-${effect.attempt}`;
  await storage.put(`workflow-repo:${at.repo}`, true);
  const row = `workflow-base:${at.repo}:${name}`;
  let base = await storage.get<{ version: string }>(row);
  if (!base) {
    base = await ctx.repo.resolve(at.ref ?? at.version ?? 'main');
    await storage.put(row, { version: base.version });
  }
  const existing = await ctx.repo.ref(name);
  if (existing && existing.owner !== `workflow:${effect.workflow}`) throw new RepoError('workflow branch belongs to another owner', 409, 'exists');
  if (!existing) {
    try { await branch(ctx, { name, from: { version: cached ?? base.version }, owner: `workflow:${effect.workflow}`, who: `workflow:${effect.workflow}`, why: 'workflow child' }); }
    catch (error) {
      if (repoErrorFrom(error)?.code !== 'exists') throw error;
      if ((await ctx.repo.ref(name))?.owner !== `workflow:${effect.workflow}`) throw error;
    }
  }
  return { repo: at.repo, ref: name, base: { ...(at.version === undefined ? { ref: at.ref ?? 'main' } : {}), version: base.version } };
}
