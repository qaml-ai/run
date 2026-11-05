import test from 'node:test';
import assert from 'node:assert/strict';
import { serveAgentMcp, agentMcpSignIn } from '../src/agent-mcp.ts';

const endpoint = 'https://runtime.test/v1/agents/client_test/mcp';
const jsonRpc = (method: string, params: object = {}, id: number = 1, session?: string) => new Request(endpoint, { method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
const options = { agent: { id: 'client_test', name: 'Support', own: false }, description: 'Answers about orders.', publicOrigin: 'https://runtime.test', base: endpoint.replace('/mcp', '') };

test('agent MCP advertises its public description and stateless capability session', async () => {
  const local: typeof fetch = async () => { throw new Error('listing does not call the agent'); };
  const initialized = await serveAgentMcp(jsonRpc('initialize', { protocolVersion: '2025-06-18', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'test', version: '1' } }), { ...options, fetch: local });
  assert.match(initialized.headers.get('Mcp-Session-Id')!, /^[a-f0-9]{32}\.f$/);
  const listed = await serveAgentMcp(jsonRpc('tools/list'), { ...options, fetch: local });
  const tool = (await listed.json() as any).result.tools[0];
  assert.equal(tool.name, 'message');
  assert.match(tool.description, /^Send a message to the agent "Support"/);
  assert.match(tool.description, /Answers about orders/);
});

test('agent MCP follows progress and reuses explicit request ids through REST admission', async () => {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder(), records = new Map<string, object>(); let prompts = 0;
  const frame = (event: object) => controller!.enqueue(encoder.encode('data: ' + JSON.stringify(event) + '\n\n'));
  const local: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/events')) return new Response(new ReadableStream({ start(value) { controller = value; controller.enqueue(encoder.encode('event: ready\ndata: {}\n\n')); } }), { headers: { 'Content-Type': 'text/event-stream' } });
    if (path.endsWith('/prompt')) {
      const body = JSON.parse(String(init?.body));
      let record = records.get(body.requestId);
      if (!record) {
        prompts++;
        record = { id: body.requestId, state: 'completed', outcome: { result: { reply: 'echo: ' + body.text } } };
        records.set(body.requestId, record);
        frame({ type: 'event', requestId: body.requestId, event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'echo: ' + body.text } } });
      }
      return Response.json(record);
    }
    throw new Error('unexpected local path ' + path);
  };
  const send = async () => {
    const response = await serveAgentMcp(jsonRpc('tools/call', { name: 'message', arguments: { text: 'hello', requestId: 'once' }, _meta: { progressToken: 'progress' } }), { ...options, fetch: local });
    return (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  };
  const first = await send(), second = await send();
  assert.equal(first.find(item => item.id === 1)?.result.content[0].text, 'echo: hello');
  assert.equal(second.find(item => item.id === 1)?.result.structuredContent.requestId, 'once');
  assert.equal(prompts, 1);
});

test('agent MCP signs in with its own protected-resource metadata', () => {
  const response = agentMcpSignIn(new Request(endpoint), 'https://agents.test', 'client_test');
  assert.equal(response.status, 401);
  assert.match(response.headers.get('WWW-Authenticate')!, /https:\/\/agents.test\/\.well-known\/oauth-protected-resource\/v1\/agents\/client_test\/mcp/);
});
