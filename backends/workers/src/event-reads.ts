import { createHash } from "node:crypto";
import { HttpError } from "./errors.ts";
import { createTenants, type SecurityEnv } from "./security-services.ts";

// Like Node's Subscribers, the bound is per serving isolate, shared across all
// agents of a tenant. Closing, aborting, and failing while loading all release it.
const watchers = new Map<string, number>();
const agentWatchers = new Map<string, number>();
const nodeWatchers = new Map<string, number>();
const encoder = new TextEncoder();
export async function eventRead(request: Request, env: SecurityEnv, tenant: string, agentId: string, forward: (request: Request) => Promise<Response>, waitUntil: (task: Promise<unknown>) => void): Promise<Response> {
  const url = new URL(request.url);
  const watch = url.searchParams.get("watch") === "1";
  const polling = url.searchParams.get("poll") === "1";
  const requested = url.searchParams.get("request");
  if (!watch) return forward(request);
  const tenants = await createTenants(env);
  const limit = tenants.maxWatchers(tenant) ?? 1024;
  const node = createHash("sha256").update(env.HYPERDRIVE.connectionString).digest("hex");
  const key = `${node}:${tenant}`, agent = `${node}:${agentId}`;
  const reject = (scope: string) => { throw Object.assign(new HttpError(429, `This ${scope} has too many event stream subscribers; retry later`), { retryAfter: 5 }); };
  // src/client-sessions/events.ts's per-agent, tenant and node bounds.
  if ((agentWatchers.get(agent) ?? 0) >= 32) reject("agent");
  if ((watchers.get(key) ?? 0) >= limit) reject("tenant");
  if ((nodeWatchers.get(node) ?? 0) >= 4096) reject("node");
  watchers.set(key, (watchers.get(key) ?? 0) + 1);
  agentWatchers.set(agent, (agentWatchers.get(agent) ?? 0) + 1);
  nodeWatchers.set(node, (nodeWatchers.get(node) ?? 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    for (const [counts, name] of [[watchers, key], [agentWatchers, agent], [nodeWatchers, node]] as const) {
      const count = (counts.get(name) ?? 1) - 1;
      if (count) counts.set(name, count); else counts.delete(name);
    }
    request.signal.removeEventListener("abort", release);
  };
  request.signal.addEventListener("abort", release, { once: true });
  if (request.signal.aborted) release();
  try {
    const response = await forward(request);
    if (!response.ok || !response.body || response.status === 101) { release(); return response; }
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    const visible = (frame: any) => !requested || (frame?.type === "event" ? frame.requestId === requested : frame?.type === "response" ? frame.id === requested : true);
    if (polling) {
      const result = await response.json() as { events: { data: unknown }[] };
      if (requested) result.events = result.events.filter(event => visible(event.data));
      release();
      return Response.json(result, { status: response.status, headers });
    }
    if (!response.headers.get("content-type")?.includes("text/event-stream")) { release(); return response; }
    const decoder = new TextDecoder();
    let pending = "";
    const filter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        for (;;) {
          const boundary = /\r?\n\r?\n/.exec(pending);
          if (!boundary) break;
          if (boundary.index > 2 * 1024 * 1024) throw new Error("Event frame exceeds stream limit");
          const frame = pending.slice(0, boundary.index);
          pending = pending.slice(boundary.index + boundary[0].length);
          const lines = frame.split(/\r?\n/);
          const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (!data) { controller.enqueue(encoder.encode(`${frame}\n\n`)); continue; }
          const value = JSON.parse(data);
          const ready = lines.some(line => /^event:\s*ready$/.test(line));
          if (ready) value.watch = true;
          if (ready || visible(value)) controller.enqueue(encoder.encode(`${lines.filter(line => !line.startsWith("data:")).join("\n")}\ndata: ${JSON.stringify(value)}\n\n`));
        }
        if (pending.length > 2 * 1024 * 1024) throw new Error("Event frame exceeds stream limit");
      },
    });
    // Native piping sees downstream cancellation while the source waits for its
    // next event. An async pull() defers cancel() until that event arrives,
    // retaining the subscriber's place after its client has already gone.
    waitUntil(response.body.pipeTo(filter.writable, { signal: request.signal })
      .catch(() => {}).finally(release));
    return new Response(filter.readable, { status: response.status, headers });
  } catch (error) { release(); throw error; }
}
