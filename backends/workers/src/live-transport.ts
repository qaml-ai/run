/** Shared wire format for hibernatable WebSockets and the SDK negotiation. */
export const EVENT_PROTOCOL = "camelrun.events.v1";
export const EVENT_CAPABILITY = "application/vnd.camelrun.events+json";

export function negotiateEvents(request: Request): Response | undefined {
  const offered = request.headers.get("accept")?.split(",").map(value => value.trim().split(";")[0]);
  if (!offered?.includes(EVENT_CAPABILITY)) return;
  // Live event streams are WebSocket-only on Workers.
  const url = new URL(request.url);
  return Response.json({ transport: "websocket", protocol: EVENT_PROTOCOL, url: url.pathname + url.search }, {
    headers: { "content-type": EVENT_CAPABILITY, "cache-control": "no-store", vary: "Accept" },
  });
}

/** Browsers cannot add Authorization to an upgrade. Carry it in an unselected
 * subprotocol, never in a URL or socket attachment. The selected protocol is public. */
export function websocketAuthorization(request: Request): Request {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket" || request.headers.has("authorization")) return request;
  const protocols = request.headers.get("sec-websocket-protocol")?.split(",").map(value => value.trim()) ?? [];
  if (!protocols.includes(EVENT_PROTOCOL)) return request;
  const encoded = protocols.find(value => /^bearer\.[A-Za-z0-9_-]+$/.test(value))?.slice(7);
  if (!encoded || encoded.length > 8192) return request;
  try {
    const token = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
    if (!/^[\x21-\x7e]+$/.test(token)) return request;
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${token}`);
    return new Request(request, { headers });
  } catch { return request; }
}

export function eventFrame(data: unknown, id?: number, event?: "ready" | "reconnect" | "closed"): string {
  return JSON.stringify({ ...(event ? { event } : {}), ...(id ? { id } : {}), data });
}

/** A stable refusal for clients which cannot negotiate a WebSocket. */
export function webSocketRequired(): Response {
  return Response.json({ error: "Workers live events require WebSocket; use a WebSocket-capable client", code: "WEBSOCKET_REQUIRED" }, {
    status: 406, headers: { "cache-control": "no-store", vary: "Accept" },
  });
}
