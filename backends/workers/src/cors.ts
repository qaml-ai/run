import { BrowserTokens } from "./browser-tokens.ts";

/** src/node.ts's browser-read policy. Tenant API keys deliberately never receive CORS. */
export const BROWSER_READS = /^\/v1\/agents\/client_[a-f0-9]{40}\/(?:events|state|history|inputs|children)$/;
export function corsPreflight(request: Request): Response | undefined {
  if (request.method !== "OPTIONS" || !request.headers.has("origin") || !BROWSER_READS.test(new URL(request.url).pathname)) return;
  return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET", "Access-Control-Allow-Headers": "Authorization, Last-Event-ID, Accept", "Access-Control-Max-Age": "86400" } });
}
export function corsResponse(request: Request, response: Response): Response {
  if (!request.headers.has("origin") || !BROWSER_READS.test(new URL(request.url).pathname) || !BrowserTokens.carries(request.headers.get("authorization") ?? undefined)) return response;
  const result = new Response(response.body, response);
  result.headers.set("Access-Control-Allow-Origin", "*");
  return result;
}
