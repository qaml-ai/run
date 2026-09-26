import type { ToolDefinition } from "./protocol.ts";
import { compiles, validateDefinitions } from "./tool-policy.ts";
import { validFileRef } from "./files.ts";

/**
 * MCP tools and results, whichever way the server is reached: remote servers the runtime
 * calls, and an application's attached server answering over its client connection.
 */
export type McpResult = {
  content?: any[]; structuredContent?: unknown; isError?: boolean; toolResult?: unknown;
  /** MCP's multi round-trip requests: `input_required` asks for `inputRequests`, to retry with their answers and `requestState`. */
  resultType?: string; inputRequests?: Record<string, unknown>; requestState?: string;
};
/** A tool from a server's `tools/list`. Runtime options ride in `_meta` under this prefix. */
export type McpTool = { name: string; title?: string; description?: string; inputSchema: Record<string, unknown>; _meta?: Record<string, unknown> };
export const META = "agent-runtime/";

/** What a `tools/call` carries for human input (inputs.ts): answers and state on a retry, and whether the agent has someone to ask. */
export type CallInput = { inputResponses?: Record<string, unknown>; requestState?: string; elicit?: boolean };
/**
 * A `tools/call` request's params. A retry after a person answered carries MCP's `inputResponses` and
 * the server's `requestState`; an agent with someone to ask declares, per request, that it can
 * elicit forms and URLs, so the server may answer `input_required`. Other agents declare nothing.
 */
export function callParams(name: string, args: Record<string, unknown>, meta: Record<string, unknown>, { inputResponses, requestState, elicit }: CallInput = {}) {
  const _meta = { ...meta, ...(elicit ? { "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {}, url: {} } } } : {}) };
  return { name, arguments: args, ...(Object.keys(_meta).length ? { _meta } : {}), ...(inputResponses ? { inputResponses } : {}), ...(requestState !== undefined ? { requestState } : {}) };
}

/**
 * An MCP tool result as a content result: text and images pass through; other content is described in text.
 * File references pass only from the runtime's own servers (`files`): its file tools, and tool sources' saved outputs.
 */
export function contentResult(result: McpResult, files = false) {
  const content = (result.content ?? []).map((part: any) => {
    if (part?.type === "text") return { type: "text", text: String(part.text) };
    if (files && validFileRef(part)) return part;
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
 * content when the tool gave it, else one text block (parsed when it is JSON) or one saved
 * file, else the blocks themselves. A saved file is `{ type: "file", path, contentType, size }`.
 * A tool error throws, as a failed call of any other tool does.
 */
export function scriptValue(value: { content: any[]; isError?: boolean; details?: unknown }) {
  const texts = value.content.filter(part => part.type === "text").map(part => part.text as string);
  if (value.isError) throw new Error(texts.join("\n") || "Tool execution failed");
  if (value.details !== undefined) return value.details;
  if (value.content.length === 1 && texts.length === 1) {
    try { return JSON.parse(texts[0]); } catch { return texts[0]; }
  }
  const content = value.content.map(part => validFileRef(part) ? { type: "file", path: part.path, contentType: part.contentType, size: part.size } : part);
  return content.length === 1 && content[0].type === "file" ? content[0] : content;
}

/** An application's attached server's tools as the agent's own (bare-named) tools. */
export function attachedTools(tools: unknown): ToolDefinition[] {
  if (!Array.isArray(tools)) throw new Error("mcp.tools must be the attached server's tools/list result");
  const definitions = tools.map((tool: McpTool): ToolDefinition => {
    if (!tool || typeof tool !== "object" || typeof tool.name !== "string") throw new Error("Invalid MCP tool");
    if (!tool.inputSchema || typeof tool.inputSchema !== "object" || tool.inputSchema.type !== "object" || !compiles(tool.inputSchema)) throw new Error(`MCP tool ${tool.name}: inputSchema must be a JSON Schema for an object`);
    const meta = tool._meta ?? {};
    const exposure = meta[`${META}exposure`], executionMode = meta[`${META}executionMode`];
    // A tool that asks the user's approval (the SDKs' needsApproval) is declared directly: code cannot wait for the user.
    const approval = meta[`${META}needsApproval`] === true;
    return {
      name: tool.name, description: tool.description || tool.title || tool.name, parameters: tool.inputSchema,
      ...(exposure !== undefined ? { exposure: exposure as ToolDefinition["exposure"] } : {}), ...(executionMode !== undefined ? { executionMode: executionMode as ToolDefinition["executionMode"] } : {}),
      ...(approval ? { exposure: "direct" as const, needsApproval: true } : {}),
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
