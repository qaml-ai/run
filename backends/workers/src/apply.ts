import { applyResources } from '../../../shared/apply.ts';
import { applyScope } from '../../../shared/apply-scope.ts';
import { transaction } from './postgres.ts';
import { Directory, type ControlEnv } from './control.ts';
import { definitionRoutes, provisionDefinition, definitionUpsert } from './definitions.ts';
import { createVolume } from './file-mounts.ts';
import { body } from './validation.ts';
import { ApiError } from './api-contract.ts';
import type { AuthContext } from './control.ts';

export async function apply(request: Request, env: ControlEnv, auth: AuthContext) {
  const input = await body(request, 1024 * 1024);
  const agents = new Map<string, Record<string, unknown>>();
  const result = await transaction(env, async sql => {
    await sql.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`apply:${auth.tenantId}`]);
    const run = () => applyScope.run({ sql }, () => applyResources(input, {
      error: message => new ApiError(400, message),
      async save(kind, key, value) {
        if (kind === 'volumes') {
          const saved = await createVolume(env, auth.tenantId, { ...value, key });
          return { id: saved.id, action: saved.existing ? 'unchanged' : 'create' };
        }
        if (kind === 'definitions') {
          const before = await sql.query('select id,revision from definitions where tenant=$1', [auth.tenantId]);
          const response = await definitionRoutes(new Request(new URL('/v1/definitions', request.url), { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(value) }), env, auth);
          const saved = await response!.json() as { id: string; revision: number };
          const old = before.rows.find(row => row.id === saved.id);
          return { id: saved.id, action: !old ? 'create' : old.revision === saved.revision ? 'unchanged' : 'update' };
        }
        const directory = new Directory(env, auth.tenantId);
        const previous = await directory.get(key);
        const provisioned = await provisionDefinition(env, auth.tenantId, value);
        const config = definitionUpsert(provisioned, previous?.config);
        const saved = await directory.upsert(config, key, new URL(request.url).origin, undefined, true);
        if ('failed' in saved) throw new ApiError(saved.status, saved.error);
        agents.set(key, config);
        return { id: saved.id, action: previous ? 'unchanged' : 'create' };
      },
    }));
    await sql.query('savepoint apply_validation');
    const preview = await run();
    await sql.query('rollback to savepoint apply_validation');
    if (preview.dryRun) return preview;
    return run();
  }, { rerun: false });
  // Durable objects only initialize after the whole manifest commits. A retry finishes any interrupted initialization.
  if (!result.dryRun) for (const [key, value] of agents) {
    const saved = await new Directory(env, auth.tenantId).upsert(value, key, new URL(request.url).origin);
    if ('failed' in saved) throw new ApiError(saved.status, saved.error);
  }
  return Response.json(result);
}
