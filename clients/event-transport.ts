/** Negotiates one live stream. SSE is selected by its Content-Type; a WebSocket
 * is selected by a JSON capability response. A failed socket never downgrades. */
const PROTOCOL = "camelrun.events.v1";
const CAPABILITY = "application/vnd.camelrun.events+json";
const MAX_FRAME = 1_100_000;

export async function openEventStream(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  offered = "websocket,sse",
  currentAuthorization?: () => string,
): Promise<Response> {
  const transports = typeof globalThis.WebSocket === "function" ? offered.split(",") : ["sse"];
  const accept = transports.map(value => value === "websocket" ? CAPABILITY : "text/event-stream").join(", ");
  // The fetcher gets a plain object with the caller's own header names, as before this transport existed: custom
  // fetchers (the chat proxy's among them) spread `init.headers`, which drops every entry of a Headers instance.
  const own: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => { own[name] = value; });
  const named = init.headers && !(init.headers instanceof Headers) && !Array.isArray(init.headers) ? { ...init.headers as Record<string, string> } : own;
  for (const name of Object.keys(named)) if (name.toLowerCase() === "accept") delete named[name];
  const headers = new Headers(own);
  headers.set("Accept", accept);
  const response = await fetcher(url, { ...init, headers: { ...named, Accept: accept } });
  if (!response.ok || !response.headers.get("content-type")?.startsWith(CAPABILITY)) return response;
  const selection = await response.json() as { transport?: string; url?: string; protocol?: string };
  if (selection.transport !== "websocket" || selection.protocol !== PROTOCOL || typeof selection.url !== "string" || !offered.split(",").includes("websocket")) {
    throw new Error("Invalid event transport selection");
  }
  const endpoint = new URL(selection.url, url);
  if (endpoint.origin !== new URL(url).origin || endpoint.username || endpoint.password || endpoint.hash) throw new Error("Invalid event WebSocket origin");
  const authorization = currentAuthorization?.() ?? headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new Error("Event WebSocket requires a bearer token");
  const token = authorization.slice(7);
  if (!/^[\x21-\x7e]+$/.test(token)) throw new Error("Invalid event bearer token");
  const credential = btoa(token).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  const cursor = headers.get("last-event-id");
  if (cursor) endpoint.searchParams.set("cursor", cursor);
  const connection = headers.get("x-agent-connection");
  if (connection) endpoint.searchParams.set("connection", connection);
  const socket = new WebSocket(endpoint, [PROTOCOL, `bearer.${credential}`]);
  const opening = setTimeout(() => end(new Error("Event WebSocket connection timed out")), 10_000);
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  const close = () => { if (socket.readyState < 2) socket.close(1000, "Stream closed"); };
  const end = (error?: Error) => {
    if (ended) return;
    ended = true;
    clearTimeout(opening);
    init.signal?.removeEventListener("abort", abort);
    if (error) controller.error(error); else controller.close();
    close();
  };
  const abort = () => end(new Error("Event stream aborted"));
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel() { ended = true; clearTimeout(opening); init.signal?.removeEventListener("abort", abort); close(); },
  }, { highWaterMark: 64 });
  socket.addEventListener("open", () => {
    clearTimeout(opening);
    if (socket.protocol !== PROTOCOL) end(new Error("Event WebSocket protocol was not selected"));
  }, { once: true });
  socket.addEventListener("message", message => {
    try {
      if (typeof message.data !== "string" || encoder.encode(message.data).byteLength > MAX_FRAME) throw new Error("Invalid event WebSocket frame");
      const frame = JSON.parse(message.data) as { event?: unknown; id?: unknown; data?: unknown };
      if (typeof frame !== "object" || frame === null || !("data" in frame)) throw new Error("Invalid event WebSocket frame");
      if (frame.event !== undefined && !["ready", "reconnect", "closed"].includes(String(frame.event))) throw new Error("Invalid event WebSocket type");
      if (frame.id !== undefined && (!Number.isSafeInteger(frame.id) || Number(frame.id) <= 0)) throw new Error("Invalid event WebSocket cursor");
      if ((controller.desiredSize ?? 0) <= 0) throw new Error("Event WebSocket consumer is too slow");
      const data = JSON.stringify(frame.data);
      controller.enqueue(encoder.encode(`${frame.event ? `event: ${frame.event}\n` : ""}${frame.id ? `id: ${frame.id}\n` : ""}data: ${data}\n\n`));
      // A protocol close is final even when the host delays its TCP close.
      if (frame.event === "closed") end();
    } catch (error) { end(error instanceof Error ? error : new Error("Invalid event WebSocket frame")); }
  });
  socket.addEventListener("close", event => end(event.code === 1000 || event.code === 1001 ? undefined : new Error(`Event WebSocket closed (${event.code})`)));
  socket.addEventListener("error", () => end(new Error("Event WebSocket failed")));
  if (init.signal?.aborted) abort(); else init.signal?.addEventListener("abort", abort, { once: true });
  // Readers begin before open: this also handles an abort or failed upgrade while connecting.
  return new Response(body, { headers: { "Content-Type": "text/event-stream", "X-Agent-Transport": "websocket" } });
}
