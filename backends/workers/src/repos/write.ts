import { notifyRepoWatchers } from './notify.ts';
import { keyServices } from '../security-services.ts';
import { RepoError, check, normalizeRepoPath, repoErrorFrom, type Entry, type Mode, type Fence, type Version } from './repo-policy.ts';
import { repoContext, type RepoContext } from './registry.ts';
import { versionEntries, statPaths } from './reads.ts';
import { HttpRepoClient, needsK5 } from './http-client.ts';
import type { RepoQuota, WriteChange } from './write-input.ts';
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
export async function reportUsage(ctx: RepoContext, info?: { bytes: number; files: number }) {
  if (!info && ctx.repo instanceof HttpRepoClient) return;
  info ??= await ctx.repo.info();
  await Promise.resolve(ctx.env.TENANTS.getByName(ctx.tenant).repoUsage(ctx.repoId, info.bytes, info.files, ctx.repo instanceof HttpRepoClient))
    .catch(error => console.error('repo usage update failed', String(error)));
}
export async function tierQuota(ctx: RepoContext): Promise<RepoQuota | undefined> {
  const [limitBytes, otherBytes] = await Promise.all([
    keyServices(ctx.env).then(({ accounts }) => accounts.billing.storageLimit(ctx.tenant)),
    ctx.env.TENANTS.getByName(ctx.tenant).reposUsed(ctx.lineage),
  ]);
  return limitBytes === undefined ? undefined : { limitBytes, otherBytes };
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
  check(input.changes && typeof input.changes === 'object' && !Array.isArray(input.changes));
  const changes = Object.entries(input.changes);
  check(changes.length <= 1000, 'too_many_paths');
  const inline = new Set<string>();
  if (ctx.repo instanceof HttpRepoClient) {
    let remaining = 8 * 2 ** 20;
    for (const [path, change] of changes) {
      if (change && typeof change === 'object' && 'bytes' in change && change.bytes.byteLength <= remaining) {
        inline.add(path);
        remaining -= change.bytes.byteLength;
      }
    }
  }
  const sizes: Record<string, number> = Object.create(null);
  const prepared: Record<string, {
    blob?: string;
    base64?: string;
    mode?: Mode;
  } | null> = Object.create(null);
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
        if (inline.has(raw)) prepared[path] = { base64: Buffer.from(c.bytes).toString('base64'), mode: c.mode };
        else {
          const b = await ctx.storage.putBlob(ctx.lineage, c.bytes);
          prepared[path] = { blob: b.blob, mode: c.mode };
          sizes[path] = b.size;
        }
      }
      else if ('from' in c) {
        const src = await repoContext(ctx.env, ctx.tenant, c.from.repo, ctx.sub), v = await src.repo.resolve(c.from.version ?? c.from.ref ?? 'main');
        const sourcePath = normalizeRepoPath(c.from.path);
        const e = (await statPaths(src, v.tree, [sourcePath]))[sourcePath];
        if (!e)
          throw new RepoError('no_file', 404, 'no_file');
        const b = src.lineage === ctx.lineage ? e : await ctx.storage.putBlob(ctx.lineage, await src.storage.readBlob(src.lineage, e.blob, v.tree, sourcePath));
        prepared[path] = { blob: b.blob, mode: e.mode };
        sizes[path] = b.size;
      }
      else
        prepared[path] = { ...c };
    }
  }));
  const edits: WriteChange[] = [];
  const expectations = Object.fromEntries(Object.entries(input.pathExpect ?? {}).map(([path, blob]) => [normalizeRepoPath(path), blob]));
  for (const [path, change] of Object.entries(prepared)) {
    edits.push({ path, ...(change ?? { delete: true as const }), expectBlob: expectations[path] });
  }
  if (ctx.repo instanceof HttpRepoClient) {
    // The tier checks expectations atomically for each path included in the write.
    for (const path of Object.keys(expectations)) check(path in prepared, 'bad_path');
    if (input.fence) throw needsK5();
  }
  const result = await ctx.repo.write({
    ref: input.ref, expect: input.expect, changes: edits, author: input.author, message: input.message,
    time: Math.floor(Date.now() / 1000), trailers: { ...input.trailers, 'Camel-Op': input.op },
    quota: ctx.repo instanceof HttpRepoClient ? await tierQuota(ctx) : undefined,
    idempotencyKey: input.idempotencyKey,
    legacy: { who: input.who, why: input.why, fence: input.fence, allowEmpty: input.allowEmpty, pathExpect: expectations, sizes },
  });
  if (result.moved) {
    await reportUsage(ctx, result);
    await notifyRepoWatchers(ctx, input.ref, result, result.changed, input.author);
  }
  return { changed: result.moved, version: result.version, tree: result.tree, previous: result.previous, watchers: result.watchers, files: result.changed };
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
    if (ctx.repo instanceof HttpRepoClient) {
      if (!head && !input.newCommit) {
        await ctx.repo.createRef({ name: input.ref, from: { version: target.version }, who: input.who, why: input.why });
        return { version: target.version, tree: target.tree, previous: null, watchers: [] as string[], changed: true };
      }
      const quota = await tierQuota(ctx);
      const restored = input.newCommit
        ? await ctx.repo.restore(input.ref, {
          version: input.version, quota, author: input.author, time: Math.floor(Date.now() / 1000),
          message: input.message ?? `restore ${input.version.slice(0, 12)}`,
          trailers: { ...(input.trailers ?? { 'Camel-User': input.author, 'Camel-Checkpoint': 'api' }), 'Camel-Op': input.op ?? 'restore' },
        })
        : await ctx.repo.cas({ ref: input.ref, expect: current, commit: target, quota, who: input.who, why: input.why });
      await reportUsage(ctx, restored);
      return { version: restored.version, tree: restored.tree, previous: current, watchers: [] as string[], changed: current !== restored.version };
    }
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
    if (ctx.repo instanceof HttpRepoClient || repoErrorFrom(e)?.code !== 'not_cached')
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
