import { vi } from "vitest";

/** A handler stand-in: token answers wait until released; it counts the event streams opened and still open. */
export function slowServer() {
  const pending: (() => void)[] = [];
  const streams: AbortSignal[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/events")) {
      streams.push(init!.signal!);
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode("event: ready\ndata: {\"watch\":true}\n\n"));
        init!.signal!.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      } }), { headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.includes("/history")) return Response.json({ entries: [], next: null, total: 0 });
    if (url.includes("/inputs") || url.includes("/state")) return Response.json([]);
    await new Promise<void>(resolve => pending.push(resolve));
    return Response.json({ proxy: true, agentId: "client_x", token: "", expiresAt: Date.now() + 3_600_000 });
  }) as unknown as typeof globalThis.fetch & { mock: { calls: unknown[] } };
  return { fetch, pending, streams, open: () => streams.filter(signal => !signal.aborted).length };
}
