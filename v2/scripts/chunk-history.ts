import type { AgentHandle, V1HistoryImport } from "../sdk/src/index.ts";

// Keep each Worker request small even when the source archive spans many pages.
const HISTORY_CHUNK_BYTES = 1024 * 1024;

export async function importHistoryInChunks(
  target: Pick<AgentHandle, "importV1History">,
  input: V1HistoryImport,
) {
  if (input.previous !== undefined || input.appendAfter !== undefined) {
    throw new Error("Chunked copy requires a fresh private destination");
  }
  if (!input.messages.length) return target.importV1History(input);

  const attachments = new Map<number, NonNullable<V1HistoryImport["attachments"]>[number]["files"]>();
  for (const { messageIndex, files } of input.attachments ?? []) {
    if (!Number.isSafeInteger(messageIndex) || messageIndex < 0 ||
        messageIndex >= input.messages.length || attachments.has(messageIndex)) {
      throw new Error(`Invalid attachment index ${messageIndex}`);
    }
    attachments.set(messageIndex, files);
  }

  const chunks: V1HistoryImport[] = [];
  const baseBytes = Buffer.byteLength(JSON.stringify(input.source)) + 256;
  let chunk: V1HistoryImport = { source: input.source, appendAfter: 0, messages: [], attachments: [] };
  let chunkBytes = baseBytes;
  for (let start = 0; start < input.messages.length;) {
    let end = start + 1;
    while ((input.messages[end] as { role?: unknown } | undefined)?.role === "toolResult") end++;
    const group = input.messages.slice(start, end);
    const groupBytes = group.reduce<number>((bytes, message, index) => {
      const files = attachments.get(start + index);
      return bytes + Buffer.byteLength(JSON.stringify(message)) + 1 +
        (files ? Buffer.byteLength(JSON.stringify(files)) + 48 : 0);
    }, 0);
    if (baseBytes + groupBytes > HISTORY_CHUNK_BYTES) {
      throw new Error(`V1 history messages ${start}–${end - 1} exceed the chunk size as a single group`);
    }
    if (chunk.messages.length && chunkBytes + groupBytes > HISTORY_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = { source: input.source, appendAfter: start, messages: [], attachments: [] };
      chunkBytes = baseBytes;
    }
    for (let index = start; index < end; index++) {
      const files = attachments.get(index);
      if (files) chunk.attachments!.push({ messageIndex: chunk.messages.length, files });
      chunk.messages.push(input.messages[index]);
    }
    chunkBytes += groupBytes;
    start = end;
  }
  chunks.push(chunk);

  let receipt: string | undefined;
  for (const chunk of chunks) {
    const previous = receipt;
    const result = await target.importV1History({ ...chunk, previous });
    if (!/^[0-9a-f]{64}$/.test(result.receipt) || result.count !== chunk.appendAfter! + chunk.messages.length) {
      throw new Error(`Incomplete receipt at v1 history offset ${chunk.appendAfter}`);
    }
    receipt = result.receipt;
  }
  return { receipt: receipt!, count: input.messages.length };
}
