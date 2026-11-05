import { withSql, type PostgresEnv } from './postgres.ts';
import { ApiError } from './api-contract.ts';
import type { DirectoryEntry } from './control.ts';

/** Source list predicates, with DO-owned activity replacing the Node owner join. */
export async function listAgentEntries(env: PostgresEnv, tenant: string, query: URLSearchParams, id?: string) {
  const limit = query.has('limit') ? Number(query.get('limit')) : undefined;
  const status = query.get('status'), subAgents = query.get('subAgents'), search = query.get('q');
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200) ||
      status && !['running', 'failed', 'expiring'].includes(status) ||
      subAgents && !['only', 'exclude'].includes(subAgents) || (search?.length ?? 0) > 200)
    throw new ApiError(400, 'Invalid agent list query', 'INVALID_REQUEST');
  const params: unknown[] = [tenant, Date.now()];
  const where = ["a.tenant=$1", "not a.revoked", "(a.expires_at is null or a.expires_at>$2)", "a.type<>'run'"];
  const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
  if (id) where.push(`a.id=${bind(id)}`);
  const cursor = query.get('cursor');
  if (cursor !== null) {
    const decoded = Buffer.from(cursor, 'base64url').toString();
    if (!decoded || decoded.length > 200 || Buffer.from(decoded).toString('base64url') !== cursor)
      throw new ApiError(400, "cursor must be a previous page's next", 'INVALID_REQUEST');
    where.push(`a.id>${bind(decoded)}`);
  }
  const workspace = query.get('workspaceId');
  if (workspace === 'unassigned') where.push('w.workspace is null');
  else if (workspace !== null) where.push(`w.workspace=${bind(workspace)}`);
  if (status === 'failed') where.push(`a.last_error_at>${bind(Date.now() - 86400_000)}`);
  if (status === 'expiring') where.push('a.expires_at is not null');
  if (subAgents) where.push(`a.header->>'parentAgentId' is ${subAgents === 'only' ? 'not ' : ''}null`);
  if (search?.trim()) {
    const pattern = bind(`%${search.trim().replace(/[\\%_]/g, value => `\\${value}`)}%`);
    where.push(`(a.name ilike ${pattern} or a.header->>'key' ilike ${pattern} or a.id ilike ${pattern})`);
  }
  const rows = (await withSql(env, sql => sql.query(`select a.header, a.last_active_at, a.last_error_at, a.last_error_class, w.workspace
    from agents a left join lateral (select workspace from workspace_assignments wa where wa.tenant=a.tenant and wa.kind='agent' and wa.resource=a.id order by wa.assigned_at desc,wa.sequence desc limit 1) w on true
    where ${where.join(' and ')} order by a.id${limit === undefined ? '' : ` limit ${limit + 1}`}`, params))).rows;
  const more = limit !== undefined && rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  return { entries: page.map(row => ({ ...(row.header as DirectoryEntry), workspaceId: row.workspace ?? null,
    lastActiveAt: row.last_active_at === null ? null : Number(row.last_active_at),
    lastError: row.last_error_at === null ? null : { at: Number(row.last_error_at), class: row.last_error_class as string } })),
    next: more ? Buffer.from(page.at(-1)!.header.id).toString('base64url') : undefined, status };
}

export async function recordAgentActivity(env: PostgresEnv, agent: string, at: number, failure?: string) {
  await withSql(env, sql => sql.query(failure
    ? 'update agents set last_active_at=greatest(coalesce(last_active_at,0),$2),last_error_at=greatest(coalesce(last_error_at,0),$2),last_error_class=case when coalesce(last_error_at,0)<=$2 then $3 else last_error_class end where id=$1'
    : 'update agents set last_active_at=greatest(coalesce(last_active_at,0),$2) where id=$1', failure ? [agent,at,failure] : [agent,at]));
}
