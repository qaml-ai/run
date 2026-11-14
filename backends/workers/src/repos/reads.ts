import type { RepoTreeCache } from './tree-cache.ts';
import type { RepoContext } from './registry.ts';
import { normalizeRepoPath, type Entry } from './repo-policy.ts';
import { StorageError, type ListOptions } from './storage.ts';

export async function versionEntries(ctx: RepoContext, tree: string, cache?: RepoTreeCache): Promise<Entry[]> {
  const cached = cache?.entries(tree);
  if (cached) return cached;
  const entries = (await ctx.storage.listAll(ctx.lineage, tree)).filter(e => 'blob' in e) as Entry[];
  cache?.fill(tree, entries);
  return entries;
}

export async function statPaths(ctx: RepoContext, tree: string, paths: string[], cache?: RepoTreeCache): Promise<Record<string, Entry | null>> {
  const names = [...new Set(paths.map(normalizeRepoPath))];
  const cached = cache?.stat(tree, names);
  if (cached) return cached;
  if (paths.length > 64) {
    const wanted = new Set(names);
    const found = new Map((await versionEntries(ctx, tree, cache)).filter(e => wanted.has(e.path)).map(e => [e.path, e]));
    return Object.fromEntries(names.map(path => [path, found.get(path) ?? null]));
  }
  const entries: Record<string, Entry | null> = Object.create(null);
  let offset = 0;
  await Promise.all(Array.from({ length: Math.min(8, names.length) }, async () => {
    while (offset < names.length) {
      const path = names[offset++];
      const e = await ctx.storage.entry(ctx.lineage, tree, path);
      entries[path] = e?.blob !== undefined ? e as Entry : null;
    }
  }));
  return entries;
}

export async function listFiles(ctx: RepoContext, tree: string, options: ListOptions, cache?: RepoTreeCache) {
  const cached = cache?.list(tree, options);
  if (cached) return cached;
  try {
    const page = await ctx.storage.listTree(ctx.lineage, tree, { ...options, recursive: true });
    return { entries: page.entries.filter(e => 'blob' in e) as Entry[], next: page.next ?? null };
  } catch (e) {
    if (e instanceof StorageError && e.code === 'not_in_tree') return { entries: [], next: null };
    throw e;
  }
}
