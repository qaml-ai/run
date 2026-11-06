// Deployed diagnostic only: no database, provider keys, or production bindings.
import { DurableObject } from "cloudflare:workers";
import { eventRead } from "../src/event-reads.ts";
import type { SecurityEnv } from "../src/security-services.ts";

type Env = { GATE: DurableObjectNamespace<SubscriberGate>; SOURCE: DurableObjectNamespace<SubscriberSource> };
type Entry = { at: number; id: string; event: string; aborted?: boolean };
const encoder = new TextEncoder();
const syntheticEnv = {
  HYPERDRIVE: { connectionString: "subscriber-probe-no-database" },
  AGENT_TENANTS_JSON: JSON.stringify({ tenants: { probe: { tokenSha256: "0".repeat(64), maxWatchers: 1 } } }),
} as SecurityEnv;

export default {
  fetch(request: Request, env: Env) {
    const session = new URL(request.url).searchParams.get("session") ?? "default";
    return env.GATE.getByName(session).fetch(request, { signal: request.signal });
  },
};

export class SubscriberGate extends DurableObject<Env> {
  private entries: Entry[] = [];
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url), id = url.searchParams.get("id") ?? "unknown";
    if (url.pathname === "/trace") return Response.json(this.entries);
    const record = (event: string) => this.entries.push({ at: Date.now(), id, event, aborted: request.signal.aborted });
    record("gate-enter");
    request.signal.addEventListener("abort", () => record("gate-abort"), { once: true });
    try {
      return await eventRead(request, syntheticEnv, "probe", this.ctx.id.toString(), async forwarded => {
        record("forward-start");
        const response = await this.env.SOURCE.getByName(this.ctx.id.toString()).fetch(forwarded, { signal: forwarded.signal });
        record("forward-response");
        return response;
      }, task => this.ctx.waitUntil(task));
    } catch (error) {
      record("gate-error");
      return Response.json({ error: String(error) }, { status: (error as { status?: number }).status ?? 500 });
    }
  }
}

export class SubscriberSource extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.searchParams.get("poll") === "1") return Response.json({ events: [] });
    await new Promise(resolve => setTimeout(resolve, Number(url.searchParams.get("delay") ?? 1000)));
    let interval: ReturnType<typeof setInterval>, timeout: ReturnType<typeof setTimeout>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: ready\ndata: {}\n\n"));
        interval = setInterval(() => controller.enqueue(encoder.encode(": heartbeat\n\n")), 100);
        timeout = setTimeout(() => { clearInterval(interval); controller.close(); }, 15000);
      },
      cancel() { clearInterval(interval); clearTimeout(timeout); },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }
}
