import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Accounts, Sealed } from "./accounts.ts";
import type { ToolDefinition } from "./protocol.ts";
import { errorText } from "./protocol.ts";
import { HttpError } from "./http.ts";
import { MAX_TIMEOUT_MS, type McpConnections, type McpServer } from "./mcp.ts";
import type { Outbound } from "./outbound.ts";
import type { Claim } from "./ownership.ts";
import type { Scheduler } from "./scheduler.ts";
import type { WebSearch } from "./web-search.ts";
import type { WebRender } from "./web-render.ts";
import { builtinDefinitions, builtinNames, runBuiltin } from "./builtins.ts";
import type { McpResult } from "./mcp-results.ts";
import { callMeta, declaredTimeout, defaultExposure, timedOut, TOOL_DEADLINES, type ToolServer, type ToolSourceView } from "./tool-servers.ts";
import { callScope, type AgentIdentity, type RuntimeSigner } from "./identity.ts";
import { checkDocument, definition as operationTool, operations, parseSpec, request as operationRequest, result as operationResult, type Operation } from "./openapi.ts";
import { acceptFiles, resolveFiles, savedContent, ToolFiles } from "./tool-files.ts";
import { TOOL_FILE_LIMITS } from "./limits.ts";
import type { FileLinks } from "./files.ts";
import type { Mount, VolumeService } from "./volumes.ts";
import type { ToolContext } from "./volume-tools.ts";
import type { HumanInputSettings } from "./inputs.ts";

/**
 * Server-side tool sources: tools the runtime calls itself, configured in a
 * definition. An agent keeps the sources of the definition revision it has (with
 * their secrets sealed under the definition's id), so tools reach every agent the
 * same way whether or not an application is connected.
 */
export type Exposure = "direct" | "codemode" | "both";
/** How a source is authenticated beyond its headers: a stored bearer token, or a token the runtime signs for each request. */
export type SourceAuth = { type: "bearer" } | { type: "runtime" };
/**
 * Which of a source's tools ask the user before each call: `default` for all (never, always, or
 * destructive: MCP tools annotated destructiveHint, OpenAPI operations that are not GET, HEAD or
 * OPTIONS), `tools` by name, and for OpenAPI `methods` (["POST", "DELETE"]). Off by default.
 */
export type ApprovalPolicy = { default?: "never" | "always" | "destructive"; tools?: Record<string, "never" | "always">; methods?: string[] };
/** An MCP server as a definition stores it: its credentials sealed, their header names kept for display. */
export interface McpServerSpec {
  name: string; url: string;
  headerNames?: string[];
  auth?: SourceAuth;
  /** `{ headers, token }`, sealed under `definition:<id>:mcp:<name>`. */
  sealed?: Sealed;
  allowTools?: string[]; denyTools?: string[];
  exposure?: Exposure;
  timeoutMs?: number;
  /** The `aud` of its identity tokens when not its URL (a server behind a proxy, say); auth "runtime" only. */
  audience?: string;
  approval?: ApprovalPolicy;
}
/**
 * An OpenAPI spec as a definition stores it: fetched and checked when the definition is saved,
 * its operations (after allowTools and denyTools) kept, its credentials sealed.
 */
export interface OpenApiSpec {
  name: string;
  /** Where the spec came from; an inline spec has none. Saving the definition fetches it again. */
  spec?: string;
  baseUrl: string;
  operations: Operation[];
  headerNames?: string[];
  auth?: SourceAuth;
  /** `{ headers, token }`, sealed under `definition:<id>:openapi:<name>`. */
  sealed?: Sealed;
  allowTools?: string[]; denyTools?: string[];
  exposure?: Exposure;
  timeoutMs?: number;
  /** The `aud` of its identity tokens when not its URL (a server behind a proxy, say); auth "runtime" only. */
  audience?: string;
  approval?: ApprovalPolicy;
}
/** Built-in tools a definition enables, its remote MCP servers and its OpenAPI specs. */
/** `webSearch.providers`: the order web_search tries providers in for this agent, instead of the runtime's. */
/** `humanInput`: how long inputs wait, what happens when they expire, and who else may answer them (inputs.ts). */
export interface Sources { builtins?: string[]; webSearch?: { providers: string[] }; mcpServers?: McpServerSpec[]; openApi?: OpenApiSpec[]; humanInput?: HumanInputSettings }
/** The agent a tool call is for, its owner's claim on it, the definition whose secrets it may unseal, its mounts (for files in and out), and who hears of files saved. */
export type SourceContext = { tenant: string; agent: string; definition: string; claim?: Claim; identity?: AgentIdentity; mounts?: Mount[]; onWrite?: ToolContext["onWrite"] };

const SERVER_NAME = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
// Headers the transport sets itself, or that would change how the request is framed or routed.
const RESERVED_HEADERS = new Set(["host", "content-length", "content-type", "accept", "connection", "transfer-encoding", "upgrade", "te", "trailer", "keep-alive",
  "proxy-authorization", "proxy-connection", "mcp-session-id", "mcp-protocol-version", "last-event-id", "cookie", "user-agent"]);
const DEFAULT_TIMEOUT_MS = TOOL_DEADLINES.remoteMs;
const LIST_TIMEOUT_MS = 10_000;
const MAX_DESCRIPTION = 4_000;

const sealedAad = (definition: string, name: string, kind: "mcp" | "openapi" = "mcp") => `definition:${definition}:${kind}:${name}`;
const SPEC_BYTES = 8 * 1024 * 1024;
/** At most the agent's whole tool catalog: a bigger API chooses its operations with allowTools. */
const MAX_OPERATIONS = 1024;
/** MCP servers, and OpenAPI specs, per definition. */
const MAX_SOURCES = 64;
const API_TIMEOUT_MS = 30_000;
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
    if (type === "oauth") throw bad("OAuth is not supported yet; use a bearer token, the runtime's identity tokens, or headers");
    if (Object.keys(result).some(name => name.toLowerCase() === "authorization")) throw bad("Give an Authorization header or auth, not both");
    // The runtime's own tokens are minted per request, so nothing is stored for them.
    if (type === "runtime" && token === undefined) return result;
    if (type !== "bearer" || typeof token !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(token)) throw bad("auth is { type: \"bearer\", token } or { type: \"runtime\" }");
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
  if (!Array.isArray(input) || input.length > MAX_SOURCES) throw bad(`mcpServers must be a list of at most ${MAX_SOURCES} servers`);
  const names = new Set<string>();
  return input.map((server: any) => {
    if (!server || typeof server !== "object" || Array.isArray(server)) throw bad("An MCP server is { name, url, headers?, auth?, allowTools?, denyTools?, exposure?, timeoutMs?, approval? }");
    const { name, url, headers, auth, allowTools, denyTools, exposure, timeoutMs, audience, approval } = server;
    if (typeof name !== "string" || name.length > 32 || !SERVER_NAME.test(name)) throw bad("An MCP server's name is 1–32 letters and digits, single underscores between them, starting with a letter");
    if (names.has(name)) throw bad(`Two MCP servers are named ${name}`);
    names.add(name);
    if (typeof url !== "string" || url.length > 2048) throw bad(`MCP server ${name} needs a url`);
    let checked: URL;
    try { checked = context.outbound.check(url); } catch (error) { throw bad(`MCP server ${name}: ${errorText(error)}`); }
    if (exposure !== undefined && !["direct", "codemode", "both"].includes(exposure)) throw bad("exposure is direct, codemode or both");
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS)) throw bad(`timeoutMs is an integer from 1000 to ${MAX_TIMEOUT_MS}`);
    const spec: McpServerSpec = {
      name, url: checked.toString(), ...(allowTools !== undefined ? { allowTools: strings(allowTools, "allowTools", 512) } : {}),
      ...(denyTools !== undefined ? { denyTools: strings(denyTools, "denyTools", 512) } : {}), ...(exposure ? { exposure } : {}), ...(timeoutMs ? { timeoutMs } : {}),
      ...(approval !== undefined ? { approval: approvalInput(approval, `MCP server ${name}`) } : {}),
    };
    const credentials = sealCredentials(headers, auth, previous?.find(other => other.name === name), checked, sealedAad(definition, name), context);
    return { ...spec, ...credentials, ...audienceInput(audience, credentials.auth, `MCP server ${name}`) };
  });
}

/**
 * A definition's `openApi` specs from what a tenant sent: each spec fetched (or given inline),
 * checked, and turned into its operations, with credentials sealed as for MCP servers.
 */
export async function openApiInput(input: unknown, previous: OpenApiSpec[] | undefined, definition: string, context: Context): Promise<OpenApiSpec[]> {
  if (!Array.isArray(input) || input.length > MAX_SOURCES) throw bad(`openApi must be a list of at most ${MAX_SOURCES} specs`);
  const names = new Set<string>();
  return Promise.all(input.map(async (entry: any) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw bad("An OpenAPI source is { name, spec (a URL or the document), baseUrl?, headers?, auth?, allowTools?, denyTools?, exposure?, timeoutMs?, approval? }");
    const { name, spec, baseUrl, headers, auth, allowTools, denyTools, exposure, timeoutMs, audience, approval } = entry;
    if (typeof name !== "string" || name.length > 32 || !SERVER_NAME.test(name)) throw bad("An OpenAPI source's name is 1–32 letters and digits, single underscores between them, starting with a letter");
    if (names.has(name)) throw bad(`Two OpenAPI sources are named ${name}`);
    names.add(name);
    if (exposure !== undefined && !["direct", "codemode", "both"].includes(exposure)) throw bad("exposure is direct, codemode or both");
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS)) throw bad(`timeoutMs is an integer from 1000 to ${MAX_TIMEOUT_MS}`);
    const allow = strings(allowTools, "allowTools", MAX_OPERATIONS), deny = strings(denyTools, "denyTools", 4_096);
    const fail = (error: unknown): never => { throw bad(`OpenAPI source ${name}: ${errorText(error)}`); };
    const kept = previous?.find(other => other.name === name);
    let doc: Record<string, unknown> | undefined;
    let specUrl: string | undefined;
    // Without `spec`, the source keeps the operations it has (an inline spec is not sent back).
    if (spec === undefined && kept) specUrl = kept.spec;
    else if (typeof spec === "string") {
      specUrl = (() => { try { return context.outbound.check(spec).toString(); } catch (error) { return fail(error); } })();
      try {
        const response = await context.outbound.fetch(specUrl, { timeoutMs: 20_000, maxBytes: SPEC_BYTES, maxRedirects: 5, headers: { Accept: "application/json, application/yaml, text/yaml, */*" } });
        if (!response.ok) throw new Error(`fetching the spec answered HTTP ${response.status}`);
        doc = parseSpec(await response.text());
      } catch (error) { return fail(error); }
    } else {
      try { doc = checkDocument(spec); } catch (error) { return fail(error); }
    }
    const api = doc ? operations(doc, specUrl) : { baseUrl: kept!.baseUrl, operations: kept!.operations };
    const base = baseUrl ?? api.baseUrl;
    if (typeof base !== "string" || base.length > 2048) return fail("the spec names no server; give baseUrl");
    let checked: URL;
    try { checked = context.outbound.check(base); } catch (error) { return fail(error); }
    const chosen = api.operations.filter(operation => (!allow || allow.includes(operation.name)) && !deny?.includes(operation.name));
    if (!chosen.length) return fail("no operations left (the spec has none, or allowTools and denyTools leave none out)");
    if (chosen.length > MAX_OPERATIONS) return fail(`${chosen.length} operations; choose at most ${MAX_OPERATIONS} with allowTools`);
    const stored: OpenApiSpec = {
      name, ...(specUrl ? { spec: specUrl } : {}), baseUrl: checked.toString(), operations: chosen,
      ...(allow ? { allowTools: allow } : {}), ...(deny ? { denyTools: deny } : {}), ...(exposure ? { exposure } : {}), ...(timeoutMs ? { timeoutMs } : {}),
      ...(approval !== undefined ? { approval: approvalInput(approval, `OpenAPI source ${name}`, true) } : {}),
    };
    const credentials = sealCredentials(headers, auth, kept && { ...kept, url: kept.baseUrl }, checked, sealedAad(definition, name, "openapi"), context);
    return { ...stored, ...credentials, ...audienceInput(audience, credentials.auth, `OpenAPI source ${name}`) };
  }));
}

function approvalInput(value: any, label: string, openApi = false): ApprovalPolicy {
  const usage = `${label}: approval is { default?: "never" | "always" | "destructive", tools?: { <tool>: "never" | "always" }${openApi ? ", methods?: [\"POST\", ...]" : ""} }`;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["default", "tools", ...(openApi ? ["methods"] : [])].includes(key))) throw bad(usage);
  if (value.default !== undefined && !["never", "always", "destructive"].includes(value.default)) throw bad(usage);
  if (value.tools !== undefined && (!value.tools || typeof value.tools !== "object" || Array.isArray(value.tools) || Object.keys(value.tools).length > 1024 || Object.values(value.tools).some(mode => mode !== "never" && mode !== "always"))) throw bad(usage);
  if (value.methods !== undefined && (!Array.isArray(value.methods) || value.methods.some((method: unknown) => typeof method !== "string" || !["GET", "PUT", "POST", "DELETE", "PATCH", "HEAD", "OPTIONS"].includes(method.toUpperCase())))) throw bad(usage);
  return { ...(value.default ? { default: value.default } : {}), ...(value.tools ? { tools: value.tools } : {}), ...(value.methods ? { methods: value.methods.map((method: string) => method.toUpperCase()) } : {}) };
}

/** Whether a source's policy asks the user before a call of `tool` (its own name, unprefixed). */
function needsApproval(policy: ApprovalPolicy | undefined, tool: string, destructive: boolean, method?: string) {
  const named = policy?.tools?.[tool];
  if (named) return named === "always";
  if (method && policy?.methods?.includes(method.toUpperCase())) return true;
  return policy?.default === "always" || (policy?.default === "destructive" && destructive);
}
/** A tool that asks first is declared to the model directly: code in js_exec cannot wait for the user. */
const gated = (tool: ToolDefinition, ask: boolean): ToolDefinition => ask ? { ...tool, exposure: "direct", needsApproval: true } : tool;
/** What a gated tool answers before it is approved: the runtime's approval request, as MCP's `input_required`. */
const APPROVAL_REQUIRED: McpResult = { resultType: "input_required", inputRequests: { approval: { method: "agent-runtime/approval", params: {} } } };

/** What callers see of an OpenAPI source: its tools' names, never its credentials. */
export const openApiView = ({ sealed: _sealed, operations: list, ...source }: OpenApiSpec) => ({ ...source, tools: list.map(operation => operation.name) });

/**
 * Sealed credentials for a server at `url`. Sent without `headers` and `auth`, it keeps
 * those of its namesake in `previous`, but only at the same origin: credentials belong to it.
 */
function sealCredentials(headers: unknown, auth: unknown, previous: { url: string; headerNames?: string[]; auth?: SourceAuth; sealed?: Sealed } | undefined, url: URL, aad: string, context: Context) {
  const kept = headers === undefined && auth === undefined && previous && new URL(previous.url).origin === url.origin ? previous : undefined;
  if (kept?.sealed || kept?.auth) return { ...(kept.headerNames ? { headerNames: kept.headerNames } : {}), ...(kept.auth ? { auth: kept.auth } : {}), ...(kept.sealed ? { sealed: kept.sealed } : {}) };
  const credentials = credentialHeaders(headers, auth);
  const runtime = (auth as { type?: unknown } | undefined)?.type === "runtime";
  if (runtime && !context.accounts?.canStoreKeys) throw new HttpError(503, "This runtime has no AGENT_SECRETS_KEY, so it cannot sign identity tokens");
  const kind: SourceAuth | undefined = runtime ? { type: "runtime" } : auth ? { type: "bearer" } : undefined;
  if (!Object.keys(credentials).length) return kind ? { auth: kind } : {};
  if (!context.accounts?.canStoreKeys) throw new HttpError(503, "This runtime has no AGENT_SECRETS_KEY, so it cannot store credentials");
  return {
    ...(headers && Object.keys(headers).length ? { headerNames: Object.keys(headers) } : {}), ...(kind ? { auth: kind } : {}),
    sealed: context.accounts.seal(aad, JSON.stringify(credentials)),
  };
}

/** An identity token audience other than the source's URL: only with auth "runtime". */
function audienceInput(audience: unknown, auth: SourceAuth | undefined, label: string) {
  if (audience === undefined) return {};
  if (typeof audience !== "string" || !audience.trim() || audience.length > 2048) throw bad(`${label}: audience is a string of 1–2048 characters`);
  if (auth?.type !== "runtime") throw bad(`${label}: audience is for auth { type: "runtime" }, whose tokens it names`);
  return { audience };
}

/** What callers see of a server: never its credentials. */
export const mcpServerView = ({ sealed: _sealed, ...server }: McpServerSpec) => server;

/** A model-facing tool name for an MCP tool: `<server>__<tool>`, in the characters tool names allow. */
const mcpToolName = (server: string, tool: string) => `${server}__${tool.replace(/[^A-Za-z0-9_]/g, "_")}`.slice(0, 80);

export class ToolSources {
  private readonly accounts?: Accounts;
  private readonly mcp: McpConnections;
  private readonly outbound: Outbound;
  private readonly options: { scheduler?: Scheduler; search?: WebSearch; render?: WebRender; volumes?: VolumeService; links?: FileLinks };

  private readonly signer?: RuntimeSigner;

  constructor(options: { accounts?: Accounts; mcp: McpConnections; outbound: Outbound; scheduler?: Scheduler; signer?: RuntimeSigner; search?: WebSearch; render?: WebRender; volumes?: VolumeService; links?: FileLinks }) {
    this.accounts = options.accounts;
    this.mcp = options.mcp;
    this.outbound = options.outbound;
    this.signer = options.signer;
    // Kept whole: the scheduler, volumes and links may be getters for ones made later.
    this.options = options;
  }

  private headers(aad: string, sealed: Sealed | undefined): Record<string, string> {
    return sealed ? JSON.parse(this.accounts!.unseal(aad, sealed)) : {};
  }
  /** A fresh identity token for a request to `audience`, for the turn the request is made in. */
  private identityToken(context: SourceContext, audience: string, call = callScope.getStore()) {
    if (!this.signer) throw new Error("This runtime cannot sign identity tokens");
    return this.signer.token(audience, { tenant: context.tenant, agent: context.agent, definition: context.definition, ...(context.identity ? { identity: context.identity } : {}), ...call });
  }
  private endpoint(context: SourceContext, spec: McpServerSpec): McpServer {
    const headers = this.headers(sealedAad(context.definition, spec.name), spec.sealed);
    if (spec.auth?.type !== "runtime") return { url: spec.url, headers };
    // Each request is signed for the turn it is made in (callScope), and each agent has its own session.
    return { url: spec.url, headers, token: () => this.identityToken(context, spec.audience ?? spec.url), scope: context.agent };
  }

  private offered(spec: McpServerSpec, tool: Tool) {
    return (!spec.allowTools || spec.allowTools.includes(tool.name)) && !spec.denyTools?.includes(tool.name);
  }

  /** An MCP server's tools as the model sees them: those the definition offers, named `<server>__<tool>`. */
  private definitions(spec: McpServerSpec, tools: Tool[]) {
    // A tool's own exposure (its `_meta`, as attached servers set it) beats the source's; one that asks for approval is direct.
    const own = (tool: Tool) => { const exposure = tool._meta?.["agent-runtime/exposure"]; return ["direct", "codemode", "both"].includes(exposure as string) ? { exposure: exposure as Exposure } : {}; };
    return defaultExposure(tools.filter(tool => this.offered(spec, tool)).map((tool): ToolDefinition => gated({
      name: mcpToolName(spec.name, tool.name), description: (tool.description || tool.title || tool.name).slice(0, MAX_DESCRIPTION),
      parameters: acceptFiles(tool.inputSchema), ...own(tool),
    }, needsApproval(spec.approval, tool.name, tool.annotations?.destructiveHint === true))), spec.exposure);
  }

  /**
   * The tool server for an agent's sources: its built-ins, and its remote MCP servers' tools as
   * `<server>__<tool>`. A server that cannot be reached contributes no tools this time.
   */
  /**
   * List a definition's MCP servers as it is saved, as an agent made from it would: what each offers, or why it could
   * not be listed. A server that refuses the definition's credentials (401, 403) is a mistake in them: a 400 now.
   */
  async listed(tenant: string, definition: string, servers: McpServerSpec[]): Promise<ToolSourceView[]> {
    const context: SourceContext = { tenant, agent: definition, definition, mounts: [] };
    return Promise.all(servers.map(async (spec): Promise<ToolSourceView> => {
      const source = { kind: "mcp" as const, name: spec.name, url: spec.url, ...(spec.exposure ? { exposure: spec.exposure } : {}) };
      try {
        const tools = this.definitions(spec, await withTimeout(this.mcp.tools(tenant, this.endpoint(context, spec)), LIST_TIMEOUT_MS));
        return { ...source, status: "listed", listedAt: Date.now(), tools };
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 401 || status === 403) throw new HttpError(400, `MCP server ${spec.name} refused the definition's credentials (HTTP ${status}): check its headers or auth${spec.auth?.type === "runtime" ? ", and the audience its tokens are checked against" : ""}. ${errorText(error)}`);
        return { ...source, status: "error", error: errorText(error), listedAt: Date.now(), tools: [] };
      }
    }));
  }

  server(context: SourceContext, sources: Sources | undefined): ToolServer {
    const builtins = builtinNames(sources?.builtins);
    const mcpServer = (name: string) => sources?.mcpServers?.find(server => name.startsWith(`${server.name}__`));
    const apiAsks = (api: OpenApiSpec, operation: Operation) => needsApproval(api.approval, operation.name, !operation.readOnly, operation.method);
    const apiTools = (api: OpenApiSpec) => defaultExposure(api.operations.map(operation => gated(operationTool(api.name, operation), apiAsks(api, operation))), api.exposure);
    type Listing = { tools: ToolDefinition[]; at: number } | { error: string; at: number };
    const list = async (spec: McpServerSpec): Promise<Listing> => {
      try {
        return { tools: this.definitions(spec, await withTimeout(this.mcp.tools(context.tenant, this.endpoint(context, spec)), LIST_TIMEOUT_MS)), at: Date.now() };
      } catch (error) {
        console.error(JSON.stringify({ type: "mcp_tools_unavailable", tenant: context.tenant, agent: context.agent, server: spec.name, error: errorText(error) }));
        return { error: errorText(error), at: Date.now() };
      }
    };
    // What each MCP server listed when the agent's tools were last built: what its model has.
    const listed = new Map<string, Listing>();
    // What the calls of the current run may still save to the workspace.
    let run = { id: undefined as string | undefined, left: TOOL_FILE_LIMITS.runBytes };
    const files = (tool: string, id: string | undefined) => {
      const volumes = this.options.volumes;
      if (!volumes || !context.mounts?.length) return undefined;
      if (!id || id !== run.id) run = { id, left: TOOL_FILE_LIMITS.runBytes };
      return new ToolFiles({ volumes, links: this.options.links, tenant: context.tenant, agent: context.agent, mounts: context.mounts, tool, run, onWrite: context.onWrite });
    };
    return {
      // Only saved outputs: remote servers' own file references are dropped (savedContent).
      returnsFiles: true,
      tools: async () => {
        const lists = await Promise.all((sources?.mcpServers ?? []).map(async spec => {
          const listing = await list(spec);
          listed.set(spec.name, listing);
          return "tools" in listing ? listing.tools : [];
        }));
        return [...builtinDefinitions(sources?.builtins), ...(sources?.openApi ?? []).flatMap(apiTools), ...lists.flat()];
      },
      sources: async ({ refresh }) => {
        const known = (spec: McpServerSpec): Listing | undefined => {
          const found = listed.get(spec.name);
          if (found) return found;
          // Listed on this node for another agent, or before this one's tools were built.
          try {
            const cached = this.mcp.cached(context.tenant, this.endpoint(context, spec));
            return cached && { tools: this.definitions(spec, cached.list), at: cached.at };
          } catch (error) { return { error: errorText(error), at: Date.now() }; }
        };
        const mcp = await Promise.all((sources?.mcpServers ?? []).map(async (spec): Promise<ToolSourceView> => {
          const listing = refresh ? await list(spec) : known(spec);
          const source = { kind: "mcp" as const, name: spec.name, url: spec.url, ...(spec.exposure ? { exposure: spec.exposure } : {}) };
          if (!listing) return { ...source, status: "unlisted", tools: [] };
          if ("error" in listing) return { ...source, status: "error", error: listing.error, listedAt: listing.at, tools: [] };
          return { ...source, status: "listed", listedAt: listing.at, tools: listing.tools };
        }));
        return [
          ...(sources?.builtins ?? []).map((name): ToolSourceView => ({ kind: "builtin", name, status: "listed", tools: builtinDefinitions([name]) })),
          ...(sources?.openApi ?? []).map((api): ToolSourceView => ({ kind: "openapi", name: api.name, url: api.baseUrl, ...(api.exposure ? { exposure: api.exposure } : {}), status: "listed", tools: apiTools(api) })),
          ...mcp,
        ];
      },
      call: async ({ name, args, signal, origin, actor, run: runId, toolCallId, innerCallId, idempotencyKey, onProgress, approval, inputResponses, requestState, elicit }) => {
        // An approved call proves it to the tool: in its identity token and its `_meta`.
        const turn = { ...(actor ? { actor } : {}), ...(origin ? { origin } : {}), ...(approval ? { approval } : {}) };
        const callFiles = files(name, runId);
        if (builtins.includes(name)) {
          const services = { outbound: this.outbound, scheduler: this.options.scheduler, search: this.options.search, render: this.options.render };
          return runBuiltin(services, { ...context, ...(sources?.webSearch ? { searchProviders: sources.webSearch.providers } : {}), ...(callFiles ? { files: callFiles } : {}) }, name, args, signal);
        }
        const api = sources?.openApi?.find(entry => name.startsWith(`${entry.name}__`));
        const operation = api?.operations.find(entry => operationTool(api.name, entry).name === name);
        if (api && operation) {
          if (apiAsks(api, operation) && !approval) return APPROVAL_REQUIRED;
          const { url, init } = await operationRequest(api.baseUrl, operation, args, callFiles);
          const secrets = this.headers(sealedAad(context.definition, api.name, "openapi"), api.sealed);
          if (api.auth?.type === "runtime") secrets.Authorization = `Bearer ${await this.identityToken(context, api.audience ?? api.baseUrl, turn)}`;
          // The call's key, as APIs that dedupe writes take one (Stripe's convention).
          if (idempotencyKey) init.headers = { ...init.headers as Record<string, string>, "Idempotency-Key": idempotencyKey };
          // Text answers are capped lower as they are read (openapi.ts).
          const response = await this.outbound.fetch(url, { ...init, signal, timeoutMs: api.timeoutMs ?? API_TIMEOUT_MS, maxBytes: TOOL_FILE_LIMITS.responseBytes, secrets });
          return operationResult(operation, response, callFiles);
        }
        const spec = mcpServer(name);
        if (!spec) throw new Error(`Unknown tool ${name}`);
        const server = this.endpoint(context, spec);
        const tool = (await this.mcp.tools(context.tenant, server)).find(entry => this.offered(spec, entry) && mcpToolName(spec.name, entry.name) === name);
        if (!tool) throw new Error(`${spec.name} no longer offers ${name.slice(spec.name.length + 2)}`);
        if (needsApproval(spec.approval, tool.name, tool.annotations?.destructiveHint === true) && !approval) return APPROVAL_REQUIRED;
        const resolved = await resolveFiles(args, tool.inputSchema, callFiles) as Record<string, unknown>;
        // The tool's own deadline (its listing's _meta), else the server's, else the default; progress restarts it.
        let timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        try { timeoutMs = declaredTimeout(tool._meta) ?? timeoutMs; } catch { /* a server's invalid deadline is ignored */ }
        const result = await callScope.run(turn, () => this.mcp.call(context.tenant, server, tool.name, resolved, signal, { timeoutMs, maxTotalMs: MAX_TIMEOUT_MS }, { ...callMeta({ toolCallId, innerCallId, idempotencyKey, origin, actor }), ...(approval ? { "agent-runtime/approval": approval } : {}) }, onProgress, { inputResponses, requestState, elicit }))
          .catch(error => { throw !signal.aborted && error instanceof McpError && error.code === ErrorCode.RequestTimeout ? timedOut(timeoutMs) : error; }) as McpResult;
        return savedContent(result, callFiles);
      },
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
}
