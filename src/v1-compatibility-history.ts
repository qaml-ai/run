import { HttpError } from "./core/http-error.ts";
import { FULL_HISTORY_READ_BYTES, PAGE_BYTES, historyPageInput } from "./history-pages.ts";
import { unavailable, unsupportedV1Operation, type MigratedAgent, type V1Compatibility, type V2HistoryMessage } from "./v1-v2-compatibility.ts";

type HistoryMessage = Record<string, unknown> & { role: string };
type Entry = { index: number; message: HistoryMessage };
type Page = { entries: Entry[]; next: number | null; total: number; split?: true; nextAfter?: number; truncated?: true };

/** Preserve the v1 transcript exactly through the boundary. New entries come from the v2 transcript. */
export async function compatibilityHistory(
  compatibility: V1Compatibility,
  route: MigratedAgent,
  query: Parameters<typeof historyPageInput>[0],
  signal: AbortSignal,
): Promise<{ messages: HistoryMessage[] } | Page> {
  const paged = Object.values(query).some(value => value !== undefined);
  const { before, after, limit, maxBytes } = historyPageInput(query);
  const [newest] = await compatibility.historyBatch(route, { before: "latest" }, 1, signal);
  const total = newest?.seq ?? 0;
  const forward = !paged || after !== undefined;
  const start = Math.min(after ?? 0, total);
  const end = Math.min(before ?? total, total);
  const seen = new Map<string, string>();

  async function project({ content, role, runId, createdAt }: V2HistoryMessage): Promise<HistoryMessage> {
    const original = content.meta?.v1;
    if (original && typeof original === "object" && "role" in original && typeof original.role === "string") {
      return original as HistoryMessage;
    }
    if (!runId || content.files?.length) throw unsupportedV1Operation();
    if (role === "user") {
      let requestId = seen.get(runId);
      if (!requestId) {
        requestId = (await compatibility.requestByRunId(route, runId, signal)).id;
        seen.set(runId, requestId);
      }
      return { role, content: content.text ?? "", timestamp: createdAt, requestId };
    }
    const blocks: unknown[] = content.text ? [{ type: "text", text: content.text }] : [];
    if (role === "assistant") {
      for (const { id, name, args } of content.toolCalls ?? []) blocks.push({ type: "toolCall", id, name, arguments: args });
      return { role, content: blocks, timestamp: createdAt };
    }
    if (role === "tool" && content.toolCallId && content.toolName) {
      return { role: "toolResult", content: blocks, timestamp: createdAt, toolCallId: content.toolCallId, toolName: content.toolName, isError: content.isError ?? false };
    }
    throw unsupportedV1Operation();
  }

  async function* read() {
    let cursor = forward ? start : end + 1;
    let expected = forward ? start + 1 : end;
    while (expected > 0 && expected <= total) {
      const messages = await compatibility.historyBatch(route, forward ? { after: cursor } : { before: cursor }, 32, signal);
      if (!messages.length) throw unavailable();
      if (!forward) messages.reverse();
      for (const message of messages) {
        if (message.seq > total && forward) return;
        if (message.seq !== expected) throw unavailable();
        yield message;
        cursor = message.seq;
        expected += forward ? 1 : -1;
      }
    }
  }

  const entries: Entry[] = [];
  let split = false, bytes = 0, boundary = 0;
  for await (const message of read()) {
    const startsTurn = message.seq === 1 || message.role === "user";
    if (paged && forward && startsTurn && entries.length >= limit) break;
    const entry = { index: message.seq - 1, message: await project(message) };
    const nextBytes = bytes + Buffer.byteLength(JSON.stringify(paged ? entry : entry.message)) + (entries.length ? 1 : 0);
    if (!paged && nextBytes > FULL_HISTORY_READ_BYTES) {
      throw new HttpError(413, "This transcript is too large for one read. Read it in pages with limit, before or maxBytes.");
    }
    const first = forward ? entries[0]?.index ?? entry.index : entry.index;
    const last = forward ? entry.index : entries[0]?.index ?? entry.index;
    const envelope = { entries: [], next: first || null, total, split: true, ...(forward ? { nextAfter: last + 1, truncated: true } : {}) };
    if (paged && entries.length && nextBytes + Buffer.byteLength(JSON.stringify(envelope)) > (maxBytes ?? PAGE_BYTES)) {
      if (maxBytes === undefined && boundary) entries.length = boundary;
      else split = forward ? !startsTurn : entries.at(-1)!.message.role !== "user";
      break;
    }
    if (paged && forward && startsTurn) boundary = entries.length;
    entries.push(entry);
    bytes = nextBytes;
    if (paged && !forward && startsTurn) {
      boundary = entries.length;
      if (entries.length >= limit) break;
    }
  }
  if (!paged) return { messages: entries.map(entry => entry.message) };
  if (!forward) entries.reverse();
  const first = entries[0];
  if (forward && first?.index && first.message.role !== "user") split = true;
  return {
    entries, next: first?.index || null, total,
    ...(split ? { split: true } : {}),
    ...(forward ? { nextAfter: (entries.at(-1)?.index ?? start - 1) + 1 } : {}),
    ...(after !== undefined && after > total ? { truncated: true } : {}),
  };
}
