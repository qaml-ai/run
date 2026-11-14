import { HttpRepoClient } from './http-client.ts';
import type { TierEnv } from '../camelfs/tier.ts';
import { randomBytes, createHash } from 'node:crypto';
import type { Env } from '../agent.ts';
import { repoStorage, requireCamelfs } from '../camelfs/repo-storage.ts';
import { check, RepoError, repoErrorFrom } from './repo-policy.ts';
export type RepoEnv = Env & TierEnv;
export async function repoContext(env: RepoEnv, tenant: string, repoId: string, sub = `api:${tenant}`) {
  const storage = repoStorage(env, sub);
  const row = await env.TENANTS.getByName(tenant).repoRow(repoId);
  if (!row || row.deletedAt !== null)
    throw new RepoError('no_repo', 404, 'no_repo');
  const { lineage } = row;
  const repo = new HttpRepoClient(env, tenant, row, sub, () => env.TENANTS.getByName(tenant).repoRow(repoId));
  return { env, tenant, repoId, repo, storage, lineage, sub };
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
  requireCamelfs(env);
  const name = input.name ?? 'repo';
  check(typeof name === 'string' && name.length >= 1 && name.length <= 120, 'bad_name');
  check(input.key === undefined || (typeof input.key === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(input.key)), 'bad_key');
  const id = 'repo_' + (input.key === undefined ? randomBytes(12).toString('hex') : createHash('sha256').update(`repo-key:${tenant}:${input.key}`).digest('hex').slice(0, 24));
  const sub = input.author ?? `api:${tenant}`;
  let usage = { bytes: 0, files: 0 };
  let lineage = `${tenant}:${id}`, seed: string | undefined;
  if (input.from) {
    const src = await repoContext(env, tenant, input.from.repo, sub);
    const v = await src.repo.resolve(input.from.version ?? input.from.ref ?? 'main');
    seed = v.version;
    lineage = src.lineage;
    const source = await env.TENANTS.getByName(tenant).repoRow(src.repoId);
    if (source) usage = { bytes: source.bytes, files: source.files };
  }
  const index = env.TENANTS.getByName(tenant);
  const { row, existing } = await index.registerRepo({ id, name, key: input.key ?? null, lineage, createdAt: Date.now(), deletedAt: null, ...usage }, input.from?.repo);
  if (row.deletedAt !== null)
    throw new RepoError('deleted_key', 409, 'deleted_key');
  const { repo, storage } = await repoContext(env, tenant, id, sub);
  if (existing) {
    // Registered earlier; init is idempotent, so only a create that stopped before it falls through.
    try { if (await repo.ref("main")) return { info: await repo.info(), existing }; }
    catch (e) {
      const error = repoErrorFrom(e);
      if (error?.status !== 404 || error.code !== 'not_found') throw e;
    }
  }
  // Every repo has main from birth: a fork's at the source version, otherwise an empty first commit.
  if (!seed) {
    const author = input.author ?? `api:${tenant}`, message = 'create', trailers = { 'Camel-Checkpoint': 'api', 'Camel-Op': 'api' };
    await repo.prepareLineage();
    const c = await storage.commit(row.lineage, { parents: [], changes: [], author, message, trailers });
    seed = c.commit;
  }
  const info = await repo.init(seed);
  return { info, existing };
}
export const agentRepo = (env: RepoEnv, tenant: string, agentId: string) => createRepo(env, tenant, { key: `agent:${agentId}`, name: `agent ${agentId}`, author: `agent:${agentId}` });
export async function deleteRepo(env: RepoEnv, tenant: string, id: string) {
  requireCamelfs(env);
  const index = env.TENANTS.getByName(tenant);
  const row = await index.repoRow(id);
  if (!row) throw new RepoError('no_repo', 404, 'no_repo');
  const repo = new HttpRepoClient(env, tenant, row, `api:${tenant}`);
  // A retry after a failed lineage delete resumes from the index tombstone.
  if (row.deletedAt === null) {
    try { await repo.delete(); }
    catch (e) {
      const error = repoErrorFrom(e);
      // A create interrupted before lineage registration leaves only an index row.
      if (error?.status !== 404 || error.code !== 'not_found') throw e;
    }
  }
  if (await index.markTierRepoDeleted(id)) {
    try { await repo.deleteLineage(`delete:${row.lineage}`); }
    catch (e) {
      const error = repoErrorFrom(e);
      if (!((error?.status === 410 && error.code === 'lineage_deleted') ||
            (error?.status === 404 && error.code === 'not_found'))) throw e;
    }
  }
  return { deleted: true };
}
