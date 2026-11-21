/**
 * CamelRun v2 Ops dashboard edge handler (`/ops`, `/ops/*`, `/ops/api/*`):
 * - Serves the restored Vite `admin.html` SPA via `env.ASSETS` with `<meta name="admin-base" content="/ops">`
 * - Proxies `/ops/api/*` -> `/v2/admin/ops/*` on `env.V2`, injecting `X-Admin-Key: env.ADMIN_SECRET`
 *   and `X-Ops-Viewer: <operator>`
 * - Enforces STRICT operator access control (NEVER public):
 *   1. Valid Cloudflare Access RS256 JWT (`Cf-Access-Jwt-Assertion` verified against
 *      `AGENT_ADMIN_ACCESS_TEAM` + `AGENT_ADMIN_ACCESS_AUD`, matching `Cf-Access-Authenticated-User-Email`), OR
 *   2. Valid signed-in `cr_console` session cookie whose verified OAuth/OIDC email ends in
 *      `@camelai.com` or `@qaml.ai` (or matches `OPS_ALLOWED_EMAILS` / `AGENT_ADMIN_EMAILS`),
 *      or GitHub login matches `OPS_ALLOWED_GITHUB`, OR
 *   3. Direct `X-Admin-Key` matching `env.ADMIN_SECRET` (for operator API calls / scripts).
 */

import { createRemoteJWKSet, jwtVerify } from "jose";
import { openConsoleSession, type ConsoleEnv } from "./console.ts";

export interface OpsEnv extends ConsoleEnv {
  OPS_ALLOWED_EMAILS?: string;
  OPS_ALLOWED_GITHUB?: string;
  AGENT_ADMIN_EMAILS?: string;
  AGENT_ADMIN_ACCESS_TEAM?: string;
  AGENT_ADMIN_ACCESS_AUD?: string;
}

const COOKIE_NAME = "cr_console";
const CONSOLE_HEADER = "x-agent-runtime-console";
const DEFAULT_ALLOWED_EMAIL_DOMAINS = ["camelai.com", "qaml.ai"];
const encoder = new TextEncoder();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

const OPS_SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Robots-Tag": "noindex, nofollow",
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

function constantTimeEqual(a: string, b: string): boolean {
  const ba = encoder.encode(a);
  const bb = encoder.encode(b);
  const len = Math.max(ba.length, bb.length);
  let diff = ba.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

function parseCsvLower(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
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

function isSameOriginMutation(request: Request, url: URL): boolean {
  if (request.headers.get(CONSOLE_HEADER) !== "1") return false;
  const origin = request.headers.get("origin");
  if (origin) return origin === url.origin;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

function isAllowedEmail(email: string, extraAllowedEmails: Set<string>): boolean {
  const lower = email.trim().toLowerCase();
  if (!lower) return false;
  if (extraAllowedEmails.has(lower)) return true;
  const at = lower.lastIndexOf("@");
  if (at <= 0) return false;
  const domain = lower.slice(at + 1);
  return DEFAULT_ALLOWED_EMAIL_DOMAINS.includes(domain);
}

type OpsAuthResult =
  | { ok: true; viewer: string; method: "admin_key" | "cloudflare_access" | "console_session" }
  | { ok: false; reason: "unauthenticated" | "forbidden"; viewer?: string };

async function verifyCloudflareAccess(request: Request, env: OpsEnv): Promise<OpsAuthResult | null> {
  const team = env.AGENT_ADMIN_ACCESS_TEAM?.trim();
  const audience = env.AGENT_ADMIN_ACCESS_AUD?.trim();
  if (!team || !audience) return null;

  const token = request.headers.get("cf-access-jwt-assertion")?.trim();
  if (!token) return null;

  let issuer: URL;
  try {
    issuer = new URL(team);
  } catch {
    return null;
  }
  if (issuer.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(issuer.hostname)) {
    return null;
  }

  let verifiedEmail: string | undefined;
  try {
    let jwks = jwksCache.get(issuer.origin);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer));
      jwksCache.set(issuer.origin, jwks);
    }
    const { payload } = await jwtVerify(token, jwks, {
      issuer: issuer.origin,
      audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp"],
    });
    if (typeof payload.email === "string" && payload.email.trim()) {
      verifiedEmail = payload.email.trim().toLowerCase();
    }
  } catch {
    return null;
  }

  if (!verifiedEmail) return null;

  const headerEmail = request.headers.get("cf-access-authenticated-user-email")?.trim().toLowerCase();
  if (headerEmail && headerEmail !== verifiedEmail) {
    return { ok: false, reason: "forbidden", viewer: verifiedEmail };
  }

  const explicitAdmins = new Set([
    ...parseCsvLower(env.OPS_ALLOWED_EMAILS),
    ...parseCsvLower(env.AGENT_ADMIN_EMAILS),
  ]);
  if (explicitAdmins.size > 0 && !explicitAdmins.has(verifiedEmail)) {
    return { ok: false, reason: "forbidden", viewer: verifiedEmail };
  }

  return { ok: true, viewer: verifiedEmail, method: "cloudflare_access" };
}

export async function authorizeOpsRequest(request: Request, env: OpsEnv): Promise<OpsAuthResult> {
  // 1. Direct X-Admin-Key matching env.ADMIN_SECRET (for operator API calls & scripts)
  const providedAdminKey = request.headers.get("x-admin-key");
  if (providedAdminKey && env.ADMIN_SECRET && constantTimeEqual(providedAdminKey, env.ADMIN_SECRET)) {
    const viewer = request.headers.get("x-ops-viewer")?.trim() || "admin";
    return { ok: true, viewer, method: "admin_key" };
  }

  // 2. Cryptographically verified Cloudflare Access JWT
  const accessResult = await verifyCloudflareAccess(request, env);
  if (accessResult) return accessResult;

  // 3. Valid signed-in `cr_console` session cookie (verified OAuth/OIDC email or allowed GitHub login)
  const rawCookie = parseCookies(request.headers.get("cookie"))[COOKIE_NAME];
  if (rawCookie && env.CONSOLE_SESSION_SECRET) {
    const session = await openConsoleSession(rawCookie, env.CONSOLE_SESSION_SECRET);
    if (session) {
      const allowedEmails = new Set([
        ...parseCsvLower(env.OPS_ALLOWED_EMAILS),
        ...parseCsvLower(env.AGENT_ADMIN_EMAILS),
      ]);
      const allowedGithub = parseCsvLower(env.OPS_ALLOWED_GITHUB);
      const isVerifiedOAuth = session.provider === "github" || session.provider === "google";

      if (isVerifiedOAuth && session.email && isAllowedEmail(session.email, allowedEmails)) {
        return { ok: true, viewer: session.email.toLowerCase(), method: "console_session" };
      }
      if (session.provider === "github" && session.login && allowedGithub.has(session.login.toLowerCase())) {
        return { ok: true, viewer: session.email || session.login, method: "console_session" };
      }

      return {
        ok: false,
        reason: "forbidden",
        viewer: session.email || session.login || session.tenantId || "signed-in user",
      };
    }
  }

  return { ok: false, reason: "unauthenticated" };
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function forbiddenHtmlResponse(viewer?: string): Response {
  const who = viewer ? `Signed in as <code>${escapeHtml(viewer)}</code>.` : "Your account is not authorized.";
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <title>403 Forbidden · camelRun ops</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, sans-serif; background: #f6f4ee; color: #111113; margin: 0; display: grid; place-items: center; min-height: 100dvh; padding: 24px; }
      @media (prefers-color-scheme: dark) { body { background: #0b0b0c; color: #f4f2ea; } main { background: #101013; border-color: #232329; } a { color: #5aa7ff; } }
      main { max-width: 440px; width: 100%; background: #efede6; border: 1px solid #d5d2c9; padding: 24px; }
      h1 { font-size: 16px; margin: 0 0 8px; }
      p { font-size: 13px; line-height: 1.5; margin: 0 0 12px; opacity: 0.85; }
      a { color: #111113; font-size: 13px; }
    </style>
  </head>
  <body>
    <main>
      <h1>403 Forbidden — Operator access required</h1>
      <p>This dashboard is restricted to CamelAI operators. ${who}</p>
      <p><a href="/console/">Return to CamelRun Console</a></p>
    </main>
  </body>
</html>`;
  return new Response(html, {
    status: 403,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      ...OPS_SECURITY_HEADERS,
    },
  });
}

function injectAdminBase(html: string, base: string): string {
  const meta = `<meta name="admin-base" content="${base}" />`;
  if (html.includes('name="admin-base"')) return html;
  if (html.includes("</head>")) return html.replace("</head>", `    ${meta}\n  </head>`);
  return `${meta}\n${html}`;
}

export async function handleOpsRequest(request: Request, env: OpsEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname, search } = url;

  // Serve ops favicon publicly if requested at root or under /ops/
  if ((pathname === "/ops-favicon.svg" || pathname === "/ops/ops-favicon.svg") && (request.method === "GET" || request.method === "HEAD")) {
    if (!env.ASSETS) return null;
    const asset = await env.ASSETS.fetch(new Request(new URL("/ops-favicon.svg", url.origin), { method: request.method }));
    if (asset.ok) {
      const headers = new Headers(asset.headers);
      headers.set("Cache-Control", "public, max-age=86400");
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(asset.body, { status: asset.status, headers });
    }
    return asset;
  }

  if (pathname !== "/ops" && !pathname.startsWith("/ops/")) return null;

  const isApi = pathname === "/ops/api" || pathname.startsWith("/ops/api/");
  const auth = await authorizeOpsRequest(request, env);

  if (!auth.ok) {
    if (isApi) {
      return Response.json(
        { error: auth.reason === "forbidden" ? "admin_required" : "sign_in_required" },
        { status: auth.reason === "forbidden" ? 403 : 401, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (auth.reason === "forbidden") {
      return forbiddenHtmlResponse(auth.viewer);
    }
    const targetNext = pathname === "/ops" ? `/ops/${search}` : `${pathname}${search}`;
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/console/?next=${encodeURIComponent(targetNext)}`,
        "Cache-Control": "no-store",
      },
    });
  }

  // Canonical trailing slash for the SPA root
  if (pathname === "/ops" && (request.method === "GET" || request.method === "HEAD")) {
    return new Response(null, {
      status: 308,
      headers: { Location: `/ops/${search}`, "Cache-Control": "no-store" },
    });
  }

  // ---- 1. Ops API proxy (/ops/api/* -> env.V2 /v2/admin/ops/*) ----
  if (isApi) {
    if (!env.ADMIN_SECRET) {
      return Response.json(
        { error: "ops_unconfigured" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    const secFetchSite = request.headers.get("sec-fetch-site");
    if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") {
      return Response.json({ error: "cross_site" }, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    const isRead = request.method === "GET" || request.method === "HEAD";
    if (!isRead && auth.method !== "admin_key" && !isSameOriginMutation(request, url)) {
      return Response.json(
        { error: "forbidden", message: "Cross-origin ops mutation rejected" },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }

    const tail = pathname.slice("/ops/api".length);
    const targetUrl = new URL(`/v2/admin/ops${tail}${search}`, url.origin);
    const forwardHeaders = new Headers();
    forwardHeaders.set("X-Admin-Key", env.ADMIN_SECRET);
    forwardHeaders.set("X-Ops-Viewer", auth.viewer);
    for (const name of ["accept", "content-type"]) {
      const value = request.headers.get(name);
      if (value) forwardHeaders.set(name, value);
    }

    const upstream = await env.V2.fetch(
      new Request(targetUrl, {
        method: request.method,
        headers: forwardHeaders,
        body: isRead ? undefined : await request.arrayBuffer(),
      }),
    );

    const outHeaders = new Headers(upstream.headers);
    outHeaders.set("Cache-Control", "no-store");
    outHeaders.set("X-Content-Type-Options", "nosniff");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });
  }

  // ---- 2. Ops SPA HTML (/ops/ and /ops/*) ----
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { "Cache-Control": "no-store" } });
  }
  if (!env.ASSETS) {
    return Response.json({ error: "ops_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  const assetRes = await env.ASSETS.fetch(new Request(new URL("/admin.html", url.origin), { method: "GET" }));
  if (!assetRes.ok) {
    return Response.json({ error: "ops_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }

  const html = injectAdminBase(await assetRes.text(), "/ops");
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    ...OPS_SECURITY_HEADERS,
  });
  return new Response(request.method === "HEAD" ? null : html, { status: 200, headers });
}
