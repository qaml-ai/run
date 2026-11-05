import { Api } from './agent-mcp-api.ts';
import { AGENT_MCP_CORS, agentMcpPreflight, transport } from './agent-mcp.ts';
import { createServer } from './hosted-mcp-server.ts';

const MAX_BODY = 8 * 1024 * 1024;

/** The CLI's MCP tools over Workers' native stateless HTTP transport. */
export async function serveHostedMcp(request: Request, options: { publicOrigin: string; fetch: typeof fetch }): Promise<Response> {
  if (request.method === 'OPTIONS') return agentMcpPreflight();
  if (request.method !== 'POST') return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'This server is stateless: POST each message' }, id: null }, { status: 405, headers: { ...AGENT_MCP_CORS, Allow: 'POST' } });
  const tooLarge = () => Response.json({ jsonrpc: '2.0', error: { code: -32600, message: 'A message is at most ' + MAX_BODY + ' bytes' }, id: null }, { status: 413, headers: AGENT_MCP_CORS });
  if (Number(request.headers.get('Content-Length') ?? 0) > MAX_BODY) return tooLarge();
  const chunks: Uint8Array[] = []; let bytes = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > MAX_BODY) { await reader.cancel(); return tooLarge(); } chunks.push(next.value); } }
    finally { reader.releaseLock(); }
  }
  const encoded = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { encoded.set(chunk, offset); offset += chunk.byteLength; }
  const body = new TextDecoder().decode(encoded);
  let messages: any[] = [];
  try { const parsed = JSON.parse(body); messages = Array.isArray(parsed) ? parsed : [parsed]; } catch { /* SDK returns the parse error. */ }
  const authorization = request.headers.get('Authorization') ?? '';
  const api = new Api({ url: options.publicOrigin, apiKey: authorization.slice(7) }, options.fetch);
  return transport(request, createServer(() => api), body, messages.some(message => message?.method === 'tools/call'), {});
}
