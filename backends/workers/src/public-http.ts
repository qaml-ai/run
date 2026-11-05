import openapi from "../../../openapi.json";
import { publicDocs } from "./public-docs.ts";

type PublicEnv = { AGENT_PUBLIC_URL?: string; PUBLIC_ASSETS?: Fetcher };
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
  const url = new URL(request.url), path = url.pathname;
  const origin = env.AGENT_PUBLIC_URL || url.origin;
  const read = request.method === "GET" || request.method === "HEAD";
  const content = (body: string, type: string, headers: Record<string, string> = {}) => new Response(request.method === "HEAD" ? null : body, { headers: { "Content-Type": type, ...headers } });
  if (read && path === "/v1/openapi.json") return content(JSON.stringify(openapi), "application/json; charset=utf-8");
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
  if (read && path === "/") return Response.redirect(`${url.origin}/console`, 302);
  if (read && /^\/console(?:\/|$)/.test(path) && !/^\/console\/auth(?:\/|$)/.test(path)) {
    const asset = await assets?.fetch(new Request(new URL("/console/index.html", url)));
    if (asset?.ok) return content(await asset.text(), "text/html; charset=utf-8");
    return new Response(request.method === "HEAD" ? null : "The console is not built on this host", { status: 404, headers: { "Content-Type": "text/plain" } });
  }
  // Unknown non-API URLs carry the same useful 404 even without credentials.
  if (!/^\/(?:v1(?:\/|$)|clients(?:\/|$)|experimental(?:\/|$)|registry(?:\/|$)|console(?:\/|$)|oauth(?:\/|$)|\.well-known(?:\/|$)|mcp$|healthz$|__test(?:\/|$))/.test(path)) return unknownRoute(origin);
}
