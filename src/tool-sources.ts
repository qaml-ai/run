import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Accounts, Sealed } from "./accounts.ts";
import type { ToolDefinition } from "./protocol.ts";
import { errorText } from "./protocol.ts";
import { HttpError } from "./http.ts";
import { compiles, validateDefinitions } from "./tool-policy.ts";
import type { McpConnections, McpServer } from "./mcp.ts";
import type { Outbound } from "./outbound.ts";

/**
 * Server-side tool sources: tools the runtime calls itself, configured in a
 * definition. An agent keeps the sources of the definition revision it has (with
 * their secrets sealed under the definition's id), so tools reach every agent the
 * same way whether or not an application is connected.
 */
export type Exposure = "direct" | "codemode" | "both";
/** An MCP server as a definition stores it: its credentials sealed, their header names kept for display. */
export interface McpServerSpec {
  name: string; url: string;
  headerNames?: string[];
  auth?: { type: "bearer" };
  /** `{ headers, token }`, sealed under `definition:<id>:mcp:<name>`. */
  sealed?: Sealed;
  allowTools?: string[]; denyTools?: string[];
  exposure?: Exposure;
  timeoutMs?: number;
}
export interface Sources { mcpServers?: McpServerSpec[] }
/** The agent a tool call is for, and the definition whose secrets it may unseal. */
export type SourceContext = { tenant: string; agent: string; definition: string };

const SERVER_NAME = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
// Headers the transport sets itself, or that would change how the request is framed or routed.
const RESERVED_HEADERS = new Set(["host", "content-length", "content-type", "accept", "connection", "transfer-encoding", "upgrade", "te", "trailer", "keep-alive",
  "proxy-authorization", "proxy-connection", "mcp-session-id", "mcp-protocol-version", "last-event-id", "cookie"]);
const DEFAULT_TIMEOUT_MS = 60_000;
const LIST_TIMEOUT_MS = 10_000;
const MAX_DESCRIPTION = 4_000;
const TOOL_BUDGET = { count: 128, bytes: 256 * 1024 };

const sealedAad = (definition: string, server: string) => `definition:${definition}:mcp:${server}`;
const bad = (message: string) => new HttpError(400, message);
const strings = (value: unknown, label: string, max: number) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > max || value.some(entry => typeof entry !== "string" || !entry || entry.length > 200)) throw bad(`${label} must be a list of at most ${max} names`);
  return value as string[];
};

/** Credentials as headers: static ones, then a bearer token. Each value is checked for header safety. */
function credentialHeaders(headers: unknown, auth: unknown) {
  const result: Record<string, string> = {};
  if (headers !== undefined) {
    if (!headers || typeof headers !== "object" || Array.isArray(headers) || Object.keys(headers).length > 32) throw bad("headers must be an object of at most 32 headers");
    for (const [name, value] of Object.entries(headers)) {
      if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase()) || name.toLowerCase().startsWith("x-agent-runtime-")) throw bad(`Header ${name} cannot be set`);
      if (typeof value !== "string" || value.length > 8192 || /[\r\n\0]/.test(value)) throw bad(`Header ${name} needs a single-line value of at most 8192 characters`);
      result[name] = value;
    }
  }
  if (auth !== undefined) {
    const { type, token } = (auth ?? {}) as { type?: unknown; token?: unknown };
    if (type === "oauth") throw bad("OAuth for MCP servers is not supported yet; use a bearer token or headers");
    if (type !== "bearer" || typeof token !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(token)) throw bad("auth is { type: \"bearer\", token }");
    if (Object.keys(result).some(name => name.toLowerCase() === "authorization")) throw bad("Give an Authorization header or a bearer token, not both");
    result.Authorization = `Bearer ${token}`;
  }
  return result;
}

/**
 * A definition's `mcpServers` from what a tenant sent: validated, credentials sealed. A server
 * sent without `headers` and `auth` keeps the credentials of the server of the same name and
 * origin, so editing its tool filters does not need its secrets again.
 */
export function mcpServersInput(input: unknown, previous: McpServerSpec[] | undefined, definition: string, context: { accounts?: Accounts; outbound: Outbound }): McpServerSpec[] {
  if (!Array.isArray(input) || input.length > 16) throw bad("mcpServers must be a list of at most 16 servers");
  const names = new Set<string>();
  return input.map((server: any) => {
    if (!server || typeof server !== "object" || Array.isArray(server)) throw bad("An MCP server is { name, url, headers?, auth?, allowTools?, denyTools?, exposure?, timeoutMs? }");
    const { name, url, headers, auth, allowTools, denyTools, exposure, timeoutMs } = server;
    if (typeof name !== "string" || name.length > 32 || !SERVER_NAME.test(name)) throw bad("An MCP server's name is 1–32 letters and digits, single underscores between them, starting with a letter");
    if (names.has(name)) throw bad(`Two MCP servers are named ${name}`);
    names.add(name);
    if (typeof url !== "string" || url.length > 2048) throw bad(`MCP server ${name} needs a url`);
    let checked: URL;
    try { checked = context.outbound.check(url); } catch (error) { throw bad(`MCP server ${name}: ${errorText(error)}`); }
    if (exposure !== undefined && !["direct", "codemode", "both"].includes(exposure)) throw bad("exposure is direct, codemode or both");
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000)) throw bad("timeoutMs is an integer from 1000 to 600000");
    const spec: McpServerSpec = {
      name, url: checked.toString(), ...(allowTools !== undefined ? { allowTools: strings(allowTools, "allowTools", 512) } : {}),
      ...(denyTools !== undefined ? { denyTools: strings(denyTools, "denyTools", 512) } : {}), ...(exposure ? { exposure } : {}), ...(timeoutMs ? { timeoutMs } : {}),
    };
    const kept = headers === undefined && auth === undefined ? previous?.find(other => other.name === name && new URL(other.url).origin === checked.origin) : undefined;
    if (kept?.sealed) return { ...spec, ...(kept.headerNames ? { headerNames: kept.headerNames } : {}), ...(kept.auth ? { auth: kept.auth } : {}), sealed: kept.sealed };
    const credentials = credentialHeaders(headers, auth);
    if (!Object.keys(credentials).length) return spec;
    if (!context.accounts?.canStoreKeys) throw new HttpError(503, "This runtime has no AGENT_SECRETS_KEY, so it cannot store MCP server credentials");
    return {
      ...spec, ...(headers && Object.keys(headers).length ? { headerNames: Object.keys(headers) } : {}), ...(auth ? { auth: { type: "bearer" as const } } : {}),
      sealed: context.accounts.seal(sealedAad(definition, name), JSON.stringify(credentials)),
    };
  });
}

/** What callers see of a server: never its credentials. */
export const mcpServerView = ({ sealed: _sealed, ...server }: McpServerSpec) => server;

/** A model-facing tool name for an MCP tool: `<server>__<tool>`, in the characters tool names allow. */
const mcpToolName = (server: string, tool: string) => `${server}__${tool.replace(/[^A-Za-z0-9_]/g, "_")}`.slice(0, 80);

export class ToolSources {
  private readonly accounts?: Accounts;
  private readonly mcp: McpConnections;

  constructor(options: { accounts?: Accounts; mcp: McpConnections }) {
    this.accounts = options.accounts;
    this.mcp = options.mcp;
  }

  private server(context: SourceContext, spec: McpServerSpec): McpServer {
    const headers = spec.sealed ? JSON.parse(this.accounts!.unseal(sealedAad(context.definition, spec.name), spec.sealed)) as Record<string, string> : {};
    return { url: spec.url, headers };
  }

  private offered(spec: McpServerSpec, tool: Tool) {
    return (!spec.allowTools || spec.allowTools.includes(tool.name)) && !spec.denyTools?.includes(tool.name);
  }

  /** Whether `name` is one of these sources' tools (by name alone: its source says whether it still exists). */
  handles(sources: Sources | undefined, name: string) {
    return !!sources?.mcpServers?.some(server => name.startsWith(`${server.name}__`));
  }

  /**
   * The sources' tools, leaving out names `taken` by other tools and anything past the
   * catalog's limits. A server that cannot be reached contributes nothing this time.
   */
  async definitions(context: SourceContext, sources: Sources | undefined, taken: ToolDefinition[]): Promise<ToolDefinition[]> {
    const lists = await Promise.all((sources?.mcpServers ?? []).map(async spec => {
      try {
        const tools = await withTimeout(this.mcp.tools(context.tenant, this.server(context, spec)), LIST_TIMEOUT_MS);
        return tools.filter(tool => this.offered(spec, tool)).map((tool): ToolDefinition => ({
          name: mcpToolName(spec.name, tool.name), description: (tool.description || tool.title || tool.name).slice(0, MAX_DESCRIPTION),
          parameters: tool.inputSchema as Record<string, unknown>, resultFormat: "content", exposure: spec.exposure ?? "codemode",
        }));
      } catch (error) {
        console.error(JSON.stringify({ type: "mcp_tools_unavailable", tenant: context.tenant, agent: context.agent, server: spec.name, error: errorText(error) }));
        return [];
      }
    }));
    const chosen: ToolDefinition[] = [];
    const names = new Set(taken.map(tool => tool.name));
    let bytes = Buffer.byteLength(JSON.stringify(taken));
    for (const tool of lists.flat()) {
      const size = Buffer.byteLength(JSON.stringify(tool)) + 1;
      if (names.has(tool.name) || names.size >= TOOL_BUDGET.count || bytes + size > TOOL_BUDGET.bytes) continue;
      try { validateDefinitions([tool]); } catch { continue; }
      if (!compiles(tool.parameters)) continue;
      names.add(tool.name);
      bytes += size;
      chosen.push(tool);
    }
    return chosen;
  }

  async call(context: SourceContext, sources: Sources | undefined, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const spec = sources?.mcpServers?.find(server => name.startsWith(`${server.name}__`));
    if (!spec) throw new Error(`Unknown tool ${name}`);
    const server = this.server(context, spec);
    const tool = (await this.mcp.tools(context.tenant, server)).find(entry => this.offered(spec, entry) && mcpToolName(spec.name, entry.name) === name);
    if (!tool) throw new Error(`${spec.name} no longer offers ${name.slice(spec.name.length + 2)}`);
    const result = await this.mcp.call(context.tenant, server, tool.name, args, signal, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return contentResult(result as McpResult);
  }
}

type McpResult = { content?: any[]; structuredContent?: unknown; isError?: boolean; toolResult?: unknown };

/** An MCP tool result as a content result: text and images pass through; other content is described in text. */
function contentResult(result: McpResult) {
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
}
