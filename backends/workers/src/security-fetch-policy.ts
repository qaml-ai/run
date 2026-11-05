// Generated from src/outbound.ts; native fetch replaces the Node dispatcher.
// Run node backends/workers/scripts/reuse-security.mjs --check to check source drift.
import type { Outbound } from "./security-outbound.ts";

export class OutboundBlocked extends Error {
  constructor(message: string) { super(message); this.name = "OutboundBlocked"; }
}

export async function guardedFetch(this: Pick<Outbound, "check" | "reachable">, input: string | URL, init: RequestInit & { secrets?: Record<string, string>; timeoutMs?: number; maxBytes?: number; maxRedirects?: number; stream?: boolean } = {}): Promise<Response> {
    const { secrets, timeoutMs = 30_000, maxBytes = 4 * 1024 * 1024, maxRedirects = 0, stream, signal, ...request } = init;
    const origin = this.check(input).origin;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new OutboundBlocked(`No response within ${timeoutMs} ms`)), timeoutMs);
    const aborted = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    let url = this.check(input);
    let method = (request.method ?? "GET").toUpperCase();
    let body = request.body;
    try {
      for (let hops = 0; ; hops++) {
        const headers = new Headers(request.headers);
        if (url.origin === origin) for (const [name, value] of Object.entries(secrets ?? {})) headers.set(name, value);
        let response: Response;
        try {
          response = await fetch(await this.reachable(url), { ...request, method, headers, body, redirect: "manual", signal: aborted });
        } catch (error) {
          throw (error as { cause?: unknown }).cause instanceof OutboundBlocked ? (error as { cause: Error }).cause : aborted.aborted && aborted.reason instanceof Error ? aborted.reason : error;
        }
        const location = response.headers.get("location");
        if (response.status >= 300 && response.status < 400 && location) {
          await response.body?.cancel();
          if (hops >= maxRedirects) throw new OutboundBlocked(maxRedirects ? `More than ${maxRedirects} redirects` : `Redirects are not followed (to ${location.slice(0, 200)})`);
          url = this.check(new URL(location, url));
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) { method = "GET"; body = undefined; }
          continue;
        }
        if (stream) clearTimeout(timer);
        return capped(response as unknown as Response, url, maxBytes, () => clearTimeout(timer));
      }
    } catch (error) { clearTimeout(timer); throw error; }
  }

function capped(response: Response, url: URL, maxBytes: number, done: () => void): Response {
  if (!response.body) { done(); return response; }
  let bytes = 0;
  const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) { done(); controller.error(new OutboundBlocked(`Response larger than ${maxBytes} bytes`)); return; }
      controller.enqueue(chunk);
    },
    flush() { done(); },
  }));
  return Object.defineProperty(new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers }), "url", { value: url.toString() });
}