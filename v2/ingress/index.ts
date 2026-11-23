import { handleConsoleRequest, readConsoleSessionFromRequest, type ConsoleEnv } from "./console.ts";
import { handleOpsRequest, type OpsEnv } from "./ops.ts";

export interface Env extends ConsoleEnv, OpsEnv {
  V2: { fetch(request: Request): Promise<Response> };
}

const isApiHost = (hostname: string) => hostname === "run.camelai.com" || hostname === "agents.camelai.dev";

function parseTenantIdFromApiKey(apiKey: string | undefined): string | undefined {
  if (!apiKey || !apiKey.startsWith("cr_live_")) return undefined;
  const rest = apiKey.slice("cr_live_".length);
  const dot = rest.indexOf(".");
  return dot > 0 ? rest.slice(0, dot) : undefined;
}

function isOAuthDiscoveryPath(pathname: string): boolean {
  return (
    pathname === "/.well-known/oauth-authorization-server" ||
    pathname === "/.well-known/oauth-protected-resource" ||
    pathname.startsWith("/.well-known/oauth-protected-resource/")
  );
}

function isOAuthPath(pathname: string): boolean {
  return pathname === "/oauth" || pathname.startsWith("/oauth/");
}

function isRetiredApiPath(path: string): boolean {
  try {
    path = decodeURIComponent(path);
  } catch {
    // Match the original path if percent-encoding is invalid.
  }
  return /^\/(?:v1|clients)(?:\/|$)/i.test(path);
}

function legacyRetired(): Response {
  return Response.json(
    { error: "This operation is unavailable on the legacy API. Use CamelRun v2.", code: "V1_OPERATION_RETIRED" },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}

async function forwardOAuthToV2(request: Request, env: Env, pathname: string): Promise<Response> {
  const forwarded = new Request(request.url, request);
  // Never trust client-supplied internal auth/session headers
  forwarded.headers.delete("x-admin-key");
  forwarded.headers.delete("x-oauth-session");

  if (pathname === "/oauth/authorize" && env.ADMIN_SECRET) {
    const session = await readConsoleSessionFromRequest(request, env);
    const tenantId = session?.tenantId || parseTenantIdFromApiKey(session?.apiKey);
    if (session && tenantId) {
      forwarded.headers.set("X-Admin-Key", env.ADMIN_SECRET);
      forwarded.headers.set(
        "X-OAuth-Session",
        JSON.stringify({
          tenantId,
          email: session.email ?? null,
          login: session.login ?? null,
          name: session.name ?? null,
        }),
      );
    }
  }

  return env.V2.fetch(forwarded);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { hostname, pathname } = new URL(request.url);
    if (hostname === "run.camelai.com" && (pathname === "/v2" || pathname.startsWith("/v2/"))) {
      return env.V2.fetch(request);
    }
    if (isApiHost(hostname) && pathname === "/mcp" && !request.headers.has("upgrade")) {
      return env.V2.fetch(request);
    }
    if (isApiHost(hostname) && isOAuthDiscoveryPath(pathname)) {
      return env.V2.fetch(request);
    }
    if (isApiHost(hostname) && isOAuthPath(pathname)) {
      return forwardOAuthToV2(request, env, pathname);
    }

    if (isApiHost(hostname)) {
      const opsRes = await handleOpsRequest(request, env);
      if (opsRes) return opsRes;
      const consoleRes = await handleConsoleRequest(request, env);
      if (consoleRes) return consoleRes;

      if (isRetiredApiPath(pathname)) return legacyRetired();
      if (request.method === "GET" || request.method === "HEAD") {
        if (pathname === "/") return Response.redirect("https://camelai.com/run", 302);
        if (pathname === "/docs" || pathname.startsWith("/docs/")) return Response.redirect("https://camelai.com/docs/camelrun/overview", 302);
        if (pathname === "/llms.txt") return Response.redirect("https://camelai.com/docs/llms.txt", 302);
        if (pathname === "/robots.txt") return new Response("User-agent: *\nAllow: /\n", { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
        if (pathname === "/health" || pathname === "/healthz") {
          return env.V2.fetch(new Request(new URL("/v2/health", request.url), request));
        }
      }
      return Response.json(
        { error: "Not found", api: "/v2", docs: "https://camelai.com/docs/camelrun/overview" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }

    // On a Workers Route this sends the original request to the hostname's
    // configured origin. Preserve redirects, streams, and WebSocket upgrades.
    return fetch(request, { redirect: "manual" });
  },
};
