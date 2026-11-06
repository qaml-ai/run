// Throwaway prototype: does a Durable Object hibernate behind a WebSocket that a
// Worker opened (and bridges to SSE), as it does for an external WebSocket client?
import { DurableObject } from "cloudflare:workers";

interface Env { PROBE: DurableObjectNamespace<Probe>; PROBE_TOKEN: string }

const encoder = new TextEncoder();

export class Probe extends DurableObject<Env> {
  instance = crypto.randomUUID();
  writers = new Set<WritableStreamDefaultWriter<Uint8Array>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Pings answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("upgrade") !== "websocket") return new Response("upgrade", { status: 426 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].send(JSON.stringify({ type: "hello", instance: this.instance }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/sse") {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      this.writers.add(writer);
      void writer.write(encoder.encode(`data: ${JSON.stringify({ type: "hello", instance: this.instance })}\n\n`));
      const timer = setInterval(() => {
        writer.write(encoder.encode(": hb\n\n")).catch(() => { clearInterval(timer); this.writers.delete(writer); });
      }, 30_000);
      return new Response(readable, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    }
    if (url.pathname === "/send") {
      const event = JSON.stringify({ type: "event", instance: this.instance, at: new Date().toISOString() });
      const sockets = this.ctx.getWebSockets();
      for (const ws of sockets) ws.send(event);
      for (const writer of this.writers) writer.write(encoder.encode(`data: ${event}\n\n`)).catch(() => this.writers.delete(writer));
      return Response.json({ instance: this.instance, sockets: sockets.length, sse: this.writers.size });
    }
    if (url.pathname === "/state") return Response.json({ instance: this.instance, sockets: this.ctx.getWebSockets().length });
    return new Response("not found", { status: 404 });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    ws.send(JSON.stringify({ type: "echo", instance: this.instance, message: String(message) }));
  }
  webSocketClose(ws: WebSocket, code: number, reason: string) { try { ws.close(code, reason); } catch {} }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const auth = request.headers.get("authorization") ?? `Bearer ${url.searchParams.get("token")}`;
    if (auth !== `Bearer ${env.PROBE_TOKEN}`) return new Response("Unauthorized", { status: 401 });
    const name = url.searchParams.get("obj") ?? "x";
    const stub = env.PROBE.getByName(name);
    const meta = { objectId: stub.id.toString(), name };
    if (url.pathname === "/meta") return Response.json(meta);
    if (url.pathname === "/ws" || url.pathname === "/sse" || url.pathname === "/send" || url.pathname === "/state")
      return stub.fetch(new Request(new URL(url.pathname, "https://probe"), request));
    if (url.pathname === "/bridge") {
      // The Worker opens a WebSocket to the object and turns frames into SSE.
      const upstream = await stub.fetch("https://probe/ws", { headers: { upgrade: "websocket" } });
      const ws = upstream.webSocket;
      if (!ws) return new Response(`no websocket (${upstream.status})`, { status: 502 });
      ws.accept();
      const pingUpstream = url.searchParams.get("wsping") === "1";
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      let closed = false;
      const close = () => {
        if (closed) return; closed = true; clearInterval(timer);
        try { ws.close(1000, "client gone"); } catch {}
        writer.close().catch(() => {});
      };
      const write = (text: string) => writer.write(encoder.encode(text)).catch(close);
      ws.addEventListener("message", event => { void write(`data: ${event.data}\n\n`); });
      ws.addEventListener("close", event => { void write(`event: closed\ndata: ${JSON.stringify({ code: event.code, reason: event.reason })}\n\n`); close(); });
      ws.addEventListener("error", () => close());
      const timer = setInterval(() => {
        void write(": hb\n\n");
        if (pingUpstream) try { ws.send("ping"); } catch { close(); }
      }, 30_000);
      request.signal?.addEventListener("abort", close);
      return new Response(readable, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    }
    return new Response("not found", { status: 404 });
  },
};
