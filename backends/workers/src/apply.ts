import { applyResources, validateApply } from '../../../shared/apply.ts';
import { applyScope, applyPreparation, ApplyChanged } from '../../../shared/apply-scope.ts';
import { transaction } from './postgres.ts';
import { Directory, type ControlEnv, type DirectoryEntry } from './control.ts';
import { definitionRoutes, provisionDefinition, definitionUpsert, resolveDefinition, definitionId } from './definitions.ts';
import { createRepo, type RepoEnv } from './repos/registry.ts';
import { repoProvision, planRepo } from './repos/provision.ts';
import { reserveAgentCreation } from './agent-capacity.ts';
import { body } from './validation.ts';
import { ApiError } from './api-contract.ts';
import type { AuthContext } from './control.ts';

export async function apply(request: Request, env: ControlEnv, auth: AuthContext) {
  const input = validateApply(await body(request, 1024 * 1024), message => new ApiError(400, message));
  const agents = new Map<string, DirectoryEntry>();
  const repos = new Map<string, {key:string;name:string;row:import('./repos/tenant-repos.ts').RepoRow}>();
  const directory = new Directory(env, auth.tenantId);
  const preparation = { values: new Map<string, Promise<unknown>>(), locked: false };
  const origin = new URL(request.url).origin;
  return repoProvision.run(repos,()=>applyPreparation.run(preparation, async () => {
    const execute = (preview: boolean) => transaction(env, async sql => {
      if (!preview) {
        await sql.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`apply:${auth.tenantId}`]);
        preparation.locked = true;
      }
      agents.clear();
      repos.clear();
      const run = () => applyScope.run({ sql }, () => applyResources(input, {
        error: message => new ApiError(400, message),
        async save(kind, key, value) {
          if (kind === 'volumes') {
            // The shared apply envelope keeps its volumes field; Worker mounts receive repo ids.
            const saved = await planRepo(env as RepoEnv,auth.tenantId,key,value.name as string|undefined);
            return { id: saved.row.id, action: saved.existing ? 'unchanged' : 'create' };
          }
          if (kind === 'definitions') {
            const old = await resolveDefinition(env, auth.tenantId, await definitionId(auth.tenantId, key)).catch(error => { if (error.status === 404) return undefined; throw error; });
            const response = await definitionRoutes(new Request(new URL('/v1/definitions', request.url), { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(value) }), env, auth);
            const saved = await response!.json() as { id: string; revision: number };
            return { id: saved.id, action: !old ? 'create' : old.revision === saved.revision ? 'unchanged' : 'update' };
          }
          const previous = await directory.get(key);
          const provisioned = await provisionDefinition(env, auth.tenantId, value);
          const config = definitionUpsert(provisioned, previous?.config);
          const saved = await directory.upsert(config, key, origin, undefined, true);
          if ('failed' in saved) throw new ApiError(saved.status, saved.error);
          agents.set(key, saved);
          return { id: saved.id, action: previous ? 'unchanged' : 'create' };
        },
      }));
      if (!preview) return run();
      await sql.query('savepoint apply_validation');
      const plan = await run();
      await sql.query('rollback to savepoint apply_validation');
      return plan;
    }, { rerun: false });
    // A concurrent apply can change the inputs to preparation. Retry outside the lock.
    for (let attempt = 0; ; attempt++) {
      preparation.locked = false;
      const preview = await execute(true);
      if (preview.dryRun) return Response.json(preview);
      const releases: (() => Promise<void>)[] = [];
      try {
        for (const entry of agents.values()) if (!entry.initialized && entry.config.type !== 'run')
          releases.push(await reserveAgentCreation(env as import('./agent.ts').Env, auth.tenantId, entry.id));
        const result = await execute(false);
        // Initialize committed records only. Existing initialized agents receive no configuration call.
        for (const repo of repos.values()) await createRepo(env as RepoEnv,auth.tenantId,{key:repo.key,name:repo.name});
        for (const entry of agents.values()) for(const mount of entry.config.mounts??[]) if(mount.repo&&mount.notify) await env.REPOS.getByName(`${auth.tenantId}:${mount.repo}`).watch(mount.ref??'main',entry.id);
        for (const entry of agents.values()) {
          const saved = await directory.initializeCommitted(entry, origin);
          if ('failed' in saved) throw new ApiError(saved.status, saved.error);
        }
        return Response.json(result);
      } catch (error) {
        if (!(error instanceof ApplyChanged)) throw error;
        if (attempt >= 2) throw new ApiError(409, error.message);
      } finally {
        await Promise.all(releases.map(release => release()));
      }
    }
  }));
}
