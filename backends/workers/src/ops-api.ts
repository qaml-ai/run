import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Db } from "./postgres.ts";
import { OPS_PATH, OPS_SCOPE } from "./account-oauth.ts";
import type { AccountServices } from "./account-services.ts";
import { AGENT_MCP_CORS, agentMcpPreflight, transport } from "./agent-mcp.ts";
import { readText } from "./account-http.ts";
import * as reports from "./ops-reports.ts";
import { INSTRUCTIONS, READ, opsTools as coreTools, type OpsTool } from "../../../src/core/ops-tools.ts";
import { VERSION } from "./agent-mcp-api.ts";

// The tools are one copy in src/core/ops-tools.ts; the HTTP transport below is Workers-native.
/** The tools, in the order tools/list gives them: each answers a chart's rows, and nothing that changes anything. */
export const opsTools = (db: Db): OpsTool[] => coreTools(db, reports);

/** A server with the tools, for one request: each is registered with what it does, its arguments and that it reads. */
function createServer(db: Db) {
  const server = new McpServer({ name: "camelrun-ops", title: "camelRun operations", version: VERSION }, { instructions: INSTRUCTIONS });
  for (const tool of opsTools(db)) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: { title: tool.title, ...READ } }, (async (args: any) => {
      try {
        const answer = await tool.run(args ?? {});
        return { content: [{ type: "text", text: JSON.stringify(answer) }], structuredContent: answer };
      } catch (error) {
        // A failed query says what happened, short: the row it was for is not the team's to see in an error either.
        const message = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({ type: "ops_mcp_tool_failed", tool: tool.name, error: message.slice(0, 300) }));
        return { isError: true, content: [{ type: "text", text: `${tool.name} failed: ${message.slice(0, 300)}` }] };
      }
    }) as any);
  }
  return server;
}

/** Only OAuth grants for the ops resource, admitted on every request. */
export async function operationsMcp(request: Request, service: AccountServices): Promise<Response> {
  if (request.method === "OPTIONS") return agentMcpPreflight();
  const authorization = request.headers.get("authorization") ?? undefined;
  const principal = authorization ? await service.oauth.authenticate(authorization, "ops") : undefined;
  if (!principal) {
    const origin = service.origins.of(request.headers);
    return Response.json({ error: authorization ? "invalid_token" : "unauthorized", error_description: authorization ? "The token is invalid, expired or revoked" : "Sign in (OAuth), or send Authorization: Bearer <API token>" }, {
      status: 401, headers: { ...AGENT_MCP_CORS, "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${OPS_PATH}"${authorization ? ', error="invalid_token"' : ''}, scope="${OPS_SCOPE}"` },
    });
  }
  if (!service.oauth.opsAdmin(principal.tenant)) return Response.json({ type: "error", error: "camelRun operations is for the camelRun team only", code: "NOT_TEAM" }, { status: 403, headers: { "Cache-Control": "no-store" } });
  if (request.method !== "POST") return Response.json({ jsonrpc: "2.0", error: { code: -32000, message: "This server is stateless: POST each message" }, id: null }, { status: 405, headers: { ...AGENT_MCP_CORS, Allow: "POST" } });
  const limit = 8 * 1024 * 1024;
  if (Number(request.headers.get("content-length") ?? 0) > limit) return Response.json({ jsonrpc: "2.0", error: { code: -32600, message: `A message is at most ${limit} bytes` }, id: null }, { status: 413, headers: AGENT_MCP_CORS });
  return transport(request, createServer(service.accounts.db), await readText(request.body, limit), false, {});
}
