import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from '../clients/typescript.ts';

test('inbox SDK sends filters and cursor and returns the page', async t => {
  const page = { items: [{ id: 'local', inputId: 'local' }], cursor: 'next', counts: { priority: { urgent: 1, high: 0, normal: 0, low: 0 }, lead: { lead: 1 } } };
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, '/v1/inbox');
    assert.deepEqual(Object.fromEntries(url.searchParams), { for: 'sam & alex', subject: 'customer', root: 'lead', priority: 'urgent', kind: 'decision', cursor: 'a+b=', limit: '7' });
    return Response.json(page);
  });
  const client = new AgentRuntime({ url: 'https://runtime.example', apiKey: 'test-key' });
  assert.deepEqual(await client.inbox({ for: 'sam & alex', subject: 'customer', root: 'lead', priority: 'urgent', kind: 'decision', cursor: 'a+b=', limit: 7 }), page);
});

test('answerInbox posts public IDs and versions in a batch', async () => {
  const client = new AgentRuntime({ url: 'https://runtime.example', apiKey: 'key', fetch: async (url, init) => {
    assert.equal(new URL(String(url)).pathname, '/v1/inbox/answers');
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { requestId: 'review', answers: [{ agent: 'agent', id: 'local', version: 1, action: 'accept', content: 'yes' }] });
    return Response.json({ input: {}, request: null });
  } });
  await client.answerInbox([{ agent: 'agent', id: 'local', version: 1, action: 'accept', content: 'yes' }], 'review');
});

test('canonical runtime environment names take precedence and explicit options win', () => {
  const old = { ...process.env };
  try {
    process.env.CAMELRUN_API_KEY = 'canonical'; process.env.CAMELRUN_URL = 'https://canonical.example';
    process.env.CAMELAI_API_KEY = 'legacy'; process.env.CAMELAI_BASE_URL = 'https://legacy.example';
    const client = new AgentRuntime();
    assert.equal(client.options.apiKey, 'canonical');
    assert.equal(client.options.url, 'https://canonical.example');
    const explicit = new AgentRuntime({ apiKey: 'explicit', url: 'https://explicit.example' });
    assert.equal(explicit.options.apiKey, 'explicit');
    assert.equal(explicit.options.url, 'https://explicit.example');
    process.env.CAMELRUN_API_KEY = ''; process.env.CAMELRUN_URL = '';
    assert.equal(new AgentRuntime().options.apiKey, 'legacy');
    assert.equal(new AgentRuntime().options.url, 'https://legacy.example');
  } finally { process.env = old; }
});
