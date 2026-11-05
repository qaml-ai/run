// Generated from packages/cli/src/ by scripts/reuse-agent-mcp.mjs. Host dependencies only.
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Api } from "./agent-mcp-api.ts";
import { VERSION } from "./agent-mcp-api.ts";
import { errorText, INSTRUCTIONS, resultText, tools } from "./hosted-mcp-tools.ts";
void z;

/** A result's most characters: past it the rest is cut, so one long history or spec cannot fill a model's context. */
export const MAX_RESULT = 100_000;
const capped = (text: string) => text.length <= MAX_RESULT ? text : `${text.slice(0, MAX_RESULT)}\n\n[Cut at ${MAX_RESULT} characters of ${text.length}: ask for less, such as a smaller limit.]`;

export function createServer(api: () => Api) {
  const server = new McpServer({ name: "camelrun", title: "camelRun", version: VERSION }, { instructions: INSTRUCTIONS });
  const local = undefined;
  for (const tool of tools(api, { local })) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: { title: tool.title, ...tool.annotations } }, (async (args: any) => {
      try { return { content: [{ type: "text", text: capped(resultText(await tool.run(args))) }] }; }
      catch (error) { return { isError: true, content: [{ type: "text", text: errorText(error) }] }; }
    }) as any);
  }
  return server;
}
