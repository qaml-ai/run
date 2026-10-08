import { Hono, type Context } from "hono";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Api } from "../packages/cli/src/api.ts";
import { createServer } from "../packages/cli/src/mcp.ts";
import type { Principal } from "./accounts.ts";
import { readText } from "./http.ts";
import type { PublicOrigins } from "./origins.ts";
import { network } from "./node-context.ts";

/** A message's largest body: room for a manifest with an OpenAPI spec inline. */
const MAX_BODY = 8 * 1024 * 1024;

/**
 * The hosted MCP endpoint, /mcp: the camelrun CLI's MCP tools over Streamable HTTP, for clients that connect by URL.
 * A caller authenticates with an API token or an OAuth access token (src/oauth.ts); without one it is told where to
 * get one (RFC 9728). It is stateless, so any node answers any request: each makes a server for its caller, whose
 * tools call the runtime's own REST API over loopback with the caller's credential. So they route to the node that
 * holds an agent, and are checked and limited, exactly as the same calls from outside are.
 */
export interface HostedMcpOptions {
  authenticate(authorization: string | undefined): Promise<Principal | undefined>;
  /** The runtime's origins: the public URL is the one tools show; the resource is at whichever the client reached. */
  origins: PublicOrigins;
  /** Where this node's REST API answers locally, e.g. http://127.0.0.1:8790. */
  loopback: () => string;
}

export const MCP_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version",
};

export const mcpPreflight = (c: Context) => c.body(null, 204, { ...MCP_CORS, "Access-Control-Max-Age": "86400" });

/** The 401 an MCP client signs in from: `metadata` is the resource's protected-resource metadata (RFC 9728). */
export function mcpSignIn(c: Context, authorization: string | undefined, metadata: string) {
  return c.json({ error: authorization ? "invalid_token" : "unauthorized", error_description: authorization ? "The token is invalid, expired or revoked" : "Sign in (OAuth), or send Authorization: Bearer <API token>" }, 401, {
    ...MCP_CORS, "WWW-Authenticate": `Bearer resource_metadata="${metadata}"${authorization ? ", error=\"invalid_token\"" : ""}, scope="agents"`,
  });
}

/** A stateless endpoint's POST body, read whole within the limit (to hand on); or the answer refusing the request. */
export async function mcpBody(c: Context): Promise<string | Response> {
  // Stateless: no session, and nothing to stream to between requests.
  if (c.req.method !== "POST") return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "This server is stateless: POST each message" }, id: null }, 405, { ...MCP_CORS, Allow: "POST" });
  // Refused from its length before it is read; otherwise read within the limit (it throws 413 past it).
  if (Number(c.req.header("content-length") ?? 0) > MAX_BODY) return c.json({ jsonrpc: "2.0", error: { code: -32600, message: `A message is at most ${MAX_BODY} bytes` }, id: null }, 413, MCP_CORS);
  return readText(c.req.raw.body, MAX_BODY);
}

/**
 * Answer one POST with `server`, which is closed once the answer is sent. By default the answer is JSON, whole. With
 * `stream`, it is server-sent events, so a long tool call can send progress (and requests of its own) before its
 * result: the server closes when the stream ends, or when the client goes (which aborts the calls it was making).
 */
export async function serveMcp(c: Context, server: McpServer, body: string, options: { stream?: boolean; headers?: Record<string, string> } = {}) {
  const headers = new Headers(c.req.raw.headers);
  headers.delete("content-length");
  const request = new Request(c.req.raw.url, { method: "POST", headers, body });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: !options.stream });
  await server.connect(transport);
  let streaming = false;
  try {
    const response = await transport.handleRequest(request);
    const answer = new Headers(response.headers);
    for (const [name, value] of Object.entries({ ...MCP_CORS, ...options.headers })) answer.set(name, value);
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      // The body is read before the server closes: a JSON response is whole by now.
      return new Response(response.body && await response.arrayBuffer(), { status: response.status, headers: answer });
    }
    const reader = response.body.getReader();
    const close = () => void server.close().catch(() => {});
    streaming = true;
    return new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value, done } = await reader.read();
        if (done) { controller.close(); close(); } else controller.enqueue(value);
      },
      cancel() { void reader.cancel().catch(() => {}); close(); },
    }), { status: response.status, headers: answer });
  } finally {
    if (!streaming) await server.close();
  }
}

export function hostedMcp(options: HostedMcpOptions) {
  const app = new Hono();
  app.options("/mcp", mcpPreflight);
  app.on(["GET", "POST", "DELETE"], "/mcp", async c => {
    const authorization = c.req.header("authorization");
    const principal = authorization ? await options.authenticate(authorization) : undefined;
    if (!principal) return mcpSignIn(c, authorization, `${options.origins.of(c.req.raw.headers)}/.well-known/oauth-protected-resource/mcp`);
    const body = await mcpBody(c);
    if (body instanceof Response) return body;
    const publicUrl = options.origins.canonical, loopback = options.loopback();
    const local: typeof fetch = (input, init) => { const url = String(input); return network().fetch(url.startsWith(publicUrl) ? loopback + url.slice(publicUrl.length) : url, init); };
    return serveMcp(c, createServer(() => new Api({ url: publicUrl, apiKey: authorization!.slice(7) }, local)), body);
  });
  return app;
}
