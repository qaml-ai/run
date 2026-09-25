import type { ToolDefinition } from "./protocol.ts";
import type { McpResult } from "./mcp-results.ts";
import { compiles, validateDefinitions } from "./tool-policy.ts";

/**
 * A tool call as a server gets it; `toolCallId` is the model's id for the call, `origin` where the
 * turn came from (a channel and its sender), and `actor` who the application said is acting in it:
 * set by the runtime, never by the model, so tools can authorize.
 */
export type ToolCall = { name: string; args: Record<string, unknown>; signal: AbortSignal; toolCallId?: string; origin?: Record<string, unknown>; actor?: string };

/**
 * The one interface every source of an agent's tools answers through, shaped like MCP's
 * tools/list and tools/call: the runtime's file tools and built-ins, a channel's
 * send_message, a definition's remote MCP servers, and the application's attached server.
 */
export interface ToolServer {
  tools(): ToolDefinition[] | Promise<ToolDefinition[]>;
  call(call: ToolCall): Promise<McpResult>;
}

/** A plain value as an MCP result: its JSON as text, and as structured content when it is an object. */
export function jsonResult(value: unknown): McpResult {
  const structured = !!value && typeof value === "object" && !Array.isArray(value);
  return { content: [{ type: "text", text: JSON.stringify(value) ?? "null" }], ...(structured ? { structuredContent: value } : {}) };
}

/** A server for tools the runtime answers with plain values. */
export function valueServer(tools: ToolDefinition[], run: (call: ToolCall) => Promise<unknown>): ToolServer {
  return { tools: () => tools, call: async call => jsonResult(await run(call)) };
}

const BUDGET = { count: 128, bytes: 256 * 1024 };
/** A source with at most this many tools offers them to the model directly as well as from js_exec. */
export const SMALL_SOURCE = 10;

/**
 * A source's tools with its default exposure where they set none: a few tools are declared
 * to the model directly as well (a call costs one step, not a discovery in js_exec first);
 * many are reached from js_exec only, so they do not crowd the model's context.
 */
export function defaultExposure(tools: ToolDefinition[], exposure?: ToolDefinition["exposure"]): ToolDefinition[] {
  const chosen = exposure ?? (tools.length <= SMALL_SOURCE ? "both" : "codemode");
  return tools.map(tool => tool.exposure ? tool : { ...tool, exposure: chosen });
}

/**
 * An agent's tools from its servers in order of precedence: a name an earlier server lists
 * is left out of later ones, as is a tool that is invalid or past the catalog's limits.
 * Every tool answers with an MCP result; `route` sends each call to the server that listed it.
 */
export async function compose(servers: ToolServer[]): Promise<{ tools: ToolDefinition[]; route: Map<string, ToolServer> }> {
  const lists = await Promise.all(servers.map(server => server.tools()));
  const tools: ToolDefinition[] = [];
  const route = new Map<string, ToolServer>();
  let bytes = 0;
  lists.forEach((list, index) => {
    for (const listed of list) {
      const tool: ToolDefinition = { ...listed, resultFormat: "content" };
      const size = Buffer.byteLength(JSON.stringify(tool)) + 1;
      if (route.has(tool.name) || route.size >= BUDGET.count || bytes + size > BUDGET.bytes) continue;
      try { validateDefinitions([tool]); } catch { continue; }
      if (!compiles(tool.parameters)) continue;
      route.set(tool.name, servers[index]);
      tools.push(tool);
      bytes += size;
    }
  });
  return { tools, route };
}
