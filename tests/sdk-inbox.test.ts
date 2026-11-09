import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../clients/typescript.ts';

test('inbox SDK sends filters and cursor and returns the page', async t => {
  const page = { items: [{ id: 'global', inputId: 'local' }], cursor: 'next', counts: { priority: { urgent: 1, high: 0, normal: 0, low: 0 }, lead: { lead: 1 } } };
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, '/v1/inbox');
    assert.deepEqual(Object.fromEntries(url.searchParams), { for: 'sam & alex', subject: 'customer', root: 'lead', priority: 'urgent', kind: 'decision', cursor: 'a+b=', limit: '7' });
    return Response.json(page);
  });
  const client = new AgentRuntime({ url: 'https://runtime.example', apiKey: 'test-key' });
  assert.deepEqual(await client.inbox({ for: 'sam & alex', subject: 'customer', root: 'lead', priority: 'urgent', kind: 'decision', cursor: 'a+b=', limit: 7 }), page);
});
