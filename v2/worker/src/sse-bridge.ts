import { FRAME_BYTES } from "../../../shared/client-protocol.ts";
import type { AgentDO } from "./agent-do.ts";
import { ApiError, extractApiError, type AgentEventRecord, type RpcStub } from "./types.ts";

const encoder = new TextEncoder();
const terminalEvents = new Set(["run_completed", "run_failed", "run_cancelled", "input_required"]);

interface EventStreamOptions {
  after: number;
  runId: string | null;
  follow: boolean;
}

/** Keep the SSE response and heartbeat in the front Worker. Use RPC and a hibernatable socket to read the agent. */
export async function bridgeEvents(stub: RpcStub<AgentDO>, { after, runId, follow }: EventStreamOptions, signal: AbortSignal): Promise<Response> {
  const upstream = await stub.fetch("https://agent.internal/ws", { headers: { Upgrade: "websocket" } });
  if (!upstream.ok && upstream.status !== 101) return upstream;
  const socket = upstream.webSocket;
  if (upstream.status !== 101 || !socket) throw new ApiError(502, "events_upgrade_failed", "Agent did not open an event WebSocket");

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let ended = false;
  let cursor = after;
  let queuedBytes = 0;
  let duringReplay: Array<{ event: AgentEventRecord; bytes: Uint8Array }> | undefined = [];
  const finish = (error?: unknown) => {
    if (ended) return;
    ended = true;
    clearInterval(heartbeat);
    signal.removeEventListener("abort", abort);
    duringReplay = undefined;
    void (error ? writer.abort(error) : writer.close()).catch(() => {});
    try { socket.close(1000, "Stream closed"); } catch {}
  };
  const abort = () => finish(signal.reason);
  const encode = (event: AgentEventRecord) => encoder.encode(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

  function writeLive(event: AgentEventRecord, bytes: Uint8Array) {
    if (ended) return;
    if (event.seq > cursor) {
      cursor = event.seq;
      queuedBytes += bytes.byteLength;
      void writer.write(bytes).then(() => { queuedBytes -= bytes.byteLength; }, finish);
    }
    if (runId && terminalEvents.has(event.type)) finish();
  }

  socket.addEventListener("message", ({ data }) => {
    if (ended) return;
    try {
      const frame = JSON.parse(String(data)) as {
        type: string; runId: string | null; seq: number; event: Omit<AgentEventRecord, "runId" | "seq">;
      };
      if (frame.type !== "event" || (runId && frame.runId !== runId)) return;
      const event = { seq: frame.seq, runId: frame.runId, ...frame.event };
      const bytes = encode(event);
      // Match the pilot bridge's backlog budget and allow a single larger event while the writer is ready.
      if (queuedBytes && queuedBytes + bytes.byteLength > 2 * FRAME_BYTES) {
        finish(new Error("Event subscriber is too slow"));
        return;
      }
      if (duringReplay) {
        duringReplay.push({ event, bytes });
        queuedBytes += bytes.byteLength;
      } else {
        writeLive(event, bytes);
      }
    } catch (error) {
      finish(error);
    }
  });
  socket.addEventListener("close", ({ code }) => finish(new Error(`Agent event WebSocket closed (${code})`)));
  socket.addEventListener("error", () => finish(new Error("Agent event WebSocket failed")));
  void writer.closed.catch(finish);
  socket.accept();

  async function replay() {
    await writer.write(encoder.encode(": connected\n\n"));
    const run = runId ? await stub.getRun(runId).catch((error: unknown) => {
      if (extractApiError(error)?.status === 404) return null;
      throw error;
    }) : null;
    const replayOnly = runId
      ? run !== null && run.status !== "running" && run.status !== "queued"
      : !follow && (await stub.getState()).activeRunId === null;
    // Subscribe first, then read through a stable high-water mark. The socket may also
    // have sent some of these records, so discard those copies when draining its buffer.
    const { nextAfter: head } = await stub.getEvents({ after: "latest", runId });
    while (!ended && cursor < head) {
      const { events } = await stub.getEvents({ after: cursor, runId });
      const previous = cursor;
      for (const event of events) {
        if (event.seq > head) break;
        await writer.write(encode(event));
        cursor = event.seq;
      }
      if (cursor === previous) throw new Error("Agent event replay did not advance");
    }
    if (ended) return;
    if (replayOnly) return finish();
    const buffered = duringReplay!;
    duringReplay = undefined;
    for (const { event, bytes } of buffered) {
      queuedBytes -= bytes.byteLength;
      writeLive(event, bytes);
    }
  }

  heartbeat = setInterval(() => {
    if (queuedBytes === 0 && writer.desiredSize !== null && writer.desiredSize >= 0) {
      void writer.write(encoder.encode(": heartbeat\n\n")).catch(finish);
    }
  }, 10_000);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  else void replay().catch(finish);
  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
