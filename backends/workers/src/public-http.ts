import openapi from "../../../openapi.json" with { type: "json" };
import { workersOpenApi } from "./workers-openapi.ts";
import { publicDocs } from "./public-docs.ts";
import { publicOrigins } from "./account-origins.ts";

type PublicEnv = { AGENT_PUBLIC_URL?: string; AGENT_PUBLIC_ALIASES?: string; AGENT_ISSUER?: string; PUBLIC_ASSETS?: Fetcher };
const docsOrigin = "https://run.camelai.com";
const browserPages = /^(?:\/$|\/console(?:\/|$)|\/oauth\/authorize$)/;

export function publicPageHeaders(request: Request, response: Response): Response {
  if (!browserPages.test(new URL(request.url).pathname)) return response;
  const result = new Response(response.body, response);
  result.headers.set("X-Robots-Tag", "noindex");
  return result;
}

export function unknownRoute(origin: string): Response {
  return Response.json({ type: "error", error: `Not found. The docs' index: ${origin}/llms.txt; coding agents setting camelRun up: ${origin}/SKILL.md`, code: "NOT_FOUND" }, { status: 404 });
}

export function authenticationHint(request: Request, origin: string): string {
  const reason = request.headers.has("authorization") ? "Invalid, expired or revoked token." : "No credentials. Sign in to the console, or:";
  return `${reason} Create an API token at ${origin}/console/tokens and send it as Authorization: Bearer <token> (the SDKs read CAMELAI_API_KEY; the CLI also takes \`npx @camelai/camelrun login\`). Coding agents: read ${origin}/SKILL.md`;
}

/** Public documents are exact asset lookups; they never fall through to authentication. */
export async function publicRoutes(request: Request, env: PublicEnv): Promise<Response | undefined> {
  const url = new URL(request.url), path = url.pathname;
  // Account routes own console redirects, consent, and journey collection.
  if (/^\/console(?:\/|$)/.test(path) || path === "/api/journey/events") return;
  const assets = env.PUBLIC_ASSETS;
  const document = await publicDocs(request, {
    AGENT_PUBLIC_URL: env.AGENT_PUBLIC_URL,
    DOCS: assets ? { fetch: (input, init) => {
      const assetRequest = new Request(input, init);
      const assetUrl = new URL(assetRequest.url);
      assetUrl.pathname = `/docs${assetUrl.pathname}`;
      return assets.fetch(new Request(assetUrl, assetRequest));
    } } : undefined,
  });
  if (document) return document;
  const origin = env.AGENT_PUBLIC_URL || url.origin;
  const read = request.method === "GET" || request.method === "HEAD";
  const content = (body: string, type: string, headers: Record<string, string> = {}) => new Response(request.method === "HEAD" ? null : body, { headers: { "Content-Type": type, ...headers } });
  if (read && path === "/v1/openapi.json") return content(JSON.stringify(workersOpenApi(openapi)), "application/json; charset=utf-8");
  if (path === "/r" || path.startsWith("/r/")) {
    const eligible = /^\/r\/[^/]+\.json$/.test(path);
    const asset = read && eligible && env.PUBLIC_ASSETS ? await env.PUBLIC_ASSETS.fetch(new Request(url, { method: "GET" })) : undefined;
    if (!asset?.ok) return Response.json({ type: "error", error: `Unknown document. The docs' index: ${origin}/llms.txt`, code: "NOT_FOUND" }, { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
    const text = (await asset.text()).replaceAll(docsOrigin, origin);
    return content(text, "application/json; charset=utf-8", {
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    });
  }
  if (read && path === "/") {
    const origins = publicOrigins({ AGENT_PUBLIC_URL: env.AGENT_PUBLIC_URL, AGENT_PUBLIC_ALIASES: env.AGENT_PUBLIC_ALIASES, AGENT_ISSUER: env.AGENT_ISSUER }, url.origin);
    return Response.redirect(origins.alias(request.headers) ? `${origins.canonical}/${url.search}` : `${url.origin}/console`, 302);
  }
  // Unknown non-API URLs carry the same useful 404 even without credentials.
  if (!/^\/(?:v1(?:\/|$)|clients(?:\/|$)|experimental(?:\/|$)|registry(?:\/|$)|console(?:\/|$)|oauth(?:\/|$)|\.well-known(?:\/|$)|mcp$|healthz$|__test(?:\/|$))/.test(path)) return unknownRoute(origin);
}
