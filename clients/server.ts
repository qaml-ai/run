/**
 * Serving tools to agents from your own server, for many users at once. The runtime calls a tool
 * source with `auth: { type: "runtime" }` with a token it signs for each request, naming the agent,
 * whom it acts for and who is acting; these helpers verify it and hand your tools the identity.
 * Portable: fetch-style handlers and WebCrypto (Ed25519), so it runs on Workers, Node 22+, Bun and Deno.
 *
 *   export default { fetch: serveTools(tools, { runtime: "https://run.camelai.com", tenant: "acme" }) };
 *
 * An identity means something only within your own tenant: other tenants' agents can be pointed at your
 * server too, so every check here requires `tenant`, and refuses tokens made for anyone else's agents.
 */
import { answerMcp, identityFromClaims, toolContext, toolServer, type RuntimeIdentity, type ToolServer, type Tools } from "./typescript.ts";
export type { RuntimeIdentity };

export interface VerifyOptions {
  /**
   * Your tenant's id (GET /v1/me answers it), or those you accept: tokens from other tenants' agents are
   * refused. Required: another tenant can point its agents at your server and say they act for anyone.
   */
  tenant: string | string[];
  /** The runtime's URL (e.g. https://run.camelai.com): its keys are at /.well-known/jwks.json. */
  runtime: string;
  /** The issuer tokens must name; the runtime's URL by default (camelRun's hosted runtime names itself https://agents.camelai.dev at either of its URLs). */
  issuer?: string;
  /** What tokens must be for: your server's URL as the runtime calls it (a definition's `url`, or its `audience`). */
  audience: string | string[];
  /** Fetches the runtime's keys; `testRuntime()` supplies one. */
  fetch?: typeof globalThis.fetch;
  /** Seconds of clock skew allowed (default 30). */
  clockTolerance?: number;
}

/** A token that is missing, malformed, unsigned by the runtime, for another server, or expired. */
export class RuntimeTokenError extends Error {
  constructor(message: string) { super(message); this.name = "RuntimeTokenError"; }
}

const trim = (url: string) => url.replace(/\/+$/, "");
/** camelRun's hosted runtime answers at both names, and signs as the first it had, which tool servers already check. */
const HOSTED = ["https://run.camelai.com", "https://agents.camelai.dev"];
const HOSTED_ISSUER = "https://agents.camelai.dev";
const issuerOf = (options: { runtime: string; issuer?: string }) => {
  if (options.issuer) return trim(options.issuer);
  const runtime = trim(options.runtime);
  return HOSTED.includes(runtime) ? HOSTED_ISSUER : runtime;
};
const decoder = new TextDecoder();
function base64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
const part = (text: string) => { try { return JSON.parse(decoder.decode(base64url(text))); } catch { throw new RuntimeTokenError("Malformed token"); } };

/**
 * The runtime's public keys, per fetch function and JWKS URL: kept five minutes, and fetched again for a
 * key id not seen (a rotated key), at most every 10 seconds so a stream of bad tokens cannot flood the runtime.
 */
type KeySet = { keys: Map<string, CryptoKey>; fetched: number; loading?: Promise<void> };
const keySets = new WeakMap<typeof globalThis.fetch, Map<string, KeySet>>();
async function publicKey(url: string, kid: string, fetcher: typeof globalThis.fetch): Promise<CryptoKey> {
  let sets = keySets.get(fetcher);
  if (!sets) keySets.set(fetcher, sets = new Map());
  let set = sets.get(url);
  if (!set) sets.set(url, set = { keys: new Map(), fetched: 0 });
  const age = Date.now() - set.fetched;
  if (age > 300_000 || (!set.keys.has(kid) && age > 10_000)) {
    set.loading ??= (async () => {
      const response = await fetcher(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new RuntimeTokenError(`Could not read the runtime's keys (${url}: HTTP ${response.status})`);
      const body = await response.json() as { keys?: Record<string, any>[] };
      const keys = new Map<string, CryptoKey>();
      for (const jwk of body.keys ?? []) {
        if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.kid !== "string") continue;
        keys.set(jwk.kid, await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, false, ["verify"]));
      }
      set!.keys = keys;
      set!.fetched = Date.now();
    })().finally(() => { set!.loading = undefined; });
    await set.loading;
  }
  const key = set.keys.get(kid);
  if (!key) throw new RuntimeTokenError("Token signed with a key the runtime does not publish");
  return key;
}

/**
 * Verify an identity token and return who the call is for. Checks the signature against the runtime's
 * published Ed25519 keys (EdDSA only), the issuer, that the audience is yours, and the times.
 */
/** Refuse to check tokens without the tenant they must come from. */
function requireTenant(options: { tenant?: unknown }) {
  const valid = (value: unknown) => typeof value === "string" && value.length > 0;
  if (!(valid(options.tenant) || (Array.isArray(options.tenant) && options.tenant.length > 0 && options.tenant.every(valid)))) {
    throw new TypeError("Pass tenant: your tenant's id (GET /v1/me answers it), or a list of those you accept. Without it, another tenant's agents could act as your users");
  }
}

export async function verifyRuntimeToken(token: string, options: VerifyOptions): Promise<RuntimeIdentity & { claims: Record<string, unknown> }> {
  requireTenant(options);
  const claims = await signedClaims(token, options);
  if (![options.tenant].flat().includes(claims.tenant)) throw new RuntimeTokenError("Token is for another tenant's agent");
  const audiences = new Set((Array.isArray(options.audience) ? options.audience : [options.audience]).map(trim));
  if (![claims.aud].flat().some(audience => typeof audience === "string" && audiences.has(trim(audience)))) throw new RuntimeTokenError("Token is for another server");
  return { ...identityFromClaims(claims), claims };
}

/** A token's claims once its signature (one of the runtime's published Ed25519 keys, EdDSA only), issuer and times check out. */
async function signedClaims(token: string, options: { runtime: string; issuer?: string; fetch?: typeof globalThis.fetch; clockTolerance?: number }): Promise<Record<string, any>> {
  const pieces = token.split(".");
  if (pieces.length !== 3) throw new RuntimeTokenError("Malformed token");
  const header = part(pieces[0]);
  if (header.alg !== "EdDSA" || typeof header.kid !== "string") throw new RuntimeTokenError("Token is not an EdDSA token with a key id");
  const runtime = trim(options.runtime);
  const key = await publicKey(`${runtime}/.well-known/jwks.json`, header.kid, options.fetch ?? globalThis.fetch);
  const valid = await crypto.subtle.verify({ name: "Ed25519" }, key, base64url(pieces[2]), new TextEncoder().encode(`${pieces[0]}.${pieces[1]}`));
  if (!valid) throw new RuntimeTokenError("Token signature does not verify");
  const claims = part(pieces[1]);
  const now = Math.floor(Date.now() / 1000), skew = options.clockTolerance ?? 30;
  if (claims.iss !== issuerOf(options)) throw new RuntimeTokenError("Token is from another issuer");
  if (typeof claims.exp !== "number" || claims.exp + skew < now) throw new RuntimeTokenError("Token has expired");
  if (typeof claims.nbf === "number" && claims.nbf - skew > now) throw new RuntimeTokenError("Token is not valid yet");
  if (typeof claims.iat === "number" && claims.iat - skew > now) throw new RuntimeTokenError("Token is issued in the future");
  return claims;
}

/**
 * What a file URL the runtime sent a tool grants (`{"$file": path}` in a call's arguments): the agent and call it is
 * for, and the file (`path` in `volume`, `agentPath` as the agent names it) at a `version`, or a directory's `manifest`
 * or `archive` in a `snapshot`. `exp` is when the URL stops working (seconds).
 */
export interface FileUrlClaims {
  tenant: string; agent: string; call: string; tool: string; volume: string; path: string; agentPath: string;
  kind: "file" | "manifest" | "archive"; version?: number; snapshot?: string; iss: string; exp: number; iat: number;
}

export interface FileUrlOptions {
  /** The runtime's URL (e.g. https://run.camelai.com): the URL must be at it, and its keys are at /.well-known/jwks.json. */
  runtime: string;
  /** The tenants (or tenant) whose agents' files you accept. */
  tenant?: string | string[];
  /** The agents (or agent) whose files you accept. */
  agent?: string | string[];
  /** The issuer tokens must name; the runtime's URL by default, as for identity tokens. */
  issuer?: string;
  /** Fetches the runtime's keys; `testRuntime()` supplies one. */
  fetch?: typeof globalThis.fetch;
  /** Seconds of clock skew allowed (default 30). */
  clockTolerance?: number;
}

/**
 * Check that a file URL a tool was sent came from the runtime, for the tenant and agent you expect, and has not expired:
 * its origin is the runtime's, and its token is signed by the runtime's keys for files. Returns what it grants. The
 * runtime checks it again when the URL is fetched (and answers 410 if the file changed since the call).
 */
export async function verifyFileUrl(url: string, options: FileUrlOptions): Promise<FileUrlClaims> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new RuntimeTokenError("Not a URL"); }
  const runtime = trim(options.runtime);
  const origins = HOSTED.includes(runtime) ? HOSTED : [runtime];
  if (!origins.some(origin => new URL(origin).origin === parsed.origin)) throw new RuntimeTokenError("The URL is not at the runtime");
  const match = /^\/v1\/files\/([^/]+)\/[^/]*$/.exec(parsed.pathname);
  if (!match) throw new RuntimeTokenError("Not a file URL");
  const claims = await signedClaims(decodeURIComponent(match[1]), options);
  if (claims.aud !== "camelrun:file") throw new RuntimeTokenError("Token is not for a file");
  if (options.tenant !== undefined && ![options.tenant].flat().includes(claims.tenant)) throw new RuntimeTokenError("Token is for another tenant's agent");
  if (options.agent !== undefined && ![options.agent].flat().includes(claims.agent)) throw new RuntimeTokenError("Token is for another agent");
  return claims as FileUrlClaims;
}

/** A request's bearer token, if it has one. */
export function bearerToken(request: Request): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1];
}

/** Your server's URL as the runtime calls it, from a request: its origin and path, without query. */
const requestAudience = (request: Request) => { const url = new URL(request.url); return `${url.origin}${url.pathname}`; };

/**
 * For servers built with the MCP SDK (or Cloudflare's `createMcpHandler`): verify the request's
 * token and return MCP's `AuthInfo`, with the identity in `extra.identity` (the token's claims in `extra.claims`). Pass it as the request's
 * `auth` (`transport.handleRequest(Object.assign(req, { auth }), ...)`, or `createMcpHandler(server,
 * { authContext })`), and a tool handler reads `runtimeIdentity(extra)`.
 */
export async function runtimeAuth(request: Request, options: Omit<VerifyOptions, "audience"> & { audience?: string | string[] }) {
  requireTenant(options);
  const token = bearerToken(request);
  if (!token) throw new RuntimeTokenError("No bearer token");
  const { claims, ...identity } = await verifyRuntimeToken(token, { ...options, audience: options.audience ?? requestAudience(request) });
  return { token, clientId: identity.agent, scopes: [] as string[], expiresAt: claims.exp as number, extra: { identity: identity as RuntimeIdentity, claims } };
}

/** The identity `runtimeAuth` put in an MCP SDK tool handler's `extra`. */
export function runtimeIdentity(extra: { authInfo?: { extra?: Record<string, unknown> } } | undefined): RuntimeIdentity | undefined {
  return extra?.authInfo?.extra?.identity as RuntimeIdentity | undefined;
}

export interface ServeOptions extends Omit<VerifyOptions, "audience"> {
  /** What tokens must be for; by default the request's URL (origin and path), which is what the runtime signs for unless your definition sets `audience`. */
  audience?: string | string[];
  /** Serve MCP's protected-resource metadata (RFC 9728) naming the runtime as the issuer; on by default. */
  metadata?: boolean;
  /** The name and version `initialize` reports. */
  serverInfo?: { name: string; version: string };
}

/**
 * Serve tools (`tool({...})` definitions, any `ToolServer`, or a function of the caller's identity returning the tools,
 * to offer each agent or user its own) as a stateless MCP server over Streamable HTTP, for the runtime to call with its
 * identity tokens: a fetch handler (`(Request) => Promise<Response>`). Every call's context carries the verified
 * `identity`; requests without a valid token get a 401. The same tools can be attached to an agent instead.
 */
export function serveTools(tools: Tools | ToolServer | ((identity: RuntimeIdentity) => Tools | Promise<Tools>), options: ServeOptions): (request: Request) => Promise<Response> {
  requireTenant(options);
  const of = async (identity: RuntimeIdentity | undefined) => toolServer(await (tools as (identity: RuntimeIdentity) => Tools | Promise<Tools>)(identity!));
  const server: ToolServer = typeof tools === "function" ? { listTools: async context => (await of(context?.identity)).listTools(), callTool: async (name, args, context) => (await of(context.identity)).callTool(name, args, context) }
    : typeof (tools as ToolServer).listTools === "function" && typeof (tools as ToolServer).callTool === "function" ? tools as ToolServer : toolServer(tools as Tools);
  const issuer = issuerOf(options);
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const WELL_KNOWN = "/.well-known/oauth-protected-resource";
  return async request => {
    const url = new URL(request.url);
    // RFC 9728: the metadata for https://host/mcp is at https://host/.well-known/oauth-protected-resource/mcp.
    if (options.metadata !== false && request.method === "GET" && url.pathname.startsWith(WELL_KNOWN)) {
      const resource = `${url.origin}${url.pathname.slice(WELL_KNOWN.length) || "/"}`;
      return json(200, { resource, authorization_servers: [issuer], bearer_methods_supported: ["header"], resource_name: options.serverInfo?.name ?? "agent-runtime tools" });
    }
    if (request.method !== "POST") return json(405, { error: "Use POST: this MCP server is stateless and has no event stream" }, { Allow: "POST" });
    let identity: RuntimeIdentity;
    try {
      const token = bearerToken(request);
      if (!token) throw new RuntimeTokenError("No bearer token");
      const { claims: _claims, ...verified } = await verifyRuntimeToken(token, { ...options, audience: options.audience ?? requestAudience(request) });
      identity = verified;
    } catch (error) {
      if (!(error instanceof RuntimeTokenError)) throw error;
      const metadata = options.metadata !== false ? `, resource_metadata="${url.origin}${WELL_KNOWN}${url.pathname === "/" ? "" : url.pathname}"` : "";
      return json(401, { error: error.message }, { "WWW-Authenticate": `Bearer error="invalid_token"${metadata}` });
    }
    let body: unknown;
    try { body = await request.json(); }
    catch { return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
    const messages = Array.isArray(body) ? body : [body];
    const answers = await Promise.all(messages.map(async (message: any) => {
      if (!message || typeof message.method !== "string") return message && "id" in message ? { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32600, message: "Invalid request" } } : undefined;
      if (message.id === undefined) return undefined;
      const answer = await answerMcp(message, server, params => toolContext(params, String(message.id), request.signal, identity), options.serverInfo);
      return { jsonrpc: "2.0", id: message.id, ...answer };
    }));
    const replies = answers.filter(answer => answer !== undefined);
    // Only notifications: accepted, nothing to answer.
    if (!replies.length) return new Response(null, { status: 202 });
    return json(200, Array.isArray(body) ? replies : replies[0]);
  };
}

export { createAgentHandler, agentKeyFor } from "./handler.ts";
export type { AgentAuth, AgentHandler, AgentHandlerOptions, AgentSetup, HandlerAction, SendEvent } from "./handler.ts";
