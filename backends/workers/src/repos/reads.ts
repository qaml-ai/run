import type { RepoContext } from './registry.ts';
import { normalizeRepoPath, type Entry } from './repo-policy.ts';
import { StorageError, type ListOptions } from './storage.ts';

export async function versionEntries(ctx: RepoContext, tree: string): Promise<Entry[]> {
  return (await ctx.storage.listAll(ctx.lineage, tree)).filter(e => 'blob' in e) as Entry[];
}

export async function statPaths(ctx: RepoContext, tree: string, paths: string[]): Promise<Record<string, Entry | null>> {
  const names = [...new Set(paths.map(normalizeRepoPath))];
  if (paths.length > 64) {
    const wanted = new Set(names);
    const found = new Map((await versionEntries(ctx, tree)).filter(e => wanted.has(e.path)).map(e => [e.path, e]));
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

export async function listFiles(ctx: RepoContext, tree: string, options: ListOptions) {
  try {
    const page = await ctx.storage.listTree(ctx.lineage, tree, { ...options, recursive: true });
    return { entries: page.entries.filter(e => 'blob' in e) as Entry[], next: page.next ?? null };
  } catch (e) {
    if (e instanceof StorageError && e.code === 'not_in_tree') return { entries: [], next: null };
    throw e;
  }
}
