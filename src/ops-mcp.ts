import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono, type Context } from "hono";
import type { Principal } from "./accounts.ts";
import type { Db } from "./db.ts";
import { mcpBody, mcpPreflight, mcpSignIn, serveMcp } from "./hosted-mcp.ts";
import type { PublicOrigins } from "./origins.ts";
import { OPS_PATH, OPS_SCOPE, type OAuthResource } from "./oauth.ts";
import * as reports from "./ops-reports.ts";
import { INSTRUCTIONS, READ, opsTools as coreTools, type OpsTool } from "./core/ops-tools.ts";
import { VERSION } from "../packages/cli/src/version.ts";

/**
 * The team's read-only operations MCP endpoint, /v1/ops/mcp: the platform's own counts, names, times, dollars and bytes
 * (src/ops-reports.ts), for a connector whose dashboards ask production live. It signs in with the same OAuth server as
 * /mcp (src/oauth.ts) for the `ops` resource: a /mcp token is refused here and this one there, and only a tenant on
 * AGENT_OPS_ADMINS gets past the 403, checked on every request. Stateless JSON-RPC over POST, as /mcp is.
 *
 * Every tool answers rows (`{rows: [...]}`, and for some a total or a second list beside it) a dashboard charts as they
 * are. Nothing here answers prompts, messages, transcripts, tokens, secrets or sessions: the queries name their columns
 * (ops-reports.ts), and the descriptions say what a row holds. The server's instructions call the data what it is, never
 * instructions, because the team's agents read it.
 */
export interface OpsMcpOptions {
  /** The OAuth access token's tenant, at the ops resource alone: no API token reaches this endpoint. */
  authenticate(authorization: string | undefined, resource: OAuthResource): Promise<Principal | undefined>;
  /** Whether `tenant` is on AGENT_OPS_ADMINS, who alone may use it. */
  opsAdmin(tenant: string): boolean;
  /** The endpoints and pages are at whichever origin the client reached: the resource metadata names that one. */
  origins: PublicOrigins;
  db: Db;
}


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

/** The team only: a token for another resource, or a tenant off the list, gets nothing. */
const notTeam = (c: Context) => c.json({ type: "error", error: "camelRun operations is for the camelRun team only", code: "NOT_TEAM" }, 403, { "Cache-Control": "no-store" });

export function opsMcp(options: OpsMcpOptions) {
  const app = new Hono();
  app.options(OPS_PATH, mcpPreflight);
  app.on(["GET", "POST", "DELETE"], OPS_PATH, async c => {
    const authorization = c.req.header("authorization");
    const principal = authorization ? await options.authenticate(authorization, "ops") : undefined;
    if (!principal) return mcpSignIn(c, authorization, `${options.origins.of(c.req.raw.headers)}/.well-known/oauth-protected-resource${OPS_PATH}`, OPS_SCOPE);
    if (!options.opsAdmin(principal.tenant)) return notTeam(c);
    const body = await mcpBody(c);
    if (body instanceof Response) return body;
    return serveMcp(c, createServer(options.db), body);
  });
  return app;
}
