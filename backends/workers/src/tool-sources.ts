import { TOOL_FILE_LIMITS } from '../../../src/limits.ts';
import { acceptFiles, resolveFiles, takesFiles, hasFileArgument } from './tool-file-schema.ts';
import { savedContent, multipartBody, type ToolFiles } from './tool-files.ts';
import { textual } from './file-policy.ts';
import { legacyMcpRequest } from "./legacy-mcp.ts";
import { pacedProgress, progressEvent, silenceDeadline, type Progress, type ToolProgressEvent } from "./mcp-progress.ts";
import { Outbound } from "./security-outbound.ts";
import { ownAudience, mcpToolName } from "./source-input-policy.ts";
import { DENIED_PERMISSION, type JudgeInput, type Judged } from "./tool-judge.ts";
import { approvalFor } from "./tool-call-policy.ts";
import { toolCallMeta, toolCallSite, type ToolCallSite } from "./tool-call-context.ts";
import type { ToolRegistration, ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { registration, type McpResult, type ToolDefinition, type ToolSpawn } from "./attached-tools.ts";
import { checkDocument, operations, formEncode, type Operation } from "./openapi-policy.ts";
import { HttpError } from "./errors.ts";
import { HostExecutionRequest } from "./host-execution.ts";
import { HumanInputs, waitForHuman } from "./human.ts";
import { parse as parseYaml } from "yaml";
import { signRuntimeIdentity, type IdentityEnv, type RuntimeIdentity } from "./tool-identity.ts";
import { resolveToolInputs, withInputNote, withToolInputs, type ToolInputReply } from "./mcp-inputs.ts";
import { openProviderSecret } from "./model-credentials.ts";
import { credentialExchange, CredentialExchangeError, type ExchangeAuth } from "./exchange-auth.ts";
import { COMPUTER_TOOLS } from "./computers/policy.ts";
import { fileToolsFor } from "./file-tool-policy.ts";

type Env = { API_TOKEN: string; TEST_MODE?: string } & Partial<IdentityEnv>;
type Approval = { default?: "never" | "always" | "destructive" | "judged"; tools?: Record<string, "never" | "always" | "judged">; methods?: string[] };
type Sealed = { iv: string; ciphertext: string; tag: string };
export type RemoteSource = {
  name: string; url?: string; baseUrl?: string; spec?: string; operations?: Operation[];
  headerNames?: string[]; auth?: { type: "bearer" | "runtime" } | ExchangeAuth; sealed?: Sealed; audience?: string;
  allowTools?: string[]; denyTools?: string[]; timeoutMs?: number;
  exposure?: "direct" | "codemode" | "both"; approval?: Approval; fileArguments?: "on" | "off";
  discovery?: { tools?: ToolDefinition[]; error?: string };
};
const MAX_BYTES = 1024 * 1024;
const NAME = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/;
const forbiddenHeaders = new Set(["host", "content-length", "content-type", "accept", "connection", "transfer-encoding", "upgrade", "cookie", "mcp-session-id", "mcp-protocol-version"]);
const bad = (message: string) => new HttpError(400, message);

/** Every redirect is checked before fetching, including local test fixtures. */
function outbound(env: Pick<Env, "TEST_MODE" | "AGENT_OUTBOUND_ALLOW_HTTP" | "AGENT_OUTBOUND_ALLOW_CIDRS" | "AGENT_OUTBOUND_BLOCK_CIDRS">) {
  const split = (value?: string) => value?.split(",").map(value => value.trim()).filter(Boolean);
  return new Outbound({ allowHttp: env.TEST_MODE === "1" && env.AGENT_OUTBOUND_ALLOW_HTTP !== "false",
    allow: env.TEST_MODE === "1" ? split(env.AGENT_OUTBOUND_ALLOW_CIDRS ?? "127.0.0.1/32,::1/128") : [], block: split(env.AGENT_OUTBOUND_BLOCK_CIDRS) });
}
export function sourceUrl(value: unknown, env: Pick<Env, "TEST_MODE" | "AGENT_OUTBOUND_ALLOW_HTTP" | "AGENT_OUTBOUND_ALLOW_CIDRS" | "AGENT_OUTBOUND_BLOCK_CIDRS">): URL {
  if (typeof value !== "string" || value.length > 2048) throw bad("Source URL must be a bounded URL");
  try { const url = outbound(env).check(value); if (url.hash) throw bad("Source URLs take no fragment"); return url; }
  catch (error) { throw bad(error instanceof Error ? error.message : String(error)); }
}

async function fetchSource(env: Pick<Env, "TEST_MODE">, url: string | URL, init: RequestInit, max = MAX_BYTES, complete?: (text: string) => boolean) {
  let current = sourceUrl(String(url), env);
  await outbound(env).reachable(current);
  for (let count = 0; count < 6; count++) {
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      const next = sourceUrl(new URL(response.headers.get("location")!, current).href, env);
      await response.body?.cancel();
      if (next.origin !== current.origin) throw bad("Source redirects may not change origin");
      current = await outbound(env).reachable(next);
      continue;
    }
    const text = await readText(response, max, complete);
    return { response, text };
  }
  throw bad("Too many source redirects");
}

async function readText(response: Response, max: number, complete?: (text: string) => boolean) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  let streamed = "";
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > max) { await reader.cancel(); throw new Error("Source response exceeds its byte limit"); }
      parts.push(part.value);
      if (complete) {
        streamed += decoder.decode(part.value, { stream: true });
        if (complete(streamed)) { await reader.cancel(); return streamed; }
      }
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return new TextDecoder().decode(bytes);
}

const b64 = (bytes: Uint8Array) => {
  let text = "";
  for (let i = 0; i < bytes.length; i += 16384) text += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(text);
};
async function key(env: Env) {
  if (!env.AGENT_SECRETS_KEY || !/^[a-f0-9]{64}$/i.test(env.AGENT_SECRETS_KEY)) throw new HttpError(503, "This runtime has no AGENT_SECRETS_KEY, so it cannot store credentials");
  return crypto.subtle.importKey("raw", Uint8Array.from(env.AGENT_SECRETS_KEY.match(/../g)!, part => Number.parseInt(part, 16)), "AES-GCM", false, ["encrypt"]);
}
async function seal(env: Env, aad: string, headers: Record<string, string>): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, await key(env), new TextEncoder().encode(JSON.stringify(headers)));
  const bytes = new Uint8Array(data);
  return { iv: b64(iv), ciphertext: b64(bytes.subarray(0, -16)), tag: b64(bytes.subarray(-16)) };
}
async function unseal(env: Env, aad: string, value?: Sealed): Promise<Record<string, string>> {
  if (!value) return {};
  return JSON.parse(await openProviderSecret(env as IdentityEnv, aad, value));
}
const aad = (_tenant: string, definition: string, kind: string, name: string) => `definition:${definition}:${kind === "mcpServers" ? "mcp" : "openapi"}:${name}`;
const names = (value: unknown, label: string) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 4096 || value.some(x => typeof x !== "string" || x.length > 200)) throw bad(`${label} must be a bounded list of names`);
  return value as string[];
};

/** Validate sources and encrypt definition credentials before storing any config. */
export async function prepareSources(env: Env, tenant: string, definition: string | undefined, kind: "mcpServers" | "openApi", input: unknown, previous: RemoteSource[] = []): Promise<RemoteSource[]> {
  if (input === null) return [];
  if (!Array.isArray(input) || input.length > 64) throw bad(`${kind} must be a list of at most 64 sources`);
  const used = new Set<string>();
  return Promise.all(input.map(async raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("Expected a source object");
    const value = raw as Record<string, any>, name = value.name;
    if (typeof name !== "string" || name.length > 32 || !NAME.test(name) || used.has(name)) throw bad("Source names must be unique, 1–32 letters and digits with single underscores");
    used.add(name);
    if (!definition && (value.headers !== undefined || value.auth !== undefined && (value.auth?.type !== "runtime" || Object.keys(value.auth).length !== 1))) throw bad("An agent's or run's own MCP servers carry no credentials; put credentials in a definition");
    if (value.fileArguments !== undefined && !['on', 'off'].includes(value.fileArguments)) throw bad('fileArguments must be "on" or "off"');
    if (!definition && value.fileArguments !== undefined) throw bad('fileArguments belongs in a definition');
    const kept = previous.find(x => x.name === name);
    const url = kind === "mcpServers" ? sourceUrl(value.url, env).href : undefined;
    if (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 1_200_000)) throw bad("timeoutMs must be 1000..1200000");
    if (value.exposure !== undefined && !["direct", "codemode", "both"].includes(value.exposure)) throw bad("Invalid tool exposure");
    const headers: Record<string, string> = {};
    if (value.headers !== undefined) {
      if (!value.headers || typeof value.headers !== "object" || Array.isArray(value.headers) || Object.keys(value.headers).length > 32) throw bad("headers must be an object of at most 32 headers");
      for (const [header, content] of Object.entries(value.headers)) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(header) || forbiddenHeaders.has(header.toLowerCase()) || header.toLowerCase().startsWith("x-agent-runtime-")) throw bad(`Header ${header} cannot be set`);
        if (typeof content !== "string" || content.length > 8192 || /[\r\n\0]/.test(content)) throw bad("Header values must be bounded single-line strings");
        headers[header] = content;
      }
    }
    if (value.auth !== undefined) {
      if (value.auth?.type !== "runtime" && value.auth?.type !== "exchange" && (value.auth?.type !== "bearer" || typeof value.auth.token !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(value.auth.token))) throw bad("Source auth must be runtime, exchange, or a bearer credential in a definition");
      if (value.auth?.type === "runtime" && Object.keys(value.auth).length !== 1) throw bad("Runtime auth takes no credentials");
      if (value.auth?.type === "exchange") {
        if (kind !== "mcpServers") throw bad('auth { type: "exchange" } is for MCP servers');
        const extra = Object.keys(value.auth).find(key => !["type", "url", "audience"].includes(key));
        if (extra) throw bad(`auth: Unrecognized key: "${extra}"`);
        if (typeof value.auth.url !== "string" || !value.auth.url) throw bad('auth is { type: "exchange", url, audience? }');
        let exchange: URL;
        try { exchange = sourceUrl(value.auth.url, env); } catch (error) { throw bad(`auth.url: ${(error as Error).message}`); }
        if (value.auth.audience !== undefined && (typeof value.auth.audience !== "string" || !ownAudience(value.auth.audience, exchange, tenant))) throw bad("auth.audience must be a URL on the exchange's own origin or a name of your tenant's own");
      }
      if (Object.keys(headers).some(x => x.toLowerCase() === "authorization")) throw bad("Give an Authorization header or auth, not both");
      if (value.auth.type === "bearer") headers.Authorization = `Bearer ${value.auth.token}`;
    }
    const source: RemoteSource = {
      name, ...(url ? { url } : {}),
      ...(value.fileArguments !== undefined ? { fileArguments: value.fileArguments } : {}),
      ...(value.exposure ? { exposure: value.exposure } : {}),
      ...(value.timeoutMs ? { timeoutMs: value.timeoutMs } : {}),
      ...(value.allowTools !== undefined ? { allowTools: names(value.allowTools, "allowTools") } : {}),
      ...(value.denyTools !== undefined ? { denyTools: names(value.denyTools, "denyTools") } : {}),
      ...(value.auth?.type === "runtime" ? { auth: { type: "runtime" as const } } : {}),
      ...(value.auth?.type === "exchange" ? { auth: { type: "exchange" as const, url: sourceUrl(value.auth.url, env).href, ...(value.auth.audience ? { audience: value.auth.audience } : {}) } } : {}),
    };
    if (value.approval !== undefined) {
      const approval = value.approval;
      if (approval?.default !== undefined && !["never", "always", "destructive", "judged"].includes(approval.default))
        throw bad('Invalid option: expected one of "never"|"always"|"destructive"|"judged"');
      if (!approval || typeof approval !== "object" || Array.isArray(approval) ||
        (approval.default !== undefined && !["never", "always", "destructive", "judged"].includes(approval.default)) ||
        (approval.tools !== undefined && (!approval.tools || typeof approval.tools !== "object" || Array.isArray(approval.tools) || Object.values(approval.tools).some(x => !["never", "always", "judged"].includes(String(x)))))) throw bad("Invalid approval policy");
      source.approval = { ...approval, ...(approval.methods ? { methods: names(approval.methods, "approval.methods") } : {}) };
    }
    if (kind === "openApi") {
      let document: Record<string, unknown> | undefined, spec: string | undefined;
      if (typeof value.spec === "string") {
        spec = sourceUrl(value.spec, env).href;
        const loaded = await fetchSource(env, spec, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) }, 8 * MAX_BYTES);
        if (!loaded.response.ok) throw bad(`OpenAPI spec answered HTTP ${loaded.response.status}`);
        try { document = checkDocument(loaded.text.trimStart().startsWith("{") ? JSON.parse(loaded.text) : parseYaml(loaded.text, { maxAliasCount: 100 })); } catch (error) { throw bad(`OpenAPI source ${name}: ${error instanceof Error ? error.message : "invalid document"}`); }
      } else if (value.spec !== undefined) document = checkDocument(value.spec);
      else if (!kept) throw bad("OpenAPI source needs a spec");
      const api = document ? operations(document, spec) : { baseUrl: kept!.baseUrl, operations: kept!.operations! };
      if (typeof (value.baseUrl ?? api.baseUrl) !== "string") throw bad("The spec names no server; give baseUrl");
      source.baseUrl = sourceUrl(value.baseUrl ?? api.baseUrl, env).href.replace(/\/$/, "");
      source.operations = api.operations.filter(op => (!source.allowTools || source.allowTools.includes(op.name)) && !source.denyTools?.includes(op.name));
      if (!source.operations.length) throw bad("OpenAPI source has no operations left");
      if (source.operations.length > 1024) throw bad("OpenAPI source must select at most 1024 operations");
      if (spec ?? kept?.spec) source.spec = spec ?? kept?.spec;
    }
    const origin = new URL(source.url ?? source.baseUrl!).origin, keptOrigin = kept && new URL(kept.url ?? kept.baseUrl!).origin;
    if (value.audience !== undefined) {
      if (source.auth?.type === "exchange") throw bad("with auth { type: \"exchange\" } the audience goes in auth (auth.audience)");
      if (source.auth?.type !== "runtime" || typeof value.audience !== "string" || value.audience.length > 2048) throw bad("audience is for runtime auth");
      if (!ownAudience(value.audience, origin, tenant)) throw bad("audience must be a URL on the source's own origin or a name of your tenant's own");
      source.audience = value.audience;
    }
    if (Object.keys(headers).length) {
      source.sealed = await seal(env, aad(tenant, definition!, kind, name), headers);
      if (value.headers && Object.keys(value.headers).length) source.headerNames = Object.keys(value.headers);
      if (value.auth?.type === "bearer") source.auth = { type: "bearer" };
    } else if (kept && origin === keptOrigin && value.headers === undefined && value.auth === undefined) {
      if (kept.sealed) source.sealed = kept.sealed;
      if (kept.headerNames) source.headerNames = kept.headerNames;
      if (kept.auth) source.auth = kept.auth;
      if (kept.audience && value.audience === undefined) source.audience = kept.audience;
    }
    return source;
  }));
}

export function sourceView(source: RemoteSource) {
  // The allowlist also protects callers reading an older, unvalidated record.
  const { name, url, baseUrl, spec, headerNames, audience, allowTools, denyTools, timeoutMs, exposure, approval, operations } = source;
  const auth = source.auth?.type === "runtime" || source.auth?.type === "bearer" ? { type: source.auth.type }
    : source.auth?.type === "exchange" ? { type: "exchange", url: source.auth.url, ...(source.auth.audience ? { audience: source.auth.audience } : {}) }
    : undefined;
  return { name, ...(url ? { url } : {}), ...(baseUrl ? { baseUrl } : {}), ...(spec ? { spec } : {}),
    ...(headerNames ? { headerNames } : {}), ...(auth ? { auth } : {}), ...(audience ? { audience } : {}),
    ...(allowTools ? { allowTools } : {}), ...(denyTools ? { denyTools } : {}), ...(timeoutMs ? { timeoutMs } : {}),
    ...(exposure ? { exposure } : {}), ...(approval ? { approval } : {}), ...(source.fileArguments !== undefined ? { fileArguments: source.fileArguments } : {}),
    ...(operations ? { tools: operations.map(operation => operation.name) } : {}) };
}

const listedAt = new WeakMap<ToolRegistration, number>();
const markListed = (tool: ToolRegistration) => { listedAt.set(tool, Date.now()); return tool; };

/** Public catalog preserves source priority and makes duplicate exclusions explicit. */
export function toolSourceViews(config: { mcp?: { tools?: ToolDefinition[] }; mcpServers?: RemoteSource[]; openApi?: RemoteSource[]; fileTools?: boolean; codeMode?: boolean; builtins?: string[] }, tools: ToolRegistration[], connected: boolean, failures: SourceFailure[] = [], loaded = true) {
  const view = (tool: ToolRegistration) => ({ name: tool.name, description: tool.description, parameters: tool.parameters, exposure: tool.callers?.length === 1 ? tool.callers[0] === "model" ? "direct" : "codemode" : "both", ...(tool.executionMode ? { executionMode: tool.executionMode } : {}) });
  const result: { kind: string; name: string; status: string; tools: any[]; connected?: boolean; url?: string; error?: string; listedAt?: number }[] = [];
  if (config.mcp?.tools?.length) result.push({ kind: "application", name: "application", status: "listed", connected, tools: config.mcp.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters ?? tool.inputSchema, exposure: tool.exposure ?? tool._meta?.["agent-runtime/exposure"] ?? "both" })) });
  const fileNames = new Set(["read", "write", "edit", "ls", "find", "glob", "grep", "stat", "mkdir", "rm", "rename", "cp", "mv", "present_file"]);
  const files = tools.filter(tool => fileNames.has(tool.name));
  const fileExposure = new Map(fileToolsFor(files, config.fileTools, config.codeMode).map(tool => [tool.name, tool.callers]));
  if (files.length) result.push({ kind: "files", name: "files", status: "listed", tools: files.map(tool => ({ ...view(tool), exposure: fileExposure.get(tool.name)?.includes("model") === false ? "codemode" : "both" })) });
  const computers = tools.filter(tool => COMPUTER_TOOLS.has(tool.name));
  if (computers.length) result.push({ kind: "builtin", name: "computer", status: "listed", tools: computers.map(view) });
  for (const name of new Set([...(tools.some(tool => tool.name === "decide") ? ["decide"] : []), ...(config.builtins ?? [])])) {
    const installed = tools.filter(tool => tool.name === name);
    if (installed.length) result.push({ kind: "builtin", name, status: "listed", tools: installed.map(view) });
  }
  for (const [kind, sources] of [["mcp", config.mcpServers], ["openapi", config.openApi]] as const) for (const source of sources ?? []) {
    const installed = tools.filter(tool => tool.name.startsWith(`${source.name}__`));
    const failure = failures.find(failure => failure.kind === kind && failure.source === source.name);
    result.push({ kind, name: source.name, url: source.url ?? source.baseUrl, status: failure ? loaded ? "error" : "unlisted" : "listed", tools: installed.map(view), ...(!failure ? { listedAt: Math.max(0, ...installed.map(tool => listedAt.get(tool) ?? Date.now())) } : loaded ? { error: failure.message } : {}) });
  }
  const claimed = new Set<string>();
  for (const source of result) source.tools = source.tools.map(tool => {
    if (claimed.has(tool.name)) return { ...tool, excluded: "an earlier source has a tool of this name" };
    claimed.add(tool.name); return tool;
  });
  return result;
}

function rpcMessages(text: string): any[] {
  if (!text.trim()) return [];
  let messages: any[];
  try { messages = [JSON.parse(text)]; }
  catch {
    messages = text.split(/\r?\n\r?\n/).flatMap(frame => {
      const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
      if (!data) return [];
      try { return [JSON.parse(data)]; } catch { return []; }
    });
  }
  return messages.flat();
}
function rpcResult(text: string, id: string): any {
  const response = rpcMessages(text).find(message => String(message.id) === id);
  if (!response) throw new Error("MCP server returned no matching response");
  if (response.error) {
    // MCP's older URL elicitation spelling, retained by src/client-sessions/tools.ts.
    const elicitations = response.error.code === -32042 ? response.error.data?.elicitations : undefined;
    if (Array.isArray(elicitations) && elicitations.length) return { resultType: "input_required", inputRequests: Object.fromEntries(elicitations.map((params, index) => [`url_${index}`, { method: "elicitation/create", params: { ...params, mode: "url" } }])) };
    throw new Error(String(response.error.message ?? "MCP request failed"));
  }
  return response.result;
}

class RemoteMcp {
  private legacy = false;
  private session?: string;
  private ready?: Promise<void>;
  private env: Env;
  private source: RemoteSource;
  private headers: Record<string, string>;
  private runtimeHeaders: (api?: ToolExecutionApi, approval?: ToolInputReply["approval"]) => Promise<Record<string, string>>;
  private refused?: () => void;
  private identity?: SourceIdentity;
  constructor(env: Env, source: RemoteSource, headers: Record<string, string>, runtimeHeaders: (api?: ToolExecutionApi, approval?: ToolInputReply["approval"]) => Promise<Record<string, string>>, refused?: () => void, identity?: SourceIdentity) {
    this.env = env; this.source = source; this.headers = headers; this.runtimeHeaders = runtimeHeaders;
    this.refused = refused; this.identity = identity;
  }
  private async rpc(method: string, params: unknown, notification = false, signal?: AbortSignal, api?: ToolExecutionApi, approval?: ToolInputReply["approval"], onProgress?: (progress: Progress) => void): Promise<any> {
    const id = crypto.randomUUID();
    const deadline = silenceDeadline(this.source.timeoutMs ?? 300_000, signal);
    let read = 0;
    const complete = (text: string) => {
      const messages = rpcMessages(text);
      for (const message of messages.slice(read)) if (message.method === "notifications/progress" && String(message.params?.progressToken) === id) { deadline.touch(); onProgress?.(message.params); }
      read = messages.length;
      return messages.some(message => String(message.id) === id);
    };
    const request = { jsonrpc: "2.0", ...(notification ? {} : { id }), method, params: method === "tools/call" ? { ...params as object, _meta: { ...(params as { _meta?: object })._meta, progressToken: id } } : params };
    const legacy = async () => {
      const response = await legacyMcpRequest(this.source.url!, request, { ...this.headers, ...await this.runtimeHeaders(api, approval) }, async (url, init) => {
        await outbound(this.env).reachable(url);
        const result = await fetch(url, { ...init, redirect: "manual" });
        if (result.status >= 300 && result.status < 400) { await result.body?.cancel(); throw new Error("Legacy MCP redirects are not allowed"); }
        return result;
      }, deadline.signal, notification, message => {
        if (message.method === "notifications/progress" && String(message.params?.progressToken) === id) { deadline.touch(); onProgress?.(message.params); }
      });
      return notification ? undefined : rpcResult(JSON.stringify(response), id);
    };
    try {
    if (this.legacy) return await legacy();
    let result!: Awaited<ReturnType<typeof fetchSource>>;
    for (let attempt = 0; attempt < 2; attempt++) {
    result = await fetchSource(this.env, this.source.url!, {
      method: "POST", headers: { ...this.headers, ...await this.runtimeHeaders(api, approval), Accept: "application/json, text/event-stream", "Content-Type": "application/json", ...(this.session ? { "Mcp-Session-Id": this.session, "MCP-Protocol-Version": "2025-06-18" } : {}) },
      body: JSON.stringify(request), signal: deadline.signal,
    }, MAX_BYTES, notification ? undefined : complete);
    if (attempt === 0 && this.refused && [401, 403].includes(result.response.status)) { this.refused(); continue; }
    break;
    }
    if ([404, 405].includes(result.response.status)) { this.legacy = true; return await legacy(); }
    if (!result.response.ok) {
      if (this.refused && [401, 403].includes(result.response.status)) {
        const { origin, pathname } = new URL((this.source.auth as ExchangeAuth).url);
        throw new CredentialExchangeError("rejected", `MCP server ${this.source.name} refused the credential from its exchange (HTTP ${result.response.status}), and a second one fetched after: check what ${origin}${pathname} issues for it`, result.response.status);
      }
      let detail = result.text.slice(0, 1000);
      try { detail = String(JSON.parse(result.text).error ?? detail).slice(0, 1000); } catch {}
      throw Object.assign(new Error(`MCP source ${this.source.name} answered HTTP ${result.response.status}${detail ? `: ${detail}` : ""}`), { status: result.response.status });
    }
    this.session = result.response.headers.get("mcp-session-id") ?? this.session;
    return notification ? undefined : rpcResult(result.text, id);
    } catch (error) { if (deadline.signal.aborted) throw deadline.signal.reason; throw error; }
    finally { deadline.close(); }
  }
  private init() {
    return this.ready ??= this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-runtime", version: "1.0.0" } }).then(() => this.rpc("notifications/initialized", {}, true));
  }
  async list(): Promise<ToolDefinition[]> {
    await this.init();
    const tools: ToolDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 64; page++) {
      const result = await this.rpc("tools/list", cursor ? { cursor } : {});
      if (!Array.isArray(result.tools)) throw new Error("MCP tools/list returned no tools");
      tools.push(...result.tools);
      if (tools.length > 1024) throw new Error("MCP source has more than 1024 tools");
      if (typeof result.nextCursor !== "string") return tools;
      if (result.nextCursor === cursor) throw new Error("MCP tools/list cursor did not advance");
      cursor = result.nextCursor;
    }
    throw new Error("MCP tool list exceeds 64 pages");
  }
  async call(name: string, args: unknown, signal?: AbortSignal, api?: ToolExecutionApi, reply: ToolInputReply = {}, fileMeta?: Record<string, unknown>): Promise<McpResult> {
    await this.init();
    const { approval, note: _note, ...responses } = reply;
    const identity = api ? await this.identity?.(api) : undefined;
    const site = api ? identity?.call ?? await toolCallSite(api) : undefined;
    const meta = site ? { ...toolCallMeta(identity?.claims.agent ?? String(api!.conversationId), site, identity?.claims.origin, identity?.claims.act), ...(identity?.elicit ? { "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {}, url: {} } } } : {}) } : undefined;
    const progress = pacedProgress(value => site ? identity?.progress?.(progressEvent(mcpToolName(this.source.name, name), site, value)) : undefined);
    try { return await this.rpc("tools/call", { name, arguments: args, ...responses, ...(meta ? { _meta: { ...meta, ...fileMeta, ...(approval ? { "agent-runtime/approval": approval } : {}) } } : {}) }, false, signal, api, approval, progress.update); }
    finally { await progress.flush(); }
  }
}

export type SourceFailure = { kind: "mcp" | "openapi"; source: string; message: string };
const sourceError = (error: unknown, headers: Record<string, string>, url?: string) => {
  let message = error instanceof Error ? error.message : String(error);
  for (const value of Object.values(headers)) for (const secret of [value, value.replace(/^Bearer /i, "")])
    if (secret) message = message.split(secret).join("[redacted]");
  if (url && !(error as { status?: number })?.status && !(error instanceof CredentialExchangeError)) message = `Could not connect to MCP server ${new URL(url).host}: ${message}`;
  return message.slice(0, 2000);
};

/** Definitions validate static credentials now; temporary unavailability remains visible and can recover later. */
export async function discoverSources(env: Env, tenant: string, definition: string, sources: RemoteSource[], origin: string): Promise<RemoteSource[]> {
  return Promise.all(sources.map(async source => {
    const identity = async () => ({ issuer: origin, claims: { tenant, agent: definition, definition, sub: definition } });
    const exchange = source.auth?.type === "exchange" ? credentialExchange(env as IdentityEnv, { name: source.name, url: source.url!, auth: source.auth }, identity, (url, init, max) => fetchSource(env, url, init, max)) : undefined;
    const runtimeHeaders = async (): Promise<Record<string, string>> => exchange ? exchange.headers() : source.auth?.type === "runtime" ? { Authorization: `Bearer ${await signRuntimeIdentity(env as IdentityEnv, origin, source.audience ?? source.url!, (await identity()).claims)}` } : {};
    const headers = await unseal(env, aad(tenant, definition, "mcpServers", source.name), source.sealed);
    try {
      const client = new RemoteMcp(env, { ...source, timeoutMs: Math.min(source.timeoutMs ?? 20_000, 20_000) }, headers, runtimeHeaders, exchange?.refused);
      return { ...source, discovery: { tools: await client.list() } };
    } catch (error) {
      const message = sourceError(error, headers, source.url);
      if ([401, 403].includes((error as { status?: number }).status ?? 0) || error instanceof CredentialExchangeError && !["unreachable", "unavailable"].includes(error.reason)) throw bad(error instanceof CredentialExchangeError ? message + ". Saving lists the server's tools as the definition (its token's agent and sub are the definition's id, and the request's body names no agent)" : message);
      return { ...source, discovery: { error: message } };
    }
  }));
}

export function sourceDefinitionViews(config: { mcpServers?: RemoteSource[]; openApi?: RemoteSource[] }) {
  return [
    ...(config.mcpServers ?? []).map(source => ({ kind: "mcp", name: source.name, url: source.url,
      status: source.discovery?.error ? "error" : source.discovery?.tools ? "listed" : "unlisted",
      ...(source.discovery?.error ? { error: source.discovery.error } : {}),
      ...(source.discovery?.error ? { tools: [] } : source.discovery?.tools ? { tools: source.discovery.tools.filter(tool => (!source.allowTools || source.allowTools.includes(tool.name)) && !source.denyTools?.includes(tool.name)).map(tool => ({ description: tool.description, inputSchema: tool.inputSchema ?? tool.parameters, name: mcpToolName(source.name, tool.name), exposure: tool.exposure ?? tool._meta?.["agent-runtime/exposure"] ?? source.exposure ?? "both" })) } : {}),
    })),
    ...(config.openApi ?? []).map(source => ({ kind: "openapi", name: source.name, url: source.baseUrl, status: "listed", tools: (source.operations ?? []).map(operation => ({ name: `${source.name}__${operation.name}`, description: operation.description, inputSchema: operation.inputSchema, exposure: source.exposure ?? "both" })) })),
  ];
}

export type SourceApproval = (input: { name: string; args: unknown; kind: "approval"; message: string; detail: Record<string, unknown> }) => Promise<void>;
export type SourceIdentity = (api?: ToolExecutionApi) => Promise<{ issuer: string; claims: RuntimeIdentity; call?: ToolCallSite; elicit?: boolean; intent?: string; toolFiles?: (name: string, refuse?: string) => ToolFiles; progress?: (event: ToolProgressEvent) => Promise<void>; spawn?: ToolSpawn }>;

/** Resolve only this agent's configured sources; credentials never enter model context. */
export async function sourceTools(env: Env, tenant: string, definition: string | undefined, config: { mcpServers?: RemoteSource[]; openApi?: RemoteSource[] }, approve?: SourceApproval, identity?: SourceIdentity, report?: (failures: SourceFailure[]) => void, judge?: (input: JudgeInput, api: ToolExecutionApi, context: Context) => Promise<Judged>): Promise<ToolRegistration[]> {
  const result: ToolRegistration[] = [];
  const failures: SourceFailure[] = [];
  for (const kind of ["mcpServers", "openApi"] as const) for (const source of config[kind] ?? []) {
    const headers = await unseal(env, aad(tenant, definition ?? "", kind, source.name), source.sealed);
    const exchange = source.auth?.type === "exchange" && identity && env.HYPERDRIVE ? credentialExchange(env as IdentityEnv, { name: source.name, url: source.url!, auth: source.auth }, identity, (url, init, max) => fetchSource(env, url, init, max)) : undefined;
    const runtimeHeaders = async (api?: ToolExecutionApi, approval?: ToolInputReply["approval"]): Promise<Record<string, string>> => {
      if (exchange) return exchange.headers(api);
      if (source.auth?.type === "exchange") throw new Error("Runtime identity is not configured for credential exchange");
      if (source.auth?.type !== "runtime") return {};
      if (!identity || !env.HYPERDRIVE) throw new Error("Runtime identity is not configured");
      const value = await identity(api);
      return { Authorization: `Bearer ${await signRuntimeIdentity(env as IdentityEnv, value.issuer, source.audience ?? source.url ?? source.baseUrl!, { ...value.claims, ...(approval ? { approval } : {}) })}` };
    };
    const needsApproval = async (tool: string, args: unknown, destructive: boolean, api: ToolExecutionApi, context: Context, method?: string, description = ""): Promise<{ result: McpResult } | { reply: ToolInputReply }> => {
      const mode = approvalFor(source.approval, tool, destructive, method);
      if (mode !== "never") {
        const identityValue = mode === "judged" ? await identity?.(api) : undefined;
        if (mode === "judged" && judge && identityValue?.intent?.trim()) {
          const verdict = await judge({ tool: `${source.name}__${tool}`, args: args as Record<string, unknown>, description: description.slice(0, 4000), ...(identityValue?.intent ? { intent: identityValue.intent } : {}) }, api, context);
          context.abortSignal?.throwIfAborted();
          if (verdict.decision === "allow") return { reply: {} };
          if (verdict.decision === "deny") return { result: { isError: true, content: [{ type: "text", text: DENIED_PERMISSION(`${source.name}__${tool}`) }] } };
        }
        if ((await toolCallSite(api, context)).innerCallId && !(await api.snapshot(HostExecutionRequest, api.conversationId, context))?.requestId) throw new Error(`${source.name}__${tool} needs the user's approval: call ${source.name}__${tool} directly`);
        const input = { name: `${source.name}__${tool}`, args, kind: "approval" as const, message: `Allow ${source.name}__${tool} to run?`, detail: { tool: `${source.name}__${tool}`, source: source.name, arguments: args } };
        if (approve) await approve(input);
        else {
          await waitForHuman({ kind: "approval", question: input.message, detail: input.detail }, api, context);
          const saved = (await api.snapshot(HumanInputs, context))!.requests[String(api.taskId)];
          return resolveToolInputs([{ id: String(api.taskId), input: saved }]);
        }
      }
      return { reply: {} };
    };
    if (kind === "mcpServers") {
      const client = new RemoteMcp(env, source, headers, runtimeHeaders, exchange?.refused, identity);
      // An unavailable server cannot prevent loading or using the agent's other tools.
      let listed: ToolDefinition[];
      try { listed = await client.list(); } catch (error) { failures.push({ kind: "mcp", source: source.name, message: sourceError(error, headers, source.url) }); continue; }
      for (const tool of listed) {
        if (source.allowTools && !source.allowTools.includes(tool.name) || source.denyTools?.includes(tool.name)) continue;
        const { name } = tool;
        const mode = approvalFor(source.approval, name, (tool as any).annotations?.destructiveHint === true);
        result.push(markListed(registration({ ...tool, description: (tool.description ?? name).slice(0, 4000), needsApproval: mode === "always", judged: mode === "judged", name: mcpToolName(source.name, name), inputSchema: takesFiles(source) ? acceptFiles(tool.inputSchema ?? tool.parameters) : tool.inputSchema ?? tool.parameters, parameters: undefined, exposure: tool.exposure ?? tool._meta?.["agent-runtime/exposure"] as ToolDefinition["exposure"] ?? source.exposure }, async (args, api, context) => {
          const approval = await needsApproval(name, args, (tool as any).annotations?.destructiveHint === true, api, context, undefined, tool.description);
          if ("result" in approval) return approval.result;
          const files = (await identity?.(api))?.toolFiles?.(`${source.name}__${name}`, takesFiles(source) ? undefined : `${source.name} is not sent files: $file needs fileArguments "on" in its definition`);
          const sent = { at: '', values: {} };
          const resolved = await resolveFiles(args, tool.inputSchema ?? tool.parameters, files, undefined, sent);
          const meta = Object.keys(sent.values).length ? { 'camelrun/files': sent.values } : undefined;
          const answer = api ? await withToolInputs(reply => client.call(name, resolved, context?.abortSignal, api, reply, meta), api, context, { name: `${source.name}__${name}`, args }, approval.reply) : await client.call(name, resolved, context?.abortSignal);
          return savedContent(answer, files, takesFiles(source) ? url => outbound(env).fetch(url, { timeoutMs: 20_000, maxBytes: TOOL_FILE_LIMITS.responseBytes, maxRedirects: 5, signal: context?.abortSignal }) : undefined);
        }, source.auth?.type === "runtime" ? async (...args) => {
          const spawn = (await identity?.(args[2]))?.spawn;
          if (!spawn) throw new Error("Sub-agents are not enabled on this runtime");
          return spawn(...args);
        } : undefined)));
      }
    } else {
      for (const operation of source.operations ?? []) result.push(markListed(registration({ name: `${source.name}__${operation.name}`, description: operation.description, inputSchema: takesFiles(source) ? acceptFiles(operation.inputSchema, undefined, true) : operation.inputSchema, needsApproval: approvalFor(source.approval, operation.name, !operation.readOnly, operation.method) === "always", judged: approvalFor(source.approval, operation.name, !operation.readOnly, operation.method) === "judged", exposure: source.exposure, executionMode: operation.readOnly ? "parallel" : "sequential" }, async (input, api, context) => {
        const files = (await identity?.(api))?.toolFiles?.(`${source.name}__${operation.name}`, takesFiles(source) ? undefined : `${source.name} is not sent files: $file needs fileArguments "on" in its definition`);
        const approval = await needsApproval(operation.name, input, !operation.readOnly, api, context, operation.method, operation.description);
        if ("result" in approval) return approval.result;
        if (!takesFiles(source) && hasFileArgument(input)) throw new Error(`${source.name} is not sent files: $file needs fileArguments "on" in its definition`);
        const { body: originalBody, ...rest } = input as Record<string, unknown>;
        const rawBody = operation.body === 'multipart' || operation.body === 'binary';
        const args = await resolveFiles(rawBody ? rest : input, operation.inputSchema, files) as Record<string, unknown>;
        if (rawBody) args.body = originalBody;
        const text = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);
        const path = operation.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
          if (args[name] === undefined) throw new Error(`Missing path parameter ${name}`);
          return encodeURIComponent(text(args[name]));
        });
        const url = new URL(source.baseUrl!.replace(/\/+$/, "") + path), sent: Record<string, string> = { Accept: "application/json" };
        for (const parameter of operation.parameters) {
          const value = args[parameter.name];
          if (value === undefined || value === null) continue;
          if (parameter.in === "query") for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(parameter.name, text(item));
          else if (parameter.in === "header") sent[parameter.name] = text(value);
        }
        Object.assign(sent, headers, await runtimeHeaders(api, approval.reply.approval));
        if (api) {
          const value = await identity?.(api), site = value?.call ?? await toolCallSite(api, context);
          sent["Idempotency-Key"] = String(toolCallMeta(value?.claims.agent ?? String(api.conversationId), site)["agent-runtime/idempotencyKey"]);
        }
        let body: BodyInit | undefined;
        if (args.body !== undefined && operation.body) {
          if (operation.body === "json") { sent["Content-Type"] = "application/json"; body = JSON.stringify(args.body); }
          else if (operation.body === "form") { sent["Content-Type"] = "application/x-www-form-urlencoded"; body = formEncode(args.body); }
          else if (operation.body === 'multipart') {
            if (!files) throw new Error('This agent has no files to send: it has no volumes mounted');
            const form = await multipartBody(args.body, files, (operation.inputSchema.properties as any)?.body); body = form.body; sent['Content-Type'] = form.contentType; sent['Content-Length'] = String(form.length);
          } else {
            if (hasFileArgument(args.body)) {
              if (!files) throw new Error('This agent has no files to send: it has no volumes mounted');
              const file = await files.bodyFile(args.body); body = file.stream; sent['Content-Type'] = operation.bodyType?.includes('*') ? file.contentType : operation.bodyType ?? file.contentType; sent['Content-Length'] = String(file.size);
            } else { body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body); sent['Content-Type'] = operation.bodyType?.includes('*') ? 'application/octet-stream' : operation.bodyType ?? 'application/octet-stream'; }
          }
        }
        await outbound(env).reachable(url);
        const response = await fetch(url, { method: operation.method, headers: sent, body, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(source.timeoutMs ?? 30_000), ...(context?.abortSignal ? [context.abortSignal] : [])]) });
        const contentType = response.headers.get('content-type')?.split(';')[0] ?? '';
        if (response.ok && contentType && !textual(contentType) && files) {
          const name = /filename\*?=(?:UTF-8''|"?)([^";]+)/i.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? url.pathname.split('/').pop() ?? 'output';
          const file = await files.save(decodeURIComponent(name), response.body as any, contentType);
          return withInputNote({ content: [file], structuredContent: file }, approval.reply);
        }
        let responseText: string;
        try { responseText = await readText(response, MAX_BYTES); } catch { throw new Error(`Response larger than ${MAX_BYTES} bytes`); }
        return withInputNote({ content: [{ type: 'text', text: response.ok ? responseText : `${operation.method} ${operation.path} answered HTTP ${response.status}: ${responseText}` }], ...(!response.ok ? { isError: true } : {}) }, approval.reply);
      })));
    }
  }
  report?.(failures);
  return result;
}
