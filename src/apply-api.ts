import { createRoute, z } from '@hono/zod-openapi';
import { applyResources } from '../shared/apply.ts';
import { applyScope } from '../shared/apply-scope.ts';
import { transaction, type Db } from './db.ts';
import { HttpError, readJson } from './http.ts';
import * as schema from './api-schemas.ts';
import type { Definitions } from './definitions.ts';
import type { VolumeService } from './volumes.ts';
import type { Context } from 'hono';

export function applyRoutes(route: any, context: {
  applyDb?: Db; definitions?: Definitions; volumes?: VolumeService;
  createAgent: (...args: any[]) => Promise<unknown>;
  rateLimits?: { agentCreate(tenant: string, count: boolean): Promise<unknown> };
}) {
  route(createRoute({ method: 'post', path: '/v1/apply', request: { body: { content: { 'application/json': { schema: z.object({
    volumes: z.record(z.string(), schema.VolumeInput).optional(),
    definitions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    agents: z.record(z.string(), z.record(z.string(), z.unknown())).optional(), dryRun: z.boolean().optional(),
  }).strict() } } } }, responses: { 200: { description: 'Atomic provisioning result or dry-run diff', content: { 'application/json': { schema: z.object({ dryRun: z.boolean(), volumes: z.record(z.string(), z.string()), definitions: z.record(z.string(), z.string()), agents: z.record(z.string(), z.string()), changes: z.array(z.object({resource: z.string(), action: z.enum(['create','update','unchanged'])})) }) } } } } }), async (c: Context<any>) => {
    const { applyDb: db, definitions, volumes } = context;
    if (!db || !definitions || !volumes) throw new HttpError(404, 'Atomic apply is not enabled');
    const input = await readJson(c.req.raw.body, 1024 * 1024, {});
    const tenant = c.var.principal.tenant;
    const result = await transaction(db, async sql => {
      // One tenant's applies serialize, including keys that do not exist yet.
      await sql.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`apply:${tenant}`]);
      const run = () => applyScope.run({ sql }, () => applyResources(input, {
        error: message => new HttpError(400, message),
        async save(kind, key, value) {
          if (kind === 'volumes') {
            const saved = await volumes.create(tenant, { ...value, key });
            return { id: saved.id, action: 'existing' in saved ? 'unchanged' : 'create' };
          }
          if (kind === 'definitions') {
            const parsed = schema.DefinitionInput.safeParse(value);
            if (!parsed.success) throw new HttpError(400, parsed.error.message);
            const previous = await definitions.list(tenant);
            const saved = await definitions.upsert(tenant, key, parsed.data);
            return { id: saved.id, action: !previous.some(item => item.id === saved.id) ? 'create' : saved.revised ? 'update' : 'unchanged' };
          }
          for (const field of Object.keys(value)) if (!Object.hasOwn(schema.AgentInput.shape, field)) throw new HttpError(400, `Unknown agent field: ${field}`);
          const saved = await context.createAgent(tenant, value, key, undefined, (unchanged: boolean) => context.rateLimits?.agentCreate(tenant, !unchanged)) as { id: string; existing?: boolean };
          return { id: saved.id, action: saved.existing ? 'unchanged' : 'create' };
        },
      }));
      // The validation pass uses the real upserts and sees all earlier resources, then is discarded.
      await sql.query('savepoint apply_validation');
      const preview = await run();
      await sql.query('rollback to savepoint apply_validation');
      if (preview.dryRun) return preview;
      return run();
    }, { rerun: false });
    return c.json(result);
  });
}
