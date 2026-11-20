import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { HistoryPage } from "../../clients/typescript.ts";
import { fetchWithoutRedirects } from "../../src/core/no-redirect.ts";
import { CamelRun, type AgentHandle, type V1HistoryImport } from "../sdk/src/index.ts";

export async function readV1History(v1Url: string, v1Key: string, sourceAgent: string) {
  const url = new URL(`/v1/agents/${encodeURIComponent(sourceAgent)}/history`, v1Url);
  const source = url.href;
  const messages: unknown[] = [];
  let total: number | undefined;
  for (;;) {
    url.searchParams.set("after", String(messages.length));
    url.searchParams.set("limit", "100");
    const response = await fetchWithoutRedirects(fetch, url, {
      headers: { Authorization: `Bearer ${v1Key}` }, signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`v1 history request failed with HTTP ${response.status}`);
    const page = await response.json() as HistoryPage;
    total ??= page.total;
    if (page.truncated || page.total !== total) throw new Error("The v1 history changed during the copy or has a gap");
    for (const { index, message } of page.entries) {
      if (index !== messages.length) throw new Error(`Missing v1 message ${messages.length}`);
      messages.push(message);
    }
    if (messages.length === total && page.entries.length === 0) break;
    if (!page.entries.length || page.nextAfter !== messages.length || messages.length > total) {
      throw new Error("The v1 history cursor did not advance as expected");
    }
  }
  return { source, messages };
}

export async function migrateHistory(
  v1Url: string,
  v1Key: string,
  sourceAgent: string,
  target: AgentHandle,
  previous?: string,
  attachments?: V1HistoryImport["attachments"],
  chunked = false,
) {
  const input = { ...await readV1History(v1Url, v1Key, sourceAgent), previous, attachments };
  return chunked ? importHistoryInChunks(target, input) : target.importV1History(input);
}

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

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { attachments: { type: "string" }, chunked: { type: "boolean" } },
  });
  const [sourceAgent, destinationAgent, previous, ...extra] = positionals;
  if (!sourceAgent || !destinationAgent || extra.length) {
    throw new Error("Usage: node --experimental-strip-types v2/scripts/migrate-history.ts <v1-agent> <v2-agent> [previous-receipt | --chunked] [--attachments manifest.json]");
  }
  const v2 = new CamelRun({ baseUrl: env("V2_URL"), apiKey: env("V2_API_KEY") });
  try {
    const destination = await v2.agents.get(destinationAgent);
    const attachments: V1HistoryImport["attachments"] = values.attachments
      ? JSON.parse(await readFile(values.attachments, "utf8"))
      : undefined;
    console.log(JSON.stringify(await migrateHistory(env("V1_URL"), env("V1_API_KEY"), sourceAgent,
      destination, previous, attachments, values.chunked)));
  } finally {
    await v2.close();
  }
}
