/** Bounded reconstruction from durable messages; contents may include secrets echoed by tools. */
export const LOG_PAGE_BYTES = 256 * 1024;
export const LOG_ITEM_BYTES = 16 * 1024;
const encoder = new TextEncoder();
export class LogQueryError extends Error { status = 400; code = "INVALID_REQUEST"; }
export function logOptions(query: { get(name: string): string | null }) {
  const after = Number(query.get("cursor") ?? 0), limit = Number(query.get("limit") ?? 50);
  if (!Number.isSafeInteger(after) || after < 0) throw new LogQueryError("cursor must be a nonnegative message index");
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new LogQueryError("limit must be an integer from 1 to 100");
  return { after, limit };
}
function bounded(value: unknown, maxBytes: number) {
  const text = JSON.stringify(value), bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return value;
  return { truncated: true, originalBytes: bytes.length, preview: new TextDecoder().decode(bytes.slice(0, Math.floor(maxBytes / 8))) };
}
export function runLog(run: Record<string, any>, history: { entries: { index: number; message: unknown }[]; total: number; truncated?: true }, options: { after: number; limit: number }) {
  const result: Record<string, any> = {
    run: bounded(run, 32768),
    durationMs: typeof run.startedAt === "number" && typeof run.endedAt === "number" ? run.endedAt - run.startedAt : null,
    events: [],
    ...(history.truncated ? { truncated: true } : {}),
  };
  if (result.run !== run) result.truncated = true;
  let next = options.after;
  let bytes = encoder.encode(JSON.stringify(result)).length + 128;
  for (const entry of history.entries.slice(0, options.limit)) {
    const value = entry.message as Record<string, any>, message = bounded(entry.message, LOG_ITEM_BYTES);
    const event = { index: entry.index, type: "message", at: typeof value?.timestamp === "number" ? value.timestamp : null, message,
      ...(message !== entry.message ? { truncated: true } : {}) };
    const eventBytes = encoder.encode(JSON.stringify(event)).length + 1;
    if (bytes + eventBytes > LOG_PAGE_BYTES) break;
    bytes += eventBytes;
    result.events.push(event);
    if (event.truncated) result.truncated = true;
    next = entry.index + 1;
  }
  if (next < history.total && result.events.length) result.next = String(next);
  return result;
}
