export const EVENT_CONNECTION_HEADER = "x-camel-event-connection";

/** Keep public disconnects attached to the exact DO connection across fetch. */
export function relayEvents(response: Response, signal: AbortSignal, detach: (connection: string) => Promise<unknown>, waitUntil: (task: Promise<unknown>) => void): Response {
  if (!response.body || !response.headers.get("content-type")?.startsWith("text/event-stream")) return response;
  const connection = response.headers.get(EVENT_CONNECTION_HEADER);
  const headers = new Headers(response.headers);
  headers.delete(EVENT_CONNECTION_HEADER);
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  let detached = false;
  const disconnect = () => {
    if (detached || !connection) return;
    detached = true;
    waitUntil(detach(connection));
  };
  const abort = () => disconnect();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  // A native pipe observes cancellation while waiting for the next DO event.
  // An async JavaScript pull() can otherwise defer it until that event arrives.
  waitUntil(response.body.pipeTo(stream.writable, { signal })
    .catch(() => disconnect())
    .finally(() => signal.removeEventListener("abort", abort)));
  return new Response(stream.readable, { status: response.status, statusText: response.statusText, headers });
}
