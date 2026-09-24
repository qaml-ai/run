import type { ToolDefinition } from "./protocol.ts";
import { compiles, validateDefinitions } from "./tool-policy.ts";

/**
 * MCP tools and results, whichever way the server is reached: remote servers the runtime
 * calls, and an application's attached server answering over its client connection.
 */
export type McpResult = { content?: any[]; structuredContent?: unknown; isError?: boolean; toolResult?: unknown };
/** A tool from a server's `tools/list`. Runtime options ride in `_meta` under this prefix. */
export type McpTool = { name: string; title?: string; description?: string; inputSchema: Record<string, unknown>; _meta?: Record<string, unknown> };
export const META = "agent-runtime/";

/** An MCP tool result as a content result: text and images pass through; other content is described in text. */
export function contentResult(result: McpResult) {
  const content = (result.content ?? []).map((part: any) => {
    if (part?.type === "text") return { type: "text", text: String(part.text) };
    if (part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") return { type: "image", data: part.data, mimeType: part.mimeType };
    if (part?.type === "resource" && typeof part.resource?.text === "string") return { type: "text", text: part.resource.text };
    if (part?.type === "resource_link") return { type: "text", text: `Resource: ${part.name ?? ""} ${part.uri ?? ""}`.trim() };
    return { type: "text", text: `[${part?.type ?? "unknown"} content${part?.mimeType ? ` (${part.mimeType})` : ""} omitted]` };
  });
  const structured = result.structuredContent ?? result.toolResult;
  if (!content.length) content.push({ type: "text", text: structured === undefined ? "" : JSON.stringify(structured) });
  return { content, ...(result.isError ? { isError: true } : {}), ...(structured !== undefined ? { details: structured } : {}) };
}

/**
 * What `js_exec` code gets from a content result: the data, not the envelope. Structured
 * content when the tool gave it, else one text block (parsed when it is JSON), else the
 * blocks themselves. A tool error throws, as a failed call of any other tool does.
 */
export function scriptValue(value: { content: any[]; isError?: boolean; details?: unknown }) {
  const texts = value.content.filter(part => part.type === "text").map(part => part.text as string);
  if (value.isError) throw new Error(texts.join("\n") || "Tool execution failed");
  if (value.details !== undefined) return value.details;
  if (value.content.length === 1 && texts.length === 1) {
    try { return JSON.parse(texts[0]); } catch { return texts[0]; }
  }
  return value.content;
}

/** An application's attached server's tools as the agent's own (bare-named) tools. */
export function attachedTools(tools: unknown): ToolDefinition[] {
  if (!Array.isArray(tools)) throw new Error("mcp.tools must be the attached server's tools/list result");
  const definitions = tools.map((tool: McpTool): ToolDefinition => {
    if (!tool || typeof tool !== "object" || typeof tool.name !== "string") throw new Error("Invalid MCP tool");
    if (!tool.inputSchema || typeof tool.inputSchema !== "object" || tool.inputSchema.type !== "object" || !compiles(tool.inputSchema)) throw new Error(`MCP tool ${tool.name}: inputSchema must be a JSON Schema for an object`);
    const meta = tool._meta ?? {};
    const exposure = meta[`${META}exposure`], executionMode = meta[`${META}executionMode`];
    return {
      name: tool.name, description: tool.description || tool.title || tool.name, parameters: tool.inputSchema,
      ...(exposure !== undefined ? { exposure: exposure as ToolDefinition["exposure"] } : {}), ...(executionMode !== undefined ? { executionMode: executionMode as ToolDefinition["executionMode"] } : {}),
    };
  });
  validateDefinitions(definitions);
  return definitions;
}

/** An application's tools from a create request: its attached server's tools/list, `mcp.tools`. */
export function applicationTools(params: { tools?: unknown; mcp?: { tools?: unknown } }): ToolDefinition[] {
  if (params.tools !== undefined) throw new Error("An application's tools come from its MCP server: send mcp: { tools }, its tools/list");
  return params.mcp === undefined ? [] : attachedTools(params.mcp.tools);
}
