import { setTimeout as delay } from "node:timers/promises";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { FRAME_BYTES, type ClientEvent, type RequestRecord, type TurnSnapshot } from "../shared/client-protocol.ts";
import { parseSSE } from "../v2/sdk/src/sse.ts";
import { MAX_POLL_WAIT_MS, type StreamReader } from "./client-sessions/events.ts";
import { HttpError } from "./core/http-error.ts";
import { unsupportedV1Operation, v2Event, type MigratedAgent, type V1Compatibility, type V2Event } from "./v1-v2-compatibility.ts";

const terminal = new Set(["run_completed", "run_failed", "run_cancelled", "input_required"]);
const progress = new Set(["run_started", "text_delta", "tool_call_start", "tool_call_end"]);

/** Replay and follow the v2 event buffer in the v1 cursor namespace. */
export async function compatibilityEvents(c: Context, compatibility: V1Compatibility, route: MigratedAgent, reader?: StreamReader) {
  if (c.req.query("subagents") === "1") throw unsupportedV1Operation();
  const raw = c.req.header("last-event-id") ?? "0";
  const last = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(last)) throw new HttpError(400, "Invalid event cursor");
  const wait = Number(c.req.query("wait") ?? 0);
  if (!Number.isFinite(wait) || wait < 0) throw new HttpError(400, "wait is a number of seconds");

  const browserExpiry = reader && Number.isFinite(reader.until) ? AbortSignal.timeout(Math.max(0, reader.until - Date.now())) : undefined;
  const signal = browserExpiry ? AbortSignal.any([c.req.raw.signal, browserExpiry]) : c.req.raw.signal;
  const latest = await compatibility.eventPage(route, "latest", signal);
  const gap = last !== 0 && (last < route.event_base || last > route.event_base + latest.nextAfter);
  if (gap && c.req.query("snapshot") === "0") throw new HttpError(409, "REPLAY_GAP: recover from session state", "REPLAY_GAP");
  const after = gap || last === 0 ? 0 : last - route.event_base;
  // The source was idle when the route published. Replaying from that boundary reconstructs the v2 events.
  const snapshot: TurnSnapshot | undefined = (gap || last === 0) && c.req.query("snapshot") !== "0"
    ? { type: "snapshot", cursor: route.event_base, requestId: null, turn: null } : undefined;
  const filter = c.req.query("request");
  const known = new Map<string, string>();

  function show(event: ClientEvent) {
    return reader ? reader.show(event) : event;
  }

  async function frame(event: V2Event, signal: AbortSignal): Promise<ClientEvent | undefined> {
    if (!event.runId || (!terminal.has(event.type) && !progress.has(event.type))) return;
    let requestId = known.get(event.runId);
    let record: RequestRecord | undefined;
    if (!requestId || terminal.has(event.type)) {
      record = await compatibility.requestByRunId(route, event.runId, signal);
      requestId = record.id;
      if (known.size >= 64) known.delete(known.keys().next().value!);
      known.set(event.runId, requestId);
    }
    if (filter !== undefined && requestId !== filter) return;
    const data = event.data;
    switch (event.type) {
      case "run_started":
        return { type: "event", requestId, event: { type: "agent_start" } };
      case "text_delta":
        return { type: "event", requestId, event: {
          type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: data.delta },
        } };
      case "tool_call_start":
        return { type: "event", requestId, event: { type: "tool_execution_start", toolCallId: data.callId, toolName: data.name, args: data.args } };
      case "tool_call_end":
        return { type: "event", requestId, event: { type: "tool_execution_end", toolCallId: data.callId, toolName: data.name, isError: !data.ok } };
      default: {
        // A paused run can resume before this buffered event is read. Its terminal outcome
        // is due only once the new state is terminal too.
        return record?.outcome ? { type: "response", id: requestId, outcome: record.outcome } : undefined;
      }
    }
  }

  if (c.req.query("poll") === "1") {
    const deadline = Date.now() + Math.min(wait * 1000, MAX_POLL_WAIT_MS);
    let cursor = after;
    const frames: Array<{ id: number; data: unknown }> = [];
    if (snapshot) frames.push({ id: snapshot.cursor, data: show(snapshot) });
    for (;;) {
      const page = await compatibility.eventPage(route, cursor, signal);
      for (const event of page.events) {
        const projected = await frame(event, signal);
        const data = projected && show(projected);
        if (data !== undefined) frames.push({ id: route.event_base + event.seq, data });
      }
      cursor = page.nextAfter;
      const remaining = deadline - Date.now();
      if (frames.length || remaining <= 0 || signal.aborted) {
        return c.json({ cursor: route.event_base + cursor, events: frames.filter(event => event.data !== undefined) }, 200, { "Cache-Control": "no-store" });
      }
      await delay(Math.min(remaining, 500), undefined, { signal });
    }
  }

  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    const upstream = await compatibility.eventStream(route, after, controller);
    c.header("X-Accel-Buffering", "no");
    c.header("Cache-Control", "no-store, no-transform");
    return streamSSE(c, async stream => {
      stream.onAbort(() => controller.abort());
      let writingHeartbeat = false;
      const heartbeat = setInterval(() => {
        if (writingHeartbeat) return;
        writingHeartbeat = true;
        void stream.write(": heartbeat\n\n").catch(() => controller.abort()).finally(() => { writingHeartbeat = false; });
      }, 10_000);
      async function write(event: ClientEvent, id: number) {
        const data = show(event);
        if (data === undefined) return;
        const encoded = JSON.stringify(data);
        if (Buffer.byteLength(encoded) > FRAME_BYTES) throw new Error("Projected v1 event is too large");
        await stream.writeSSE({ id: String(id), data: encoded });
      }
      try {
        await stream.writeSSE({ event: "ready", data: JSON.stringify({ version: 5, agentId: route.agent, watch: true }) });
        if (snapshot) await write(snapshot, snapshot.cursor);
        for await (const message of parseSSE(upstream, controller.signal)) {
          const event = v2Event.parse(JSON.parse(message.data));
          const projected = await frame(event, controller.signal);
          if (projected) await write(projected, route.event_base + event.seq);
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      } finally {
        clearInterval(heartbeat);
        signal.removeEventListener("abort", abort);
        controller.abort();
      }
    });
  } catch (error) {
    signal.removeEventListener("abort", abort);
    controller.abort();
    throw error;
  }
}
