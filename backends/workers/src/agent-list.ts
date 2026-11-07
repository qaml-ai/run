import { ApiError } from './api-contract.ts';
import { withSql } from './postgres.ts';
import type { ControlEnv, Directory, DirectoryEntry } from './control.ts';

/** List filtering uses directory state; live state comes from each agent's owner. */
export async function listAgents(request: Request, env: ControlEnv, tenant: string, directory: Directory, summary: (entry: DirectoryEntry) => Record<string, unknown>) {
  const query = new URL(request.url).searchParams;
  const limit = query.has('limit') ? Number(query.get('limit')) : undefined;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) throw new ApiError(400, 'limit must be an integer from 1 to 200');
  const rawCursor = query.get('cursor');
  let cursor: string | undefined;
  if (rawCursor !== null) {
    cursor = Buffer.from(rawCursor, 'base64url').toString();
    if (!cursor || cursor.length > 200 || Buffer.from(cursor).toString('base64url') !== rawCursor) throw new ApiError(400, 'Invalid cursor');
  }
  const status = query.get('status');
  if (status && !['running', 'failed', 'expiring'].includes(status)) throw new ApiError(400, 'Invalid status');
  const subAgents = query.get('subAgents');
  if (subAgents && !['only', 'exclude'].includes(subAgents)) throw new ApiError(400, 'Invalid subAgents');
  const search = query.get('q') ?? '';
  if (search.length > 200) throw new ApiError(400, 'q must be at most 200 characters');
  const { rows } = await withSql(env, sql => sql.query(`select a.id, a.last_active_at, a.last_error_at, a.last_error_class, w.workspace as workspace_id
    from agents a left join lateral (select workspace from workspace_assignments where tenant=a.tenant and kind='agent' and resource=a.id order by assigned_at desc, sequence desc limit 1) w on true where a.tenant=$1`, [tenant]));
  const metadata = new Map(rows.map(row => [row.id, row]));
  const list: Record<string, unknown>[] = [];
  const workspace = query.get('workspaceId');
  const candidates = (await directory.list()).filter(entry => {
    if (entry.config.type === 'run' || (cursor && entry.id <= cursor)) return false;
    const child = !!entry.parentAgentId || entry.config.type === 'subagent';
    if (subAgents === 'only' && !child || subAgents === 'exclude' && child) return false;
    const workspaceId = metadata.get(entry.id)?.workspace_id ?? null;
    if (workspace && (workspace === 'unassigned' ? workspaceId !== null : workspaceId !== workspace)) return false;
    return !search || `${entry.id} ${entry.key ?? ''} ${entry.config.name ?? ''}`.toLowerCase().includes(search.trim().toLowerCase());
  });
  for await (const { entry, state } of liveStates(candidates, id => env.AGENTS.getByName(id).fetch(new Request('https://agent/state')))) {
    if (!state) continue;
    const row = metadata.get(entry.id), workspaceId = row?.workspace_id ?? null;
    const lastError = row?.last_error_class ? { at: Number(row.last_error_at), class: row.last_error_class } : null;
    if (status === 'running' && !state.running || status === 'failed' && (!lastError || lastError.at <= Date.now() - 86400_000) || status === 'expiring' && entry.expiresAt === null) continue;
    const { id, key, name, type, model, configHash, expiresAt, resume, parentAgentId } = summary(entry);
    list.push({ id, key, name, type, model, configHash, expiresAt, resume, ...(parentAgentId ? { parentAgentId } : {}), running: state.running, connected: state.connected ?? false, workspaceId, lastActiveAt: row?.last_active_at == null ? null : Number(row.last_active_at), lastError });
    if (limit && list.length > limit) break;
  }
  const next = limit && list.length > limit ? Buffer.from(String(list[limit - 1].id)).toString('base64url') : undefined;
  return Response.json(limit ? list.slice(0, limit) : list, { headers: { 'cache-control': 'no-store', ...(next ? { 'x-next-cursor': next } : {}) } });
}

type LiveState = { running: boolean; connected?: boolean };

/**
 * Each entry with its agent's live state, in order, fetched `width` at a time (one by one, listing a tenant's 48 agents
 * took 6 s on the pilot). An agent whose state cannot be read (an error answer, or a fetch that throws, as one did
 * under load and failed the whole list) has state null, as an error answer always did: the list leaves it out.
 */
export async function* liveStates<T extends { id: string }>(entries: T[], fetchState: (id: string) => Promise<Response>, width = 16): AsyncGenerator<{ entry: T; state: LiveState | null }> {
  for (let start = 0; start < entries.length; start += width) {
    const chunk = entries.slice(start, start + width);
    const states = await Promise.all(chunk.map(async entry => {
      try {
        const response = await fetchState(entry.id);
        return response.ok ? await response.json() as LiveState : null;
      } catch { return null; }
    }));
    for (let index = 0; index < chunk.length; index++) yield { entry: chunk[index], state: states[index] };
  }
}
