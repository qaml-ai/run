import type { AgentEvent, ByteStreamLike } from "./types.ts";

export interface SSEMessage { id?: string; event: string; data: string; }

const TERMINAL_TYPES = new Set([
  "run.completed", "run_completed", "completed",
  "run.failed", "run_failed", "failed",
  "run.cancelled", "run_cancelled", "cancelled", "run.aborted", "run_aborted", "aborted",
  "run.input_required", "run_input_required", "input_required", "done",
]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "input_required"]);

export function normalizeAgentEvent(raw: unknown, sseId?: string, sseEvent?: string): AgentEvent {
  const numId = sseId ? Number(sseId) : 0;
  const fallbackSeq = Number.isFinite(numId) ? numId : 0;
  if (!raw || typeof raw !== "object") {
    return { seq: fallbackSeq, type: sseEvent && sseEvent !== "message" ? sseEvent : "message", data: raw };
  }
  const obj = raw as Record<string, unknown>;
  const inner = obj.type === "event" && obj.event && typeof obj.event === "object"
    ? (obj.event as Record<string, unknown>) : null;
  const rawData = inner?.data ?? obj.data;
  const dataFields = rawData && typeof rawData === "object" && !Array.isArray(rawData)
    ? (rawData as Record<string, unknown>) : null;
  const seq = typeof obj.seq === "number" ? obj.seq : typeof inner?.seq === "number" ? inner.seq : fallbackSeq;
  const runId = (obj.runId ?? inner?.runId ?? null) as string | null;
  const resolvedType = typeof inner?.type === "string"
    ? inner.type
    : typeof obj.event === "string" && (!obj.type || obj.type === "event")
      ? obj.event
      : typeof obj.type === "string" && obj.type !== "event"
        ? obj.type
        : sseEvent && sseEvent !== "message" ? sseEvent : typeof obj.type === "string" ? obj.type : "event";
  return { ...(dataFields ?? {}), ...(inner ?? {}), ...obj, seq, runId, type: resolvedType };
}

export function isTerminalAgentEvent(ev: AgentEvent): boolean {
  if (TERMINAL_TYPES.has(ev.type)) return true;
  const dataStatus = ev.data && typeof ev.data === "object" ? (ev.data as Record<string, unknown>).status : undefined;
  const st = typeof ev.status === "string" ? ev.status : typeof dataStatus === "string" ? dataStatus : undefined;
  return st !== undefined && TERMINAL_STATUSES.has(st);
}

export async function* parseSSE(stream: ByteStreamLike, signal?: AbortSignal): AsyncGenerator<SSEMessage, void, void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let eventName = "message";
  let eventId: string | undefined;
  let dataLines: string[] = [];

  const onAbort = () => { void reader.cancel?.().catch(() => {}); };
  signal?.addEventListener("abort", onAbort, { once: true });

  const flush = (): SSEMessage | null => {
    if (dataLines.length === 0) { eventName = "message"; return null; }
    const msg: SSEMessage = { id: eventId, event: eventName, data: dataLines.join("\n") };
    eventName = "message";
    dataLines = [];
    return msg;
  };

  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        let line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") { const msg = flush(); if (msg) yield msg; continue; }
        if (line.startsWith(":")) continue;

        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let val = colon === -1 ? "" : line.slice(colon + 1);
        if (val.startsWith(" ")) val = val.slice(1);
        if (field === "event") eventName = val || "message";
        else if (field === "data") dataLines.push(val);
        else if (field === "id" && !val.includes("\0")) eventId = val;
      }
    }
    buffer += decoder.decode();
    if (buffer.startsWith("data:")) {
      const val = buffer.endsWith("\r") ? buffer.slice(5, -1) : buffer.slice(5);
      dataLines.push(val.startsWith(" ") ? val.slice(1) : val);
    }
    const tail = flush();
    if (tail) yield tail;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try { await reader.cancel?.(); } catch {}
    try { reader.releaseLock(); } catch {}
  }
}

export async function* streamAgentEvents(stream: ByteStreamLike, signal?: AbortSignal): AsyncGenerator<AgentEvent, void, void> {
  for await (const msg of parseSSE(stream, signal)) {
    if (!msg.data || msg.data === "[DONE]") continue;
    try { yield normalizeAgentEvent(JSON.parse(msg.data) as unknown, msg.id, msg.event); }
    catch { yield normalizeAgentEvent(msg.data, msg.id, msg.event); }
  }
}
