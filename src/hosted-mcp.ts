import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Api } from "../packages/cli/src/api.ts";
import { createServer } from "../packages/cli/src/mcp.ts";
import type { Principal } from "./accounts.ts";
import { readText } from "./http.ts";

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
  /** The runtime's public URL: the resource's origin, and the URL tools show. */
  publicUrl: () => string;
  /** Where this node's REST API answers locally, e.g. http://127.0.0.1:8790. */
  loopback: () => string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version",
};

export function hostedMcp(options: HostedMcpOptions) {
  const app = new Hono();
  app.options("/mcp", c => c.body(null, 204, { ...CORS, "Access-Control-Max-Age": "86400" }));
  app.on(["GET", "POST", "DELETE"], "/mcp", async c => {
    const authorization = c.req.header("authorization");
    const principal = authorization ? await options.authenticate(authorization) : undefined;
    if (!principal) {
      const metadata = `${options.publicUrl()}/.well-known/oauth-protected-resource/mcp`;
      return c.json({ error: authorization ? "invalid_token" : "unauthorized", error_description: authorization ? "The token is invalid, expired or revoked" : "Sign in (OAuth), or send Authorization: Bearer <API token>" }, 401, {
        ...CORS, "WWW-Authenticate": `Bearer resource_metadata="${metadata}"${authorization ? ", error=\"invalid_token\"" : ""}, scope="agents"`,
      });
    }
    // Stateless: no session, and nothing to stream to between requests.
    if (c.req.method !== "POST") return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "This server is stateless: POST each message" }, id: null }, 405, { ...CORS, Allow: "POST" });
    const publicUrl = options.publicUrl(), loopback = options.loopback();
    const local: typeof fetch = (input, init) => { const url = String(input); return fetch(url.startsWith(publicUrl) ? loopback + url.slice(publicUrl.length) : url, init); };
    // Read within a limit (it throws 413 past it), then handed on whole.
    if (Number(c.req.header("content-length") ?? 0) > MAX_BODY) return c.json({ jsonrpc: "2.0", error: { code: -32600, message: `A message is at most ${MAX_BODY} bytes` }, id: null }, 413, CORS);
    const headers = new Headers(c.req.raw.headers);
    headers.delete("content-length");
    const request = new Request(c.req.raw.url, { method: "POST", headers, body: await readText(c.req.raw.body, MAX_BODY) });
    const server = createServer(() => new Api({ url: publicUrl, apiKey: authorization!.slice(7) }, local));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      const response = await transport.handleRequest(request);
      const answer = new Headers(response.headers);
      for (const [name, value] of Object.entries(CORS)) answer.set(name, value);
      // The body is read before the server closes: a JSON response is whole by now.
      return new Response(response.body && await response.arrayBuffer(), { status: response.status, headers: answer });
    } finally {
      await server.close();
    }
  });
  return app;
}
