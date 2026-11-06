import { HttpError } from "./errors.ts";
import { EVENT_PROTOCOL } from "./live-transport.ts";

type Inbox = { push(item: { kind: "event"; data: unknown } | { kind: "reconnected" } | { kind: "failed"; error: Error }): void };

/** Internal watchers use the same hibernatable socket protocol as the SDK. */
export function followEvents(call: { fetch: typeof fetch; events: string; authorization?: string }, inbox: Inbox, signal: AbortSignal): Promise<void> {
  const opened = Promise.withResolvers<void>();
  void (async () => {
    let cursor: string | undefined, first = true;
    while (!signal.aborted) {
      try {
        const response = await call.fetch(call.events, { headers: {
          ...(call.authorization ? { Authorization: call.authorization } : {}), Upgrade: "websocket", "Sec-WebSocket-Protocol": EVENT_PROTOCOL,
          ...(cursor ? { "Last-Event-ID": cursor } : {}),
        }, signal });
        if (response.status === 409) { cursor = undefined; await response.body?.cancel(); continue; }
        const socket = response.webSocket;
        if (response.status !== 101 || !socket) {
          const error = new HttpError(response.status, (await response.json().catch(() => ({})) as { error?: string }).error ?? response.statusText);
          if (response.status !== 503) { opened.reject(error); inbox.push({ kind: "failed", error }); return; }
        } else {
          const closed = Promise.withResolvers<void>();
          const close = () => { try { socket.close(1000, "Watcher ended"); } catch {} closed.resolve(); };
          const message = (event: MessageEvent) => {
            try {
              const frame = JSON.parse(String(event.data));
              if (frame.event === "ready") {
                if (first) opened.resolve(); else inbox.push({ kind: "reconnected" });
                first = false;
                return;
              }
              if (frame.id) cursor = String(frame.id);
              if (frame.data) inbox.push({ kind: "event", data: frame.data });
            } catch { close(); }
          };
          socket.addEventListener("message", message);
          socket.addEventListener("close", close);
          socket.addEventListener("error", close);
          signal.addEventListener("abort", close, { once: true });
          socket.accept();
          if (signal.aborted) close();
          await closed.promise;
          socket.removeEventListener("message", message);
          socket.removeEventListener("close", close);
          socket.removeEventListener("error", close);
          signal.removeEventListener("abort", close);
        }
      } catch { /* A dropped internal socket reconnects from the durable cursor. */ }
      if (!signal.aborted) await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
        const timer = setTimeout(done, 1000);
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
    }
    opened.resolve();
  })();
  return opened.promise;
}
