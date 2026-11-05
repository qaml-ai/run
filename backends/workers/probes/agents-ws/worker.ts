import { DurableObject } from "cloudflare:workers";
import { AttachedTools } from "../../src/attached-tools.ts";
import { EVENT_PROTOCOL, eventFrame } from "../../src/live-transport.ts";

type Env = { API_TOKEN: string; PROBE: DurableObjectNamespace<AttachedWsProbe> };
/** Synthetic fixed tool only. Uses the production pool and attachment recovery. */
export class AttachedWsProbe extends DurableObject<Env> {
  private readonly boot = crypto.randomUUID();
  private readonly attached = new AttachedTools();
  private restored = 0;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const socket of ctx.getWebSockets()) {
      const value = socket.deserializeAttachment();
      if (value?.type !== "camel.application") continue;
      if (!value.serving || !value.initialized || this.attached.connected) { this.retire(socket); continue; }
      this.attached.restore(value.connection, event => socket.send(eventFrame(event)), () => this.retire(socket));
      this.restored++;
    }
  }
  private retire(socket: WebSocket) {
    const value = socket.deserializeAttachment();
    if (value) socket.serializeAttachment({ ...value, serving: false });
    try { socket.close(1000, "Probe retired"); } catch {}
  }
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === "/events" && request.headers.get("upgrade") === "websocket") {
      await this.attached.prepareAttach();
      const pair = new WebSocketPair(), socket = pair[1];
      this.ctx.acceptWebSocket(socket);
      const connection = this.attached.attach(event => socket.send(eventFrame(event)), undefined, false, () => this.retire(socket));
      socket.serializeAttachment({ type: "camel.application", connection: connection.id, serving: true, initialized: false });
      socket.send(eventFrame({ version: 5, connection: connection.id, boot: this.boot }, undefined, "ready"));
      void connection.start().then(() => socket.serializeAttachment({ ...socket.deserializeAttachment(), initialized: true }));
      return new Response(null, { status: 101, webSocket: pair[0], headers: { "sec-websocket-protocol": EVENT_PROTOCOL } });
    }
    if (path === "/mcp" && request.method === "POST") {
      this.attached.receive(await request.json(), request.headers.get("x-agent-connection"));
      return Response.json({ ok: true });
    }
    if (path === "/call" && request.method === "POST") {
      const result = await this.attached.call("echo", { value: "synthetic probe" }, 5000);
      return Response.json({ boot: this.boot, restored: this.restored, sockets: this.ctx.getWebSockets().length, result });
    }
    if (path === "/state") return Response.json({ boot: this.boot, restored: this.restored, connected: this.attached.connected, sockets: this.ctx.getWebSockets().length });
    if (path === "/cleanup" && request.method === "POST") {
      for (const socket of this.ctx.getWebSockets()) this.retire(socket);
      this.attached.close();
      await this.ctx.storage.deleteAll();
      return Response.json({ cleared: true });
    }
    return new Response("Not found", { status: 404 });
  }
  webSocketMessage(socket: WebSocket) { socket.close(1008, "Read-only event stream"); }
  webSocketClose(socket: WebSocket) {
    this.attached.close(socket.deserializeAttachment()?.connection);
    try { socket.close(1000, "Closed"); } catch {}
  }
  webSocketError(socket: WebSocket) { this.webSocketClose(socket); }
}
export default {
  fetch(request: Request, env: Env) {
    if (request.headers.get("authorization") !== `Bearer ${env.API_TOKEN}`) return new Response("Unauthorized", { status: 401 });
    return env.PROBE.getByName("attached-ws-hibernation-probe").fetch(request);
  },
};
