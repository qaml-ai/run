import { createHash } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, SystemMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ConversationId, Cursor, EntryId, EntryRecord, Storage, StorageWrite } from "@earendil-works/pi-durable";
import type { AppendLog } from "../../shared/append-log.ts";
import { convertToLlm } from "../pi-harness/messages.ts";
import { Transcript, type TranscriptRecord, type TranscriptSnapshot } from "../transcript.ts";

export const LEGACY_MIGRATION_KIND = "camel.legacy.migration";
export const LEGACY_RECORD_KIND = "camel.legacy.record";
export const LEGACY_CONTEXT_KIND = "camel.legacy.context";
/** Each Camel session has its own fenced Pi storage, so it uses Pi's reserved root. */
export const LEGACY_CONVERSATION_ID = 1 as ConversationId;
const VERSION = 1;
const PAGE_SIZE = 256;
const ARCHIVE_BLOCK_RECORDS = 128;
/** Automatic migration is intentionally small. Larger sessions stay on the legacy engine. */
export const MIGRATION_MAX_BYTES = 64 * 1024 * 1024;
export const MIGRATION_MAX_RECORDS = 200_000;

export function assertMigrationFits(records: readonly TranscriptRecord[]) {
  if (records.length > MIGRATION_MAX_RECORDS) throw migrationTooLarge();
  let bytes = 0;
  for (const record of records) {
    bytes += Buffer.byteLength(JSON.stringify(record)) + 1;
    if (bytes > MIGRATION_MAX_BYTES) throw migrationTooLarge();
  }
}

function migrationTooLarge() {
  return new LegacyMigrationDeferred("size_limit", "automatic import exceeds its size budget or storage cannot guarantee a bounded read");
}

/** Refuse oversized sources before full-read/IPC allocations and before any Pi writes. */
export async function readMigrationRecords(log: AppendLog<TranscriptRecord>): Promise<TranscriptRecord[]> {
  const records = await log.readBounded?.(MIGRATION_MAX_BYTES);
  if (!records) throw migrationTooLarge();
  assertMigrationFits(records);
  return records;
}

export interface LegacyMigrationMetadata {
  version: 1;
  sessionId: string;
  fingerprint: string;
  conversationId: ConversationId;
  recordCount: number;
  historyCount: number;
  contextCount: number;
  importedAt: number;
  markerId: EntryId;
  contextEntryId: EntryId;
}

export interface LegacyMigrationPlan {
  records: TranscriptRecord[];
  snapshot: TranscriptSnapshot;
  model: Message[];
  fingerprint: string;
  historyCount: number;
}

/** A session that still has old execution state stays on the old engine. No tool is replayed by an import. */
export class LegacyMigrationDeferred extends Error {
  readonly reason: "active" | "awaiting" | "context_changed" | "size_limit";
  constructor(reason: LegacyMigrationDeferred["reason"], detail: string) {
    super(`Legacy session migration deferred: ${detail}`);
    this.name = "LegacyMigrationDeferred";
    this.reason = reason;
  }
}

/** Already imported storage belongs to one original session and one immutable source generation. */
export class LegacyMigrationConflict extends Error {
  constructor(detail: string) {
    super(`Legacy session migration conflict: ${detail}`);
    this.name = "LegacyMigrationConflict";
  }
}

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const payload = (value: unknown): JsonValue => json(value) as JsonValue;

/** Hash individual persisted records, avoiding a second archive-sized JSON string. */
export function legacyTranscriptFingerprint(records: readonly TranscriptRecord[]): string {
  const hash = createHash("sha256");
  for (const record of records) hash.update(JSON.stringify(record)).update("\n");
  return hash.digest("hex");
}

function reduced(records: readonly TranscriptRecord[]) {
  // Reduction does not write: the source log and all of its ownership/fencing stay with the host.
  const log = { read: async () => [...records] } as AppendLog<TranscriptRecord>;
  const transcript = new Transcript(log);
  for (const record of records) transcript.apply(record);
  return transcript;
}

/** Exact effective history, including opaque sender, provider signatures, usage, and custom fields. */
export function legacyHistoryOf(records: readonly TranscriptRecord[]): AgentMessage[] {
  let history: AgentMessage[] = [];
  for (const record of records) {
    if (record.t === "message") history.push(record.message);
    else if (record.t === "retract") history.pop();
    else if (record.t === "reset") history = [...record.messages];
  }
  return history;
}

/**
 * Pi deliberately normalizes tool-result order and omits failed assistant messages. A migration must not silently
 * change an old active context: defer these unusual shapes to the legacy engine instead. This mirrors the stable
 * context invariants, rather than repairing or executing unfinished calls as part of migration.
 */
function assertCompatibleContext(messages: readonly Message[]) {
  const ordered: Message[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "toolResult") continue;
    if (message.role === "assistant" && ["error", "aborted", "deferred"].includes(message.stopReason)) {
      throw new LegacyMigrationDeferred("context_changed", "active context includes an excluded assistant response");
    }
    ordered.push(message);
    if (message.role !== "assistant") continue;
    for (const call of message.content.filter(part => part.type === "toolCall")) {
      let result: Message | undefined;
      for (let next = index + 1; next < messages.length && messages[next].role !== "assistant"; next++) {
        const candidate = messages[next];
        if (candidate.role === "toolResult" && candidate.toolCallId === call.id) { result = candidate; break; }
      }
      if (!result) throw new LegacyMigrationDeferred("context_changed", `tool call ${call.id} has no durable result`);
      ordered.push(result);
    }
  }
  const firstSystem = ordered.findIndex(message => message.role === "system");
  if (firstSystem > 0 && ordered.slice(0, firstSystem).every(message => message.role === "user")) {
    ordered.unshift(...ordered.splice(firstSystem, 1));
  }
  if (!same(messages, ordered)) throw new LegacyMigrationDeferred("context_changed", "Pi would reorder the active model context");
}

/** A detached, side-effect-free conversion. It never mutates or folds the original archive. */
export function planLegacyMigration(records: readonly TranscriptRecord[], leadingSystem?: SystemMessage): LegacyMigrationPlan {
  const detached = records.map(record => json(record));
  const transcript = reduced(detached);
  if (transcript.active) throw new LegacyMigrationDeferred("active", "the legacy turn is still active");
  if (transcript.awaiting.length) throw new LegacyMigrationDeferred("awaiting", "a tool is waiting for human input");
  const snapshot = json(transcript.snapshot());
  // Native entry IDs are scoped to their storage. Fork/import archives retain the old cursor as evidence, but the
  // new storage starts a new projection domain and must not skip entries because of an ancestor's high watermark.
  delete snapshot.piCursor;
  if (!snapshot.system && leadingSystem) snapshot.system = json(leadingSystem);
  const model = [
    ...(snapshot.system ? [snapshot.system] : []),
    ...convertToLlm(transcript.view()),
  ];
  assertCompatibleContext(model);
  return { records: detached, snapshot, model, fingerprint: legacyTranscriptFingerprint(detached), historyCount: transcript.total };
}

async function entries(storage: Storage, conversationId: ConversationId, context: Context, minEntryId?: EntryId) {
  const all: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanEntries({ conversationId, order: "ascending", ...(minEntryId === undefined ? {} : { minEntryId }) }, PAGE_SIZE, cursor, context);
    all.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return all;
}

/** O(1) archive-independent lookup: the migration marker is always the first entry. */
export async function loadLegacyMigration(storage: Storage, context: Context = BACKGROUND_CONTEXT): Promise<LegacyMigrationMetadata | undefined> {
  if (!await storage.conversation(LEGACY_CONVERSATION_ID, context)) return undefined;
  const first = (await storage.scanEntries({ conversationId: LEGACY_CONVERSATION_ID, order: "ascending" }, 1, undefined, context)).items[0];
  if (!first || first.kind !== LEGACY_MIGRATION_KIND) throw new LegacyMigrationConflict("Pi root contains data without a Camel migration marker");
  const metadata = first.data as unknown as LegacyMigrationMetadata;
  if (metadata?.version !== VERSION || metadata.markerId !== first.id || metadata.conversationId !== LEGACY_CONVERSATION_ID) {
    throw new LegacyMigrationConflict("unsupported or malformed migration marker");
  }
  return json(metadata);
}

/** Read only the reduced checkpoint, never the archived transcript bodies. */
export async function loadMigratedSnapshot(storage: Storage, conversationId: ConversationId = LEGACY_CONVERSATION_ID, context: Context = BACKGROUND_CONTEXT): Promise<{ snapshot: TranscriptSnapshot; metadata: LegacyMigrationMetadata } | undefined> {
  const metadata = await loadLegacyMigration(storage, context);
  if (!metadata) return undefined;
  if (metadata.conversationId !== conversationId) throw new LegacyMigrationConflict("conversation mapping differs from the migration marker");
  const record = await storage.entry(conversationId, metadata.contextEntryId, context);
  if (!record || record.entry.kind !== LEGACY_CONTEXT_KIND) throw new LegacyMigrationConflict("migration context checkpoint is missing");
  const data = record.entry.data as unknown as { snapshot: TranscriptSnapshot; fingerprint: string };
  if (!data?.snapshot || data.fingerprint !== metadata.fingerprint) throw new LegacyMigrationConflict("migration context checkpoint does not match its marker");
  return { snapshot: json(data.snapshot), metadata };
}

const lines = new WeakMap<Storage, Promise<unknown>>();

/**
 * Import while the host holds the session's exclusive claim, before opening its Harness. The original source is
 * retained by the host and also archived verbatim as non-model entries. One commit publishes every record, request
 * deduplication key, and the context head together. A failed commit publishes no partial conversation. No task is
 * created, resumed, settled, or retried by this function. The host changes its engine selector only after validation.
 */
export async function importLegacyTranscript(options: {
  storage: Storage;
  sessionId: string;
  records: readonly TranscriptRecord[];
  leadingSystem?: SystemMessage;
  context?: Context;
  now?: number;
}): Promise<LegacyMigrationMetadata & { status: "imported" | "existing" }> {
  const { storage, sessionId, records, leadingSystem, context = BACKGROUND_CONTEXT, now = Date.now() } = options;
  if (!sessionId) throw new TypeError("A migration needs the existing public session ID");
  const run = (lines.get(storage) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const previous = await loadLegacyMigration(storage, context);
    if (previous) {
      if (previous.sessionId !== sessionId || previous.fingerprint !== legacyTranscriptFingerprint(records)) {
        throw new LegacyMigrationConflict("storage belongs to another session or source transcript");
      }
      await loadMigratedSnapshot(storage, previous.conversationId, context);
      return { ...previous, status: "existing" as const };
    }
    assertMigrationFits(records);
    const plan = planLegacyMigration(records, leadingSystem);
    const blockCount = Math.ceil(plan.records.length / ARCHIVE_BLOCK_RECORDS);
    // Postgres reserves the complete monotonic range under the host's claim in one transaction. Native SQLite mints
    // from its in-memory allocator. Both retain the storage's global ID-ownership checks in the final atomic commit.
    const count = blockCount + 2 + plan.snapshot.requests.length;
    const bulk = storage as Storage & { mintIds?(count: number): Promise<number[]> };
    const ids = bulk.mintIds ? await bulk.mintIds(count) : await (async () => {
      const ids: number[] = [];
      for (let index = 0; index < count; index++) ids.push(await storage.mintId());
      return ids;
    })();
    if (ids.length !== count || ids.some((id, index) => !Number.isSafeInteger(id) || id <= 1 || index > 0 && id <= ids[index - 1])) {
      throw new LegacyMigrationConflict("storage returned an invalid ID reservation");
    }
    let nextId = 0;
    const markerId = ids[nextId++] as EntryId;
    const archive: EntryRecord[] = [];
    for (let index = 0; index < plan.records.length; index += ARCHIVE_BLOCK_RECORDS) {
      // The plan already owns detached records. Reuse their bodies instead of copying the entire archive again.
      archive.push({ id: ids[nextId++] as EntryId, conversationId: LEGACY_CONVERSATION_ID, kind: LEGACY_RECORD_KIND,
        data: { index, records: plan.records.slice(index, index + ARCHIVE_BLOCK_RECORDS) } as unknown as JsonValue });
    }
    const contextEntryId = ids[nextId++] as EntryId;
    const metadata: LegacyMigrationMetadata = {
      version: VERSION, sessionId, fingerprint: plan.fingerprint, conversationId: LEGACY_CONVERSATION_ID,
      recordCount: plan.records.length, historyCount: plan.historyCount, contextCount: plan.model.length,
      importedAt: now, markerId, contextEntryId,
    };
    const writes: StorageWrite[] = [
      { type: "conversation", value: { id: LEGACY_CONVERSATION_ID } },
      { type: "entry", value: { id: markerId, conversationId: LEGACY_CONVERSATION_ID, kind: LEGACY_MIGRATION_KIND, data: payload(metadata) } },
      ...archive.map(value => ({ type: "entry" as const, value })),
      { type: "entry", value: { id: contextEntryId, conversationId: LEGACY_CONVERSATION_ID, kind: LEGACY_CONTEXT_KIND, head: contextEntryId, model: plan.model, data: payload({ fingerprint: plan.fingerprint, snapshot: plan.snapshot }) } },
    ];
    // Import historical request IDs as terminal admissions. Retrying one must never start a new model/tool run.
    for (const requestId of plan.snapshot.requests) writes.push({
      type: "submission",
      value: { id: ids[nextId++] as never, conversationId: LEGACY_CONVERSATION_ID, requestId, type: "input", status: "unanswered", reason: "legacy_import", detail: "Request already recorded by the legacy runtime; its original history is retained." },
    });
    await storage.commit(writes, context);
    const checkpoint = await loadMigratedSnapshot(storage, LEGACY_CONVERSATION_ID, context);
    if (!checkpoint || !same(checkpoint.snapshot, plan.snapshot)) throw new LegacyMigrationConflict("persisted reduced state differs from the source");
    return { ...metadata, status: "imported" as const };
  });
  lines.set(storage, run);
  try { return await run; }
  finally { if (lines.get(storage) === run) lines.delete(storage); }
}

/** Explicit export/review path; ordinary session reload never reads these archive entries. */
export async function readMigratedLegacyRecords(storage: Storage, context: Context = BACKGROUND_CONTEXT): Promise<TranscriptRecord[]> {
  const metadata = await loadLegacyMigration(storage, context);
  if (!metadata) return [];
  const archived = (await entries(storage, metadata.conversationId, context)).filter(entry => entry.kind === LEGACY_RECORD_KIND);
  const records: TranscriptRecord[] = [];
  for (const entry of archived) {
    const data = entry.data as unknown as { index: number; records?: TranscriptRecord[]; record?: TranscriptRecord };
    // Accept the initial single-record form too, so review fixtures and interrupted local trials remain readable.
    const block = data?.records ?? (data?.record ? [data.record] : undefined);
    if (data?.index !== records.length || !Array.isArray(block) || !block.length) throw new LegacyMigrationConflict("archive records are missing or reordered");
    for (const record of block) records.push(json(record));
  }
  if (records.length !== metadata.recordCount || legacyTranscriptFingerprint(records) !== metadata.fingerprint) throw new LegacyMigrationConflict("archive fingerprint differs from the original transcript");
  return records;
}

export async function readMigratedLegacyHistory(storage: Storage, context: Context = BACKGROUND_CONTEXT): Promise<AgentMessage[]> {
  return legacyHistoryOf(await readMigratedLegacyRecords(storage, context));
}

/** Full migration audit for tests, dry runs, and operator review; it intentionally reads the archive. */
export async function validateLegacyMigration(storage: Storage, source: readonly TranscriptRecord[], leadingSystem?: SystemMessage, context: Context = BACKGROUND_CONTEXT): Promise<LegacyMigrationMetadata> {
  const loaded = await loadMigratedSnapshot(storage, LEGACY_CONVERSATION_ID, context);
  if (!loaded) throw new LegacyMigrationConflict("migration is absent");
  const plan = planLegacyMigration(source, leadingSystem);
  if (loaded.metadata.fingerprint !== plan.fingerprint || !same(loaded.snapshot, plan.snapshot)) throw new LegacyMigrationConflict("source context or request identity differs");
  const archive = await readMigratedLegacyRecords(storage, context);
  if (!same(archive, plan.records) || !same(legacyHistoryOf(archive), legacyHistoryOf(plan.records))) throw new LegacyMigrationConflict("source history differs");
  const checkpoint = await storage.entry(loaded.metadata.contextEntryId, context);
  if (!checkpoint || !same(checkpoint.entry.model, plan.model) || checkpoint.entry.head !== checkpoint.entry.id) throw new LegacyMigrationConflict("active model context differs");
  return loaded.metadata;
}
