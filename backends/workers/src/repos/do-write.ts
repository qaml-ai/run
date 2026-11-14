import { check, RepoError, repoErrorFrom, normalizeRepoPath, type Entry, type Mode } from "./repo-policy.ts";
import type { RepoContext } from "./registry.ts";
import type { Change } from "./storage.ts";
import { statPaths } from "./reads.ts";
import { quota, addedBytes } from "./write.ts";
import type { RepoWrite, WriteResult } from "./write-input.ts";

export async function doWrite(ctx: RepoContext, input: RepoWrite): Promise<WriteResult> {
  const prepared: Record<string, { blob?: string; size?: number; mode?: Mode } | null> = Object.create(null);
  await Promise.all(input.changes.map(async change => {
    if ("delete" in change) { prepared[change.path] = null; return; }
    const { base64, text, blob, mode } = change;
    prepared[change.path] = base64 !== undefined || text !== undefined
      ? { ...await ctx.storage.putBlob(ctx.lineage, base64 !== undefined ? Buffer.from(base64, "base64") : Buffer.from(text!)), mode }
      : { blob, mode, size: input.legacy?.sizes?.[change.path] };
  }));
  for (let attempt = 0;; attempt++) {
    const head = await ctx.repo.ref(input.ref), current = head?.version ?? null;
    if (input.expect !== undefined && input.expect !== current)
      throw new RepoError('stale', 412, 'stale', { current });
    const named = [...Object.keys(prepared), ...Object.keys(input.legacy?.pathExpect ?? {})];
    const old = head ? await statPaths(ctx, head.tree, named) : Object.create(null) as Record<string, Entry | null>;
    const pathExpect: Record<string, string | 'none'> = Object.create(null);
    for (const [raw, expected] of Object.entries(input.legacy?.pathExpect ?? {})) {
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
    if (!storageChanges.length && !input.legacy?.allowEmpty)
      return { ...await ctx.repo.info(), moved: false, version: current, tree: head?.tree ?? null, previous: current, watchers: [], changed: delta, parents: [], time: input.time };
    await quota(ctx, await addedBytes(ctx, Object.values(delta).filter((entry): entry is Entry => entry !== null)));
    const parents = current ? [current] : [], trailers = input.trailers;
    const c = await ctx.storage.commit(ctx.lineage, { parents, changes: storageChanges, author: input.author, message: input.message, trailers }, input.idempotencyKey);
    const result = await ctx.repo.cas({ ref: input.ref, expect: current, commit: { version: c.commit, tree: c.tree, parents, author: input.author, message: input.message, trailers, at: c.time * 1000 }, changes: { ...delta }, pathExpect: { ...pathExpect }, fence: input.legacy?.fence, who: input.legacy?.who ?? input.author, why: input.legacy?.why ?? "write" }).catch(e => {
      if (repoErrorFrom(e)?.code !== 'stale' || input.expect !== undefined || attempt >= 3)
        throw e;
      return null;
    });
    if (!result) continue;
    const { bytes, files } = await ctx.repo.info();
    return { ...result, tree: c.tree, moved: true, changed: delta, files, bytes, parents, time: c.time };
  }
}
