import { readableFrame, readableMessage, readableRequest, type BrowserClaims } from "./browser-tokens.ts";

/** Source browser projections over the Workers JSON/SSE transport. */
export async function browserResponse(response: Response, claims: BrowserClaims, path: string): Promise<Response> {
  if (!response.ok) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  if (path === "/events" && response.body) {
    const reader = response.body.getReader(), decoder = new TextDecoder(), encoder = new TextEncoder();
    let timer: ReturnType<typeof setTimeout>, closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const close = () => {
          if (closed) return;
          closed = true; clearTimeout(timer); controller.close(); void reader.cancel();
        };
        timer = setTimeout(close, Math.max(0, claims.exp - Date.now()));
        void (async () => {
          let pending = "";
          while (!closed) {
            const { value, done } = await reader.read();
            if (done) { close(); return; }
            pending += decoder.decode(value, { stream: true });
            if (pending.length > 2 * 1024 * 1024) throw new Error("Browser event exceeds stream limit");
            for (;;) {
              const boundary = /\r?\n\r?\n/.exec(pending);
              if (!boundary) break;
              const frame = pending.slice(0, boundary.index);
              pending = pending.slice(boundary.index + boundary[0].length);
              const lines = frame.split(/\r?\n/), data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
              if (!data || lines.some(line => /^event:\s*ready$/.test(line))) {
                controller.enqueue(encoder.encode(`${frame}\n\n`)); continue;
              }
              const visible = readableFrame(claims, JSON.parse(data));
              if (visible !== undefined) controller.enqueue(encoder.encode(`${lines.filter(line => !line.startsWith("data:")).join("\n")}\ndata: ${JSON.stringify(visible)}\n\n`));
            }
          }
        })().catch(error => {
          if (!closed) { closed = true; clearTimeout(timer); controller.error(error); void reader.cancel(); }
        });
      },
      cancel(reason) { closed = true; clearTimeout(timer); return reader.cancel(reason); },
    });
    return new Response(stream, { status: response.status, headers });
  }
  const value: any = await response.json();
  const visible = path === "/state" ? { ...value, requests: value.requests.map(readableRequest) }
    : path === "/history" ? readableMessage(claims, value) : value;
  return Response.json(visible, { status: response.status, headers });
}
