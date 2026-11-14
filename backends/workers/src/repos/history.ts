import type { RepoContext } from './registry.ts';
import { RepoError, check, normalizeRepoPath, page, refName } from './repo-policy.ts';
import { StorageError, type CommitInfo } from './storage.ts';

const WALK_LIMIT = 10_000;

export async function repoHistory(ctx: RepoContext, input: { ref: string; after?: string; limit?: number; path?: string }) {
  refName(input.ref);
  const limit = page(input.limit, 50, 500);
  const path = input.path ? normalizeRepoPath(input.path.replace(/\/$/, '')) : undefined;
  const head = await ctx.repo.ref(input.ref);
  if (!head) throw new RepoError('no_ref', 404, 'no_ref');

  const { storage, lineage } = ctx;
  let version: string | undefined = head.version;
  if (input.after !== undefined) {
    const after = input.after;
    check(/^[0-9a-f]{40}$/.test(after), 'bad_cursor');
    const reachable = await storage.isAncestor(lineage, after, head.version).catch(e => {
      if (e instanceof StorageError && e.status === 404 && e.code === 'not_found') return false;
      throw e;
    });
    check(reachable, 'bad_cursor');
    version = (await storage.getCommit(lineage, after)).parents[0];
  }

  const versions: (Omit<CommitInfo, 'tree'> & { version: string })[] = [];
  let commit: CommitInfo | undefined, last: string | null = null;
  for (let walked = 0; version && walked < WALK_LIMIT && versions.length < limit; walked++) {
    const { tree, parents, author, message, trailers, time }: CommitInfo = commit ?? await storage.getCommit(lineage, version);
    const parent: string | undefined = parents[0];
    commit = path && parent ? await storage.getCommit(lineage, parent) : undefined;
    if (!path || (commit ? (await storage.diff(lineage, commit.tree, tree, path)).changes.length : await storage.entry(lineage, tree, path))) {
      versions.push({ version, parents, author, message, trailers, time });
    }
    last = version;
    version = parent;
  }
  return { versions, next: version ? last : null };
}
