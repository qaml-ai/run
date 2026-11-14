import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { registerHooks } from 'node:module';
import { fakeCamelfsd } from './fake-camelfsd.ts';
import { camelfsStorage, StorageError } from '../src/repos/storage.ts';
const hooks = registerHooks({ resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers')
      return { url: 'data:text/javascript,export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} } export const waitUntil=p=>p;', shortCircuit: true };
    if (specifier.endsWith('/security-services.ts'))
      return { url: 'data:text/javascript,export const keyServices=async env=>({accounts:{billing:{storageLimit:async()=>env.limit}}});', shortCircuit: true };
    return next(specifier, context);
  } });
const { RepoDO } = await import('../src/repos/repo-do.ts');
const { TenantRepos } = await import('../src/repos/tenant-repos.ts');
const { commitChanges, setRefToVersion, branch, advanceRef } = await import('../src/repos/write.ts');
const { mergeRefs } = await import('../src/repos/merge.ts');
const { agentRepo, createRepo, repoContext, deleteRepo } = await import('../src/repos/registry.ts');
hooks.deregister();
const bytes = (s: string) => new TextEncoder().encode(s);
const err = (code: string) => (e: any) => { assert.equal(e.code, code); return true; };
export function fixture(t: any) {
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
  const repos = new Map<string, InstanceType<typeof RepoDO>>(), index = new TenantRepos(state().storage as never);
  const tenant = { registerRepo: (r: any) => index.register(r), repoRow: (id: string) => index.row(id), listRepos: (i: any) => index.list(i), markRepoDeleted: (id: string) => index.deleted(id), repoUsage: (id: string, b: number, f: number) => index.usage(id, b, f), reposUsed: () => index.used() };
  const fake = fakeCamelfsd('test-token');
  const env: any = { CAMELFS: { fetch: (input: any, init: any) => fake.fetch(input instanceof Request ? input : new Request(input, init)) }, CAMELFS_API_TOKEN: 'test-token', TENANTS: { getByName: () => tenant }, REPOS: { getByName: (id: string) => {
        if (!repos.has(id))
          repos.set(id, new RepoDO(state() as never, {}));
        return repos.get(id);
      } } };
  const create = async (input = {}) => { const { info } = await createRepo(env, 't', input); return repoContext(env, 't', info.id); };
  const write = (ctx: any, changes: any, extra = {}) => commitChanges(ctx, { ref: 'main', op: 'api', changes, message: 'test', author: 'api:t', who: 'api:t', why: 'test', ...extra });
  return { env, fake, create, write, index };
}
