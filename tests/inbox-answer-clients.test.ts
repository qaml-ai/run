import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRuntime } from '../clients/typescript.ts';

test('TypeScript sends the inbox request key and versions unchanged', async () => {
  const payload = { requestId: 'review-1', answers: [{ id: 'input', version: 3, action: 'accept' as const }] };
  const client = new AgentRuntime({ url: 'https://runtime.test', apiKey: 'fixture', fetch: async (url, init) => {
    assert.equal(new URL(String(url)).pathname, '/v1/inbox/answers');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), payload);
    return Response.json({ outcomes: [{ id: 'input', outcome: 'answered', status: 202 }] });
  } });
  assert.equal((await client.answerInbox(payload.answers, payload.requestId)).outcomes[0].status, 202);
});
