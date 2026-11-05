import { ApiError } from './api-contract.ts';
import { withSql } from './postgres.ts';
import type { ControlEnv, Directory, DirectoryEntry } from './control.ts';

/** List filtering uses directory state; live state comes from each agent's owner. */
export async function listAgents(request: Request, env: ControlEnv, tenant: string, directory: Directory, summary: (entry: DirectoryEntry) => Record<string, unknown>) {
  const query = new URL(request.url).searchParams;
  const limit = query.has('limit') ? Number(query.get('limit')) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) throw new ApiError(400, 'limit must be an integer from 1 to 200');
  const cursor = query.get('cursor');
  if (cursor && !/^client_[a-f0-9]{40}$/.test(cursor)) throw new ApiError(400, 'Invalid cursor');
  const status = query.get('status');
  if (status && !['running', 'failed', 'expiring'].includes(status)) throw new ApiError(400, 'Invalid status');
  const subAgents = query.get('subAgents');
  if (subAgents && !['only', 'exclude', 'include'].includes(subAgents)) throw new ApiError(400, 'Invalid subAgents');
  const search = query.get('q') ?? '';
  if (search.length > 200) throw new ApiError(400, 'q must be at most 200 characters');
  const { rows } = await withSql(env, sql => sql.query(`select a.id, a.last_active_at, a.last_error_at, a.last_error_class, w.workspace as workspace_id
    from agents a left join lateral (select workspace from workspace_assignments where tenant=a.tenant and kind='agent' and resource=a.id order by assigned_at desc, sequence desc limit 1) w on true where a.tenant=$1`, [tenant]));
  const metadata = new Map(rows.map(row => [row.id, row]));
  const list: Record<string, unknown>[] = [];
  for (const entry of await directory.list()) {
    if (entry.config.type === 'run' || (cursor && entry.id <= cursor)) continue;
    const child = !!entry.parentAgentId || entry.config.type === 'subagent';
    if (subAgents === 'only' ? !child : subAgents !== 'include' && child) continue;
    const row = metadata.get(entry.id), workspaceId = row?.workspace_id ?? null;
    const workspace = query.get('workspaceId');
    if (workspace && (workspace === 'unassigned' ? workspaceId !== null : workspaceId !== workspace)) continue;
    if (search && !`${entry.id} ${entry.config.name ?? ''}`.toLowerCase().includes(search.toLowerCase())) continue;
    const stateResponse = await env.AGENTS.getByName(entry.id).fetch(new Request('https://agent/state'));
    if (!stateResponse.ok) continue;
    const state = await stateResponse.json() as { running: boolean; connected?: boolean };
    const lastError = row?.last_error_class ? { at: Number(row.last_error_at), class: row.last_error_class } : null;
    if (status === 'running' && !state.running || status === 'failed' && !lastError || status === 'expiring' && entry.expiresAt === null) continue;
    list.push({ ...summary(entry), ...state, workspaceId, lastActiveAt: row?.last_active_at == null ? null : Number(row.last_active_at), lastError });
    if (limit && list.length > limit) break;
  }
  const next = limit && list.length > limit ? String(list[limit - 1].id) : undefined;
  return Response.json(limit ? list.slice(0, limit) : list, { headers: { 'cache-control': 'no-store', ...(next ? { 'x-next-cursor': next } : {}) } });
}
