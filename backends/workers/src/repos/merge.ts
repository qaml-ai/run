import { RepoError, check, type Entry } from './repo-policy.ts';
import type { RepoContext } from './registry.ts';
import { setRefToVersion, diffEntries, reportUsage, quota, addedBytes } from './write.ts';
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export async function mergeRefs(ctx: RepoContext, input: {
  into: string;
  from: string;
  mode?: 'ff' | 'merge' | 'squash';
  message?: string;
}) {
  const mode = input.mode ?? 'merge';
  check(['ff', 'merge', 'squash'].includes(mode), 'bad_mode');
  const ours = await ctx.stub.resolve(input.into), theirs = await ctx.stub.resolve(input.from), base = await ctx.stub.mergeBase(ours.version, theirs.version);
  const author = `api:${ctx.tenant}`;
  if (mode === 'ff' && base !== ours.version)
    throw new RepoError('not_fast_forward', 409, 'not_fast_forward');
  if (base === theirs.version)
    return { version: ours.version, changed: false };
  if (mode === 'ff' || (mode === 'merge' && base === ours.version)) {
    if (base !== ours.version)
      throw new RepoError('not_fast_forward', 409, 'not_fast_forward');
    return setRefToVersion(ctx, { ref: input.into, version: theirs.version, expect: ours.version, newCommit: false, author, who: author, why: 'merge' });
  }
  const baseTree = base ? (await ctx.stub.commit(base))!.tree : EMPTY_TREE;
  const merged = await ctx.storage.merge(ctx.lineage, { base: baseTree, ours: ours.tree, theirs: theirs.tree, mode });
  if ('conflicts' in merged)
    throw new RepoError('conflicts', 409, 'conflicts', { conflicts: merged.conflicts });
  const parents = mode === 'squash' ? [ours.version] : [ours.version, theirs.version], message = input.message ?? `merge ${input.from}`, trailers = { 'Camel-User': author, 'Camel-Checkpoint': 'api' };
  const changes = await diffEntries(ctx, ours.tree, merged.tree);
  await quota(ctx, await addedBytes(ctx, Object.values(changes).filter((entry): entry is Entry => entry !== null)));
  const c = await ctx.storage.commit(ctx.lineage, { parents, baseTree: merged.tree, changes: [], author, message, trailers });
  const result = await ctx.stub.cas({ ref: input.into, expect: ours.version, commit: { version: c.commit, tree: c.tree, parents, author, message, trailers, at: c.time * 1000 }, changes: { ...changes }, who: author, why: 'merge' });
  await reportUsage(ctx);
  return { ...result, tree: c.tree, changed: true, files: changes };
}
