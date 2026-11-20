import { legacyBillingCallback, type BillingCallbackOrigin } from "./ingress-billing.ts";
import { legacyVolumes, type LegacyVolumeOrigin } from "./legacy-volumes.ts";
import { legacyDefinitionRead } from "../../src/v1-definition-reads.ts";
import { legacyGatewayTextAddress, legacyGatewayTextUncertain } from "../../shared/legacy-gateway-text-address.ts";

export interface LegacyOriginEnv extends LegacyVolumeOrigin {
  LEGACY_V1?: { route(request: Request): Promise<Response | null> };
  LEGACY_V1_BRIDGE?: string;
  LEGACY_GATEWAY_TEXT_ROUTING?: string;
  LEGACY_ECS_FALLBACK?: string;
}

interface Env extends LegacyOriginEnv {
  LEGACY_BILLING?: BillingCallbackOrigin;
  V2: { fetch(request: Request): Promise<Response> };
  LEGACY_V1_CANARY_AUTH_SHA256?: string;
  LEGACY_DECISIONS?: { route(request: Request): Promise<Response | null> };
  LEGACY_DECISIONS_CANARY_AUTH_SHA256?: string;
  LEGACY_BOTS_IMAGES?: { route(request: Request): Promise<Response | null> };
  LEGACY_BOT_DECISIONS?: { route(request: Request): Promise<Response | null> };
  LEGACY_DECISIONS_BOTS_AUTH_SHA256?: string;
}

const legacyAgentRoute = /^\/(?:v1\/agents|clients)\/client_[a-f0-9]{40}(?:\/[^/]+(?:\/[^/]+)?)?$/;
const legacyCredentialsRoute = /^\/v1\/agents\/(?:[A-Za-z0-9_-]|%[a-fA-F0-9]{2}){1,80}\/credentials$/;
const legacyEndUserRead = /^\/v1\/end-users(?:\/[^/]+(?:\/(?:usage|days|ledger))?)?$/;
const legacyEndUserPatch = /^\/v1\/end-users\/[^/]+$/;
const legacyEndUserPost = /^\/v1\/end-users\/[^/]+\/(?:lots|entries)$/;
function legacyEndUserRoute(pathname: string, method: string) {
  if (pathname === "/v1/end-user-settings") return method === "GET" || method === "PUT" || method === "PATCH";
  if (method === "GET") return legacyEndUserRead.test(pathname);
  if (method === "PATCH") return legacyEndUserPatch.test(pathname);
  if (method === "POST") return legacyEndUserPost.test(pathname);
  return false;
}
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

async function decisionService(request: Request, env: Env) {
  const synthetic = env.LEGACY_DECISIONS_CANARY_AUTH_SHA256;
  if (env.LEGACY_DECISIONS && decisionsFingerprint(synthetic) && await selected(request, synthetic)) return env.LEGACY_DECISIONS;
  const app = env.LEGACY_DECISIONS_BOTS_AUTH_SHA256;
  if (env.LEGACY_BOT_DECISIONS && decisionsFingerprint(app) && await selected(request, app)) return env.LEGACY_BOT_DECISIONS;
}

const legacyApiHost = (hostname: string) => hostname === "run.camelai.com" || hostname === "agents.camelai.dev";

function retiredApiPath(path: string) {
  try { path = decodeURIComponent(path); } catch { /* Match the original path if encoding is invalid. */ }
  return /^\/(?:v1|clients|mcp)(?:\/|$)/i.test(path);
}

function legacyUnavailable() {
  return Response.json({ error: "This operation is unavailable on the legacy API. Use CamelRun v2.", code: "V1_OPERATION_RETIRED" },
    { status: 410, headers: { "Cache-Control": "no-store" } });
}

function legacyVolumeOrigin(request: Request, env: LegacyOriginEnv, source: "edge" | "mcp") {
  // Strict volumes run on the independently deployed volume service.
  if (env.LEGACY_ECS_FALLBACK === "0" && env.LEGACY_VOLUMES_STRICT_GLOBAL !== "1") return;
  return legacyVolumes(request, env, source);
}

async function gatewayText(request: Request, env: LegacyOriginEnv): Promise<Response | null> {
  if (env.LEGACY_GATEWAY_TEXT_ROUTING !== "1" || request.headers.has("upgrade") || !legacyGatewayTextAddress(request)) return null;
  if (!env.LEGACY_V1) return legacyGatewayTextUncertain();
  try { return await env.LEGACY_V1.route(request.clone()); }
  catch { return legacyGatewayTextUncertain(); }
}

export async function fetchLegacyApi(request: Request, env: LegacyOriginEnv = {}): Promise<Response> {
  const { protocol, hostname, pathname, port } = new URL(request.url);
  if (protocol !== "https:" || port || !legacyApiHost(hostname) ||
      (!pathname.startsWith("/v1/") && !pathname.startsWith("/clients/"))) {
    return new Response(null, { status: 404 });
  }
  return legacyVolumeOrigin(request, env, "mcp") ?? await gatewayText(request, env) ??
    (env.LEGACY_ECS_FALLBACK === "0" ? legacyUnavailable() : fetch(request, { redirect: "manual" }));
}

const legacyChannelWebhookRoute = /^\/channels\/[^/]+\/[^/]+$/;
const legacyDefinitionWriteRoute = /^\/v1\/definitions(?:\/[^/]+)?$/;
const legacyStatelessRunRoute = /^\/v1\/runs(?:\/run_[a-f0-9]{16,40})?$/;
const legacyMediaDecisionPaths = new Set(["/v1/speech", "/v1/transcriptions", "/v1/images", "/v1/decisions"]);

function legacyBridgedApiRoute(pathname: string, method: string, hasAuth: boolean) {
  if (!hasAuth) return false;
  if (legacyDefinitionWriteRoute.test(pathname) && ["POST", "PATCH", "DELETE"].includes(method)) return true;
  if (legacyStatelessRunRoute.test(pathname) && (method === "POST" || (method === "GET" && pathname.length > "/v1/runs".length))) return true;
  if (method === "POST" && legacyMediaDecisionPaths.has(pathname)) return true;
  return false;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { hostname, pathname } = new URL(request.url);
    if (hostname === "run.camelai.com" && (pathname === "/v2" || pathname.startsWith("/v2/"))) {
      return env.V2.fetch(request);
    }

    let gatewayTried = false;
    if (legacyApiHost(hostname)) {
      const billing = legacyBillingCallback(request, env.LEGACY_BILLING);
      if (billing) return billing;
      const volume = legacyVolumeOrigin(request, env, "edge");
      if (volume) return volume;
      if (env.LEGACY_GATEWAY_TEXT_ROUTING === "1" && !request.headers.has("upgrade") && legacyGatewayTextAddress(request)) {
        gatewayTried = true;
      }
      const gateway = await gatewayText(request, env);
      if (gateway) return gateway;
      if (env.LEGACY_V1 && env.LEGACY_V1_BRIDGE === "1" && request.method === "POST" && !request.headers.has("upgrade") && legacyChannelWebhookRoute.test(pathname)) {
        const delivered = await env.LEGACY_V1.route(request.clone());
        if (delivered) return delivered;
      }
    }

    if (legacyApiHost(hostname) && pathname === "/v1/decisions" && request.method === "POST" && !request.headers.has("upgrade")) {
      const service = await decisionService(request, env);
      if (service) {
        const response = await service.route(request);
        return response ?? Response.json({ error: "Decisions are unavailable", code: "DECISIONS_UNAVAILABLE" },
          { status: 503, headers: { "Cache-Control": "no-store" } });
      }
    }

    if (env.LEGACY_BOTS_IMAGES && legacyApiHost(hostname) && pathname === "/v1/images" &&
        request.method === "POST" && !request.headers.has("upgrade") &&
        request.headers.get("content-type")?.toLowerCase().trim() === "application/json" &&
        decisionsFingerprint(env.LEGACY_DECISIONS_BOTS_AUTH_SHA256) &&
        await selected(request, env.LEGACY_DECISIONS_BOTS_AUTH_SHA256)) {
      const image = await env.LEGACY_BOTS_IMAGES.route(request.clone());
      if (image) return image;
    }
    const legacyIdentity = legacyApiHost(hostname) && pathname === "/v1/me" && request.method === "GET" &&
      request.headers.has("authorization");
    const legacyAccountRead = legacyApiHost(hostname) && request.method === "GET" &&
      ["/v1/models", "/v1/inbox", "/v1/inputs"].includes(pathname);
    const legacyCredentials = legacyApiHost(hostname) && request.method === "GET" &&
      request.headers.has("authorization") && legacyCredentialsRoute.test(pathname);
    const definitionRead = legacyApiHost(hostname) && legacyDefinitionRead(request);
    const bridgedApi = env.LEGACY_V1_BRIDGE === "1" && !gatewayTried && legacyApiHost(hostname) &&
      legacyBridgedApiRoute(pathname, request.method, request.headers.has("authorization"));
    if (env.LEGACY_V1 && !request.headers.has("upgrade") &&
        (legacyIdentity || legacyAccountRead || legacyCredentials || definitionRead || bridgedApi || pathname === "/mcp" || pathname === "/v1/agents" || legacyAgentRoute.test(pathname) ||
         legacyEndUserRoute(pathname, request.method) || legacyOAuthRoute(pathname, request.method)) &&
        await selected(request, env.LEGACY_V1_CANARY_AUTH_SHA256)) {
      const compatible = await env.LEGACY_V1.route(request.clone());
      if (compatible) return compatible;
    }

    if (env.LEGACY_ECS_FALLBACK === "0" && legacyApiHost(hostname) && retiredApiPath(pathname)) {
      return legacyUnavailable();
    }

    // On a Workers Route this sends the original request to the hostname's
    // configured origin. Preserve redirects, streams, and WebSocket upgrades.
    return fetch(request, { redirect: "manual" });
  },
};
