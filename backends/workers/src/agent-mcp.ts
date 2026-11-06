import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Api, VERSION } from './agent-mcp-api.ts';
import { converse, describe, settle, type Call, type Extra } from './agent-mcp-core.ts';
import { digest } from './api-contract.ts';

export const AGENT_MCP_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version',
};
const MAX_BODY = 8 * 1024 * 1024;
const waiting: Call['waiting'] = new Map();

export function agentMcpSignIn(request: Request, publicOrigin: string, id: string): Response {
  const invalid = !!request.headers.get('Authorization');
  const metadata = publicOrigin + '/.well-known/oauth-protected-resource' + (id ? '/v1/agents/' + id : '') + '/mcp';
  return Response.json({ error: invalid ? 'invalid_token' : 'unauthorized', error_description: invalid ? 'The token is invalid, expired or revoked' : 'Sign in (OAuth), or send Authorization: Bearer <API token>' }, { status: 401, headers: { ...AGENT_MCP_CORS, 'WWW-Authenticate': 'Bearer resource_metadata="' + metadata + '"' + (invalid ? ', error="invalid_token"' : '') + ', scope="agents"' } });
}
export function agentMcpPreflight(): Response {
  return new Response(null, { status: 204, headers: { ...AGENT_MCP_CORS, 'Access-Control-Max-Age': '86400' } });
}

type AgentMcpOptions = {
  agent: { id: string; name?: string; own: boolean };
  /** Current definition description, never the agent's instructions. */
  description?: string;
  publicOrigin: string;
  /** Root URL for this agent's REST API; internal fetch still authenticates each call. */
  base: string;
  fetch: typeof fetch;
};

/** Authenticated agent MCP endpoint. Conversation behavior is generated unchanged from src/. */
export async function serveAgentMcp(request: Request, options: AgentMcpOptions): Promise<Response> {
  if (request.method === 'OPTIONS') return agentMcpPreflight();
  if (request.method !== 'POST') return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'This server is stateless: POST each message' }, id: null }, { status: 405, headers: { ...AGENT_MCP_CORS, Allow: 'POST' } });
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY) return tooLarge();
  const chunks: Uint8Array[] = []; let bytes = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > MAX_BODY) { await reader.cancel(); return tooLarge(); } chunks.push(next.value); } }
    finally { reader.releaseLock(); }
  }
  const encoded = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { encoded.set(chunk, offset); offset += chunk.byteLength; }
  const body = new TextDecoder().decode(encoded), authorization = request.headers.get('Authorization')!;
  let messages: any[] = [];
  try { const parsed = JSON.parse(body); messages = Array.isArray(parsed) ? parsed : [parsed]; } catch { /* the SDK returns JSON-RPC parse errors */ }
  const api = new Api({ url: options.base, apiKey: authorization.slice(7) }, options.fetch);
  const replies = messages.filter(message => typeof message?.id === 'string' && message.id.startsWith('input:') && message.method === undefined);
  if (replies.length) {
    for (const reply of replies) {
      const pending = waiting.get(reply.id);
      if (pending?.agent === options.agent.id) { pending.reply(reply); continue; }
      const input = (await api.get<any[]>('/inputs?state=pending').catch(() => [])).find(item => item.id === reply.id.slice(6));
      if (input) await settle(api, input, reply).catch(() => {});
    }
    return new Response(null, { status: 202, headers: AGENT_MCP_CORS });
  }
  const initialize = messages.find(message => message?.method === 'initialize'), elicitation = initialize?.params?.capabilities?.elicitation;
  const session = initialize ? crypto.randomUUID().replaceAll('-', '') + '.' + (elicitation && (elicitation.form || !elicitation.url) ? 'f' : '') + (elicitation?.url ? 'u' : '') : request.headers.get('mcp-session-id');
  const can = session?.split('.')[1] ?? '';
  const server = new McpServer({ name: 'camelrun-agent', title: options.agent.name ?? 'camelRun agent', version: VERSION });
  const call: Call = { agent: options.agent.id, api, own: options.agent.own, authorization, events: options.base + '/events?watch=1&snapshot=0', publicUrl: options.publicOrigin, form: can.includes('f'), url: can.includes('u'), waiting, fetch: options.fetch,
    elicit: (id, params, extra) => server.server.transport!.send({ jsonrpc: '2.0', id, method: 'elicitation/create', params }, { relatedRequestId: extra.requestId }),
  };
  server.registerTool('message', { title: options.agent.name ? 'Message ' + options.agent.name : 'Message the agent', description: describe(options.agent.name, options.description), inputSchema: {
    text: z.string().min(1).describe('Your message'), requestId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).optional().describe('Sending again with the same requestId (and text) is the same message: it is not sent twice, and the call gives its reply'),
  } }, (async ({ text, requestId }: { text: string; requestId?: string }, extra: Extra) => {
    const derived = session ? 'mcp_' + (await digest(session + ':' + String(extra.requestId))).slice(0, 40) : 'mcp_' + crypto.randomUUID().replaceAll('-', '');
    return converse(call, text, requestId ?? derived, extra);
  }) as any);
  return transport(request, server, body, messages.some(message => message?.method === 'tools/call'), initialize && session ? { 'Mcp-Session-Id': session } : {});
}
function tooLarge() { return Response.json({ jsonrpc: '2.0', error: { code: -32600, message: 'A message is at most ' + MAX_BODY + ' bytes' }, id: null }, { status: 413, headers: AGENT_MCP_CORS }); }

/** The source's Web Standard stateless transport, without its Hono request wrapper. */
export async function transport(request: Request, server: McpServer, body: string, stream: boolean, extraHeaders: Record<string, string>): Promise<Response> {
  const headers = new Headers(request.headers); headers.delete('content-length');
  const incoming = new Request(request.url, { method: 'POST', headers, body });
  const native = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: !stream });
  await server.connect(native); let streaming = false;
  try {
    const response = await native.handleRequest(incoming), answer = new Headers(response.headers);
    for (const [key, value] of Object.entries({ ...AGENT_MCP_CORS, ...extraHeaders })) answer.set(key, value);
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return new Response(response.body && await response.arrayBuffer(), { status: response.status, headers: answer });
    const reader = response.body.getReader(), close = () => void server.close().catch(() => {}); streaming = true;
    return new Response(new ReadableStream<Uint8Array>({ async pull(controller) { const { value, done } = await reader.read(); if (done) { controller.close(); close(); } else controller.enqueue(value); }, cancel() { void reader.cancel().catch(() => {}); close(); } }), { status: response.status, headers: answer });
  } finally { if (!streaming) await server.close(); }
}
