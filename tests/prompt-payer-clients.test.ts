import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentClient } from '../clients/typescript.ts';
import { Agent } from '../clients/agents.ts';
import { run } from '../packages/cli/src/ops.ts';

test('TypeScript prompt and submit use tenant authorization for an explicit payer', async () => {
  const calls: { path: string; token: string | null; body: any }[] = [];
  const id = `client_${'a'.repeat(40)}`;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init!.body as string);
    calls.push({ path: new URL(String(url)).pathname, token: new Headers(init?.headers).get('Authorization'), body });
    return Response.json({ id: body.requestId ?? body.id, state: 'completed', outcome: { result: { reply: 'done' } } });
  };
  const client = new AgentClient({ apiKey: 'tenant-test', fetch }, { id, token: 'agent-test', expiresAt: 0 }, { attach: false, connection: 'lazy' });
  const agent = new Agent(client);
  await agent.run('one', { endUser: 'guest', idempotencyKey: 'one' });
  await agent.send('two', { endUser: 'guest', idempotencyKey: 'two' });
  await agent.run('default', { idempotencyKey: 'default' });
  assert.deepEqual(calls.slice(0, 2).map(c => [c.path, c.token, c.body.endUser, c.body.requestId]), [
    [`/v1/agents/${id}/prompt`, 'Bearer tenant-test', 'guest', 'one'],
    [`/v1/agents/${id}/prompt`, 'Bearer tenant-test', 'guest', 'two'],
  ]);
  assert.equal(calls[2].path, `/clients/${id}/requests`);
  assert.equal(calls[2].token, 'Bearer agent-test');
  const tokenOnly = new AgentClient({ fetch }, { id, token: 'agent-test', expiresAt: 0 }, { attach: false, connection: 'lazy' });
  await assert.rejects(tokenOnly.submit('no', { endUser: 'guest' }), /tenant API key/);
  assert.equal(calls.length, 3);
  await client.close();
  await tokenOnly.close();
});

test('CLI sends its explicit payer to the public prompt route', async () => {
  let sent: any;
  const api = { agentId: async () => 'client_test', call: async (method: string, path: string, body: any) => {
    sent = { method, path, body }; return { id: 'request', state: 'running' };
  } } as any;
  await run(api, 'bot', 'brief', { endUser: 'guest', requestId: 'request', wait: 0 });
  assert.deepEqual(sent, { method: 'POST', path: '/v1/agents/client_test/prompt', body: { text: 'brief', requestId: 'request', endUser: 'guest' } });
});
