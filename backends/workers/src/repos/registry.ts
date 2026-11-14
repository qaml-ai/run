import { randomBytes, createHash } from 'node:crypto';
import type { Env } from '../agent.ts';
import { DoRepoClient, type RepoClient } from './client.ts';
import type { RepoDO } from './repo-do.ts';
import { versionEntries } from './reads.ts';
import { camelfsStorage, type CamelfsEnv } from './storage.ts';
import { check, RepoError, repoErrorFrom } from './repo-policy.ts';
export type RepoEnv = Env & CamelfsEnv & {
  REPOS: DurableObjectNamespace<RepoDO>;
};
export async function repoContext(env: RepoEnv, tenant: string, repoId: string) {
  const row = await env.TENANTS.getByName(tenant).repoRow(repoId);
  if (!row || row.deletedAt !== null)
    throw new RepoError('no_repo', 404, 'no_repo');
  const repo: RepoClient = new DoRepoClient(env, tenant, repoId);
  return { env, tenant, repoId, repo, storage: camelfsStorage(env), lineage: row.lineage };
}
export type RepoContext = Awaited<ReturnType<typeof repoContext>>;
export async function createRepo(env: RepoEnv, tenant: string, input: {
  name?: string;
  key?: string;
  /** Who the first commit is attributed to (default `api:<tenant>`). */
  author?: string;
  from?: {
    repo: string;
    ref?: string;
    version?: string;
  };
} = {}) {
  const name = input.name ?? 'repo';
  check(typeof name === 'string' && name.length >= 1 && name.length <= 120, 'bad_name');
  check(input.key === undefined || (typeof input.key === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(input.key)), 'bad_key');
  const id = 'repo_' + (input.key === undefined ? randomBytes(12).toString('hex') : createHash('sha256').update(`repo-key:${tenant}:${input.key}`).digest('hex').slice(0, 24));
  let lineage = `${tenant}:${id}`, seed;
  if (input.from) {
    const src = await repoContext(env, tenant, input.from.repo);
    const v = await src.repo.resolve(input.from.version ?? input.from.ref ?? 'main');
    const metadata = await src.repo.commit(v.version);
    check(metadata);
    seed = { version: metadata, entries: await versionEntries(src, v.tree) };
    lineage = src.lineage;
  }
  const index = env.TENANTS.getByName(tenant);
  const { row, existing } = await index.registerRepo({ id, name, key: input.key ?? null, lineage, createdAt: Date.now(), deletedAt: null, bytes: 0, files: 0 });
  if (row.deletedAt !== null)
    throw new RepoError('deleted_key', 409, 'deleted_key');
  const repo = new DoRepoClient(env, tenant, id);
  if (existing) {
    // Registered earlier; init is idempotent, so only a create that stopped before it falls through.
    try { return { info: await repo.info(), existing }; }
    catch (e) { if (repoErrorFrom(e)?.code !== 'uninitialized') throw e; }
  }
  // Every repo has main from birth: a fork's at the source version, otherwise an empty first commit.
  if (!seed) {
    const author = input.author ?? `api:${tenant}`, message = 'create', trailers = { 'Camel-Checkpoint': 'api', 'Camel-Op': 'api' };
    const c = await camelfsStorage(env).commit(row.lineage, { parents: [], changes: [], author, message, trailers });
    seed = { version: { version: c.commit, tree: c.tree, parents: [], author, message, trailers, at: c.time * 1000 }, entries: [] };
  }
  const info = await repo.init({ tenant, ...row, seed });
  await index.repoUsage(id, info.bytes, info.files);
  return { info, existing };
}
export const agentRepo = (env: RepoEnv, tenant: string, agentId: string) => createRepo(env, tenant, { key: `agent:${agentId}`, name: `agent ${agentId}`, author: `agent:${agentId}` });
export async function deleteRepo(env: RepoEnv, tenant: string, id: string) { const ctx = await repoContext(env, tenant, id); await ctx.repo.delete(); await env.TENANTS.getByName(tenant).markRepoDeleted(id); return { deleted: true }; }
