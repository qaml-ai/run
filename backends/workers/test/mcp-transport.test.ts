import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { legacyMcpRequest } from '../src/legacy-mcp.ts';
import { sourceTools } from '../src/tool-sources.ts';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord';

const env = { API_TOKEN: 'fixture', TEST_MODE: '1' };
const tool = { name: 'ping', description: 'Ping', inputSchema: { type: 'object' } };
const initialize = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } };
const api = { taskId: 1, conversationId: 1, callId: 'call' } as unknown as ToolExecutionApi;
const context = { abortSignal: new AbortController().signal } as Context;

test('remote progress extends the silence deadline and flushes the final update', async t => {
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const message = JSON.parse(body);
    if (!message.id) { res.writeHead(202).end(); return; }
    const result = message.method === 'initialize' ? initialize : { tools: [tool] };
    if (message.method !== 'tools/call') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (let progress = 1; progress <= 3; progress++) {
      await new Promise(resolve => setTimeout(resolve, 60));
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: message.params._meta.progressToken, progress, total: 3, message: `step ${progress}` } })}\n\n`);
    }
    res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'pong' }] } })}\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const progress: any[] = [];
  const tools = await sourceTools(env, 'tenant', undefined, { mcpServers: [{ name: 'source', url: `http://127.0.0.1:${(server.address() as any).port}/mcp`, timeoutMs: 100 }] }, undefined,
    async () => ({ issuer: 'https://runtime.test', claims: { tenant: 'tenant', agent: 'agent' }, call: { toolCallId: 'outer', innerCallId: 'c1' }, progress: async value => { progress.push(value); } }));
  const result = await tools[0].execute({}, api, context);
  assert.match(JSON.stringify(result.output), /pong/);
  assert.equal(progress.at(-1).partialResult.details.progress, 3);
  assert.equal(progress[0].toolCallId, 'outer');
  assert.equal(progress[0].toolName, 'codemode');
  assert.equal(progress[0].partialResult.details.innerCallId, 'c1');
  assert.equal('progressToken' in progress[0].partialResult.details, false);
});

test('a legacy SSE-only source is called and each stream closes after its operation', async t => {
  const streams = new Map<string, import('node:http').ServerResponse>();
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      const id = crypto.randomUUID(); streams.set(id, res);
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`event: endpoint\ndata: /messages?id=${id}\n\n`);
      res.on('close', () => streams.delete(id)); return;
    }
    if (req.url === '/sse') { res.writeHead(405).end(); return; }
    let body = ''; for await (const part of req) body += part;
    const message = JSON.parse(body), stream = streams.get(new URL(req.url!, 'http://x').searchParams.get('id')!);
    res.writeHead(202).end();
    if (!message.id) return;
    const result = message.method === 'initialize' ? initialize : message.method === 'tools/list' ? { tools: [tool] } : { content: [{ type: 'text', text: 'pong' }] };
    stream!.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const tools = await sourceTools(env, 'tenant', undefined, { mcpServers: [{ name: 'old', url: `http://127.0.0.1:${(server.address() as any).port}/sse` }] }, undefined,
    async () => ({ issuer: 'https://runtime.test', claims: { tenant: 'tenant', agent: 'agent' }, call: { toolCallId: 'call' } }));
  assert.equal(tools.length, 1);
  assert.match(JSON.stringify((await tools[0].execute({}, api, context)).output), /pong/);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(streams.size, 0);
});

test('legacy MCP refusal closes its unused endpoint wait without an unhandled rejection', async () => {
  await assert.rejects(legacyMcpRequest('https://mcp.test/sse', { jsonrpc: '2.0', id: '1', method: 'initialize' }, {}, async () => new Response(null, { status: 503 }), new AbortController().signal, false, () => {}), /HTTP 503/);
  await new Promise(resolve => setTimeout(resolve, 0));
});

test('source redirects are checked against limited networking before a second request',async t=>{
  const {fetchSource}=await import('../src/tool-sources.ts');
  const {networkAllows}=await import('../../../src/core/vault.ts');
  let requests=0;
  const server=createServer((_req,res)=>{requests++;res.writeHead(302,{location:'https://blocked.example.com/mcp'}).end();});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const url=`http://127.0.0.1:${(server.address() as any).port}/mcp`;
  const networking={type:'limited' as const,allowedHosts:['127.0.0.1'],allowPackageManagers:false,allowMcpServers:false};
  const checkNetwork=(target:URL)=>{if(!networkAllows(networking,target))throw new Error('Network destination is not allowed');};
  for(const headers of [{},{authorization:'fixture-secret'}]) await assert.rejects(fetchSource(env,url,{headers},1024,undefined,{checkNetwork}),/Network destination is not allowed/);
  assert.equal(requests,2);
});
