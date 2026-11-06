import { body } from '../validation.ts';
import { HttpError } from '../errors.ts';
import type { AuthContext } from '../control.ts';
import { ComputerService, type ComputerEnv } from './service.ts';
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
async function agentCall(env: ComputerEnv, tenant: string, agent: string, operation: string, args: Record<string, unknown> = {}, key: string = crypto.randomUUID()) {
  return env.AGENTS.getByName(agent).fetch(new Request('https://computer.internal/__computer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenant, operation, args, key }) }));
}
export async function handleComputerRequest(request: Request, env: ComputerEnv, auth: AuthContext): Promise<Response | null> {
  const path = new URL(request.url).pathname, service = new ComputerService(env, auth.tenantId);
  if (path === '/v1/computers/options' && request.method === 'GET') return json({ managed: service.managedEnabled });
  if (path === '/v1/computers/usage' && request.method === 'GET') return json(await service.usage());
  if (path === '/v1/computers') {
    if (request.method === 'GET') return json(await service.list());
    if (request.method === 'POST') {
      const connection = await service.create(await body(request));
      const refreshed = await agentCall(env, auth.tenantId, connection.agent, 'refresh');
      if (!refreshed.ok) throw new HttpError(503, 'Computer connected; tool refresh is pending');
      return json(connection, 201);
    }
  }
  const remove = /^\/v1\/computers\/([^/]+)$/.exec(path);
  if (remove && request.method === 'DELETE') {
    const c = (await service.list()).find(c => c.id === decodeURIComponent(remove[1]));
    if (!c) throw new HttpError(404, 'Unknown computer connection');
    return agentCall(env, auth.tenantId, c.agent, 'remove');
  }
  const agent = /^\/v1\/agents\/([^/]+)\/computer(?:\/(stop|confirm-cleanup))?$/.exec(path);
  if (agent) {
    const agentId = decodeURIComponent(agent[1]);
    if (!agent[2] && request.method === 'GET') return json(await service.status(agentId));
    if (agent[2] === 'stop' && request.method === 'POST') {
      await service.connection(agentId);
      return agentCall(env, auth.tenantId, agentId, 'computer_stop', {}, request.headers.get('Idempotency-Key') ?? crypto.randomUUID());
    }
    if (agent[2] === 'confirm-cleanup' && request.method === 'POST') {
      const input = await body(request) as Record<string, unknown>;
      if (!input || Object.keys(input).length !== 1 || input.providerCleanupConfirmed !== true) throw new HttpError(400, 'Verify provider cleanup before confirming');
      await service.connection(agentId);
      return agentCall(env, auth.tenantId, agentId, 'confirm-cleanup');
    }
  }
  return null;
}
