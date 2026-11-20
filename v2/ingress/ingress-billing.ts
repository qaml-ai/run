export interface BillingCallbackOrigin { fetch(request: Request): Promise<Response> }

export function legacyBillingCallback(request: Request, origin?: BillingCallbackOrigin) {
  if (!origin || request.method !== "POST" || request.headers.has("upgrade")) return;
  const url = new URL(request.url);
  if (url.protocol !== "https:" || url.port || (url.hostname !== "run.camelai.com" && url.hostname !== "agents.camelai.dev") ||
      (url.pathname !== "/v1/billing/stripe/webhook" && url.pathname !== "/v1/billing/email/feedback")) return;

  // The binding fixes the destination. Forward the original body and signature once.
  const upstream = new Request(`http://${url.hostname}${url.pathname}${url.search}`, request);
  return origin.fetch(upstream);
}
