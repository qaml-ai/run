import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { discoverSources, prepareSources, sourceDefinitionViews, sourceTools } from '../src/tool-sources.ts';

test('definition discovery rejects refused credentials and retains temporary source failures', async t => {
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    if (req.url === '/refused') { res.writeHead(401).end('wrong credentials'); return; }
    if (req.url === '/down') { res.writeHead(503).end('down for maintenance'); return; }
    const request = JSON.parse(text);
    if (request.id === undefined) { res.writeHead(202).end(); return; }
    const result = request.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'test', version: '1' } } : { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }] };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const env = { API_TOKEN: 'test', TEST_MODE: '1', AGENT_SECRETS_KEY: '22'.repeat(32) };
  const prepared = await prepareSources(env, 'tenant', 'definition', 'mcpServers', [{ name: 'bad', url: `${base}/refused`, auth: { type: 'bearer', token: 'test-credential' } }]);
  await assert.rejects(discoverSources(env, 'tenant', 'definition', prepared, base), /HTTP 401/);
  const sources = await discoverSources(env, 'tenant', 'definition', [{ name: 'good', url: `${base}/good` }, { name: 'down', url: `${base}/down` }], base);
  const views = sourceDefinitionViews({ mcpServers: sources });
  assert.equal(views[0].status, 'listed');
  assert.equal(views[0].tools?.[0].name, 'good__echo');
  assert.equal(views[1].status, 'error');
  assert.match(views[1].error ?? '', /down for maintenance/);
  let failures: any[] = [];
  await sourceTools(env, 'tenant', 'definition', { mcpServers: sources }, undefined, undefined, value => { failures = value; });
  assert.deepEqual(failures.map(value => [value.kind, value.source]), [['mcp', 'down']]);
  assert.match(failures[0].message, /down for maintenance/);
});
