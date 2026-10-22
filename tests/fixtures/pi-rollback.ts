/**
 * What a release with the legacy engine wrote when an operator rolled a session back off Pi (AGENT_ENGINE=legacy):
 * the legacy log rewritten from the native history, then the host generation disabled (`camel.host.disabled`, and the
 * host document's `enabled: false`). The legacy engine then appended its own turns to that log. The current release refuses to start a session in this
 * state, but still reads its history.
 */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, DocumentId, EntryId, JsonObject, Storage } from "@earendil-works/pi-durable";
import type { AppendLog } from "../../shared/append-log.ts";
import { nativeTranscriptRecords, type TranscriptRecord } from "./host-transcript.ts";

const ADDRESS = { kind: "camel.host.snapshot", scope: { kind: "session" as const } };

export async function rollBack(storage: Storage, log: AppendLog<TranscriptRecord>) {
  const records = await nativeTranscriptRecords(storage);
  if (!records) throw new Error("The session has no host generation to roll back");
  await log.rewrite(() => records);
  await disableGeneration(storage);
}

/** The rollback's last step alone: the host generation disabled, its legacy log left as it is. */
export async function disableGeneration(storage: Storage) {
  const document = await storage.findDocument(ADDRESS, "current", context);
  const stored = await storage.document(document!.id as DocumentId, "current", context);
  await storage.commit([
    { type: "entry", value: { id: await storage.mintId<EntryId>(), conversationId: 1 as ConversationId, kind: "camel.host.disabled" } },
    { type: "document.change", id: document!.id as DocumentId, content: { version: 1, kind: "base", value: { ...stored!.value as JsonObject, enabled: false } } },
  ], context);
}

