import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { startFixture } from './fixture.ts';

test('configuration refreshes delegation tools and deletion cancels an ownerless host call', { timeout: 60_000 }, async t => {
  let started!: () => void, closed!: () => void;
  const called = new Promise<void>(resolve => { started = resolve; });
  const cancelled = new Promise<void>(resolve => { closed = resolve; });
  const mcp = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const message = JSON.parse(raw);
    if (message.method === 'tools/call') {
      response.on('close', closed);
      started();
      return;
    }
    if (!message.id) { response.writeHead(202).end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'tools/list'
      ? { tools: [{ name: 'wait', description: 'Wait for cancellation', inputSchema: { type: 'object' } }] } : {} }));
  });
  mcp.listen(0, '127.0.0.1'); await once(mcp, 'listening');
  t.after(() => { mcp.closeAllConnections(); return new Promise<void>(resolve => mcp.close(() => resolve())); });
  const fixture = await startFixture();
  t.after(() => fixture.stop());
  async function call(path: string, input?: unknown, method = input === undefined ? 'GET' : 'POST') {
    const response = await fetch(fixture.url + path, { method, headers: { authorization: `Bearer ${fixture.token}`, 'content-type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const value = await response.json() as any;
    assert.ok(response.ok, `${response.status} ${JSON.stringify(value)}`);
    return value;
  }
  const agent = await call('/v1/agents', { mcpServers: [{ name: 'lifecycle', url: `http://127.0.0.1:${(mcp.address() as any).port}/mcp` }] });
  const base = `/v1/agents/${agent.id}`;
  const configure = async (params: object) => {
    const accepted = await call(base + '/configuration', params, 'PATCH');
    // Configuration admission is asynchronous. Observe its durable completion
    // before inspecting the registry it installs, as the public API specifies.
    const completed = await call(`${base}/requests/${accepted.id}?wait=25`);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.outcome.error, undefined);
    assert.equal(completed.outcome.result.configured, true);
  };
  const hasDelegate = async () => (await call(base)).toolSources.some((source: any) => source.tools.some((tool: any) => tool.name === 'delegate'));
  assert.equal(await hasDelegate(), false);
  await configure({ builtins: ['delegate'], delegate: { instructions: true } });
  assert.equal(await hasDelegate(), true, 'updated configuration installs delegation tools');
  await configure({ builtins: [], delegate: { maxDepth: 2 } });
  assert.equal(await hasDelegate(), false, 'removing the builtin removes its registry tools');
  await call(base + '/requests', { id: 'host-wait', method: 'execute', params: { code: 'return await tools.lifecycle__wait({})' } });
  await Promise.race([called, new Promise((_, reject) => setTimeout(() => reject(new Error('Host tool did not start')), 10_000))]);
  await call(base, undefined, 'DELETE');
  await Promise.race([cancelled, new Promise((_, reject) => setTimeout(() => reject(new Error('Deleting the agent did not abort its host tool')), 5000))]);
});
