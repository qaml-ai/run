import { notifyRepoWatchers } from './notify.ts';
import { keyServices } from '../security-services.ts';
import { RepoError, check, normalizeRepoPath, repoErrorFrom, type Entry, type Mode, type Fence, type Version } from './repo-policy.ts';
import { repoContext, type RepoContext } from './registry.ts';
import { versionEntries, statPaths } from './reads.ts';
import type { Change } from './storage.ts';
export type CommitOp = 'api' | 'turn' | 'job' | 'merge' | 'restore';
export type WriteInput = {
  op: CommitOp;
  ref: string;
  expect?: string | null;
  changes: Record<string, {
    bytes: Uint8Array;
    mode?: Mode;
  } | {
    blob: string;
    mode?: Mode;
  } | {
    from: {
      repo: string;
      version?: string;
      ref?: string;
      path: string;
    };
  } | {
    mode: Mode;
  } | null>;
  pathExpect?: Record<string, string | 'none'>;
  message: string;
  author: string;
  trailers?: Record<string, string>;
  who: string;
  why: string;
  fence?: Fence;
  allowEmpty?: boolean;
  idempotencyKey?: string;
};
// Awaited (not waitUntil): the next write's quota check reads it, and the tool import graph runs outside cloudflare:workers in tests.
export async function reportUsage(ctx: RepoContext) {
  const info = await ctx.repo.info();
  await Promise.resolve(ctx.env.TENANTS.getByName(ctx.tenant).repoUsage(ctx.repoId, info.bytes, info.files))
    .catch(error => console.error('repo usage update failed', String(error)));
}
export async function quota(ctx: RepoContext, bytes: number) {
  const { accounts } = await keyServices(ctx.env);
  const limit = await accounts.billing.storageLimit(ctx.tenant);
  if (limit !== undefined && await ctx.env.TENANTS.getByName(ctx.tenant).reposUsed() + bytes > limit)
    throw new RepoError('storage_limit', 507, 'storage_limit', { limit });
}
/** RepoDO accounts for each blob once across all heads. */
export const addedBytes = (ctx: RepoContext, incoming: Entry[]) => ctx.repo.unseenBytes(incoming.map(({ blob, size }) => ({ blob, size })));
export async function commitChanges(ctx: RepoContext, input: WriteInput) {
  const prepared: Record<string, {
    blob?: string;
    size?: number;
    mode?: Mode;
  } | null> = Object.create(null);
  check(input.changes && typeof input.changes === 'object' && !Array.isArray(input.changes));
  const changes = Object.entries(input.changes);
  check(changes.length <= 1000, 'too_many_paths');
  let offset = 0;
  await Promise.all(Array.from({ length: Math.min(8, changes.length) }, async () => {
    while (offset < changes.length) {
      const [raw, c] = changes[offset++], path = normalizeRepoPath(raw);
      check(!(path in prepared), 'bad_path');
      prepared[path] = null;
      if (c === null)
        continue;
      check(c && typeof c === 'object');
      if ('mode' in c && c.mode !== undefined)
        check(['100644', '100755', '120000'].includes(c.mode!), 'bad_mode');
      if ('bytes' in c) {
        const b = await ctx.storage.putBlob(ctx.lineage, c.bytes);
        prepared[path] = { blob: b.blob, size: b.size, mode: c.mode };
      }
      else if ('from' in c) {
        const src = await repoContext(ctx.env, ctx.tenant, c.from.repo), v = await src.repo.resolve(c.from.version ?? c.from.ref ?? 'main');
        const sourcePath = normalizeRepoPath(c.from.path);
        const e = (await statPaths(src, v.tree, [sourcePath]))[sourcePath];
        if (!e)
          throw new RepoError('no_file', 404, 'no_file');
        const b = src.lineage === ctx.lineage ? e : await ctx.storage.putBlob(ctx.lineage, await src.storage.readBlob(src.lineage, e.blob, v.tree, sourcePath));
        prepared[path] = { blob: b.blob, size: b.size, mode: e.mode };
      }
      else
        prepared[path] = { ...c };
    }
  }));
  for (let attempt = 0;; attempt++) {
    const head = await ctx.repo.ref(input.ref), current = head?.version ?? null;
    if (input.expect !== undefined && input.expect !== current)
      throw new RepoError('stale', 412, 'stale', { current });
    const named = [...Object.keys(prepared), ...Object.keys(input.pathExpect ?? {})];
    const old = head ? await statPaths(ctx, head.tree, named) : Object.create(null) as Record<string, Entry | null>;
    const pathExpect: Record<string, string | 'none'> = Object.create(null);
    for (const [raw, expected] of Object.entries(input.pathExpect ?? {})) {
      const path = normalizeRepoPath(raw);
      pathExpect[path] = expected;
      const actual = old[path]?.blob ?? null;
      if (actual !== (expected === 'none' ? null : expected))
        throw new RepoError('stale_path', 412, 'stale_path', { path, current: actual });
    }
    const delta: Record<string, Entry | null> = Object.create(null), storageChanges: Change[] = [];
    for (const [path, c] of Object.entries(prepared)) {
      const prev = old[path];
      let next: Entry | null = null;
      if (c) {
        let blob = c.blob ?? prev?.blob, size = c.size ?? prev?.size;
        if (c.blob && c.size === undefined) {
          const known = await ctx.repo.blobSize(c.blob);
          if (known === null)
            throw new RepoError('unknown_blob', 400, 'unknown_blob');
          size = known;
        }
        if (!blob || size === undefined)
          throw new RepoError('no_file', 404, 'no_file');
        next = { path, blob, size, mode: c.mode ?? prev?.mode ?? '100644' };
        check(['100644', '100755', '120000'].includes(next.mode), 'bad_mode');
      }
      if ((!prev && !next) || (prev && next && prev.blob === next.blob && prev.mode === next.mode))
        continue;
      delta[path] = next;
      storageChanges.push(next ? { path, blob: next.blob, mode: next.mode } : { path, delete: true });
    }
    if (!storageChanges.length && !input.allowEmpty)
      return { changed: false, version: current, tree: head?.tree ?? null, previous: current, watchers: [], files: delta };
    await quota(ctx, await addedBytes(ctx, Object.values(delta).filter((entry): entry is Entry => entry !== null)));
    const parents = current ? [current] : [], trailers = { ...input.trailers, 'Camel-Op': input.op };
    // The daemon replays a key's first answer whatever the body, so the key names the parent too: a retry after a crash
    // (same parent) gets the same commit, and a retry after losing the ref to a concurrent write commits on the new head.
    const key = input.idempotencyKey === undefined ? undefined : `${input.idempotencyKey}@${current ?? 'root'}`;
    const c = await ctx.storage.commit(ctx.lineage, { parents, changes: storageChanges, author: input.author, message: input.message, trailers }, key);
    const result = await ctx.repo.cas({ ref: input.ref, expect: current, commit: { version: c.commit, tree: c.tree, parents, author: input.author, message: input.message, trailers, at: c.time * 1000 }, changes: { ...delta }, pathExpect: { ...pathExpect }, fence: input.fence, who: input.who, why: input.why }).catch(e => {
      if (repoErrorFrom(e)?.code !== 'stale' || input.expect !== undefined || attempt >= 3)
        throw e;
      return null;
    });
    if (!result) continue;
    await reportUsage(ctx);
    await notifyRepoWatchers(ctx, input.ref, result, delta, input.author);
    return { ...result, tree: c.tree, changed: true, files: delta };
  }
}
export async function setRefToVersion(ctx: RepoContext, input: {
  ref: string;
  version: string;
  expect?: string | null;
  parents?: string[];
  message?: string;
  author: string;
  who: string;
  why: string;
  newCommit: boolean;
  op?: 'restore' | 'turn';
  trailers?: Record<string, string>;
}) {
  for (let attempt = 0;; attempt++) {
    const head = await ctx.repo.ref(input.ref), current = head?.version ?? null;
    if (input.expect !== undefined && input.expect !== current)
      throw new RepoError('stale', 412, 'stale', { current });
    const target = await ctx.repo.commit(input.version);
    if (!target)
      throw new RepoError('no_commit', 404, 'no_commit');
    const entries = await versionEntries(ctx, target.tree);
    await quota(ctx, await addedBytes(ctx, entries));
    let commit: Version = target;
    if (input.newCommit) {
      const parents = input.parents ?? (current ? [current] : []), message = input.message ?? `restore ${input.version.slice(0, 12)}`, trailers = { ...(input.trailers ?? { 'Camel-User': input.author, 'Camel-Checkpoint': 'api' }), 'Camel-Op': input.op ?? 'restore' };
      const c = await ctx.storage.commit(ctx.lineage, { parents, baseTree: target.tree, changes: [], author: input.author, message, trailers });
      commit = { version: c.commit, tree: c.tree, parents, author: input.author, message, trailers, at: c.time * 1000 };
    }
    try {
      const result = await ctx.repo.cas({ ref: input.ref, expect: current, commit, entries, who: input.who, why: input.why });
      await reportUsage(ctx);
      if (result.previous !== result.version && result.watchers.length) {
        const changes = head ? await diffEntries(ctx, head.tree, commit.tree) : Object.fromEntries(entries.map(e => [e.path, e]));
        await notifyRepoWatchers(ctx, input.ref, result, changes, input.author);
      }
      return { ...result, tree: commit.tree, changed: result.previous !== result.version };
    }
    catch (e) {
      if (repoErrorFrom(e)?.code !== 'stale' || input.expect !== undefined || attempt >= 3)
        throw e;
    }
  }
}
export async function branch(ctx: RepoContext, input: {
  name: string;
  from: string | {
    version: string;
  };
  owner?: string;
  ttlSeconds?: number;
  why?: string;
  who: string;
}) {
  check(input.ttlSeconds === undefined || (Number.isSafeInteger(input.ttlSeconds) && input.ttlSeconds > 0), 'bad_ttl');
  const expiresAt = input.ttlSeconds === undefined ? undefined : Date.now() + input.ttlSeconds * 1000;
  try {
    const r = await ctx.repo.createRef({ ...input, expiresAt, why: input.why ?? 'branch' });
    await reportUsage(ctx);
    return r;
  }
  catch (e) {
    if (repoErrorFrom(e)?.code !== 'not_cached')
      throw e;
  }
  const target = await ctx.repo.resolve(typeof input.from === 'string' ? input.from : input.from.version), commit = await ctx.repo.commit(target.version);
  check(commit);
  // createRef saw the destination absent; never overwrite a concurrently created ref.
  await ctx.repo.cas({ ref: input.name, expect: null, commit, entries: await versionEntries(ctx, target.tree), owner: input.owner, expiresAt, who: input.who, why: input.why ?? 'branch' });
  await reportUsage(ctx);
  return await ctx.repo.ref(input.name);
}
export async function diffEntries(ctx: RepoContext, from: string, to: string) {
  const diff = await ctx.storage.diff(ctx.lineage, from, to), changes: Record<string, Entry | null> = Object.create(null);
  const wanted = diff.changes.filter(c => c.status !== 'deleted');
  const entries: Entry[] = [];
  if (wanted.length > 1000)
    entries.push(...await versionEntries(ctx, to));
  else
    for (const dir of new Set(wanted.map(c => c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/')) : ''))) {
      let after: string | undefined;
      do {
        const list = await ctx.storage.listTree(ctx.lineage, to, { path: dir || undefined, recursive: false, after });
        entries.push(...list.entries.filter(e => 'blob' in e) as Entry[]);
        after = list.next;
      } while (after);
    }
  const byPath = new Map(entries.map(e => [e.path, e]));
  for (const c of diff.changes) {
    if (c.status === 'deleted')
      changes[c.path] = null;
    else {
      const e = byPath.get(c.path);
      check(e, 'missing_entry');
      changes[c.path] = e;
    }
  }
  return changes;
}
export async function advanceRef(ctx: RepoContext, input: {
  ref: string;
  expect: string;
  commit: string;
  root?: string;
  fence?: Fence;
  who: string;
  why: string;
}) {
  const head = await ctx.repo.ref(input.ref);
  if (head?.version !== input.expect)
    throw new RepoError('stale', 412, 'stale', { current: head?.version ?? null });
  const c = await ctx.storage.getCommit(ctx.lineage, input.commit), changes = await diffEntries(ctx, head.tree, c.tree);
  await quota(ctx, await addedBytes(ctx, Object.values(changes).filter((entry): entry is Entry => entry !== null)));
  const result = await ctx.repo.cas({ ...input, expect: head.version, commit: { version: input.commit, tree: c.tree, parents: c.parents, author: c.author, message: c.message, trailers: c.trailers, at: c.time * 1000 }, changes: { ...changes } });
  await reportUsage(ctx);
  return { ...result, tree: c.tree, changed: true, files: changes };
}
