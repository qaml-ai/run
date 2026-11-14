import { check } from './repo-policy.ts';
import type { RepoContext } from './registry.ts';
import { reportUsage, tierQuota } from './write.ts';
export async function mergeRefs(ctx: RepoContext, input: {
  into: string;
  from: string;
  mode?: 'ff' | 'merge' | 'squash';
  message?: string;
}) {
  const mode = input.mode ?? 'merge';
  check(['ff', 'merge', 'squash'].includes(mode), 'bad_mode');
  const [ours, theirs, quota] = await Promise.all([ctx.repo.resolve(input.into), ctx.repo.resolve(input.from), tierQuota(ctx)]);
  if (ours.version === theirs.version || await ctx.storage.isAncestor(ctx.lineage, theirs.version, ours.version)) return { version: ours.version, changed: false as const };
  const result = await ctx.repo.merge(input.into, {
    theirs: theirs.version, quota, mode: mode === 'ff' ? 'ff-only' : mode,
    author: ctx.sub, message: input.message ?? `merge ${input.from}`, time: Math.floor(Date.now() / 1000),
    trailers: { 'Camel-User': ctx.sub, 'Camel-Checkpoint': 'api', 'Camel-Op': 'merge' },
  });
  await reportUsage(ctx, result);
  return { version: result.version, tree: result.tree, files: result.merged, previous: ours.version, watchers: [], changed: result.version !== ours.version };
}
