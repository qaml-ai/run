import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, McpTool, ToolServer } from "./typescript.ts";

/** Tool names the runtime accepts; others are renamed, and calls map back. */
const safeName = (name: string) => (/^[A-Za-z]/.test(name) ? name : `t_${name}`).replace(/[^A-Za-z0-9_]/g, "_").slice(0, 80);

/**
 * Attach an MCP SDK server (`McpServer` or low-level `Server`) to an agent: pass the result
 * as `mcp` to `createAgent`, `connectAgent` or `configure`. The SDK talks to the server in
 * memory, so the same server can later run remotely, as a definition's `mcpServers` entry,
 * without changing its tools. `callId`, `toolCallId` and `origin` reach its handlers as
 * `_meta["agent-runtime/…"]`.
 */
export async function fromMcpServer(server: McpServer | Server): Promise<ToolServer & { close(): Promise<void> }> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "agent-runtime-sdk", version: "1.0.0" });
  await client.connect(clientSide);
  const names = new Map<string, string>();
  return {
    async listTools() {
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        for (const tool of page.tools) {
          names.set(safeName(tool.name), tool.name);
          tools.push({ ...tool, name: safeName(tool.name) } as McpTool);
        }
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },
    async callTool(name, args, context) {
      const _meta = { "agent-runtime/callId": context.callId, ...(context.toolCallId ? { "agent-runtime/toolCallId": context.toolCallId } : {}), ...(context.origin ? { "agent-runtime/origin": context.origin } : {}) };
      return await client.callTool({ name: names.get(name) ?? name, arguments: args, _meta }, undefined, { signal: context.signal }) as CallToolResult;
    },
    async close() { await client.close(); },
  };
}
