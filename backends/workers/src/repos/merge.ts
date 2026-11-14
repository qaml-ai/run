import { HttpRepoClient } from "./http-client.ts";
import { RepoError, check, type Entry } from './repo-policy.ts';
import type { RepoContext } from './registry.ts';
import { setRefToVersion, diffEntries, reportUsage, tierQuota, quota, addedBytes } from './write.ts';
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export async function mergeRefs(ctx: RepoContext, input: {
  into: string;
  from: string;
  mode?: 'ff' | 'merge' | 'squash';
  message?: string;
}) {
  const mode = input.mode ?? 'merge';
  check(['ff', 'merge', 'squash'].includes(mode), 'bad_mode');
  if (ctx.repo instanceof HttpRepoClient) {
    const [ours, theirs, quota] = await Promise.all([ctx.repo.resolve(input.into), ctx.repo.resolve(input.from), tierQuota(ctx)]);
    if (ours.version === theirs.version) return { version: ours.version, changed: false };
    const result = await ctx.repo.merge(input.into, {
      theirs: theirs.version, quota, mode: mode === 'ff' ? 'ff-only' : mode,
      author: ctx.sub, message: input.message ?? `merge ${input.from}`, time: Math.floor(Date.now() / 1000),
      trailers: { 'Camel-User': ctx.sub, 'Camel-Checkpoint': 'api', 'Camel-Op': 'merge' },
    });
    await reportUsage(ctx, result);
    return { version: result.version, tree: result.tree, previous: ours.version, watchers: [], changed: result.version !== ours.version };
  }
  const ours = await ctx.repo.resolve(input.into), theirs = await ctx.repo.resolve(input.from), base = await ctx.storage.mergeBase(ctx.lineage, ours.version, theirs.version);
  const author = `api:${ctx.tenant}`;
  if (mode === 'ff' && base?.base !== ours.version)
    throw new RepoError('not_fast_forward', 409, 'not_fast_forward');
  if (base?.base === theirs.version)
    return { version: ours.version, changed: false };
  if (mode === 'ff' || (mode === 'merge' && base?.base === ours.version)) {
    if (base?.base !== ours.version)
      throw new RepoError('not_fast_forward', 409, 'not_fast_forward');
    return setRefToVersion(ctx, { ref: input.into, version: theirs.version, expect: ours.version, newCommit: false, author, who: author, why: 'merge' });
  }
  const baseTree = base?.tree ?? EMPTY_TREE;
  const merged = await ctx.storage.merge(ctx.lineage, { base: baseTree, ours: ours.tree, theirs: theirs.tree, mode });
  if ('conflicts' in merged)
    throw new RepoError('conflicts', 409, 'conflicts', { conflicts: merged.conflicts });
  const parents = mode === 'squash' ? [ours.version] : [ours.version, theirs.version], message = input.message ?? `merge ${input.from}`, trailers = { 'Camel-User': author, 'Camel-Checkpoint': 'api', 'Camel-Op': 'merge' };
  const changes = await diffEntries(ctx, ours.tree, merged.tree);
  await quota(ctx, await addedBytes(ctx, Object.values(changes).filter((entry): entry is Entry => entry !== null)));
  const c = await ctx.storage.commit(ctx.lineage, { parents, baseTree: merged.tree, changes: [], author, message, trailers });
  const result = await ctx.repo.cas({ ref: input.into, expect: ours.version, commit: { version: c.commit, tree: c.tree, parents, author, message, trailers, at: c.time * 1000 }, changes: { ...changes }, who: author, why: 'merge' });
  await reportUsage(ctx);
  return { ...result, tree: c.tree, changed: true, files: changes };
}
