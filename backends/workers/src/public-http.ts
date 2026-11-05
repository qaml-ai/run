import openapi from "../../../openapi.json";

type PublicEnv = { AGENT_PUBLIC_URL?: string; PUBLIC_ASSETS?: Fetcher };
const docsOrigin = "https://run.camelai.com";
const browserPages = /^(?:\/$|\/console(?:\/|$)|\/oauth\/authorize$)/;
const documentPath = /^(?:\/(?:SKILL\.md|skill\.md|llms\.txt|llms-full\.txt)|\/docs(?:\/|$)|\/r(?:\/|$))/;

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
  const origin = env.AGENT_PUBLIC_URL || url.origin;
  const read = request.method === "GET" || request.method === "HEAD";
  const content = (body: string, type: string, headers: Record<string, string> = {}) => new Response(request.method === "HEAD" ? null : body, { headers: { "Content-Type": type, ...headers } });
  if (read && path === "/robots.txt") return content("User-agent: *\nAllow: /\n", "text/plain; charset=utf-8", { "Cache-Control": "public, max-age=3600" });
  if (read && path === "/v1/openapi.json") return content(JSON.stringify(openapi), "application/json; charset=utf-8");
  if (read && (path === "/docs" || path === "/docs/")) return Response.redirect("https://camelai.com/docs/camelrun/overview", 302);
  if (documentPath.test(path)) {
    const registry = path === "/r" || path.startsWith("/r/");
    const eligible = registry ? /^\/r\/[^/]+\.json$/.test(path) : /\.md$/.test(path) || path === "/llms.txt" || path === "/llms-full.txt";
    const asset = read && eligible && env.PUBLIC_ASSETS ? await env.PUBLIC_ASSETS.fetch(new Request(url, { method: "GET" })) : undefined;
    if (!asset?.ok) return Response.json({ type: "error", error: `Unknown document. The docs' index: ${origin}/llms.txt`, code: "NOT_FOUND" }, { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });
    const text = (await asset.text()).replaceAll(docsOrigin, origin);
    return content(text, registry ? "application/json; charset=utf-8" : path.endsWith(".txt") ? "text/plain; charset=utf-8" : "text/markdown; charset=utf-8", {
      "Cache-Control": path === "/SKILL.md" || path === "/skill.md" ? "no-cache" : "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
      ...(registry ? {} : { "X-Robots-Tag": "noindex" }),
    });
  }
  if (read && path === "/") return Response.redirect(`${url.origin}/console`, 302);
  if (read && /^\/console(?:\/|$)/.test(path) && !/^\/console\/auth(?:\/|$)/.test(path) && env.PUBLIC_ASSETS) {
    const asset = await env.PUBLIC_ASSETS.fetch(new Request(new URL("/console/index.html", url)));
    if (asset.ok) return content(await asset.text(), "text/html; charset=utf-8");
  }
  // Unknown non-API URLs carry the same useful 404 even without credentials.
  if (!/^\/(?:v1(?:\/|$)|clients(?:\/|$)|experimental(?:\/|$)|registry(?:\/|$)|console(?:\/|$)|oauth(?:\/|$)|\.well-known(?:\/|$)|mcp$|healthz$|__test(?:\/|$))/.test(path)) return unknownRoute(origin);
}
