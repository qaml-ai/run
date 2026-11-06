import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { discoverSources, prepareSources, sourceDefinitionViews, sourceTools, toolSourceViews } from '../src/tool-sources.ts';

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


test('source auth and audience validation keeps the source public contract', async () => {
  const env = { API_TOKEN: 'test', TEST_MODE: '1', AGENT_SECRETS_KEY: '22'.repeat(32), AGENT_OUTBOUND_ALLOW_HTTP: 'true', AGENT_OUTBOUND_ALLOW_CIDRS: '127.0.0.1/32' };
  const source = { name: 'app', url: 'http://127.0.0.1:1/mcp' };
  await assert.rejects(prepareSources(env, 'tenant', 'definition', 'mcpServers', [{ ...source, auth: { type: 'exchange' } }]), /auth is \{ type: "exchange", url, audience\? \}/);
  await assert.rejects(prepareSources(env, 'tenant', undefined, 'mcpServers', [{ ...source, auth: { type: 'runtime', token: 'secret' } }]), /no credentials.*definition/);
  await assert.rejects(prepareSources(env, 'tenant', 'definition', 'mcpServers', [{ ...source, auth: { type: 'runtime' }, audience: 'urn:camelrun:tenant:' }]), /own origin/);
  await assert.rejects(prepareSources(env, 'tenant', 'definition', 'mcpServers', [{ ...source, approval: { default: 'invalid' } }]), /Invalid option: expected one of/);
  const [prepared] = await prepareSources(env, 'tenant', 'definition', 'mcpServers', [{ ...source, auth: { type: 'bearer', token: 'secret' } }]);
  assert.equal(prepared.headerNames, undefined);
});


test('tool catalogs preserve source priority, duplicate exclusions and parameter schemas', () => {
  const tool = (name: string) => ({ name, description: name, parameters: { type: 'object' }, execute: async () => ({ output: [] }) });
  const tools = [tool('web_fetch'), tool('read'), tool('decide'), tool('kb__ping')];
  const result = toolSourceViews({ mcp: { tools: [{ name: 'web_fetch', description: 'App fetch', inputSchema: { type: 'object' } }] }, builtins: ['web_fetch'], mcpServers: [{ name: 'kb', url: 'https://example.test/mcp' }] }, tools, false);
  assert.deepEqual(result.map(source => `${source.kind}:${source.name}`), ['application:application', 'files:files', 'builtin:decide', 'builtin:web_fetch', 'mcp:kb']);
  assert.equal(result[3].tools[0].excluded, 'an earlier source has a tool of this name');
  assert.deepEqual(result[4].tools[0].parameters, { type: 'object' });
  assert.equal(typeof result[4].listedAt, 'number');
});
