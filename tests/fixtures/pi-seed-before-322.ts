/**
 * The layout of an import before #322: the seed marker, the archive as `camel.legacy.record` blocks and the context
 * checkpoint, with no host generation (the host adopted the session into one of its own when it next opened it).
 * Readers still read it; no release writes it.
 */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord";
import type { EntryId, Storage, StorageWrite } from "@earendil-works/pi-durable";
import { convertToLlm } from "../../src/pi-harness/messages.ts";
import { contextWrites, SEED_MARKER_KIND, SEED_RECORD_KIND, SESSION_CONVERSATION_ID as conversationId, type SeedMetadata } from "../../src/pi-durable/seed.ts";
import { copyFingerprint, reducedTranscript, type TranscriptRecord } from "./host-transcript.ts";

export async function seedWithoutGeneration(storage: Storage, sessionId: string, records: TranscriptRecord[]): Promise<SeedMetadata> {
  const source = reducedTranscript(records);
  const { context: _context, piCursor: _cursor, ...state } = source.snapshot();
  const model = [...(source.system ? [source.system] : []), ...convertToLlm(source.view())];
  const fingerprint = copyFingerprint(records)!;
  const blocks = Math.ceil(records.length / 128), contextIds = Math.max(1, model.length);
  const ids: number[] = [];
  for (let index = 0; index < 1 + blocks + contextIds + state.requests.length; index++) ids.push(await storage.mintId());
  let next = 0;
  const markerId = ids[next++] as EntryId, contextEntryId = ids[1 + blocks] as EntryId;
  const metadata: SeedMetadata = { version: 1, sessionId, fingerprint, conversationId, recordCount: records.length, historyCount: source.total,
    contextCount: model.length, importedAt: Date.now(), markerId, contextEntryId };
  const writes: StorageWrite[] = [
    { type: "conversation", value: { id: conversationId } },
    { type: "entry", value: { id: markerId, conversationId, kind: SEED_MARKER_KIND, data: metadata as unknown as JsonValue } },
  ];
  for (let index = 0; index < records.length; index += 128) writes.push({ type: "entry", value: { id: ids[next++] as EntryId, conversationId, kind: SEED_RECORD_KIND,
    data: { index, records: records.slice(index, index + 128) } as unknown as JsonValue } });
  writes.push(...contextWrites(ids.slice(next, next += contextIds), conversationId, model, JSON.parse(JSON.stringify({ fingerprint, state }))));
  for (const requestId of state.requests) writes.push({ type: "submission", value: { id: ids[next++] as never, conversationId, requestId, type: "input", status: "unanswered", reason: "legacy_import" } });
  await storage.commit(writes, () => {}, context);
  return metadata;
}
