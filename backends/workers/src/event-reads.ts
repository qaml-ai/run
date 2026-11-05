import { createHash } from "node:crypto";
import { HttpError } from "./errors.ts";
import { createTenants, type SecurityEnv } from "./security-services.ts";

// Like Node's Subscribers, the bound is per serving isolate, shared across all
// agents of a tenant. Closing, aborting, and failing while loading all release it.
const watchers = new Map<string, number>();
const encoder = new TextEncoder();
export async function eventRead(request: Request, env: SecurityEnv, tenant: string, forward: (request: Request) => Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  const watch = url.searchParams.get("watch") === "1";
  const polling = url.searchParams.get("poll") === "1";
  const requested = url.searchParams.get("request");
  if (!watch) return forward(request);
  const tenants = await createTenants(env);
  const limit = tenants.maxWatchers(tenant) ?? 1024;
  const key = createHash("sha256").update(`${env.HYPERDRIVE.connectionString}\0${tenant}`).digest("hex");
  if ((watchers.get(key) ?? 0) >= limit) throw Object.assign(new HttpError(429, `This account has too many watchers; close another event stream and retry`), { retryAfter: 5 });
  watchers.set(key, (watchers.get(key) ?? 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const count = (watchers.get(key) ?? 1) - 1;
    if (count) watchers.set(key, count); else watchers.delete(key);
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
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let pending = "";
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          for (;;) {
            const boundary = /\r?\n\r?\n/.exec(pending);
            if (boundary) {
              const frame = pending.slice(0, boundary.index);
              pending = pending.slice(boundary.index + boundary[0].length);
              const lines = frame.split(/\r?\n/);
              const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
              if (!data) { controller.enqueue(encoder.encode(`${frame}\n\n`)); return; }
              const value = JSON.parse(data);
              const ready = lines.some(line => /^event:\s*ready$/.test(line));
              if (ready) value.watch = true;
              if (ready || visible(value)) {
                controller.enqueue(encoder.encode(`${lines.filter(line => !line.startsWith("data:")).join("\n")}\ndata: ${JSON.stringify(value)}\n\n`));
                return;
              }
              continue;
            }
            const chunk = await reader.read();
            if (chunk.done) { release(); controller.close(); return; }
            pending += decoder.decode(chunk.value, { stream: true });
            if (pending.length > 2 * 1024 * 1024) throw new Error("Event frame exceeds stream limit");
          }
        } catch (error) { release(); controller.error(error); await reader.cancel(error).catch(() => {}); }
      },
      async cancel(reason) { release(); await reader.cancel(reason); },
    });
    return new Response(body, { status: response.status, headers });
  } catch (error) { release(); throw error; }
}
