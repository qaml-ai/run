import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ComputersPage } from '../web/pages/computers';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it.each(['daytona', 'sprites'])('connects %s without displaying its secret and shows session state and workspace usage', async provider => {
  const label = provider === 'sprites' ? 'API token' : 'API key';
  const writes: any[] = [];
  let connections: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== 'GET') writes.push({ path, method, body });
    if (path === '/v1/computers' && method === 'POST') connections = [{ id: 'cmp_one', agent: 'agent_one', provider: body.provider, leaseSeconds: 900, dailySeconds: 3600, session: { state: 'active', expiresAt: 1792713000000 } }];
    const result = path === '/v1/computers' ? connections : path === '/v1/agents' ? [{ id:'agent_one', name:'Researcher' }]
      : path === '/v1/workspaces' ? [{ id:'ws_one', name:'Research' }] : [{ workspace:'ws_one', provider, sessions:1, seconds:30 }];
    return new Response(JSON.stringify(result), { headers: { 'Content-Type':'application/json' } });
  }));
  render(<ComputersPage />);
  await screen.findByRole('option', { name:'Researcher' });
  fireEvent.change(screen.getByLabelText('Agent'), { target:{ value:'agent_one' } });
  fireEvent.change(screen.getByLabelText('Provider'), { target:{ value:provider } });
  fireEvent.change(screen.getByLabelText(label), { target:{ value:'secret-for-test' } });
  fireEvent.click(screen.getByRole('button', { name:'Connect computer' }));
  await screen.findByText(/active · expires/);
  expect(screen.getByText(`Research · ${provider} · 1 sessions · 30 seconds`)).toBeTruthy();
  await waitFor(() => expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe(''));
  expect(writes[0].body).toEqual({ agent:'agent_one', provider, credentials:{ apiKey:'secret-for-test' }, leaseSeconds:900, dailySeconds:3600 });
  fireEvent.click(screen.getByRole('button', { name:'Stop session' }));
  await waitFor(() => expect(writes[1].path).toBe('/v1/agents/agent_one/computer/stop'));
});
