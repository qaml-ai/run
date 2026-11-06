import { FRAME_BYTES } from "../../../shared/client-protocol.ts";
import { EVENT_CAPABILITY } from "./live-transport.ts";

/**
 * Server-sent events, served by the stateless front Worker. The agent's Durable Object never holds an SSE response:
 * that would keep it in memory and billed for wall-clock time. The Worker opens the same hibernatable WebSocket an
 * SDK opens, and writes each of its frames as an SSE event; Workers bill CPU time, so an idle bridge costs about
 * nothing while the object sleeps (measurements/sse-bridge.json).
 */

/** Comment lines that keep an idle stream open: well under the 20 s after which the SDK calls an SSE stream stalled
 * (clients/typescript.ts; watchers wait 35 s), and Cloudflare's 100 s idle cut. Node sends one every 5 s; each costs
 * the Worker a fraction of a millisecond of CPU. */
export const SSE_HEARTBEAT_MS = 10_000;
/** A stream with no event this long is closed with a `reconnect` frame, and its subscriber resumes at once with
 * Last-Event-ID. A backstop: anything the bridge holds (a socket the object lost track of, a half-open client) is
 * let go within this, while a reconnect every few idle minutes costs a subscriber one request. */
export const SSE_IDLE_MS = 5 * 60_000;

/** Tests shorten both; deployments keep the defaults. */
export function bridgeOptions(env: object): { heartbeatMs?: number; idleMs?: number } {
  const vars = env as { AGENT_SSE_HEARTBEAT_MS?: string; AGENT_SSE_IDLE_MS?: string };
  return { heartbeatMs: Number(vars.AGENT_SSE_HEARTBEAT_MS) || undefined, idleMs: Number(vars.AGENT_SSE_IDLE_MS) || undefined };
}

const encoder = new TextEncoder();
const reconnect = (reason: string) => `event: reconnect\nretry: 0\ndata: ${JSON.stringify({ type: "reconnect", reason, retryMs: 0 })}\n\n`;

/** A live event stream that wants SSE: neither the WebSocket capability nor an upgrade, nor a JSON long poll. */
export function wantsEventStream(request: Request): boolean {
  if (request.method !== "GET" || request.headers.has("upgrade")) return false;
  if (new URL(request.url).searchParams.get("poll") === "1") return false;
  const offered = request.headers.get("accept")?.split(",").map(value => value.trim().split(";")[0]) ?? [];
  return !offered.includes(EVENT_CAPABILITY);
}

/**
 * `open` reaches the agent's /events with the request's own headers (bearer, Last-Event-ID, X-Agent-Connection) and
 * an Upgrade added. A refusal before the upgrade (a replay gap's 409, a 429, an unknown agent) is the answer as is.
 */
export async function bridgeEvents(request: Request, open: (request: Request) => Promise<Response>,
  options: { heartbeatMs?: number; idleMs?: number } = {}): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set("upgrade", "websocket");
  for (const name of ["accept", "sec-websocket-protocol", "sec-websocket-key", "sec-websocket-version", "content-length"]) headers.delete(name);
  const upstream = await open(new Request(request.url, { method: "GET", headers }));
  const socket = upstream.webSocket;
  if (upstream.status !== 101 || !socket) return upstream;
  socket.accept();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false, heartbeat: ReturnType<typeof setInterval> | undefined, idle: ReturnType<typeof setTimeout> | undefined;
  /** Once: stop the timers, settle the stream as `settle` says, and close the object's socket. */
  const finish = (code: number, reason: string, settle: () => void = () => {}) => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    clearTimeout(idle);
    request.signal?.removeEventListener("abort", gone);
    try { settle(); } catch {}
    try { socket.close(code, reason); } catch {}
  };
  const end = (last?: string) => finish(1000, "Stream closed", () => { if (last) controller.enqueue(encoder.encode(last)); controller.close(); });
  const gone = () => finish(1000, "Subscriber gone");
  const quiet = () => { clearTimeout(idle); idle = setTimeout(() => end(reconnect("idle")), options.idleMs ?? SSE_IDLE_MS); };
  const write = (text: string) => {
    if (ended) return;
    const bytes = encoder.encode(text);
    // As Node's send(): a subscriber more than two frames behind is cut off, and resumes from its cursor.
    if (-(controller.desiredSize ?? 0) + bytes.byteLength > 2 * FRAME_BYTES)
      return finish(1011, "Subscriber too slow", () => controller.error(new Error("Event subscriber is too slow")));
    controller.enqueue(bytes);
  };
  const body = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel: gone,
  }, new ByteLengthQueuingStrategy({ highWaterMark: 0 }));
  socket.addEventListener("message", message => {
    try {
      // The object's frames: {event?, id?, data}, exactly as clients/event-transport.ts reads them.
      const frame = JSON.parse(String(message.data)) as { event?: string; id?: number; data?: unknown };
      write(`${frame.event ? `event: ${frame.event}\n` : ""}${frame.id ? `id: ${frame.id}\n` : ""}data: ${JSON.stringify(frame.data)}\n\n`);
      if (frame.event === "closed") end();
      else if (frame.event !== "ready") quiet();
    } catch { end(); }
  });
  socket.addEventListener("close", () => end());
  socket.addEventListener("error", () => end());
  heartbeat = setInterval(() => write(": heartbeat\n\n"), options.heartbeatMs ?? SSE_HEARTBEAT_MS);
  quiet();
  request.signal?.addEventListener("abort", gone, { once: true });
  if (request.signal?.aborted) gone();
  return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
