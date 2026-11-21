import { handleConsoleRequest, type ConsoleEnv } from "./console.ts";
import { handleOpsRequest, type OpsEnv } from "./ops.ts";

export interface Env extends ConsoleEnv, OpsEnv {
  V2: { fetch(request: Request): Promise<Response> };
}

const isApiHost = (hostname: string) => hostname === "run.camelai.com" || hostname === "agents.camelai.dev";

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

function forwardToV2Mcp(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  url.pathname = "/v2/mcp";
  return env.V2.fetch(new Request(url, request));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { hostname, pathname } = new URL(request.url);
    if (hostname === "run.camelai.com" && (pathname === "/v2" || pathname.startsWith("/v2/"))) {
      return env.V2.fetch(request);
    }
    if (isApiHost(hostname) && pathname === "/mcp" && !request.headers.has("upgrade")) {
      return forwardToV2Mcp(request, env);
    }
    if (
      hostname === "run.camelai.com" &&
      (pathname === "/.well-known/oauth-protected-resource/v2/mcp" ||
        /^\/\.well-known\/oauth-protected-resource\/v2\/agents\/[^/]+\/mcp$/.test(pathname))
    ) {
      return env.V2.fetch(request);
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
