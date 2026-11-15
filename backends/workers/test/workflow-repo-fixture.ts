import { repoSqliteStorage } from './repo-sqlite-storage.ts';
import { serveFakeCamelfsd } from './fake-camelfsd.ts';
import { hookTierServices, tierIdentity } from './tier-env.ts';
const hooks = hookTierServices();
const { TenantRepos } = await import('../src/repos/tenant-repos.ts');
const { commitChanges } = await import('../src/repos/write.ts');
const { createRepo, repoContext } = await import('../src/repos/registry.ts');
hooks.deregister();
export async function fixture(t: import('node:test').TestContext, options?: Parameters<typeof serveFakeCamelfsd>[1]) {
  const index = new TenantRepos(repoSqliteStorage(t).storage as never);
  const tenant = {
    registerRepo: index.register.bind(index),
    repoRow: index.row.bind(index),
    listRepos: index.list.bind(index),
    markTierRepoDeleted: index.markTierRepoDeleted.bind(index),
    lineageDeleted: index.lineageDeleted.bind(index),
    lineageDeleteFailed: index.lineageDeleteFailed.bind(index),
    repoUsage: (id: string, b: number, f: number) => index.usage(id, b, f),
    reposUsed: index.used.bind(index),
  };
  const { issuer, jwks, accounts } = tierIdentity();
  const fake = await serveFakeCamelfsd('unused', { issuer, jwks, ...options });
  t.after(() => fake.close());
  const env: any = { AGENT_PUBLIC_URL: issuer, CAMELFS_URL: fake.url, accounts, TENANTS: { getByName: () => tenant } };
  const create = async (input = {}) => { const { info } = await createRepo(env, 't', input); return repoContext(env, 't', info.id); };
  const write = (ctx: any, changes: any, extra = {}) => commitChanges(ctx, { ref: 'main', op: 'api', changes, message: 'test', author: 'api:t', ...extra });
  return { env, fake, create, write, index };
}
