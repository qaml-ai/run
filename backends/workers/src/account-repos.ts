import { repoContext, type RepoContext, type RepoEnv } from './repos/registry.ts';
import { versionEntries } from './repos/reads.ts';
import type { FileEntry } from './repos/storage.ts';
import { HttpError } from './errors.ts';

export async function* liveRepos(env: RepoEnv, tenant: string) {
  let after: string | undefined;
  do {
    const page = await env.TENANTS.getByName(tenant).listRepos({ after, limit: 1000 });
    yield* page.repos;
    after = page.next ?? undefined;
  } while (after);
}

/** Read one immutable main tree, with bounded batches and streamed oversized files. */
export async function* exportRepos(env: RepoEnv, tenant: string): AsyncGenerator<{ name: string; body: string | AsyncIterable<Uint8Array> }> {
  for await (const row of liveRepos(env, tenant)) {
    const ctx = await repoContext(env, tenant, row.id), info = await ctx.repo.info();
    yield { name: `repos/${row.id}/repo.json`, body: JSON.stringify({ name: info.name, key: info.key, refs: info.refs, createdAt: info.createdAt }, null, 2) + '\n' };
    const main = info.refs.find(ref => ref.name === 'main');
    if (!main) throw new HttpError(503, 'Repo main ref unavailable during export');
    yield* exportRepoFiles(ctx, row.id, main);
  }
}

export async function* exportRepoFiles(ctx: RepoContext, id: string, main: {tree: string}) {
  const files = await versionEntries(ctx, main.tree);
  const maxBytes = 64 * 1024 * 1024;
  let batch: FileEntry[] = [], bytes = 0;
  const flush = async function* () {
    const result = await ctx.storage.readBatch(ctx.lineage, main.tree, batch.map(file => file.path), maxBytes);
    const byPath = new Map(result.map(file => [file.path, file]));
    for (const expected of batch) {
      const file = byPath.get(expected.path);
      if (!file || !('bytes' in file) || file.bytes.byteLength !== expected.size) throw new HttpError(503, 'Repo file unavailable during export');
      yield { name: `repos/${id}/main/${file.path}`, body: (async function* () { yield file.bytes; })() };
    }
    batch = []; bytes = 0;
  };
  for (const file of files) {
    if (batch.length && (batch.length === 256 || bytes + file.size > maxBytes)) yield* flush();
    if (file.size > maxBytes) {
      yield { name: `repos/${id}/main/${file.path}`, body: (async function* () {
        const response = await ctx.storage.openBlob(ctx.lineage, file.blob, main.tree, file.path);
        if (!response.ok || !response.body) throw new HttpError(503, 'Repo file unavailable during export');
        let read = 0;
        for await (const chunk of response.body) { read += chunk.byteLength; yield chunk; }
        if (read !== file.size) throw new HttpError(503, 'Repo file size changed during export');
      })() };
    } else { batch.push(file); bytes += file.size; }
  }
  if (batch.length) yield* flush();
}
