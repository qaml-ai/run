import { legacyVolumes, type LegacyVolumeOrigin } from "./legacy-volumes.ts";
import { DECISION_LIMITS } from "../../src/core/limits.ts";

interface Env extends LegacyVolumeOrigin {
  V2: { fetch(request: Request): Promise<Response> };
  LEGACY_V1?: { route(request: Request): Promise<Response | null> };
  LEGACY_V1_CANARY_AUTH_SHA256?: string;
  LEGACY_DECISIONS?: { route(request: Request): Promise<Response | null> };
  LEGACY_DECISIONS_CANARY_AUTH_SHA256?: string;
  LEGACY_DECISIONS_BOTS_AUTH_SHA256?: string;
  LEGACY_DECISIONS_BOTS?: string;
}

const legacyAgentRoute = /^\/(?:v1\/agents|clients)\/client_[a-f0-9]{40}\/[^/]+(?:\/[^/]+)?$/;
const legacyEndUserRead = /^\/v1\/end-users(?:\/[^/]+(?:\/(?:usage|days|ledger))?)?$/;
const legacyProtectedResource = /^\/\.well-known\/oauth-protected-resource(?:\/mcp|\/v1\/(?:ops|agents\/client_[a-f0-9]{40})\/mcp)?$/;

function legacyOAuthRoute(pathname: string, method: string) {
  if (pathname === "/oauth/token" || pathname === "/oauth/revoke" || pathname === "/oauth/register") return method === "POST" || method === "OPTIONS";
  if (legacyProtectedResource.test(pathname)) return method === "GET" || method === "OPTIONS";
  return method === "GET" && (pathname === "/.well-known/jwks.json" || pathname === "/.well-known/oauth-authorization-server");
}

async function selected(request: Request, fingerprint?: string): Promise<boolean> {
  if (!fingerprint) return true;
  const authorization = request.headers.get("authorization");
  if (!authorization) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(authorization));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return hex === fingerprint;
}

function decisionsFingerprint(value?: string): value is string {
  return !!value && /^[a-f0-9]{64}$/.test(value);
}

/** Camel Bots supplies context.bot itself after accepting the bot's decision arguments. */
async function selectedDecision(request: Request, env: Env): Promise<boolean> {
  if (decisionsFingerprint(env.LEGACY_DECISIONS_CANARY_AUTH_SHA256) &&
      await selected(request, env.LEGACY_DECISIONS_CANARY_AUTH_SHA256)) return true;
  const cohort = env.LEGACY_DECISIONS_BOTS?.split(",") ?? [];
  if (!cohort.length || cohort.some(id => !/^[a-f0-9]{16}$/.test(id)) ||
      !decisionsFingerprint(env.LEGACY_DECISIONS_BOTS_AUTH_SHA256) ||
      !await selected(request, env.LEGACY_DECISIONS_BOTS_AUTH_SHA256)) return false;

  const limit = DECISION_LIMITS.requestBytes;
  if (Number(request.headers.get("content-length")) > limit) return false;
  const reader = request.clone().body?.getReader();
  if (!reader) return false;
  const decoder = new TextDecoder();
  let bytes = 0, text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) return false;
      text += decoder.decode(value, { stream: true });
    }
    const body = JSON.parse(text + decoder.decode());
    return typeof body?.context?.bot === "string" && cohort.includes(body.context.bot);
  } catch {
    return false;
  } finally {
    // The untouched original remains available whichever origin owns the request.
    void reader.cancel().catch(() => {});
  }
}

const legacyApiHost = (hostname: string) => hostname === "run.camelai.com" || hostname === "agents.camelai.dev";

export function fetchLegacyApi(request: Request, env: LegacyVolumeOrigin = {}): Promise<Response> {
  const { protocol, hostname, pathname, port } = new URL(request.url);
  if (protocol !== "https:" || port || !legacyApiHost(hostname) ||
      (!pathname.startsWith("/v1/") && !pathname.startsWith("/clients/"))) {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
  return legacyVolumes(request, env) ?? fetch(request, { redirect: "manual" });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { hostname, pathname } = new URL(request.url);
    if (hostname === "run.camelai.com" && (pathname === "/v2" || pathname.startsWith("/v2/"))) {
      return env.V2.fetch(request);
    }

    if (legacyApiHost(hostname)) {
      const volume = legacyVolumes(request, env);
      if (volume) return volume;
    }

    if (env.LEGACY_DECISIONS && legacyApiHost(hostname) &&
        pathname === "/v1/decisions" && request.method === "POST" && !request.headers.has("upgrade") &&
        await selectedDecision(request, env)) {
      const response = await env.LEGACY_DECISIONS.route(request);
      return response ?? Response.json({ error: "Decisions are unavailable", code: "DECISIONS_UNAVAILABLE" },
        { status: 503, headers: { "Cache-Control": "no-store" } });
    }

    const legacyIdentity = legacyApiHost(hostname) && pathname === "/v1/me" && request.method === "GET" &&
      request.headers.has("authorization");
    if (env.LEGACY_V1 && !request.headers.has("upgrade") &&
        (legacyIdentity || pathname === "/mcp" || pathname === "/v1/agents" || legacyAgentRoute.test(pathname) ||
         (request.method === "GET" && legacyEndUserRead.test(pathname)) || legacyOAuthRoute(pathname, request.method)) &&
        await selected(request, env.LEGACY_V1_CANARY_AUTH_SHA256)) {
      const compatible = await env.LEGACY_V1.route(request.clone());
      if (compatible) return compatible;
    }

    // On a Workers Route this sends the original request to the hostname's
    // configured origin. Preserve redirects, streams, and WebSocket upgrades.
    return fetch(request, { redirect: "manual" });
  },
};
