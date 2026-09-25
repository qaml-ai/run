import type { ToolDefinition } from "./protocol.ts";
import type { McpResult } from "./mcp-results.ts";
import { compiles, validateDefinitions } from "./tool-policy.ts";
import { CATALOG_LIMITS } from "./limits.ts";

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
  /**
   * What each of its sources offers, for callers to see (GET /v1/agents/:id): from what is already
   * known, unless `refresh` lists remote sources now. Without it, the server shows as one source.
   */
  sources?(options: { refresh?: boolean }): Promise<ToolSourceView[]>;
}

/** One source of an agent's tools and what it offers, as callers see it. */
export interface ToolSourceView {
  kind: "channel" | "application" | "files" | "builtin" | "mcp" | "openapi";
  name: string;
  /** listed: its tools are known; unlisted: an MCP server this node has not listed yet; error: listing it failed. */
  status: "listed" | "unlisted" | "error";
  error?: string;
  /** When an MCP server was last listed (or its listing failed). */
  listedAt?: number;
  /** The application source: whether the application is connected to answer its tools. */
  connected?: boolean;
  url?: string;
  exposure?: ToolDefinition["exposure"];
  tools: ToolDefinition[];
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

const BUDGET = { count: CATALOG_LIMITS.tools, bytes: CATALOG_LIMITS.bytes };
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
 * The catalog's rules, applied to tools in order of precedence: a name an earlier tool has is
 * left out, as is a tool that is invalid or past the catalog's limits. `visit` sees every tool,
 * with the reason it is left out, if it is.
 */
function select(lists: ToolDefinition[][], visit: (list: number, tool: ToolDefinition, excluded?: string) => void) {
  const names = new Set<string>();
  let bytes = 0, direct = 0;
  lists.forEach((list, index) => {
    for (const listed of list) {
      const tool: ToolDefinition = { ...listed, resultFormat: "content" };
      const size = Buffer.byteLength(JSON.stringify(tool)) + 1;
      const excluded = names.has(tool.name) ? "an earlier source has a tool of this name"
        : names.size >= BUDGET.count ? `past the catalog's limit of ${BUDGET.count} tools`
        : bytes + size > BUDGET.bytes ? `past the catalog's limit of ${BUDGET.bytes / 1024} KiB`
        : !valid(tool) ? "its name or input schema is not valid" : undefined;
      if (!excluded) { names.add(tool.name); bytes += size; }
      // Past the model's budget of direct tools, tools offered both ways are reached from js_exec
      // only, earlier servers keeping theirs: many small sources must not crowd the model's context.
      if (!excluded && (tool.exposure === "direct" || tool.exposure === "both")) {
        if (direct < CATALOG_LIMITS.direct || tool.exposure === "direct") direct++;
        else tool.exposure = "codemode";
      }
      visit(index, tool, excluded);
    }
  });
}
function valid(tool: ToolDefinition) {
  try { validateDefinitions([tool]); } catch { return false; }
  return compiles(tool.parameters);
}

/**
 * An agent's tools from its servers in order of precedence (see `select`). Every tool answers
 * with an MCP result; `route` sends each call to the server that listed it.
 */
export async function compose(servers: ToolServer[]): Promise<{ tools: ToolDefinition[]; route: Map<string, ToolServer> }> {
  const lists = await Promise.all(servers.map(server => server.tools()));
  const tools: ToolDefinition[] = [];
  const route = new Map<string, ToolServer>();
  select(lists, (index, tool, excluded) => {
    if (excluded) return;
    route.set(tool.name, servers[index]);
    tools.push(tool);
  });
  return { tools, route };
}

/**
 * Sources as callers see them: each tool marked with why the model does not get it, if it
 * does not, and its input schema left out unless `schemas`.
 */
export function describeSources(sources: ToolSourceView[], schemas = false) {
  const views = sources.map(source => ({ ...source, tools: [] as (Omit<ToolDefinition, "parameters" | "resultFormat"> & { parameters?: Record<string, unknown>; excluded?: string })[] }));
  select(sources.map(source => source.tools), (index, { resultFormat: _format, parameters, ...tool }, excluded) => {
    views[index].tools.push({ ...tool, ...(schemas ? { parameters } : {}), ...(excluded ? { excluded } : {}) });
  });
  return views;
}
