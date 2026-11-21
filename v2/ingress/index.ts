export interface Env {
  V2: { fetch(request: Request): Promise<Response> };
}

const isApiHost = (hostname: string) => hostname === "run.camelai.com" || hostname === "agents.camelai.dev";

function isRetiredApiPath(path: string): boolean {
  try {
    path = decodeURIComponent(path);
  } catch {
    // Match the original path if percent-encoding is invalid.
  }
  return /^\/(?:v1|clients|mcp)(?:\/|$)/i.test(path);
}

function legacyRetired(): Response {
  return Response.json(
    { error: "This operation is unavailable on the legacy API. Use CamelRun v2.", code: "V1_OPERATION_RETIRED" },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { hostname, pathname } = new URL(request.url);
    if (hostname === "run.camelai.com" && (pathname === "/v2" || pathname.startsWith("/v2/"))) {
      return env.V2.fetch(request);
    }

    if (isApiHost(hostname) && isRetiredApiPath(pathname)) {
      return legacyRetired();
    }

    // On a Workers Route this sends the original request to the hostname's
    // configured origin. Preserve redirects, streams, and WebSocket upgrades.
    return fetch(request, { redirect: "manual" });
  },
};
