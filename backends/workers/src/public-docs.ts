import { DOCS_SITE, ROBOTS_TXT, SKILL_PATHS } from "../../../src/docs.ts";

interface DocsEnv {
  DOCS?: { fetch: typeof fetch };
  AGENT_PUBLIC_URL?: string;
}

/** Serve the same checked-in documents as src/docs.ts, from a Workers asset binding. */
export async function publicDocs(request: Request, env: DocsEnv): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = /^https?:\/\/[^/]+([^?#]*)/.exec(request.url)?.[1] || "/";
  const read = request.method === "GET" || request.method === "HEAD";
  const head = request.method === "HEAD";
  if (path === "/robots.txt" && read) return new Response(head ? null : ROBOTS_TXT, {
    headers: { "Content-Type": "text/plain; charset=UTF-8", "Cache-Control": "public, max-age=3600" },
  });
  if ((path === "/docs" || path === "/docs/") && read) return Response.redirect(DOCS_SITE, 302);
  const skill = SKILL_PATHS.includes(path);
  const text = path === "/llms.txt" || path === "/llms-full.txt";
  if (!skill && !text && path !== "/docs" && !path.startsWith("/docs/")) return;
  const publicUrl = env.AGENT_PUBLIC_URL || url.origin;
  const unknown = () => Response.json({ type: "error", error: `Unknown document. The docs' index: ${publicUrl}/llms.txt`, code: "NOT_FOUND" }, {
    status: 404, headers: { "Access-Control-Allow-Origin": "*" },
  });
  if (!read || path.includes("%") || path.includes("//") || path.split("/").some(part => part === "." || part === "..")) return unknown();
  const asset = skill ? "/SKILL.md" : text ? path
    : path.startsWith("/docs/") && path.endsWith(".md") ? path.slice("/docs".length) : undefined;
  if (!asset || !env.DOCS) return unknown();
  const response = await env.DOCS.fetch(new Request(new URL(asset, url), { method: "GET" }));
  if (!response.ok) return unknown();
  const body = (await response.text()).replaceAll("https://run.camelai.com", publicUrl);
  return new Response(head ? null : body, { headers: {
    "Content-Type": text ? "text/plain; charset=utf-8" : "text/markdown; charset=utf-8",
    "Cache-Control": skill ? "no-cache" : "public, max-age=300",
    "Access-Control-Allow-Origin": "*",
    "X-Robots-Tag": "noindex",
  } });
}
