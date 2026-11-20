/** Only unkeyed bearer mints use the read-only legacy adapter. Other shapes keep the original route. */
export function legacyBrowserTokenAgent(request: Request): string | undefined {
  const url = new URL(request.url);
  if (url.protocol !== "https:" || url.port || !["run.camelai.com", "agents.camelai.dev"].includes(url.hostname)) return;
  if (request.method !== "POST" || request.headers.has("upgrade") || request.headers.has("idempotency-key")) return;
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length <= 7) return;
  return /^\/v1\/agents\/(client_[a-f0-9]{40})\/browser-tokens$/.exec(url.pathname)?.[1];
}
