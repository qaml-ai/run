import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { serveFakeCamelfsd } from './fake-camelfsd.ts';
import { hookTierServices, tierIdentity } from './tier-env.ts';
const hooks = hookTierServices();
const { TenantRepos } = await import('../src/repos/tenant-repos.ts');
const { commitChanges } = await import('../src/repos/write.ts');
const { createRepo, repoContext } = await import('../src/repos/registry.ts');
hooks.deregister();
export async function fixture(t: import('node:test').TestContext, options?: Parameters<typeof serveFakeCamelfsd>[1]) {
  const databases: DatabaseSync[] = [];
  function state() {
    const db = new DatabaseSync(':memory:');
    databases.push(db);
    const sql = { exec(q: string, ...args: any[]) { const stmt = db.prepare(q); const rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []); return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; }, [Symbol.iterator]: () => rows[Symbol.iterator]() }; } };
    return { storage: { sql, transactionSync(fn: any) {
          db.exec('BEGIN');
          try {
            const v = fn();
            db.exec('COMMIT');
            return v;
          }
          catch (e) {
            db.exec('ROLLBACK');
            throw e;
          }
        }, setAlarm: async () => { }, deleteAlarm: async () => { } } };
  }
  t.after(() => databases.forEach(d => d.close()));
  const index = new TenantRepos(state().storage as never);
  const tenant = {
    registerRepo: index.register.bind(index),
    repoRow: index.row.bind(index),
    listRepos: index.list.bind(index),
    markTierRepoDeleted: index.markTierRepoDeleted.bind(index),
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
