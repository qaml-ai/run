import { keyServices } from '../security-services.ts';
import { RepoError, check, normalizeRepoPath, type Mode } from './repo-policy.ts';
import { repoContext, type RepoContext } from './registry.ts';
import { statPaths } from './reads.ts';
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
  idempotencyKey?: string;
};
// Awaited (not waitUntil): the next write's quota check reads it, and the tool import graph runs outside cloudflare:workers in tests.
export async function reportUsage(ctx: RepoContext, info: { bytes: number; files: number }) {
  await Promise.resolve(ctx.env.TENANTS.getByName(ctx.tenant).repoUsage(ctx.repoId, info.bytes, info.files))
    .catch(error => console.error('repo usage update failed', String(error)));
}
export async function tierQuota(ctx: RepoContext): Promise<RepoQuota | undefined> {
  const [limitBytes, otherBytes] = await Promise.all([
    keyServices(ctx.env).then(({ accounts }) => accounts.billing.storageLimit(ctx.tenant)),
    ctx.env.TENANTS.getByName(ctx.tenant).reposUsed(ctx.lineage),
  ]);
  return limitBytes === undefined ? undefined : { limitBytes, otherBytes };
}
export async function commitChanges(ctx: RepoContext, input: WriteInput) {
  check(input.changes && typeof input.changes === 'object' && !Array.isArray(input.changes));
  const changes = Object.entries(input.changes);
  check(changes.length <= 1000, 'too_many_paths');
  const inline = new Set<string>();
  let remaining = 8 * 2 ** 20;
  for (const [path, change] of changes) {
    if (change && typeof change === 'object' && 'bytes' in change && change.bytes.byteLength <= remaining) {
      inline.add(path);
      remaining -= change.bytes.byteLength;
    }
  }

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
      }
      else
        prepared[path] = { ...c };
    }
  }));
  const edits: WriteChange[] = [];
  const expectations = new Map(Object.entries(input.pathExpect ?? {}).map(([path, blob]) => [normalizeRepoPath(path), blob]));
  for (const [path, change] of Object.entries(prepared)) {
    edits.push({ path, ...(change ?? { delete: true as const }), expectBlob: expectations.get(path) });
  }
  // The tier checks expectations atomically for each path included in the write.
  for (const path of expectations.keys()) check(path in prepared, 'bad_path');
  const result = await ctx.repo.write({
    ref: input.ref, expect: input.expect, changes: edits, author: input.author, message: input.message,
    time: Math.floor(Date.now() / 1000), trailers: { ...input.trailers, 'Camel-Op': input.op },
    quota: await tierQuota(ctx),
    idempotencyKey: input.idempotencyKey,
  });
  if (result.moved) await reportUsage(ctx, result);
  return { changed: result.moved, version: result.version, tree: result.tree, previous: result.previous, watchers: [] as string[], files: result.changed };
}
export async function setRefToVersion(ctx: RepoContext, input: {
  ref: string;
  version: string;
  expect?: string | null;
  message?: string;
  author: string;
  newCommit: boolean;
  op?: 'restore' | 'turn';
  trailers?: Record<string, string>;
}) {
  const head = await ctx.repo.ref(input.ref), current = head?.version ?? null;
  if (input.expect !== undefined && input.expect !== current)
    throw new RepoError('stale', 412, 'stale', { current });
  const target = await ctx.repo.commit(input.version);
  if (!target)
    throw new RepoError('no_commit', 404, 'no_commit');
  if (!head && !input.newCommit) {
    await ctx.repo.createRef({ name: input.ref, from: { version: target.version } });
    return { version: target.version, tree: target.tree, previous: null, watchers: [] as string[], changed: true };
  }
  const quota = await tierQuota(ctx);
  const restored = input.newCommit
    ? await ctx.repo.restore(input.ref, {
      version: input.version, quota, author: input.author, time: Math.floor(Date.now() / 1000),
      message: input.message ?? `restore ${input.version.slice(0, 12)}`,
      trailers: { ...(input.trailers ?? { 'Camel-User': input.author, 'Camel-Checkpoint': 'api' }), 'Camel-Op': input.op ?? 'restore' },
    })
    : await ctx.repo.cas({ ref: input.ref, expect: head!.version, commit: target.version, quota });
  await reportUsage(ctx, restored);
  return { version: restored.version, tree: restored.tree, previous: current, watchers: [] as string[], changed: current !== restored.version };
}
export async function branch(ctx: RepoContext, input: {
  name: string;
  from: string | {
    version: string;
  };
  owner?: string;
  ttlSeconds?: number;
}) {
  check(input.ttlSeconds === undefined || (Number.isSafeInteger(input.ttlSeconds) && input.ttlSeconds > 0), 'bad_ttl');
  const expiresAt = input.ttlSeconds === undefined ? undefined : Date.now() + input.ttlSeconds * 1000;
  return ctx.repo.createRef({ name: input.name, from: input.from, owner: input.owner, expiresAt });
}
