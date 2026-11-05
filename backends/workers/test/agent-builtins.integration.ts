import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { startFixture } from './fixture.ts';
import { sealProviderSecret } from '../src/model-credentials.ts';

test('workerd web builtins fetch pages, search with own keys and record usage', { timeout: 90_000 }, async t => {
  let base = '', searches = 0, xSearches = 0;
  const provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    if (request.url === '/page') { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<html><head><title>Example page</title></head><main>Readable public content</main></html>'); return; }
    if (request.url === '/exa') {
      assert.equal(request.headers['x-api-key'], 'fixture-exa'); searches++;
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ results: [{ title: 'Search title', url: 'https://example.com', highlights: ['The result excerpt'] }] })); return;
    }
    if (request.url === '/xai') {
      assert.equal(request.headers.authorization, 'Bearer fixture-xai'); xSearches++;
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Relevant posts', annotations: [{ url: 'https://x.com/example/status/1' }] }] }], usage: { input_tokens: 2, output_tokens: 3, cost_in_usd_ticks: '10000000' } })); return;
    }
    const body = JSON.parse(raw), tool = body.messages.at(-1)?.role === 'tool';
    const prompt = body.messages.filter((message: any) => message.role === 'user').at(-1)?.content;
    const query = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
    const name = query.includes('x search') ? 'x_search' : query.includes('web search') ? 'web_search' : 'web_fetch';
    const args = name === 'web_fetch' ? { url: base + '/page' } : { query: 'a test query' };
    const delta = tool ? { role: 'assistant', content: 'web ok' } : { role: 'assistant', tool_calls: [{ index: 0, id: 'web-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.end(`data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'stop' : 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } })}\n\ndata: [DONE]\n\n`);
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  base = `http://127.0.0.1:${(provider.address() as any).port}`;
  t.after(() => { provider.closeAllConnections(); return new Promise<void>(resolve => provider.close(() => resolve())); });
  const secretsKey = randomBytes(32).toString('hex');
  const fixture = await startFixture({ modelURL: base + '/v1', vars: { AGENT_SECRETS_KEY: secretsKey, AGENT_EXA_SEARCH_URL: base + '/exa', AGENT_X_SEARCH_URL: base + '/xai' } });
  t.after(() => fixture.stop());
  for (const name of ['exa', 'xai']) {
    const sealed = await sealProviderSecret({ AGENT_SECRETS_KEY: secretsKey } as never, `camelrun-proto-local:${name}`, 'fixture-' + name);
    await fixture.db.query('insert into provider_keys(tenant,provider,sealed,last4,set_at) values($1,$2,$3,$4,$5)', ['camelrun-proto-local', name, sealed, 'test', Date.now()]);
  }
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(fixture.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json() as any;
    assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  };
  for (const [builtin, prompt] of [['web_fetch', 'read the page'], ['web_search', 'web search'], ['x_search', 'x search']]) {
    const agent = await call('/v1/agents', { codeMode: false, fileTools: false, builtins: [builtin] });
    const accepted = await call(`/v1/agents/${agent.id}/prompt`, { text: prompt });
    let record: any, attempts = 0;
    do {
      record = await call(`/v1/agents/${agent.id}/requests/${accepted.id}`);
      if (record.state === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (++attempts < 800);
    assert.equal(record.state, 'completed');
    assert.equal(record.outcome?.result?.reply, 'web ok', JSON.stringify(record));
    const history = await call(`/v1/agents/${agent.id}/history`);
    const result = history.messages.find((message: any) => message.role === 'toolResult');
    assert.equal(result.isError, false, JSON.stringify(result));
    const data = JSON.parse(result.content[0].text);
    if (builtin === 'web_fetch') assert.equal(data.text, 'Readable public content');
    if (builtin === 'web_search') assert.equal(data.results[0].content, 'The result excerpt');
    if (builtin === 'x_search') assert.equal(data.usage.costUsd, 0.001);
  }
  assert.equal(searches, 1);
  assert.equal(xSearches, 1);
  const usage = (await fixture.db.query("select model,responses,cost from usage where model in ('exa/web_search','xai/x_search') order by model")).rows;
  assert.deepEqual(usage.map(row => row.model), ['exa/web_search', 'xai/x_search']);
  assert.deepEqual(usage.map(row => Number(row.responses)), [1, 1]);
});
