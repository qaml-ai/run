export const EVENT_CONNECTION_HEADER = "x-camel-event-connection";

/** Keep public disconnects attached to the exact DO connection across fetch. */
export function relayEvents(response: Response, signal: AbortSignal, detach: (connection: string) => Promise<unknown>, waitUntil: (task: Promise<unknown>) => void): Response {
  if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) return response;
  const connection = response.headers.get(EVENT_CONNECTION_HEADER);
  const headers = new Headers(response.headers);
  headers.delete(EVENT_CONNECTION_HEADER);
  const reader = response.body.getReader();
  let closed = false;
  let detached = false;
  const disconnect = () => {
    if (detached || !connection) return;
    detached = true;
    waitUntil(detach(connection));
  };
  let abort: () => void;
  const cleanup = () => { closed = true; signal.removeEventListener("abort", abort); };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (closed) return;
        cleanup();
        disconnect();
        void reader.cancel(signal.reason).catch(() => {});
        controller.close();
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (closed) return;
        if (next.done) { cleanup(); controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) {
        if (!closed) { cleanup(); disconnect(); controller.error(error); }
      }
    },
    cancel(reason) { cleanup(); disconnect(); return reader.cancel(reason); },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers });
}
