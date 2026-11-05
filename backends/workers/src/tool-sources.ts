import type { ToolRegistration, ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { registration, type McpResult, type ToolDefinition } from "./attached-tools.ts";
import { checkDocument, operations, formEncode, type Operation } from "./openapi-policy.ts";
import { HttpError } from "./errors.ts";
import { waitForHuman } from "./human.ts";
import { parse as parseYaml } from "yaml";

type Env = { API_TOKEN: string; TEST_MODE?: string };
type Approval = { default?: "never" | "always" | "destructive" | "judged"; tools?: Record<string, "never" | "always" | "judged">; methods?: string[] };
type Sealed = { iv: string; data: string };
export type RemoteSource = {
  name: string; url?: string; baseUrl?: string; spec?: string; operations?: Operation[];
  headerNames?: string[]; auth?: { type: "bearer" }; sealed?: Sealed;
  allowTools?: string[]; denyTools?: string[]; timeoutMs?: number;
  exposure?: "direct" | "codemode" | "both"; approval?: Approval;
};
const MAX_BYTES = 1024 * 1024;
const NAME = /^[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*$/;
const forbiddenHeaders = new Set(["host", "content-length", "content-type", "accept", "connection", "transfer-encoding", "upgrade", "cookie", "mcp-session-id", "mcp-protocol-version"]);
const bad = (message: string) => new HttpError(400, message);

/** Every redirect is checked before fetching, including local test fixtures. */
export function sourceUrl(value: unknown, env: Pick<Env, "TEST_MODE">): URL {
  if (typeof value !== "string" || value.length > 2048) throw bad("Source URL must be a bounded URL");
  let url: URL;
  try { url = new URL(value); } catch { throw bad("Invalid source URL"); }
  const host = url.hostname.toLowerCase();
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(host);
  if (local && env.TEST_MODE === "1" && url.protocol === "http:") return url;
  if (url.protocol !== "https:" || url.username || url.password || url.hash || local ||
    /(^|\.)(internal|local|localhost)$/.test(host) || /^\[|^\d+(?:\.\d+){3}$/.test(host))
    throw bad("Source URL must be public HTTPS without credentials");
  return url;
}

async function fetchSource(env: Pick<Env, "TEST_MODE">, url: string | URL, init: RequestInit, max = MAX_BYTES) {
  let current = sourceUrl(String(url), env);
  for (let count = 0; count < 6; count++) {
    const response = await fetch(current, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      const next = sourceUrl(new URL(response.headers.get("location")!, current).href, env);
      await response.body?.cancel();
      if (next.origin !== current.origin) throw bad("Source redirects may not change origin");
      current = next;
      continue;
    }
    const text = await readText(response, max);
    return { response, text };
  }
  throw bad("Too many source redirects");
}

async function readText(response: Response, max: number) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > max) { await reader.cancel(); throw new Error("Source response exceeds its byte limit"); }
      parts.push(part.value);
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
const unb64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0));
async function key(env: Env) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.API_TOKEN));
  return crypto.subtle.importKey("raw", hash, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(env: Env, aad: string, headers: Record<string, string>): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(aad) }, await key(env), new TextEncoder().encode(JSON.stringify(headers)));
  return { iv: b64(iv), data: b64(new Uint8Array(data)) };
}
async function unseal(env: Env, aad: string, value?: Sealed): Promise<Record<string, string>> {
  if (!value) return {};
  const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(value.iv), additionalData: new TextEncoder().encode(aad) }, await key(env), unb64(value.data));
  return JSON.parse(new TextDecoder().decode(data));
}
const aad = (tenant: string, definition: string, kind: string, name: string) => `${tenant}:definition:${definition}:${kind}:${name}`;
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
    if (!definition && (value.headers !== undefined || value.auth !== undefined)) throw bad("An agent's or run's own MCP servers carry no credentials; put credentials in a definition");
    const kept = previous.find(x => x.name === name);
    const url = kind === "mcpServers" ? sourceUrl(value.url, env).href : undefined;
    if (value.timeoutMs !== undefined && (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 600_000)) throw bad("timeoutMs must be 1000..600000");
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
      if (value.auth?.type !== "bearer" || typeof value.auth.token !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(value.auth.token)) throw bad("This backend supports bearer source credentials in definitions");
      if (Object.keys(headers).some(x => x.toLowerCase() === "authorization")) throw bad("Use an Authorization header or auth, not both");
      headers.Authorization = `Bearer ${value.auth.token}`;
    }
    const source: RemoteSource = {
      name, ...(url ? { url } : {}),
      ...(value.exposure ? { exposure: value.exposure } : {}),
      ...(value.timeoutMs ? { timeoutMs: value.timeoutMs } : {}),
      ...(value.allowTools !== undefined ? { allowTools: names(value.allowTools, "allowTools") } : {}),
      ...(value.denyTools !== undefined ? { denyTools: names(value.denyTools, "denyTools") } : {}),
    };
    if (value.approval !== undefined) {
      const approval = value.approval;
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
    if (Object.keys(headers).length) {
      source.sealed = await seal(env, aad(tenant, definition!, kind, name), headers);
      source.headerNames = Object.keys(headers);
      if (value.auth !== undefined) source.auth = { type: "bearer" };
    } else if (kept && origin === keptOrigin && value.headers === undefined && value.auth === undefined) {
      if (kept.sealed) source.sealed = kept.sealed;
      if (kept.headerNames) source.headerNames = kept.headerNames;
      if (kept.auth) source.auth = kept.auth;
    }
    return source;
  }));
}

export function sourceView(source: RemoteSource) {
  const { sealed: _sealed, operations, ...view } = source;
  return { ...view, ...(operations ? { tools: operations.map(operation => operation.name) } : {}) };
}

function rpcResult(text: string, id: string): any {
  if (!text.trim()) return {};
  let messages: any[];
  try { messages = [JSON.parse(text)]; }
  catch {
    messages = text.split(/\r?\n\r?\n/).flatMap(frame => {
      const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
      if (!data) return [];
      try { return [JSON.parse(data)]; } catch { return []; }
    });
  }
  const response = messages.flat().find(message => String(message.id) === id);
  if (!response) throw new Error("MCP server returned no matching response");
  if (response.error) throw new Error(String(response.error.message ?? "MCP request failed"));
  return response.result;
}

class RemoteMcp {
  private session?: string;
  private ready?: Promise<void>;
  private env: Env;
  private source: RemoteSource;
  private headers: Record<string, string>;
  constructor(env: Env, source: RemoteSource, headers: Record<string, string>) {
    this.env = env; this.source = source; this.headers = headers;
  }
  private async rpc(method: string, params: unknown, notification = false, signal?: AbortSignal): Promise<any> {
    const id = crypto.randomUUID();
    const result = await fetchSource(this.env, this.source.url!, {
      method: "POST", headers: { ...this.headers, Accept: "application/json, text/event-stream", "Content-Type": "application/json", ...(this.session ? { "Mcp-Session-Id": this.session, "MCP-Protocol-Version": "2025-06-18" } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }), signal: AbortSignal.any([AbortSignal.timeout(this.source.timeoutMs ?? 300_000), ...(signal ? [signal] : [])]),
    });
    if (!result.response.ok) throw new Error(`MCP source ${this.source.name} answered HTTP ${result.response.status}`);
    this.session = result.response.headers.get("mcp-session-id") ?? this.session;
    return notification ? undefined : rpcResult(result.text, id);
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
  async call(name: string, args: unknown, signal?: AbortSignal): Promise<McpResult> {
    await this.init();
    return this.rpc("tools/call", { name, arguments: args }, false, signal);
  }
}

export type SourceApproval = (input: { name: string; args: unknown; kind: "approval"; message: string; detail: Record<string, unknown> }) => Promise<void>;

/** Resolve only this agent's configured sources; credentials never enter model context. */
export async function sourceTools(env: Env, tenant: string, definition: string | undefined, config: { mcpServers?: RemoteSource[]; openApi?: RemoteSource[] }, approve?: SourceApproval): Promise<ToolRegistration[]> {
  const result: ToolRegistration[] = [];
  for (const kind of ["mcpServers", "openApi"] as const) for (const source of config[kind] ?? []) {
    const headers = await unseal(env, aad(tenant, definition ?? "", kind, source.name), source.sealed);
    const needsApproval = async (tool: string, args: unknown, destructive: boolean, api: ToolExecutionApi, context: Context, method?: string) => {
      const mode = source.approval?.tools?.[tool] ?? source.approval?.default ?? "never";
      if (mode === "always" || mode === "judged" || mode === "destructive" && destructive || !!method && source.approval?.methods?.includes(method)) {
        const input = { name: `${source.name}__${tool}`, args, kind: "approval" as const, message: `Allow ${source.name}__${tool} to run?`, detail: { tool: `${source.name}__${tool}`, source: source.name, arguments: args } };
        if (approve) await approve(input);
        else {
          const answer = await waitForHuman({ kind: "approval", question: input.message, detail: input.detail }, api, context);
          const value = JSON.parse(answer.output[0].text);
          if (value.approved !== true) throw new Error("Tool approval declined");
        }
      }
    };
    if (kind === "mcpServers") {
      const client = new RemoteMcp(env, source, headers);
      for (const tool of await client.list()) {
        if (source.allowTools && !source.allowTools.includes(tool.name) || source.denyTools?.includes(tool.name)) continue;
        const { name } = tool;
        result.push(registration({ ...tool, name: `${source.name}__${name}`, exposure: source.exposure ?? tool.exposure }, async (args, api, context) => {
          await needsApproval(name, args, !(tool as any).annotations?.readOnlyHint, api, context);
          return client.call(name, args, context?.abortSignal);
        }));
      }
    } else {
      for (const operation of source.operations ?? []) result.push(registration({ name: `${source.name}__${operation.name}`, description: operation.description, inputSchema: operation.inputSchema, exposure: source.exposure, executionMode: operation.readOnly ? "parallel" : "sequential" }, async (input, api, context) => {
        const args = input as Record<string, unknown>;
        await needsApproval(operation.name, args, !operation.readOnly, api, context, operation.method);
        const text = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);
        const path = operation.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
          if (args[name] === undefined) throw new Error(`Missing path parameter ${name}`);
          return encodeURIComponent(text(args[name]));
        });
        const url = new URL(source.baseUrl!.replace(/\/+$/, "") + path), sent: Record<string, string> = { ...headers, Accept: "application/json" };
        for (const parameter of operation.parameters) {
          const value = args[parameter.name];
          if (value === undefined || value === null) continue;
          if (parameter.in === "query") for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(parameter.name, text(item));
          else if (parameter.in === "header") sent[parameter.name] = text(value);
        }
        let body: BodyInit | undefined;
        if (args.body !== undefined && operation.body) {
          if (operation.body === "json") { sent["Content-Type"] = "application/json"; body = JSON.stringify(args.body); }
          else if (operation.body === "form") { sent["Content-Type"] = "application/x-www-form-urlencoded"; body = formEncode(args.body); }
          else throw new Error("Binary and multipart OpenAPI request bodies require file transport");
        }
        const response = await fetchSource(env, url, { method: operation.method, headers: sent, body, signal: AbortSignal.any([AbortSignal.timeout(source.timeoutMs ?? 30_000), ...(context?.abortSignal ? [context.abortSignal] : [])]) });
        return { content: [{ type: "text", text: response.response.ok ? response.text : `${operation.method} ${operation.path} answered HTTP ${response.response.status}: ${response.text}` }], ...(!response.response.ok ? { isError: true } : {}) };
      }));
    }
  }
  return result;
}
