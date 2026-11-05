/** Keep the public HTTP connection's cancellation attached to the DO stream. */
export function relayEvents(response: Response, signal: AbortSignal): Response {
  if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) return response;
  const reader = response.body.getReader();
  let closed = false;
  let abort: () => void;
  const cleanup = () => { closed = true; signal.removeEventListener("abort", abort); };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      abort = () => {
        if (closed) return;
        cleanup();
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
        if (!closed) { cleanup(); controller.error(error); }
      }
    },
    cancel(reason) { cleanup(); return reader.cancel(reason); },
  });
  return new Response(stream, response);
}
