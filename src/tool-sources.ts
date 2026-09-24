import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Accounts, Sealed } from "./accounts.ts";
import type { ToolDefinition } from "./protocol.ts";
import { errorText } from "./protocol.ts";
import { HttpError } from "./http.ts";
import { compiles, validateDefinitions } from "./tool-policy.ts";
import type { McpConnections, McpServer } from "./mcp.ts";
import type { Outbound } from "./outbound.ts";
import type { Claim } from "./ownership.ts";
import type { Scheduler } from "./scheduler.ts";
import { builtinDefinitions, builtinNames, runBuiltin } from "./builtins.ts";
import { contentResult, type McpResult } from "./mcp-results.ts";

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
/** A tool the runtime answers by sending its arguments to a URL, signed with the definition's secret. */
export interface HttpToolSpec {
  name: string; description: string; inputSchema: Record<string, unknown>;
  url: string; method: "POST" | "PUT" | "PATCH";
  headerNames?: string[];
  auth?: { type: "bearer" };
  /** Its headers, sealed under `definition:<id>:http:<name>`. */
  sealed?: Sealed;
  timeoutMs?: number;
  exposure?: Exposure;
  executionMode?: "sequential" | "parallel";
}
/** `signing` is the definition's HTTP tool signing secret, sealed under `definition:<id>:signing`. */
export interface Sources { builtins?: string[]; mcpServers?: McpServerSpec[]; httpTools?: HttpToolSpec[]; signing?: Sealed }
/** The agent a tool call is for, its owner's claim on it, and the definition whose secrets it may unseal. */
export type SourceContext = { tenant: string; agent: string; definition: string; claim?: Claim };

const SERVER_NAME = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
// Headers the transport sets itself, or that would change how the request is framed or routed.
const RESERVED_HEADERS = new Set(["host", "content-length", "content-type", "accept", "connection", "transfer-encoding", "upgrade", "te", "trailer", "keep-alive",
  "proxy-authorization", "proxy-connection", "mcp-session-id", "mcp-protocol-version", "last-event-id", "cookie", "user-agent", "webhook-id", "webhook-timestamp", "webhook-signature"]);
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/;
const DEFAULT_TIMEOUT_MS = 60_000;
const HTTP_TIMEOUT_MS = 30_000;
const HTTP_RESULT_BYTES = 1024 * 1024;
const LIST_TIMEOUT_MS = 10_000;
const MAX_DESCRIPTION = 4_000;
const TOOL_BUDGET = { count: 128, bytes: 256 * 1024 };

const sealedAad = (definition: string, name: string, kind: "mcp" | "http" = "mcp") => `definition:${definition}:${kind}:${name}`;
export const signingAad = (definition: string) => `definition:${definition}:signing`;
/** A new signing secret, in the Standard Webhooks format (`whsec_` and base64 key bytes). */
export const newSigningSecret = () => `whsec_${randomBytes(32).toString("base64")}`;
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
 * Sealed credentials for a server or tool at `url`. Sent without `headers` and `auth`, it keeps
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

/** A definition's `httpTools` from what a tenant sent: validated, headers sealed as for MCP servers. */
export function httpToolsInput(input: unknown, previous: HttpToolSpec[] | undefined, definition: string, context: Context): HttpToolSpec[] {
  if (!Array.isArray(input) || input.length > 64) throw bad("httpTools must be a list of at most 64 tools");
  const names = new Set<string>();
  return input.map((tool: any) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) throw bad("An HTTP tool is { name, description, inputSchema, url, method?, headers?, auth?, timeoutMs?, exposure?, executionMode? }");
    const { name, description, inputSchema, url, method = "POST", headers, auth, timeoutMs, exposure, executionMode } = tool;
    if (typeof name !== "string" || name.length > 80 || !TOOL_NAME.test(name)) throw bad("An HTTP tool's name is letters and digits, single underscores between them, starting with a letter");
    if (names.has(name)) throw bad(`Two HTTP tools are named ${name}`);
    names.add(name);
    if (typeof description !== "string" || !description.trim() || description.length > MAX_DESCRIPTION) throw bad(`HTTP tool ${name} needs a description of at most ${MAX_DESCRIPTION} characters`);
    try { validateDefinitions([{ name, description, parameters: inputSchema, ...(exposure !== undefined ? { exposure } : {}), ...(executionMode !== undefined ? { executionMode } : {}) }]); }
    catch (error) { throw bad(`HTTP tool ${name}: ${errorText(error)}`); }
    if (!compiles(inputSchema) || inputSchema.type !== "object") throw bad(`HTTP tool ${name}: inputSchema must be a JSON Schema for an object`);
    if (!["POST", "PUT", "PATCH"].includes(method)) throw bad("method is POST, PUT or PATCH");
    if (typeof url !== "string" || url.length > 2048) throw bad(`HTTP tool ${name} needs a url`);
    let checked: URL;
    try { checked = context.outbound.check(url); } catch (error) { throw bad(`HTTP tool ${name}: ${errorText(error)}`); }
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000)) throw bad("timeoutMs is an integer from 1000 to 300000");
    return {
      name, description, inputSchema, url: checked.toString(), method, ...(timeoutMs ? { timeoutMs } : {}), ...(exposure ? { exposure } : {}), ...(executionMode ? { executionMode } : {}),
      ...sealCredentials(headers, auth, previous?.find(other => other.name === name), checked, sealedAad(definition, name, "http"), context),
    };
  });
}

/** What callers see of an HTTP tool: never its credentials. */
export const httpToolView = ({ sealed: _sealed, ...tool }: HttpToolSpec) => tool;

/** Standard Webhooks signature headers for `body`, so a receiver can check the request came from this runtime, unchanged and recently. */
export function signatureHeaders(secret: string, body: string, id = `call_${randomUUID()}`, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": `v1,${signature}` };
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
  private server(context: SourceContext, spec: McpServerSpec): McpServer {
    return { url: spec.url, headers: this.headers(sealedAad(context.definition, spec.name), spec.sealed) };
  }

  private offered(spec: McpServerSpec, tool: Tool) {
    return (!spec.allowTools || spec.allowTools.includes(tool.name)) && !spec.denyTools?.includes(tool.name);
  }

  /** Whether `name` is one of these sources' tools (by name alone: its source says whether it still exists). */
  handles(sources: Sources | undefined, name: string) {
    return !!sources?.mcpServers?.some(server => name.startsWith(`${server.name}__`)) || !!sources?.httpTools?.some(tool => tool.name === name) || builtinNames(sources?.builtins).includes(name);
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
    const http = (sources?.httpTools ?? []).map((tool): ToolDefinition => ({
      name: tool.name, description: tool.description, parameters: tool.inputSchema, exposure: tool.exposure ?? "codemode", ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
    }));
    const chosen: ToolDefinition[] = [];
    const names = new Set(taken.map(tool => tool.name));
    let bytes = Buffer.byteLength(JSON.stringify(taken));
    for (const tool of [...builtinDefinitions(sources?.builtins), ...http, ...lists.flat()]) {
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
    if (builtinNames(sources?.builtins).includes(name)) return runBuiltin({ outbound: this.outbound, scheduler: this.options.scheduler }, context, name, args, signal);
    const http = sources?.httpTools?.find(tool => tool.name === name);
    if (http) return this.send(context, sources!, http, args, signal);
    const spec = sources?.mcpServers?.find(server => name.startsWith(`${server.name}__`));
    if (!spec) throw new Error(`Unknown tool ${name}`);
    const server = this.server(context, spec);
    const tool = (await this.mcp.tools(context.tenant, server)).find(entry => this.offered(spec, entry) && mcpToolName(spec.name, entry.name) === name);
    if (!tool) throw new Error(`${spec.name} no longer offers ${name.slice(spec.name.length + 2)}`);
    const result = await this.mcp.call(context.tenant, server, tool.name, args, signal, spec.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return contentResult(result as McpResult);
  }

  /** Send an HTTP tool's arguments as signed JSON; its answer is the JSON (or text) it responds with. */
  private async send(context: SourceContext, sources: Sources, tool: HttpToolSpec, args: Record<string, unknown>, signal: AbortSignal) {
    if (!sources.signing) throw new Error("This agent's definition has no signing secret for HTTP tools");
    const body = JSON.stringify(args);
    const response = await this.outbound.fetch(tool.url, {
      method: tool.method, body, signal, timeoutMs: tool.timeoutMs ?? HTTP_TIMEOUT_MS, maxBytes: HTTP_RESULT_BYTES,
      headers: {
        "Content-Type": "application/json", "User-Agent": "agent-runtime", "X-Agent-Runtime-Agent": context.agent, "X-Agent-Runtime-Tool": tool.name,
        ...signatureHeaders(this.accounts!.unseal(signingAad(context.definition), sources.signing), body),
      },
      secrets: this.headers(sealedAad(context.definition, tool.name, "http"), tool.sealed),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${tool.name} answered HTTP ${response.status}${text ? `: ${text.slice(0, 1000)}` : ""}`);
    if (!/[/+]json\b/i.test(response.headers.get("content-type") ?? "")) return text;
    try { return text ? JSON.parse(text) : null; }
    catch { throw new Error(`${tool.name} answered with invalid JSON`); }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
}
