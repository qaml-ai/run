/**
 * CamelRun v2 Console edge handler:
 * - Serves the built Vite SPA (`console/dist`) via Cloudflare Workers Static Assets (`env.ASSETS`) at `/console/*`
 * - Redirects `/` -> `/console/` on `run.camelai.com`
 * - Handles GitHub OAuth, Google (Gmail) OIDC (PKCE + nonce + RS256 JWKS via jose), and Email/Password sign-in/sign-up
 *   backed by the singleton `__console_accounts__` TenantDO on `env.V2` (zero Postgres)
 * - Stores an AES-256-GCM encrypted HttpOnly session cookie (`cr_console`) sealed with `CONSOLE_SESSION_SECRET`
 * - Proxies `/console/v2/*` -> `/v2/*` on `env.V2` with Bearer injection and CSRF protection (`X-Agent-Runtime-Console: 1` + same-origin)
 */

import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";

export interface ConsoleEnv {
  ASSETS?: { fetch(request: Request): Promise<Response> };
  V2: { fetch(request: Request): Promise<Response> };
  CONSOLE_SESSION_SECRET?: string;
  ADMIN_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Optional overrides for tests (defaults to github.com / api.github.com / accounts.google.com). */
  GITHUB_WEB_URL?: string;
  GITHUB_API_URL?: string;
  GOOGLE_ISSUER?: string;
}

const COOKIE_NAME = "cr_console";
const GITHUB_STATE_COOKIE = "cr_oauth_state";
const GOOGLE_STATE_COOKIE = "cr_google_oauth";
const NEXT_COOKIE = "cr_oauth_next";
const CONSOLE_HEADER = "x-agent-runtime-console";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const OAUTH_STATE_TTL_SECONDS = 600;
const GOOGLE_DEFAULT_ISSUER = "https://accounts.google.com";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}
const oidcCache = new Map<string, { value: OidcDiscovery; expiresAt: number }>();

const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "),
};

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(normalized + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function randomBase64Url(byteLength: number): string {
  const buf = new Uint8Array(byteLength);
  crypto.getRandomValues(buf);
  return toBase64Url(buf);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toBase64Url(new Uint8Array(digest));
}

function constantTimeEqual(a: string, b: string): boolean {
  const ba = encoder.encode(a);
  const bb = encoder.encode(b);
  const len = Math.max(ba.length, bb.length);
  let diff = ba.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

function deriveSessionKey(secret: string): Promise<CryptoKey> {
  let cached = keyCache.get(secret);
  if (!cached) {
    cached = (async () => {
      const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`camelrun-console-session-v2:${secret}`));
      return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    })();
    keyCache.set(secret, cached);
  }
  return cached;
}

export type ConsoleProvider = "github" | "google" | "password";

export interface SessionPayload {
  tenantId?: string;
  apiKey: string;
  email?: string | null;
  login?: string | null;
  name?: string | null;
  provider?: ConsoleProvider;
  exp: number;
}

export async function sealConsoleSession(payload: SessionPayload, secret: string): Promise<string> {
  const key = await deriveSessionKey(secret);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const plain = encoder.encode(JSON.stringify(payload));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  return `v2.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(cipher))}`;
}

export async function openConsoleSession(token: string, secret: string, now = Date.now()): Promise<SessionPayload | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "v2") return null;
    const key = await deriveSessionKey(secret);
    const iv = fromBase64Url(parts[1]!);
    const cipher = fromBase64Url(parts[2]!);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, cipher as BufferSource);
    const parsed = JSON.parse(decoder.decode(plain)) as Partial<SessionPayload>;
    if (typeof parsed.apiKey !== "string" || !parsed.apiKey.startsWith("cr_live_")) return null;
    if (typeof parsed.exp !== "number" || parsed.exp <= now) return null;
    return {
      tenantId: typeof parsed.tenantId === "string" ? parsed.tenantId : undefined,
      apiKey: parsed.apiKey,
      email: typeof parsed.email === "string" ? parsed.email : null,
      login: typeof parsed.login === "string" ? parsed.login : null,
      name: typeof parsed.name === "string" ? parsed.name : null,
      provider:
        parsed.provider === "github" || parsed.provider === "google" || parsed.provider === "password"
          ? parsed.provider
          : undefined,
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
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

export async function readConsoleSessionFromRequest(
  request: Request,
  env: Pick<ConsoleEnv, "CONSOLE_SESSION_SECRET">,
): Promise<SessionPayload | null> {
  if (!env.CONSOLE_SESSION_SECRET) return null;
  const raw = parseCookies(request.headers.get("cookie"))[COOKIE_NAME];
  if (!raw) return null;
  return openConsoleSession(raw, env.CONSOLE_SESSION_SECRET);
}

function isLocalHttp(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

function buildCookie(name: string, value: string, url: URL, maxAge: number, path = "/"): string {
  const parts = [`${name}=${value}`, `Path=${path}`, "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (!isLocalHttp(url)) parts.push("Secure");
  return parts.join("; ");
}

function clearSessionCookies(url: URL): string[] {
  return [
    buildCookie(COOKIE_NAME, "", url, 0, "/"),
    buildCookie(COOKIE_NAME, "", url, 0, "/console"),
  ];
}

function safeNextPath(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  if (/^\/(?:console|ops)(?:\/[^\s]*)?$/.test(raw) && !raw.startsWith("/console//") && !raw.startsWith("/ops//")) {
    return raw;
  }
  if (raw.startsWith("/oauth/authorize?") && !/[\r\n\s]/.test(raw)) {
    return raw;
  }
  return undefined;
}

function isSameOriginMutation(request: Request, url: URL): boolean {
  if (request.headers.get(CONSOLE_HEADER) !== "1") return false;
  const origin = request.headers.get("origin");
  if (origin) return origin === url.origin;
  const secFetchSite = request.headers.get("sec-fetch-site");
  return secFetchSite === "same-origin";
}

function jsonError(status: number, code: string, message: string, extraHeaders?: Record<string, string>): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store", ...(extraHeaders ?? {}) } },
  );
}

function redirectWithCookies(location: string, setCookies: string[] = []): Response {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const c of setCookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

function failAuthRedirect(message: string, setCookies: string[] = []): Response {
  return redirectWithCookies(`/console/?error=${encodeURIComponent(message)}`, setCookies);
}

async function discoverGoogleOidc(issuer: string): Promise<OidcDiscovery> {
  const now = Date.now();
  const cached = oidcCache.get(issuer);
  if (cached && cached.expiresAt > now) return cached.value;
  const res = await fetch(`${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error("Google sign-in discovery failed; try again");
  const doc = (await res.json()) as Partial<OidcDiscovery>;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) {
    throw new Error("Google sign-in metadata is incomplete");
  }
  const value: OidcDiscovery = {
    authorization_endpoint: doc.authorization_endpoint,
    token_endpoint: doc.token_endpoint,
    jwks_uri: doc.jwks_uri,
  };
  oidcCache.set(issuer, { value, expiresAt: now + 3600_000 });
  return value;
}

async function callV2AdminAccount<T>(
  env: ConsoleEnv,
  origin: string,
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; status: number; data: T } | { ok: false; status: number; code: string; message: string }> {
  const res = await env.V2.fetch(
    new Request(new URL(path, origin), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Admin-Key": env.ADMIN_SECRET ?? "",
      },
      body: JSON.stringify(body),
    }),
  );
  const parsed = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const errObj = parsed?.error as { code?: string; message?: string } | string | undefined;
    const message = typeof errObj === "string"
      ? errObj
      : typeof errObj?.message === "string"
        ? errObj.message
        : `Sign-in failed (HTTP ${res.status})`;
    const code = typeof errObj === "object" && typeof errObj?.code === "string" ? errObj.code : "auth_error";
    return { ok: false, status: res.status, code, message };
  }
  return { ok: true, status: res.status, data: parsed as T };
}

const STATIC_EXT = /\.(?:js|mjs|css|woff2?|ttf|otf|svg|ico|png|jpe?g|gif|webp|json|map|txt)$/i;
const ROOT_FAVICONS = new Set(["/favicon.svg", "/favicon.ico", "/apple-touch-icon.png"]);

function withSecurityHeaders(response: Response, cacheControl: string): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  headers.set("Cache-Control", cacheControl);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

interface AdminAccountResult {
  tenantId: string;
  apiKey: string;
  email: string | null;
  login: string | null;
  name: string | null;
  created?: boolean;
}

export async function handleConsoleRequest(request: Request, env: ConsoleEnv): Promise<Response | null> {
  if (!env.ASSETS) return null;

  const url = new URL(request.url);
  const { pathname, search } = url;

  // Root redirect on run.camelai.com / agents.camelai.dev -> /console/
  if (pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
    return redirectWithCookies(`/console/${search}`);
  }

  // Root favicon files referenced by console/web/index.html
  if (ROOT_FAVICONS.has(pathname) && (request.method === "GET" || request.method === "HEAD")) {
    const asset = await env.ASSETS.fetch(new Request(new URL(pathname, url.origin), { method: request.method }));
    if (asset.ok) return withSecurityHeaders(asset, "public, max-age=86400");
  }

  if (pathname === "/console") {
    return redirectWithCookies(`/console/${search}`);
  }

  if (!pathname.startsWith("/console/")) return null;

  const hasAuthBackend = Boolean(env.ADMIN_SECRET && env.CONSOLE_SESSION_SECRET);

  // ---- 1. Console Auth endpoints (/console/auth/*) ----

  if (pathname === "/console/auth/methods" && request.method === "GET") {
    return Response.json(
      {
        github: Boolean(hasAuthBackend && env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
        google: Boolean(hasAuthBackend && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
        password: hasAuthBackend,
        signup: hasAuthBackend,
        open: true,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // GitHub OAuth start
  if (pathname === "/console/auth/github" && request.method === "GET") {
    if (!hasAuthBackend || !env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      return failAuthRedirect("GitHub sign-in is not configured");
    }
    const state = randomBase64Url(24);
    const authorize = new URL("/login/oauth/authorize", env.GITHUB_WEB_URL ?? "https://github.com");
    authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
    authorize.searchParams.set("redirect_uri", new URL("/console/auth/callback", url.origin).href);
    authorize.searchParams.set("scope", "read:user user:email");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("allow_signup", "true");

    const next = safeNextPath(url.searchParams.get("next"));
    const cookiesToSet = [buildCookie(GITHUB_STATE_COOKIE, state, url, OAUTH_STATE_TTL_SECONDS, "/console/auth")];
    if (next) {
      cookiesToSet.push(buildCookie(NEXT_COOKIE, encodeURIComponent(next), url, OAUTH_STATE_TTL_SECONDS, "/console/auth"));
    }
    return redirectWithCookies(authorize.href, cookiesToSet);
  }

  // GitHub OAuth callback
  if (pathname === "/console/auth/callback" && request.method === "GET") {
    const clear = [
      buildCookie(GITHUB_STATE_COOKIE, "", url, 0, "/console/auth"),
      buildCookie(NEXT_COOKIE, "", url, 0, "/console/auth"),
    ];
    if (!hasAuthBackend || !env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      return failAuthRedirect("GitHub sign-in is not configured", clear);
    }
    const reqCookies = parseCookies(request.headers.get("cookie"));
    const expected = reqCookies[GITHUB_STATE_COOKIE] ?? "";
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const next = safeNextPath(decodeURIComponent(reqCookies[NEXT_COOKIE] ?? ""));

    if (!state || !expected || !constantTimeEqual(state, expected)) {
      return failAuthRedirect("Sign-in expired or was tampered with; try again", clear);
    }
    if (!code) {
      return failAuthRedirect("GitHub sign-in was cancelled", clear);
    }

    try {
      const webBase = env.GITHUB_WEB_URL ?? "https://github.com";
      const apiBase = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
      const exchange = await fetch(new URL("/login/oauth/access_token", webBase), {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: new URL("/console/auth/callback", url.origin).href,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const tokenBody = (await exchange.json().catch(() => ({}))) as { access_token?: string };
      if (!exchange.ok || !tokenBody.access_token) {
        throw new Error("GitHub did not issue an access token");
      }

      const ghHeaders = {
        Authorization: `Bearer ${tokenBody.access_token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "camelrun-console-v2",
      };
      const userRes = await fetch(`${apiBase}/user`, { headers: ghHeaders, signal: AbortSignal.timeout(10_000) });
      if (!userRes.ok) throw new Error("Could not load GitHub profile");
      const user = (await userRes.json()) as { id?: number; login?: string; name?: string | null; email?: string | null };
      if (!user.id || !user.login) throw new Error("GitHub account details are unavailable; try again");

      let verifiedEmail: string | null = null;
      try {
        const emailsRes = await fetch(`${apiBase}/user/emails`, { headers: ghHeaders, signal: AbortSignal.timeout(10_000) });
        if (emailsRes.ok) {
          const emails = (await emailsRes.json()) as Array<{ email?: string; primary?: boolean; verified?: boolean }>;
          const primary = emails.find(e => e.primary && e.verified && e.email) ?? emails.find(e => e.verified && e.email);
          if (primary?.email) verifiedEmail = primary.email;
        }
      } catch {
        // Optional email scope lookup
      }

      const acct = await callV2AdminAccount<AdminAccountResult>(env, url.origin, "/v2/admin/console/oauth-login", {
        provider: "github",
        externalId: String(user.id),
        email: verifiedEmail,
        login: user.login,
        name: user.name ?? user.login,
      });
      if (!acct.ok) throw new Error(acct.message);

      const sealed = await sealConsoleSession(
        {
          tenantId: acct.data.tenantId,
          apiKey: acct.data.apiKey,
          email: acct.data.email,
          login: acct.data.login ?? user.login,
          name: acct.data.name ?? user.name ?? user.login,
          provider: "github",
          exp: Date.now() + SESSION_TTL_SECONDS * 1000,
        },
        env.CONSOLE_SESSION_SECRET!,
      );
      return redirectWithCookies(next ?? "/console/", [
        ...clear,
        buildCookie(COOKIE_NAME, sealed, url, SESSION_TTL_SECONDS, "/"),
      ]);
    } catch (caught) {
      return failAuthRedirect(caught instanceof Error ? caught.message : "GitHub sign-in failed", clear);
    }
  }

  // Google (Gmail) OIDC start
  if (pathname === "/console/auth/google" && request.method === "GET") {
    if (!hasAuthBackend || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return failAuthRedirect("Google sign-in is not configured");
    }
    try {
      const issuer = env.GOOGLE_ISSUER ?? GOOGLE_DEFAULT_ISSUER;
      const oidc = await discoverGoogleOidc(issuer);
      const state = randomBase64Url(24);
      const nonce = randomBase64Url(24);
      const verifier = randomBase64Url(32);
      const challenge = await sha256Base64Url(verifier);

      const authorize = new URL(oidc.authorization_endpoint);
      authorize.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
      authorize.searchParams.set("redirect_uri", new URL("/console/auth/google/callback", url.origin).href);
      authorize.searchParams.set("response_type", "code");
      authorize.searchParams.set("scope", "openid email profile");
      authorize.searchParams.set("state", state);
      authorize.searchParams.set("nonce", nonce);
      authorize.searchParams.set("code_challenge", challenge);
      authorize.searchParams.set("code_challenge_method", "S256");
      authorize.searchParams.set("prompt", "select_account");

      const next = safeNextPath(url.searchParams.get("next"));
      const cookiesToSet = [
        buildCookie(GOOGLE_STATE_COOKIE, `${state}.${nonce}.${verifier}`, url, OAUTH_STATE_TTL_SECONDS, "/console/auth"),
      ];
      if (next) {
        cookiesToSet.push(buildCookie(NEXT_COOKIE, encodeURIComponent(next), url, OAUTH_STATE_TTL_SECONDS, "/console/auth"));
      }
      return redirectWithCookies(authorize.href, cookiesToSet);
    } catch (caught) {
      return failAuthRedirect(caught instanceof Error ? caught.message : "Google sign-in failed");
    }
  }

  // Google (Gmail) OIDC callback
  if (pathname === "/console/auth/google/callback" && request.method === "GET") {
    const clear = [
      buildCookie(GOOGLE_STATE_COOKIE, "", url, 0, "/console/auth"),
      buildCookie(NEXT_COOKIE, "", url, 0, "/console/auth"),
    ];
    if (!hasAuthBackend || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
      return failAuthRedirect("Google sign-in is not configured", clear);
    }
    const reqCookies = parseCookies(request.headers.get("cookie"));
    const [expected = "", nonce = "", verifier = ""] = (reqCookies[GOOGLE_STATE_COOKIE] ?? "").split(".");
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const next = safeNextPath(decodeURIComponent(reqCookies[NEXT_COOKIE] ?? ""));

    if (!state || !expected || !nonce || !verifier || !constantTimeEqual(state, expected)) {
      return failAuthRedirect("Sign-in expired or was tampered with; try again", clear);
    }
    if (!code) {
      return failAuthRedirect("Google sign-in was cancelled", clear);
    }

    try {
      const issuer = env.GOOGLE_ISSUER ?? GOOGLE_DEFAULT_ISSUER;
      const oidc = await discoverGoogleOidc(issuer);
      const exchange = await fetch(oidc.token_endpoint, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id: env.GOOGLE_CLIENT_ID,
          client_secret: env.GOOGLE_CLIENT_SECRET,
          redirect_uri: new URL("/console/auth/google/callback", url.origin).href,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const tokenBody = (await exchange.json().catch(() => ({}))) as { id_token?: string };
      if (!exchange.ok || typeof tokenBody.id_token !== "string") {
        throw new Error("Google did not complete sign-in; try again");
      }

      const jwksRes = await fetch(oidc.jwks_uri, { signal: AbortSignal.timeout(10_000) });
      if (!jwksRes.ok) throw new Error("Could not load Google signing keys");
      const jwks = (await jwksRes.json()) as JSONWebKeySet;

      let claims: Record<string, unknown>;
      try {
        const verified = await jwtVerify(tokenBody.id_token, createLocalJWKSet(jwks), {
          issuer: [issuer, issuer.replace(/^https?:\/\//, "")],
          audience: env.GOOGLE_CLIENT_ID,
          algorithms: ["RS256"],
        });
        claims = verified.payload as Record<string, unknown>;
      } catch {
        throw new Error("Google's sign-in token did not verify; try again");
      }

      if (
        typeof claims.nonce !== "string" ||
        !constantTimeEqual(claims.nonce, nonce) ||
        (claims.azp !== undefined && claims.azp !== env.GOOGLE_CLIENT_ID)
      ) {
        throw new Error("Google's sign-in token did not verify; try again");
      }
      if (claims.email_verified !== true || typeof claims.email !== "string" || typeof claims.sub !== "string") {
        throw new Error("Sign in with a Google account whose email address is verified");
      }

      const acct = await callV2AdminAccount<AdminAccountResult>(env, url.origin, "/v2/admin/console/oauth-login", {
        provider: "google",
        externalId: claims.sub,
        email: claims.email,
        login: claims.email,
        name: typeof claims.name === "string" ? claims.name : claims.email,
      });
      if (!acct.ok) throw new Error(acct.message);

      const sealed = await sealConsoleSession(
        {
          tenantId: acct.data.tenantId,
          apiKey: acct.data.apiKey,
          email: acct.data.email ?? claims.email,
          login: acct.data.login ?? claims.email,
          name: acct.data.name ?? (typeof claims.name === "string" ? claims.name : claims.email),
          provider: "google",
          exp: Date.now() + SESSION_TTL_SECONDS * 1000,
        },
        env.CONSOLE_SESSION_SECRET!,
      );
      return redirectWithCookies(next ?? "/console/", [
        ...clear,
        buildCookie(COOKIE_NAME, sealed, url, SESSION_TTL_SECONDS, "/"),
      ]);
    } catch (caught) {
      return failAuthRedirect(caught instanceof Error ? caught.message : "Google sign-in failed", clear);
    }
  }

  // Email + Password Sign-in
  if (pathname === "/console/auth/password" && request.method === "POST") {
    if (!isSameOriginMutation(request, url)) {
      return jsonError(403, "forbidden", "Cross-origin console mutation rejected");
    }
    if (!hasAuthBackend) {
      return jsonError(503, "console_auth_unconfigured", "Console authentication is not configured on this deployment.");
    }
    const body = (await request.json().catch(() => null)) as { email?: unknown; password?: unknown; next?: unknown } | null;
    const acct = await callV2AdminAccount<AdminAccountResult>(env, url.origin, "/v2/admin/console/password-login", {
      email: body?.email,
      password: body?.password,
    });
    if (!acct.ok) {
      return jsonError(acct.status === 401 ? 401 : acct.status, acct.code, acct.message);
    }
    const next = typeof body?.next === "string" ? safeNextPath(body.next) : undefined;
    const sealed = await sealConsoleSession(
      {
        tenantId: acct.data.tenantId,
        apiKey: acct.data.apiKey,
        email: acct.data.email,
        login: acct.data.login ?? acct.data.email,
        name: acct.data.name,
        provider: "password",
        exp: Date.now() + SESSION_TTL_SECONDS * 1000,
      },
      env.CONSOLE_SESSION_SECRET!,
    );
    return Response.json(
      { ok: true, tenant: acct.data.tenantId, ...(next ? { next } : {}) },
      {
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie": buildCookie(COOKIE_NAME, sealed, url, SESSION_TTL_SECONDS, "/"),
        },
      },
    );
  }

  // Email + Password Sign-up
  if (pathname === "/console/auth/signup" && request.method === "POST") {
    if (!isSameOriginMutation(request, url)) {
      return jsonError(403, "forbidden", "Cross-origin console mutation rejected");
    }
    if (!hasAuthBackend) {
      return jsonError(503, "console_auth_unconfigured", "Console authentication is not configured on this deployment.");
    }
    const body = (await request.json().catch(() => null)) as {
      email?: unknown;
      password?: unknown;
      name?: unknown;
      next?: unknown;
    } | null;
    const acct = await callV2AdminAccount<AdminAccountResult>(env, url.origin, "/v2/admin/console/password-signup", {
      email: body?.email,
      password: body?.password,
      name: body?.name,
    });
    if (!acct.ok) {
      return jsonError(acct.status, acct.code, acct.message);
    }
    const next = typeof body?.next === "string" ? safeNextPath(body.next) : undefined;
    const sealed = await sealConsoleSession(
      {
        tenantId: acct.data.tenantId,
        apiKey: acct.data.apiKey,
        email: acct.data.email,
        login: acct.data.login ?? acct.data.email,
        name: acct.data.name,
        provider: "password",
        exp: Date.now() + SESSION_TTL_SECONDS * 1000,
      },
      env.CONSOLE_SESSION_SECRET!,
    );
    return Response.json(
      { ok: true, tenant: acct.data.tenantId, ...(next ? { next } : {}) },
      {
        status: 201,
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie": buildCookie(COOKIE_NAME, sealed, url, SESSION_TTL_SECONDS, "/"),
        },
      },
    );
  }

  // Sign out
  if (pathname === "/console/auth/logout" && request.method === "POST") {
    if (!isSameOriginMutation(request, url)) {
      return jsonError(403, "forbidden", "Cross-origin console mutation rejected");
    }
    const headers = new Headers({ "Cache-Control": "no-store" });
    for (const c of clearSessionCookies(url)) headers.append("Set-Cookie", c);
    return Response.json({ ok: true }, { headers });
  }

  // ---- 2. Authenticated v2 API proxy (/console/v2/* -> env.V2 /v2/*) ----
  if (pathname === "/console/v2" || pathname.startsWith("/console/v2/")) {
    const isRead = request.method === "GET" || request.method === "HEAD";
    if (!isRead && !isSameOriginMutation(request, url)) {
      return jsonError(403, "forbidden", "Cross-origin console mutation rejected");
    }

    let session: SessionPayload | null = null;
    let bearerToken: string | null = null;
    const rawCookie = parseCookies(request.headers.get("cookie"))[COOKIE_NAME];
    if (rawCookie && env.CONSOLE_SESSION_SECRET) {
      session = await openConsoleSession(rawCookie, env.CONSOLE_SESSION_SECRET);
      if (session) bearerToken = session.apiKey;
    }
    if (!bearerToken) {
      const authHeader = request.headers.get("authorization");
      const match = authHeader?.match(/^Bearer\s+(.+)$/i);
      if (match?.[1]) bearerToken = match[1].trim();
    }
    if (!bearerToken) {
      const headers = new Headers({ "Cache-Control": "no-store" });
      if (rawCookie) {
        for (const c of clearSessionCookies(url)) headers.append("Set-Cookie", c);
      }
      return Response.json({ error: { code: "unauthorized", message: "Not signed in" } }, { status: 401, headers });
    }

    const targetPath = pathname.slice("/console".length);
    const targetUrl = new URL(`${targetPath}${search}`, url.origin);
    const forwardHeaders = new Headers();
    forwardHeaders.set("Authorization", `Bearer ${bearerToken}`);
    for (const name of ["accept", "content-type", "last-event-id", "idempotency-key"]) {
      const val = request.headers.get(name);
      if (val) forwardHeaders.set(name, val);
    }

    const upstream = await env.V2.fetch(
      new Request(targetUrl, {
        method: request.method,
        headers: forwardHeaders,
        body: isRead ? undefined : request.body,
      }),
    );

    // Augment /console/v2/me with the signed-in person's profile from the encrypted session cookie
    if (targetPath === "/v2/me" && request.method === "GET" && upstream.ok && session) {
      const me = (await upstream.json().catch(() => null)) as Record<string, unknown> | null;
      if (me && typeof me === "object") {
        return Response.json(
          {
            ...me,
            ...(session.email ? { email: session.email } : {}),
            ...(session.login ? { login: session.login } : {}),
            ...(session.name ? { name: session.name } : {}),
            ...(session.provider ? { signIn: session.provider } : {}),
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
    }

    const isSse = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    if (isSse) return upstream;

    const outHeaders = new Headers(upstream.headers);
    outHeaders.set("Cache-Control", "no-store");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });
  }

  // ---- 3. Static assets & SPA fallback (/console/*) ----
  if (request.method !== "GET" && request.method !== "HEAD") {
    return jsonError(405, "method_not_allowed", "Method not allowed");
  }

  const subPath = pathname.slice("/console".length) || "/";
  const looksLikeAsset = subPath.startsWith("/assets/") || STATIC_EXT.test(subPath);

  if (looksLikeAsset) {
    const assetRes = await env.ASSETS.fetch(new Request(new URL(subPath, url.origin), { method: request.method }));
    if (!assetRes.ok) return assetRes;
    const cache = subPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=86400";
    return withSecurityHeaders(assetRes, cache);
  }

  const indexRes = await env.ASSETS.fetch(new Request(new URL("/index.html", url.origin), { method: request.method }));
  if (!indexRes.ok) {
    return jsonError(503, "console_unavailable", "Console assets are unavailable");
  }
  return withSecurityHeaders(indexRes, "no-cache");
}
