/**
 * CamelRun v2 Console edge handler:
 * - Serves the built Vite SPA (`console/dist`) via Cloudflare Workers Static Assets (`env.ASSETS`) at `/console/*`
 * - Redirects `/` -> `/console/` on `run.camelai.com`
 * - Stateless encrypted HttpOnly session cookie (`cr_console`, AES-256-GCM sealed with `CONSOLE_SESSION_SECRET`)
 *   backed by `/v2/me` validation against `env.V2` (`camelrun-v2-prod`)
 * - Proxies `/console/v2/*` -> `/v2/*` on `env.V2` with Bearer injection and CSRF protection (`X-Agent-Runtime-Console: 1` + same-origin)
 */

export interface ConsoleEnv {
  ASSETS?: { fetch(request: Request): Promise<Response> };
  V2: { fetch(request: Request): Promise<Response> };
  CONSOLE_SESSION_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

const COOKIE_NAME = "cr_console";
const CONSOLE_HEADER = "x-agent-runtime-console";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

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

interface SessionPayload {
  apiKey: string;
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
    return { apiKey: parsed.apiKey, exp: parsed.exp };
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

function isLocalHttp(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

function buildSessionCookie(value: string, url: URL, maxAge: number): string {
  const parts = [
    `${COOKIE_NAME}=${value}`,
    "Path=/console",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (!isLocalHttp(url)) parts.push("Secure");
  return parts.join("; ");
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

const STATIC_EXT = /\.(?:js|mjs|css|woff2?|ttf|otf|svg|ico|png|jpe?g|gif|webp|json|map|txt)$/i;
const ROOT_FAVICONS = new Set(["/favicon.svg", "/favicon.ico", "/apple-touch-icon.png"]);

function withSecurityHeaders(response: Response, cacheControl: string): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  headers.set("Cache-Control", cacheControl);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function handleConsoleRequest(request: Request, env: ConsoleEnv): Promise<Response | null> {
  if (!env.ASSETS) return null;

  const url = new URL(request.url);
  const { pathname, search } = url;

  // Root redirect on run.camelai.com / agents.camelai.dev -> /console/
  if (pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
    return new Response(null, {
      status: 302,
      headers: { Location: `/console/${search}`, "Cache-Control": "no-store" },
    });
  }

  // Root favicon files referenced by console/web/index.html
  if (ROOT_FAVICONS.has(pathname) && (request.method === "GET" || request.method === "HEAD")) {
    const asset = await env.ASSETS.fetch(new Request(new URL(pathname, url.origin), { method: request.method }));
    if (asset.ok) return withSecurityHeaders(asset, "public, max-age=86400");
  }

  if (pathname === "/console") {
    return new Response(null, {
      status: 302,
      headers: { Location: `/console/${search}`, "Cache-Control": "no-store" },
    });
  }

  if (!pathname.startsWith("/console/")) return null;

  // ---- 1. Console Auth endpoints (/console/auth/*) ----
  if (pathname === "/console/auth/methods" && request.method === "GET") {
    return Response.json(
      {
        apiKey: true,
        github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
        google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
        cookieAuth: Boolean(env.CONSOLE_SESSION_SECRET),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (pathname === "/console/auth/key" && request.method === "POST") {
    if (!isSameOriginMutation(request, url)) {
      return jsonError(403, "forbidden", "Cross-origin console mutation rejected");
    }
    if (!env.CONSOLE_SESSION_SECRET) {
      return jsonError(
        503,
        "console_auth_unconfigured",
        "Console session encryption is not configured (missing CONSOLE_SESSION_SECRET).",
      );
    }
    const body = (await request.json().catch(() => null)) as { apiKey?: unknown } | null;
    const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey || !apiKey.startsWith("cr_live_")) {
      return jsonError(400, "invalid_api_key", "Enter a valid CamelRun v2 API key (starts with cr_live_).");
    }

    const verifyReq = new Request(new URL("/v2/me", url.origin), {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    const verifyRes = await env.V2.fetch(verifyReq);
    if (!verifyRes.ok) {
      const errBody = (await verifyRes.json().catch(() => null)) as { error?: { message?: string } | string } | null;
      const msg = typeof errBody?.error === "string"
        ? errBody.error
        : errBody?.error?.message ?? "Invalid API key";
      return jsonError(verifyRes.status === 401 ? 401 : 502, "unauthorized", msg);
    }

    const me = await verifyRes.json();
    const sealed = await sealConsoleSession(
      { apiKey, exp: Date.now() + SESSION_TTL_SECONDS * 1000 },
      env.CONSOLE_SESSION_SECRET,
    );
    return Response.json(
      { ok: true, me },
      {
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie": buildSessionCookie(sealed, url, SESSION_TTL_SECONDS),
        },
      },
    );
  }

  if (pathname === "/console/auth/logout" && request.method === "POST") {
    if (!isSameOriginMutation(request, url)) {
      return jsonError(403, "forbidden", "Cross-origin console mutation rejected");
    }
    return Response.json(
      { ok: true },
      {
        headers: {
          "Cache-Control": "no-store",
          "Set-Cookie": buildSessionCookie("", url, 0),
        },
      },
    );
  }

  if (pathname === "/console/auth/github" || pathname === "/console/auth/google") {
    const provider = pathname.endsWith("github") ? "GitHub" : "Google";
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/console/?error=${encodeURIComponent(`${provider} OAuth is not configured on this deployment. Sign in with a CamelRun v2 API key.`)}`,
        "Cache-Control": "no-store",
      },
    });
  }

  // ---- 2. Authenticated v2 API proxy (/console/v2/* -> env.V2 /v2/*) ----
  if (pathname === "/console/v2" || pathname.startsWith("/console/v2/")) {
    const isRead = request.method === "GET" || request.method === "HEAD";
    if (!isRead && !isSameOriginMutation(request, url)) {
      return jsonError(403, "forbidden", "Cross-origin console mutation rejected");
    }

    let bearerToken: string | null = null;
    const rawCookie = parseCookies(request.headers.get("cookie"))[COOKIE_NAME];
    if (rawCookie && env.CONSOLE_SESSION_SECRET) {
      const session = await openConsoleSession(rawCookie, env.CONSOLE_SESSION_SECRET);
      if (session) {
        bearerToken = session.apiKey;
      }
    }
    if (!bearerToken) {
      const authHeader = request.headers.get("authorization");
      const match = authHeader?.match(/^Bearer\s+(.+)$/i);
      if (match?.[1]) bearerToken = match[1].trim();
    }
    if (!bearerToken) {
      const headers: Record<string, string> = {};
      if (rawCookie) headers["Set-Cookie"] = buildSessionCookie("", url, 0);
      return jsonError(401, "unauthorized", "Not signed in", headers);
    }

    const targetPath = pathname.slice("/console".length); // "/v2" or "/v2/..."
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
