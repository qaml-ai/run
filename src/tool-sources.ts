import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Accounts, Sealed } from "./accounts.ts";
import type { ToolDefinition } from "./protocol.ts";
import { errorText } from "./protocol.ts";
import { HttpError } from "./http.ts";
import type { McpConnections, McpServer } from "./mcp.ts";
import type { Outbound } from "./outbound.ts";
import type { Claim } from "./ownership.ts";
import type { Scheduler } from "./scheduler.ts";
import { builtinDefinitions, builtinNames, runBuiltin } from "./builtins.ts";
import type { McpResult } from "./mcp-results.ts";
import { jsonResult, type ToolServer } from "./tool-servers.ts";

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
/** Built-in tools a definition enables, and its remote MCP servers. */
export interface Sources { builtins?: string[]; mcpServers?: McpServerSpec[] }
/** The agent a tool call is for, its owner's claim on it, and the definition whose secrets it may unseal. */
export type SourceContext = { tenant: string; agent: string; definition: string; claim?: Claim };

const SERVER_NAME = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
// Headers the transport sets itself, or that would change how the request is framed or routed.
const RESERVED_HEADERS = new Set(["host", "content-length", "content-type", "accept", "connection", "transfer-encoding", "upgrade", "te", "trailer", "keep-alive",
  "proxy-authorization", "proxy-connection", "mcp-session-id", "mcp-protocol-version", "last-event-id", "cookie", "user-agent"]);
const DEFAULT_TIMEOUT_MS = 60_000;
const LIST_TIMEOUT_MS = 10_000;
const MAX_DESCRIPTION = 4_000;

const sealedAad = (definition: string, name: string) => `definition:${definition}:mcp:${name}`;
type Context = { accounts?: Accounts; outbound: Outbound };
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
    if (type === "oauth") throw bad("OAuth is not supported yet; use a bearer token or headers");
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
export function mcpServersInput(input: unknown, previous: McpServerSpec[] | undefined, definition: string, context: Context): McpServerSpec[] {
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
    return { ...spec, ...sealCredentials(headers, auth, previous?.find(other => other.name === name), checked, sealedAad(definition, name), context) };
  });
}

/**
 * Sealed credentials for a server at `url`. Sent without `headers` and `auth`, it keeps
 * those of its namesake in `previous`, but only at the same origin: credentials belong to it.
 */
function sealCredentials(headers: unknown, auth: unknown, previous: { url: string; headerNames?: string[]; auth?: { type: "bearer" }; sealed?: Sealed } | undefined, url: URL, aad: string, context: Context) {
  const kept = headers === undefined && auth === undefined && previous && new URL(previous.url).origin === url.origin ? previous : undefined;
  if (kept?.sealed) return { ...(kept.headerNames ? { headerNames: kept.headerNames } : {}), ...(kept.auth ? { auth: kept.auth } : {}), sealed: kept.sealed };
  const credentials = credentialHeaders(headers, auth);
  if (!Object.keys(credentials).length) return {};
  if (!context.accounts?.canStoreKeys) throw new HttpError(503, "This runtime has no AGENT_SECRETS_KEY, so it cannot store credentials");
  return {
    ...(headers && Object.keys(headers).length ? { headerNames: Object.keys(headers) } : {}), ...(auth ? { auth: { type: "bearer" as const } } : {}),
    sealed: context.accounts.seal(aad, JSON.stringify(credentials)),
  };
}

/** What callers see of a server: never its credentials. */
export const mcpServerView = ({ sealed: _sealed, ...server }: McpServerSpec) => server;

/** A model-facing tool name for an MCP tool: `<server>__<tool>`, in the characters tool names allow. */
const mcpToolName = (server: string, tool: string) => `${server}__${tool.replace(/[^A-Za-z0-9_]/g, "_")}`.slice(0, 80);

export class ToolSources {
  private readonly accounts?: Accounts;
  private readonly mcp: McpConnections;
  private readonly outbound: Outbound;
  private readonly options: { scheduler?: Scheduler };

  constructor(options: { accounts?: Accounts; mcp: McpConnections; outbound: Outbound; scheduler?: Scheduler }) {
    this.accounts = options.accounts;
    this.mcp = options.mcp;
    this.outbound = options.outbound;
    // Kept whole: the scheduler may be a getter for one made later.
    this.options = options;
  }

  private headers(aad: string, sealed: Sealed | undefined): Record<string, string> {
    return sealed ? JSON.parse(this.accounts!.unseal(aad, sealed)) : {};
  }
  private endpoint(context: SourceContext, spec: McpServerSpec): McpServer {
    return { url: spec.url, headers: this.headers(sealedAad(context.definition, spec.name), spec.sealed) };
  }

  private offered(spec: McpServerSpec, tool: Tool) {
    return (!spec.allowTools || spec.allowTools.includes(tool.name)) && !spec.denyTools?.includes(tool.name);
  }

  /**
   * The tool server for an agent's sources: its built-ins, and its remote MCP servers' tools as
   * `<server>__<tool>`. A server that cannot be reached contributes no tools this time.
   */
  server(context: SourceContext, sources: Sources | undefined): ToolServer {
    const builtins = builtinNames(sources?.builtins);
    const mcpServer = (name: string) => sources?.mcpServers?.find(server => name.startsWith(`${server.name}__`));
    return {
      tools: async () => {
        const lists = await Promise.all((sources?.mcpServers ?? []).map(async spec => {
          try {
            const tools = await withTimeout(this.mcp.tools(context.tenant, this.endpoint(context, spec)), LIST_TIMEOUT_MS);
            return tools.filter(tool => this.offered(spec, tool)).map((tool): ToolDefinition => ({
              name: mcpToolName(spec.name, tool.name), description: (tool.description || tool.title || tool.name).slice(0, MAX_DESCRIPTION),
              parameters: tool.inputSchema as Record<string, unknown>, exposure: spec.exposure ?? "codemode",
            }));
          } catch (error) {
            console.error(JSON.stringify({ type: "mcp_tools_unavailable", tenant: context.tenant, agent: context.agent, server: spec.name, error: errorText(error) }));
            return [];
          }
        }));
        return [...builtinDefinitions(sources?.builtins), ...lists.flat()];
      },
      call: async ({ name, args, signal, origin }) => {
        if (builtins.includes(name)) return jsonResult(await runBuiltin({ outbound: this.outbound, scheduler: this.options.scheduler }, context, name, args, signal));
        const spec = mcpServer(name);
        if (!spec) throw new Error(`Unknown tool ${name}`);
        const server = this.endpoint(context, spec);
        const tool = (await this.mcp.tools(context.tenant, server)).find(entry => this.offered(spec, entry) && mcpToolName(spec.name, entry.name) === name);
        if (!tool) throw new Error(`${spec.name} no longer offers ${name.slice(spec.name.length + 2)}`);
        return await this.mcp.call(context.tenant, server, tool.name, args, signal, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS, origin && { "agent-runtime/origin": origin }) as McpResult;
      },
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
}
