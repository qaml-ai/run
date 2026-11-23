/**
 * CamelRun v2 OAuth 2.1 Authorization Server backed by `env.MEDIA_BUCKET` R2
 * (with an in-memory Map fallback only when `MEDIA_BUCKET` is absent in minimal tests).
 *
 * Implements:
 * - RFC 8414 Authorization Server Metadata (`/.well-known/oauth-authorization-server`)
 * - RFC 9728 Protected Resource Metadata (`/.well-known/oauth-protected-resource*`)
 * - RFC 7591 Dynamic Client Registration (`POST /oauth/register`)
 * - OAuth 2.1 Authorization Code + PKCE S256 (`GET/POST /oauth/authorize`, `POST /oauth/token`)
 * - Rotating refresh tokens with 10-second concurrent retry grace window
 * - RFC 7009 Token Revocation (`POST /oauth/revoke`)
 *
 * Zero Durable Object RPC methods are added so this works immediately under deferred DO updates.
 */

import type { Context, Hono } from "hono";
import { verifyAdminHeader } from "./auth.ts";
import {
  bytesToHex,
  constantTimeEqual,
  fromBase64Url,
  sha256Hex,
  toBase64Url,
} from "./crypto.ts";
import {
  MCP_CLIENT_KINDS,
  MCP_CLIENT_LABELS,
  mcpClientKind,
  type McpClientKind,
} from "./mcp-client-kind.ts";
import { getTenantStub } from "./tenant-do.ts";
import type { Env } from "./types.ts";

export { MCP_CLIENT_KINDS, MCP_CLIENT_LABELS, mcpClientKind, type McpClientKind };

export const OAUTH_ACCESS_PREFIX = "aro_";
export const OAUTH_REFRESH_PREFIX = "arr_";
export const OAUTH_CODE_PREFIX = "arc_";

export const ACCESS_TOKEN_MS = 3600_000; // 1 hour
export const REFRESH_TOKEN_MS = 30 * 86_400_000; // 30 days
export const REFRESH_GRACE_MS = 10_000; // 10 seconds
export const AUTH_CODE_MS = 600_000; // 10 minutes
export const CSRF_TTL_MS = 15 * 60_000; // 15 minutes
export const USED_AT_THROTTLE_MS = 5 * 60_000; // 5 minutes

const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
export type OAuthAuthMethod = (typeof AUTH_METHODS)[number];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CLIENT_ID_RE = /^mcp_[A-Za-z0-9_-]{8,128}$/;
const CSRF_COOKIE_NAME = "cr_oauth_csrf";
const MAX_FORM_BYTES = 64 * 1024;
const MAX_REGISTER_BYTES = 32 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Module-level fallback only when `env.MEDIA_BUCKET` is absent in minimal unit tests. */
const fallbackStore = new Map<string, string>();

const OAUTH_CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
  "Cache-Control": "no-store",
};

const PAGE_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "Referrer-Policy": "same-origin",
};

export interface OAuthClientRecord {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: OAuthAuthMethod;
  clientSecretHash: string | null;
  grantTypes: string[];
  responseTypes: string[];
  clientKind: McpClientKind;
  createdAt: number;
}

interface OAuthCodeRecord {
  codeHash: string;
  tenantId: string;
  email: string | null;
  login: string | null;
  clientId: string;
  clientName: string;
  clientKind: McpClientKind;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  createdAt: number;
  expiresAt: number;
}

export interface OAuthGrantRecord {
  grantId: string;
  tenantId: string;
  clientId: string;
  clientName: string;
  clientKind: McpClientKind;
  scope: string;
  email: string | null;
  login: string | null;
  createdAt: number;
  usedAt: number | null;
  revokedAt: number | null;
}

interface OAuthTokenRecord {
  kind: "access" | "refresh";
  tokenHash: string;
  tenantId: string;
  grantId: string;
  clientId: string;
  clientKind: McpClientKind;
  scope: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number | null;
  revokedAt?: number | null;
  successor?: string | null;
}

export interface OAuthUserSession {
  tenantId: string;
  email?: string | null;
  login?: string | null;
  name?: string | null;
}

export interface ResolvedOAuthToken {
  tenantId: string;
  grantId: string;
  clientId: string;
  clientName: string;
  clientKind: McpClientKind;
  scopes: string[];
}

class OAuthError extends Error {
  readonly code: string;
  readonly status: 400 | 401;
  redirect?: { redirectUri: string; state?: string };

  constructor(code: string, description: string, status: 400 | 401 = 400) {
    super(description);
    this.code = code;
    this.status = status;
  }
}

function clientKey(clientId: string): string {
  return `oauth/clients/${clientId}.json`;
}

function codeKey(codeHash: string): string {
  return `oauth/codes/${codeHash}.json`;
}

function tokenKey(tokenHash: string): string {
  return `oauth/tokens/${tokenHash}.json`;
}

function grantKey(tenantId: string, grantId: string): string {
  return `oauth/grants/${tenantId}/${grantId}.json`;
}

async function storeGetJson<T>(env: Env, key: string): Promise<T | null> {
  if (env.MEDIA_BUCKET) {
    const obj = await env.MEDIA_BUCKET.get(key);
    if (!obj) return null;
    try {
      return (await obj.json()) as T;
    } catch {
      return null;
    }
  }
  const raw = fallbackStore.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function storePutJson(env: Env, key: string, value: unknown): Promise<void> {
  const payload = JSON.stringify(value);
  if (env.MEDIA_BUCKET) {
    await env.MEDIA_BUCKET.put(key, payload, {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    return;
  }
  fallbackStore.set(key, payload);
}

async function storeDelete(env: Env, key: string): Promise<void> {
  if (env.MEDIA_BUCKET) {
    await env.MEDIA_BUCKET.delete(key);
    return;
  }
  fallbackStore.delete(key);
}

async function storeListKeys(env: Env, prefix: string): Promise<string[]> {
  if (env.MEDIA_BUCKET) {
    const keys: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await env.MEDIA_BUCKET.list({ prefix, cursor, limit: 1000 });
      for (const obj of page.objects) keys.push(obj.key);
      if (!page.truncated) break;
      cursor = page.cursor;
    }
    return keys;
  }
  const keys: string[] = [];
  for (const key of fallbackStore.keys()) {
    if (key.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

function randomBase64Url(byteLength: number): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return toBase64Url(buf);
}

function randomHex(byteLength: number): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toBase64Url(new Uint8Array(digest));
}

async function hmacBase64Url(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return toBase64Url(new Uint8Array(sig));
}

async function deriveSuccessorKey(refreshToken: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`oauth-successor:${refreshToken}`));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function sealSuccessor(refreshToken: string, value: Record<string, unknown>): Promise<string> {
  const key = await deriveSuccessorKey(refreshToken);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(JSON.stringify(value)),
  );
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(cipher))}`;
}

async function unsealSuccessor(refreshToken: string, sealed: string): Promise<Record<string, unknown> | null> {
  try {
    const [ivB64, cipherB64] = sealed.split(".");
    if (!ivB64 || !cipherB64) return null;
    const key = await deriveSuccessorKey(refreshToken);
    const iv = fromBase64Url(ivB64);
    const cipher = fromBase64Url(cipherB64);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      cipher as BufferSource,
    );
    return JSON.parse(decoder.decode(plain)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

function parseCookies(header: string | null): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (name) out[name] = val;
  }
  return out;
}

function validRedirect(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 2000) return false;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash || uri.includes("#")) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname);
  return (
    /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) &&
    !["javascript:", "data:", "file:", "vbscript:", "blob:", "about:", "ftp:", "ws:", "wss:"].includes(url.protocol)
  );
}

function redirectMatches(registered: string, given: string): boolean {
  if (registered === given) return true;
  try {
    const a = new URL(registered);
    const b = new URL(given);
    return (
      a.protocol === "http:" &&
      b.protocol === "http:" &&
      LOOPBACK_HOSTS.has(a.hostname) &&
      a.hostname === b.hostname &&
      a.pathname === b.pathname &&
      a.search === b.search
    );
  } catch {
    return false;
  }
}

function destinationOf(uri: string): string {
  const url = new URL(uri);
  if (url.protocol === "https:" || url.protocol === "http:") return `${url.protocol}//${url.host}`;
  const shown = `${url.protocol}${uri.slice(url.protocol.length).split("?")[0]}`;
  return shown.length > 200 ? `${shown.slice(0, 200)}…` : shown;
}

function renderHtmlPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · camelRun</title><style>
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--card:#fff;--line:#e7e5e4;--accent:#1c1917;--on:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0c0a09;--fg:#f5f5f4;--muted:#a8a29e;--card:#1c1917;--line:#292524;--accent:#f5f5f4;--on:#0c0a09}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:16px;box-sizing:border-box}
main{max-width:440px;width:100%;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 12px}.muted{color:var(--muted);font-size:13px}code{font-size:13px}
button,.button{display:inline-block;border:1px solid var(--accent);background:var(--accent);color:var(--on);border-radius:8px;padding:8px 16px;font:inherit;cursor:pointer;text-decoration:none}
.secondary{background:transparent;color:var(--fg)}.brand{font-weight:600;margin-bottom:16px}
.destination{border:1px solid var(--line);border-radius:8px;padding:10px 12px;word-break:break-all}.destination code{font-size:15px}
.scopes{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.scope{border:1px solid var(--line);border-radius:6px;padding:2px 8px;font-size:12px}
.actions{display:flex;gap:8px;margin-top:16px}</style></head><body><main><div class="brand">camelRun</div>${body}</main></body></html>`;
}

/** Public OAuth issuer origin (respecting `VOICE_PUBLIC_URL` when configured). */
export function oauthIssuerFor(request: Request, env: Env): string {
  const configured = env.VOICE_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return new URL(request.url).origin;
}

/** Reached resource origin for RFC 9728 protected-resource metadata. */
export function oauthResourceOriginFor(request: Request, env: Env): string {
  const url = new URL(request.url);
  const configured = env.VOICE_PUBLIC_URL?.trim()?.replace(/\/+$/, "");
  if (configured) {
    try {
      const cfgUrl = new URL(configured);
      if (url.host === cfgUrl.host || LOOPBACK_HOSTS.has(url.hostname)) {
        return configured;
      }
    } catch {
      // Ignore malformed VOICE_PUBLIC_URL
    }
  }
  return url.origin;
}

export function oauthAuthorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: ["agents", "mcp"],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [...AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
    authorization_response_iss_parameter_supported: true,
  };
}

export function oauthProtectedResourceDocument(
  resourceUrl: string,
  issuerOrigin: string,
  scopes: string[] = ["agents"],
) {
  return {
    resource: resourceUrl,
    authorization_servers: [issuerOrigin],
    bearer_methods_supported: ["header"],
    scopes_supported: scopes,
    resource_name: "camelRun",
    resource_documentation: "https://camelai.com/docs/camelrun/overview",
  };
}

function csrfSecret(env: Env): string {
  return env.VAULT_SECRET || env.ADMIN_SECRET || "camelrun-oauth-csrf-dev";
}

async function mintCsrfToken(
  env: Env,
  binding: { tenantId: string; clientId: string; redirectUri: string; codeChallenge: string },
): Promise<{ token: string; nonce: string }> {
  const nonce = randomBase64Url(18);
  const exp = String(Date.now() + CSRF_TTL_MS);
  const mac = await hmacBase64Url(
    csrfSecret(env),
    `oauth-csrf:${nonce}:${exp}:${binding.tenantId}:${binding.clientId}:${binding.redirectUri}:${binding.codeChallenge}`,
  );
  return { token: `${nonce}.${exp}.${mac}`, nonce };
}

async function verifyCsrfToken(
  env: Env,
  token: string | null,
  cookieNonce: string | undefined,
  binding: { tenantId: string; clientId: string; redirectUri: string; codeChallenge: string },
): Promise<boolean> {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [nonce, expStr, providedMac] = parts;
  if (!nonce || !expStr || !providedMac) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= Date.now()) return false;
  if (cookieNonce !== undefined && !constantTimeEqual(cookieNonce, nonce)) return false;
  const expectedMac = await hmacBase64Url(
    csrfSecret(env),
    `oauth-csrf:${nonce}:${expStr}:${binding.tenantId}:${binding.clientId}:${binding.redirectUri}:${binding.codeChallenge}`,
  );
  return constantTimeEqual(providedMac, expectedMac);
}

function normalizeScope(raw: string | null | undefined): string {
  if (!raw) return "agents";
  const allowed = new Set(["agents", "mcp"]);
  const parts = raw
    .trim()
    .split(/\s+/)
    .filter((s) => allowed.has(s));
  return parts.length > 0 ? [...new Set(parts)].join(" ") : "agents";
}

function getVerifiedConsoleSession(env: Env, request: Request): OAuthUserSession | null {
  if (!verifyAdminHeader(env, request)) return null;
  const raw = request.headers.get("x-oauth-session");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OAuthUserSession>;
    if (typeof parsed.tenantId !== "string" || !parsed.tenantId.trim()) return null;
    return {
      tenantId: parsed.tenantId.trim(),
      email: typeof parsed.email === "string" ? parsed.email : null,
      login: typeof parsed.login === "string" ? parsed.login : null,
      name: typeof parsed.name === "string" ? parsed.name : null,
    };
  } catch {
    return null;
  }
}

async function readLimitedText(request: Request, maxBytes: number): Promise<string> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) {
    throw new OAuthError("invalid_request", `Request body exceeds ${maxBytes} bytes`);
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new OAuthError("invalid_request", `Request body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoder.decode(merged);
}

async function readFormOrJsonParams(request: Request): Promise<URLSearchParams> {
  const text = await readLimitedText(request, MAX_FORM_BYTES);
  const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("application/json")) {
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new OAuthError("invalid_request", "Malformed JSON body");
    }
    if (!parsed || typeof parsed !== "object") {
      throw new OAuthError("invalid_request", "Expected JSON object");
    }
    const entries: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") entries.push([k, v]);
    }
    return new URLSearchParams(entries);
  }
  return new URLSearchParams(text);
}

async function loadClient(env: Env, clientId: string | null | undefined): Promise<OAuthClientRecord | null> {
  if (!clientId || !CLIENT_ID_RE.test(clientId)) return null;
  return storeGetJson<OAuthClientRecord>(env, clientKey(clientId));
}

async function authenticateOAuthClient(
  env: Env,
  request: Request,
  form: URLSearchParams,
): Promise<OAuthClientRecord> {
  let clientId = form.get("client_id") ?? undefined;
  let secret = form.get("client_secret") ?? undefined;

  const authHeader = request.headers.get("authorization") ?? "";
  const basicMatch = /^Basic\s+(.+)$/i.exec(authHeader);
  if (basicMatch?.[1]) {
    let decoded: string;
    try {
      decoded = atob(basicMatch[1].trim());
    } catch {
      throw new OAuthError("invalid_client", "Malformed Basic credentials", 401);
    }
    const colon = decoded.indexOf(":");
    if (colon < 0) throw new OAuthError("invalid_client", "Malformed Basic credentials", 401);
    clientId = decodeURIComponent(decoded.slice(0, colon));
    secret = decodeURIComponent(decoded.slice(colon + 1));
  }

  const client = await loadClient(env, clientId);
  if (!client) {
    throw new OAuthError("invalid_client", "Unknown client", 401);
  }
  if (client.tokenEndpointAuthMethod !== "none") {
    if (!secret || !client.clientSecretHash) {
      throw new OAuthError("invalid_client", "Wrong or missing client secret", 401);
    }
    const secretHash = await sha256Hex(secret);
    if (!constantTimeEqual(secretHash, client.clientSecretHash)) {
      throw new OAuthError("invalid_client", "Wrong or missing client secret", 401);
    }
  }
  return client;
}

async function validateAuthorizationParams(
  env: Env,
  request: Request,
  params: URLSearchParams,
): Promise<{
  client: OAuthClientRecord;
  redirectUri: string;
  state: string | undefined;
  codeChallenge: string;
  scope: string;
}> {
  const client = await loadClient(env, params.get("client_id"));
  if (!client) {
    throw new OAuthError(
      "invalid_client",
      "This application is not registered here (unknown client_id). Try connecting it again.",
    );
  }
  const redirectUri =
    params.get("redirect_uri") ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : "");
  if (!redirectUri || !client.redirectUris.some((reg) => redirectMatches(reg, redirectUri))) {
    throw new OAuthError("invalid_request", "The redirect URI is not one this application registered.");
  }

  const state = params.get("state") ?? undefined;
  const fail = (code: string, description: string) => {
    const err = new OAuthError(code, description);
    err.redirect = { redirectUri, state };
    return err;
  };

  if (params.get("response_type") !== "code") {
    throw fail("unsupported_response_type", "response_type must be code");
  }
  const codeChallenge = params.get("code_challenge") ?? "";
  if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeChallenge)) {
    throw fail("invalid_request", "PKCE is required: code_challenge with code_challenge_method S256");
  }
  if ((state?.length ?? 0) > 2000) {
    throw fail("invalid_request", "state is too long");
  }

  const resourceParam = params.get("resource");
  if (resourceParam !== null && resourceParam.trim() !== "") {
    const issuerOrigin = oauthIssuerFor(request, env);
    const reachedOrigin = oauthResourceOriginFor(request, env);
    const origins = new Set([issuerOrigin, reachedOrigin, "https://run.camelai.com", "https://agents.camelai.dev"]);
    const validResource = [...origins].some(
      (orig) =>
        resourceParam === orig ||
        resourceParam === `${orig}/` ||
        resourceParam === `${orig}/mcp` ||
        resourceParam === `${orig}/mcp/` ||
        resourceParam === `${orig}/v2/mcp` ||
        resourceParam === `${orig}/v2/mcp/` ||
        (resourceParam.startsWith(`${orig}/v2/agents/`) && /^\/v2\/agents\/[^/]+\/mcp\/?$/.test(resourceParam.slice(orig.length))),
    );
    if (!validResource) {
      throw fail("invalid_target", `Unsupported resource target: ${resourceParam.slice(0, 120)}`);
    }
  }

  const scope = normalizeScope(params.get("scope"));
  return { client, redirectUri, state, codeChallenge, scope };
}

function redirectWithOAuthParams(
  c: Context,
  to: { redirectUri: string; state?: string },
  issuer: string,
  params: Record<string, string>,
): Response {
  const url = new URL(to.redirectUri);
  for (const [k, v] of Object.entries({
    ...params,
    ...(to.state !== undefined ? { state: to.state } : {}),
    iss: issuer,
  })) {
    url.searchParams.set(k, v);
  }
  return c.redirect(url.href, 302);
}

async function issueTokensForGrant(
  env: Env,
  grant: OAuthGrantRecord,
): Promise<{
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}> {
  const now = Date.now();
  const accessToken = `${OAUTH_ACCESS_PREFIX}${randomBase64Url(32)}`;
  const refreshToken = `${OAUTH_REFRESH_PREFIX}${randomBase64Url(32)}`;
  const [accessHash, refreshHash] = await Promise.all([sha256Hex(accessToken), sha256Hex(refreshToken)]);

  const accessRecord: OAuthTokenRecord = {
    kind: "access",
    tokenHash: accessHash,
    tenantId: grant.tenantId,
    grantId: grant.grantId,
    clientId: grant.clientId,
    clientKind: grant.clientKind,
    scope: grant.scope,
    createdAt: now,
    expiresAt: now + ACCESS_TOKEN_MS,
    revokedAt: null,
  };
  const refreshRecord: OAuthTokenRecord = {
    kind: "refresh",
    tokenHash: refreshHash,
    tenantId: grant.tenantId,
    grantId: grant.grantId,
    clientId: grant.clientId,
    clientKind: grant.clientKind,
    scope: grant.scope,
    createdAt: now,
    expiresAt: now + REFRESH_TOKEN_MS,
    usedAt: null,
    revokedAt: null,
    successor: null,
  };

  const updatedGrant: OAuthGrantRecord = { ...grant, usedAt: now };

  await Promise.all([
    storePutJson(env, tokenKey(accessHash), accessRecord),
    storePutJson(env, tokenKey(refreshHash), refreshRecord),
    storePutJson(env, grantKey(grant.tenantId, grant.grantId), updatedGrant),
  ]);

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TOKEN_MS / 1000),
    refresh_token: refreshToken,
    scope: grant.scope,
  };
}

/**
 * Verifies an opaque `aro_...` OAuth access token from R2, returning the bound tenant/grant
 * and updating `grant.usedAt` at most once every 5 minutes so R2 writes stay tiny.
 */
export async function resolveOAuthAccessToken(
  env: Env,
  token: string,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<ResolvedOAuthToken | null> {
  if (!token.startsWith(OAUTH_ACCESS_PREFIX)) return null;
  const hash = await sha256Hex(token);
  const record = await storeGetJson<OAuthTokenRecord>(env, tokenKey(hash));
  const now = Date.now();
  if (!record || record.kind !== "access" || record.revokedAt != null || record.expiresAt <= now) {
    return null;
  }

  const grant = await storeGetJson<OAuthGrantRecord>(env, grantKey(record.tenantId, record.grantId));
  if (!grant || grant.revokedAt != null) {
    return null;
  }

  // Throttled usedAt update (at most once per 5 minutes)
  if (!grant.usedAt || now - grant.usedAt >= USED_AT_THROTTLE_MS) {
    const touchPromise = storePutJson(env, grantKey(grant.tenantId, grant.grantId), {
      ...grant,
      usedAt: now,
    }).catch(() => {});
    if (ctx) ctx.waitUntil(touchPromise);
    else await touchPromise;
  }

  return {
    tenantId: grant.tenantId,
    grantId: grant.grantId,
    clientId: grant.clientId,
    clientName: grant.clientName,
    clientKind: grant.clientKind,
    scopes: grant.scope.split(/\s+/).filter(Boolean),
  };
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        results[i] = await fn(items[i]!);
      }
    }),
  );
  return results;
}

/** Lists all OAuth grant records stored in R2 (for ops MCP & acquisition aggregation). */
export async function listAllOAuthGrants(env: Env): Promise<OAuthGrantRecord[]> {
  const keys = await storeListKeys(env, "oauth/grants/");
  if (keys.length === 0) return [];
  const items = await mapWithConcurrency(keys, 20, (key) => storeGetJson<OAuthGrantRecord>(env, key));
  return items.filter((g): g is OAuthGrantRecord => g !== null && typeof g.grantId === "string");
}

/** Lists OAuth grant records for a single tenant from R2. */
export async function listTenantOAuthGrants(env: Env, tenantId: string): Promise<OAuthGrantRecord[]> {
  const keys = await storeListKeys(env, `oauth/grants/${tenantId}/`);
  if (keys.length === 0) return [];
  const items = await mapWithConcurrency(keys, 20, (key) => storeGetJson<OAuthGrantRecord>(env, key));
  return items.filter((g): g is OAuthGrantRecord => g !== null && typeof g.grantId === "string");
}

function oauthJsonError(c: Context, err: unknown): Response {
  if (!(err instanceof OAuthError)) throw err;
  return c.json(
    { error: err.code, error_description: err.message },
    err.status,
    {
      ...OAUTH_CORS,
      ...(err.status === 401 ? { "WWW-Authenticate": 'Basic realm="oauth"' } : {}),
    },
  );
}

/** Registers OAuth 2.1 metadata, DCR, authorize, token, and revoke routes on the v2 Worker Hono app. */
export function registerOAuthRoutes(app: Hono<{ Bindings: Env }>): void {
  const preflight = (c: Context) =>
    c.body(null, 204, { ...OAUTH_CORS, "Access-Control-Max-Age": "86400" });

  // 1. RFC 8414 Authorization Server Metadata
  app.options("/.well-known/oauth-authorization-server", preflight);
  app.get("/.well-known/oauth-authorization-server", (c) => {
    const origin = oauthIssuerFor(c.req.raw, c.env);
    return c.json(oauthAuthorizationServerMetadata(origin), 200, {
      ...OAUTH_CORS,
      "Cache-Control": "public, max-age=300",
    });
  });

  // 2. RFC 9728 Protected Resource Metadata for root `/mcp`
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    app.options(path, preflight);
    app.get(path, (c) => {
      const resourceOrigin = oauthResourceOriginFor(c.req.raw, c.env);
      const issuer = oauthIssuerFor(c.req.raw, c.env);
      return c.json(oauthProtectedResourceDocument(`${resourceOrigin}/mcp`, issuer, ["agents"]), 200, {
        ...OAUTH_CORS,
        "Cache-Control": "public, max-age=300",
      });
    });
  }

  // 3. RFC 7591 Dynamic Client Registration
  app.options("/oauth/register", preflight);
  app.post("/oauth/register", async (c) => {
    try {
      const text = await readLimitedText(c.req.raw, MAX_REGISTER_BYTES);
      let body: Record<string, unknown>;
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not object");
        body = parsed as Record<string, unknown>;
      } catch {
        throw new OAuthError("invalid_client_metadata", "Send the client's metadata as JSON");
      }

      const uris = body.redirect_uris;
      if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10) {
        throw new OAuthError("invalid_redirect_uri", "redirect_uris is a list of 1 to 10 URIs");
      }
      for (const uri of uris) {
        if (!validRedirect(uri)) {
          throw new OAuthError(
            "invalid_redirect_uri",
            `Not a redirect URI this server accepts: ${String(uri).slice(0, 200)} (https, http on a loopback address, or an app's own scheme; no fragment)`,
          );
        }
      }

      const method = (body.token_endpoint_auth_method ?? "none") as OAuthAuthMethod;
      if (!AUTH_METHODS.includes(method)) {
        throw new OAuthError(
          "invalid_client_metadata",
          `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(", ")}`,
        );
      }

      const grantTypes = Array.isArray(body.grant_types)
        ? (body.grant_types as unknown[])
        : ["authorization_code", "refresh_token"];
      if (grantTypes.some((t) => t !== "authorization_code" && t !== "refresh_token")) {
        throw new OAuthError("invalid_client_metadata", "grant_types are authorization_code and refresh_token");
      }
      if (
        body.response_types !== undefined &&
        (!Array.isArray(body.response_types) || body.response_types.some((t) => t !== "code"))
      ) {
        throw new OAuthError("invalid_client_metadata", 'response_types must be ["code"]');
      }

      const clientName =
        typeof body.client_name === "string" && body.client_name.trim()
          ? body.client_name.trim().slice(0, 100)
          : "An MCP client";
      const clientId = `mcp_${randomHex(16)}`;
      const clientKind = mcpClientKind(clientName, uris);
      const clientSecret = method === "none" ? undefined : `mcs_${randomBase64Url(32)}`;
      const clientSecretHash = clientSecret ? await sha256Hex(clientSecret) : null;
      const now = Date.now();

      const record: OAuthClientRecord = {
        clientId,
        clientName,
        redirectUris: uris,
        tokenEndpointAuthMethod: method,
        clientSecretHash,
        grantTypes: grantTypes as string[],
        responseTypes: ["code"],
        clientKind,
        createdAt: now,
      };
      await storePutJson(c.env, clientKey(clientId), record);

      return c.json(
        {
          client_id: clientId,
          client_id_issued_at: Math.floor(now / 1000),
          client_name: clientName,
          redirect_uris: uris,
          grant_types: grantTypes,
          response_types: ["code"],
          token_endpoint_auth_method: method,
          scope: "agents",
          ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
        },
        201,
        OAUTH_CORS,
      );
    } catch (err) {
      return oauthJsonError(c, err);
    }
  });

  // 4. OAuth 2.1 Authorization & Consent Screen
  const showAuthorizeError = (c: Context, err: unknown) => {
    if (!(err instanceof OAuthError)) throw err;
    if (err.redirect) {
      return redirectWithOAuthParams(c, err.redirect, oauthIssuerFor(c.req.raw, c.env), {
        error: err.code,
        error_description: err.message,
      });
    }
    return c.html(
      renderHtmlPage("Cannot connect", `<h1>Cannot connect this application</h1><p>${escapeHtml(err.message)}</p>`),
      400,
      PAGE_HEADERS,
    );
  };

  app.get("/oauth/authorize", async (c) => {
    const url = new URL(c.req.url);
    const params = url.searchParams;
    let authReq: Awaited<ReturnType<typeof validateAuthorizationParams>>;
    try {
      authReq = await validateAuthorizationParams(c.env, c.req.raw, params);
    } catch (err) {
      return showAuthorizeError(c, err);
    }

    const session = getVerifiedConsoleSession(c.env, c.req.raw);
    const here = `/oauth/authorize?${params.toString()}`;
    if (!session) {
      return new Response(null, {
        status: 302,
        headers: {
          Location: `/console/sign-in?next=${encodeURIComponent(here)}`,
          "Cache-Control": "no-store",
        },
      });
    }

    const csrf = await mintCsrfToken(c.env, {
      tenantId: session.tenantId,
      clientId: authReq.client.clientId,
      redirectUri: authReq.redirectUri,
      codeChallenge: authReq.codeChallenge,
    });

    const destination = escapeHtml(destinationOf(authReq.redirectUri));
    const displayIdentity = session.email || session.login || session.name || session.tenantId;
    const scopes = authReq.scope.split(/\s+/).filter(Boolean);
    const hiddenInputs = [...params.entries()]
      .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
      .join("");

    const isLocalHttp = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
    const csrfCookie = [
      `${CSRF_COOKIE_NAME}=${csrf.nonce}`,
      "Path=/oauth/authorize",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${Math.floor(CSRF_TTL_MS / 1000)}`,
      ...(isLocalHttp ? [] : ["Secure"]),
    ].join("; ");

    const html = renderHtmlPage(
      "Connect",
      `<h1>Connect ${escapeHtml(authReq.client.clientName)}?</h1>
<p class="muted">Signed in as <strong>${escapeHtml(displayIdentity)}</strong></p>
<p class="destination">Access goes to<br><strong><code>${destination}</code></strong></p>
<div class="scopes">${scopes.map((s) => `<span class="scope">${escapeHtml(s)}</span>`).join("")}</div>
<p>An application calling itself <strong>${escapeHtml(authReq.client.clientName)}</strong> <span class="muted">(unverified)</span> is asking to manage your camelRun agents and MCP tools. It acts for this account until you revoke it.</p>
<p class="muted">Only approve if you trust <code>${destination}</code>.</p>
<form method="post" action="/oauth/authorize">
${hiddenInputs}
<input type="hidden" name="csrf_token" value="${escapeHtml(csrf.token)}">
<div class="actions">
<button type="submit" name="decision" value="allow">Approve</button>
<button type="submit" name="decision" value="deny" class="secondary">Deny</button>
</div>
</form>`,
    );

    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...PAGE_HEADERS,
        "Set-Cookie": csrfCookie,
      },
    });
  });

  app.post("/oauth/authorize", async (c) => {
    const url = new URL(c.req.url);
    const originHeader = c.req.header("origin");
    if (originHeader) {
      const issuerOrigin = oauthIssuerFor(c.req.raw, c.env);
      if (originHeader !== url.origin && originHeader !== issuerOrigin) {
        return c.html(
          renderHtmlPage("Forbidden", "<h1>Forbidden</h1><p>This form must be submitted from this site.</p>"),
          403,
          PAGE_HEADERS,
        );
      }
    }

    const params = await readFormOrJsonParams(c.req.raw);
    const decision = params.get("decision");
    const csrfToken = params.get("csrf_token");
    params.delete("decision");
    params.delete("csrf_token");

    let authReq: Awaited<ReturnType<typeof validateAuthorizationParams>>;
    try {
      authReq = await validateAuthorizationParams(c.env, c.req.raw, params);
    } catch (err) {
      return showAuthorizeError(c, err);
    }

    const session = getVerifiedConsoleSession(c.env, c.req.raw);
    if (!session) {
      const here = `/oauth/authorize?${params.toString()}`;
      return new Response(null, {
        status: 302,
        headers: {
          Location: `/console/sign-in?next=${encodeURIComponent(here)}`,
          "Cache-Control": "no-store",
        },
      });
    }

    const cookies = parseCookies(c.req.header("cookie") ?? null);
    const csrfOk = await verifyCsrfToken(c.env, csrfToken, cookies[CSRF_COOKIE_NAME], {
      tenantId: session.tenantId,
      clientId: authReq.client.clientId,
      redirectUri: authReq.redirectUri,
      codeChallenge: authReq.codeChallenge,
    });
    if (!csrfOk) {
      return c.html(
        renderHtmlPage("Forbidden", "<h1>Invalid or expired consent form</h1><p>Please restart authorization from the application.</p>"),
        403,
        PAGE_HEADERS,
      );
    }

    const issuer = oauthIssuerFor(c.req.raw, c.env);
    if (decision !== "allow" && decision !== "approve") {
      return redirectWithOAuthParams(c, authReq, issuer, {
        error: "access_denied",
        error_description: "The user denied access",
      });
    }

    const code = `${OAUTH_CODE_PREFIX}${randomBase64Url(32)}`;
    const codeHash = await sha256Hex(code);
    const now = Date.now();
    const codeRecord: OAuthCodeRecord = {
      codeHash,
      tenantId: session.tenantId,
      email: session.email ?? null,
      login: session.login ?? null,
      clientId: authReq.client.clientId,
      clientName: authReq.client.clientName,
      clientKind: authReq.client.clientKind,
      redirectUri: authReq.redirectUri,
      codeChallenge: authReq.codeChallenge,
      scope: authReq.scope,
      createdAt: now,
      expiresAt: now + AUTH_CODE_MS,
    };
    await storePutJson(c.env, codeKey(codeHash), codeRecord);

    return redirectWithOAuthParams(c, authReq, issuer, { code });
  });

  // 5. OAuth 2.1 Token Endpoint (authorization_code + refresh_token)
  app.options("/oauth/token", preflight);
  app.post("/oauth/token", async (c) => {
    try {
      const form = await readFormOrJsonParams(c.req.raw);
      const client = await authenticateOAuthClient(c.env, c.req.raw, form);
      const grantType = form.get("grant_type");

      if (grantType === "authorization_code") {
        const code = form.get("code") ?? "";
        if (!code.startsWith(OAUTH_CODE_PREFIX)) {
          throw new OAuthError("invalid_grant", "The code is unknown, used or expired");
        }
        const hash = await sha256Hex(code);
        const record = await storeGetJson<OAuthCodeRecord>(c.env, codeKey(hash));
        if (!record || record.expiresAt <= Date.now()) {
          if (record) await storeDelete(c.env, codeKey(hash));
          throw new OAuthError("invalid_grant", "The code is unknown, used or expired");
        }
        if (record.clientId !== client.clientId) {
          throw new OAuthError("invalid_grant", "The code was issued to another client");
        }
        const providedRedirect = form.get("redirect_uri") ?? record.redirectUri;
        if (providedRedirect !== record.redirectUri) {
          throw new OAuthError("invalid_grant", "redirect_uri differs from the authorization request");
        }

        const verifier = form.get("code_verifier") ?? "";
        if (
          !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
          !constantTimeEqual(await sha256Base64Url(verifier), record.codeChallenge)
        ) {
          throw new OAuthError("invalid_grant", "The code_verifier does not match the code_challenge");
        }

        // Consume auth code (single-use)
        await storeDelete(c.env, codeKey(hash));

        // Verify tenant still exists (uses existing TenantDO.getProfile RPC)
        const profile = await getTenantStub(c.env, record.tenantId).getProfile();
        if (!profile) {
          throw new OAuthError("invalid_grant", "The account no longer exists");
        }

        const now = Date.now();
        const grant: OAuthGrantRecord = {
          grantId: `grt_${randomHex(12)}`,
          tenantId: record.tenantId,
          clientId: client.clientId,
          clientName: client.clientName,
          clientKind: client.clientKind,
          scope: record.scope,
          email: record.email,
          login: record.login,
          createdAt: now,
          usedAt: now,
          revokedAt: null,
        };
        const issued = await issueTokensForGrant(c.env, grant);
        return c.json(issued, 200, { ...OAUTH_CORS, Pragma: "no-cache" });
      }

      if (grantType === "refresh_token") {
        const presented = form.get("refresh_token") ?? "";
        if (!presented.startsWith(OAUTH_REFRESH_PREFIX)) {
          throw new OAuthError("invalid_grant", "The refresh token is unknown, used or revoked");
        }
        const hash = await sha256Hex(presented);
        const tokenRec = await storeGetJson<OAuthTokenRecord>(c.env, tokenKey(hash));
        if (!tokenRec || tokenRec.kind !== "refresh" || tokenRec.revokedAt != null) {
          throw new OAuthError("invalid_grant", "The refresh token is unknown, used or revoked");
        }
        if (tokenRec.clientId !== client.clientId) {
          throw new OAuthError("invalid_grant", "The refresh token was issued to another client");
        }
        const now = Date.now();
        if (tokenRec.expiresAt <= now) {
          throw new OAuthError("invalid_grant", "The refresh token expired; connect again");
        }

        const grant = await storeGetJson<OAuthGrantRecord>(c.env, grantKey(tokenRec.tenantId, tokenRec.grantId));
        if (!grant || grant.revokedAt != null) {
          throw new OAuthError("invalid_grant", "The refresh token is unknown, used or revoked");
        }

        if (tokenRec.usedAt != null) {
          if (tokenRec.successor && now - tokenRec.usedAt <= REFRESH_GRACE_MS) {
            const unsealed = await unsealSuccessor(presented, tokenRec.successor);
            if (unsealed) {
              return c.json(unsealed, 200, { ...OAUTH_CORS, Pragma: "no-cache" });
            }
          }
          // Past grace window: refresh token reuse revokes the grant
          await storePutJson(c.env, grantKey(grant.tenantId, grant.grantId), {
            ...grant,
            revokedAt: now,
          });
          throw new OAuthError("invalid_grant", "The refresh token is unknown, used or revoked");
        }

        const issued = await issueTokensForGrant(c.env, grant);
        const sealed = await sealSuccessor(presented, issued);
        await storePutJson(c.env, tokenKey(hash), {
          ...tokenRec,
          usedAt: now,
          successor: sealed,
        });

        return c.json(issued, 200, { ...OAUTH_CORS, Pragma: "no-cache" });
      }

      throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
    } catch (err) {
      return oauthJsonError(c, err);
    }
  });

  // 6. RFC 7009 Token Revocation
  app.options("/oauth/revoke", preflight);
  app.post("/oauth/revoke", async (c) => {
    try {
      const form = await readFormOrJsonParams(c.req.raw);
      const hasClientCreds =
        Boolean(form.get("client_id")) || /^Basic\s+/i.test(c.req.header("authorization") ?? "");
      const authedClient = hasClientCreds ? await authenticateOAuthClient(c.env, c.req.raw, form) : null;

      const token = form.get("token") ?? "";
      if (token.startsWith(OAUTH_ACCESS_PREFIX) || token.startsWith(OAUTH_REFRESH_PREFIX)) {
        const hash = await sha256Hex(token);
        const tokenRec = await storeGetJson<OAuthTokenRecord>(c.env, tokenKey(hash));
        if (tokenRec) {
          // If client credentials were provided, verify client ownership; if omitted, only allow revoking public-client tokens.
          let allowed = false;
          if (authedClient) {
            allowed = tokenRec.clientId === authedClient.clientId;
          } else {
            const ownerClient = await loadClient(c.env, tokenRec.clientId);
            allowed = ownerClient?.tokenEndpointAuthMethod === "none";
          }
          if (allowed) {
            const now = Date.now();
            await storePutJson(c.env, tokenKey(hash), { ...tokenRec, revokedAt: now });
            const grant = await storeGetJson<OAuthGrantRecord>(
              c.env,
              grantKey(tokenRec.tenantId, tokenRec.grantId),
            );
            if (grant && grant.revokedAt == null) {
              await storePutJson(c.env, grantKey(grant.tenantId, grant.grantId), {
                ...grant,
                revokedAt: now,
              });
            }
          }
        }
      }

      return c.body(null, 200, OAUTH_CORS);
    } catch (err) {
      return oauthJsonError(c, err);
    }
  });
}
