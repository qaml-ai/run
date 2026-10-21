/**
 * What a release with the legacy engine wrote when an operator rolled a session back off Pi (AGENT_ENGINE=legacy):
 * the legacy log rewritten from the native history, then the host generation disabled (`camel.host.disabled`, and the
 * host document's `enabled: false`). The legacy engine then appended its own turns to that log. Sessions left in this
 * state still exist, and this release imports them again.
 */
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, DocumentId, EntryId, JsonObject, Storage } from "@earendil-works/pi-durable";
import type { AppendLog } from "../../shared/append-log.ts";
import type { TranscriptRecord } from "../../src/transcript.ts";
import { nativeTranscriptRecords } from "../../src/pi-durable/transcript.ts";

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

/** What the release that retires the host transcript writes: the host generation disabled, its document `retired`. */
export async function retireHost(storage: Storage) {
  const document = await storage.findDocument(ADDRESS, "current", context);
  const stored = await storage.document(document!.id as DocumentId, "current", context);
  await storage.commit([
    { type: "entry", value: { id: await storage.mintId<EntryId>(), conversationId: 1 as ConversationId, kind: "camel.host.disabled", data: { retired: "journal" } } },
    { type: "document.change", id: document!.id as DocumentId, content: { version: 1, kind: "base", value: { ...stored!.value as JsonObject, enabled: false, retired: "journal" } } },
  ], context);
}
