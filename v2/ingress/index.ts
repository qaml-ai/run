interface Env {
  V2: { fetch(request: Request): Promise<Response> };
  LEGACY_V1?: { route(request: Request): Promise<Response | null> };
}

const legacyAgentRoute = /^\/(?:v1\/agents|clients)\/client_[a-f0-9]{40}\/[^/]+(?:\/[^/]+)?$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { hostname, pathname } = new URL(request.url);
    if (hostname === "run.camelai.com" && (pathname === "/v2" || pathname.startsWith("/v2/"))) {
      return env.V2.fetch(request);
    }

    if (env.LEGACY_V1 && !request.headers.has("upgrade") && (pathname === "/v1/agents" || legacyAgentRoute.test(pathname))) {
      const compatible = await env.LEGACY_V1.route(request.clone());
      if (compatible) return compatible;
    }

    // On a Workers Route this sends the original request to the hostname's
    // configured origin. Preserve redirects, streams, and WebSocket upgrades.
    return fetch(request, { redirect: "manual" });
  },
};
