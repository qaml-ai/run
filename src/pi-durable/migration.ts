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
/** One message of a context checkpoint after its head entry: Pi can choose a compaction cut between them. */
export const CONTEXT_MESSAGE_KIND = "camel.context.message";
/** Each Camel session has its own fenced Pi storage, so it uses Pi's reserved root. */
export const LEGACY_CONVERSATION_ID = 1 as ConversationId;
const VERSION = 1;
const PAGE_SIZE = 256;
const ARCHIVE_BLOCK_RECORDS = 128;
/** Automatic migration is intentionally small. Larger sessions stay on the legacy engine. */
export const MIGRATION_MAX_BYTES = 64 * 1024 * 1024;
export const MIGRATION_MAX_RECORDS = 200_000;

export function assertMigrationFits(records: readonly TranscriptRecord[]) {
  measuredFingerprint(records);
}

/** The size budget and the fingerprint in one pass: each record is serialized once, on its own. */
function measuredFingerprint(records: readonly TranscriptRecord[]): string {
  if (records.length > MIGRATION_MAX_RECORDS) throw migrationTooLarge();
  const hash = createHash("sha256");
  let bytes = 0;
  for (const record of records) {
    const text = JSON.stringify(record);
    bytes += Buffer.byteLength(text) + 1;
    if (bytes > MIGRATION_MAX_BYTES) throw migrationTooLarge();
    hash.update(text).update("\n");
  }
  return hash.digest("hex");
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
  // Reduction does not write: the source log and all of its ownership/fencing stay with the host. Applying a record
  // never changes the record or its message, so the reduced state refers to the source's own message objects.
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
  // The same objects in the same order, compared one message at a time rather than as two context-sized strings.
  if (messages.length !== ordered.length || messages.some((message, index) => message !== ordered[index] && !same(message, ordered[index]))) {
    throw new LegacyMigrationDeferred("context_changed", "Pi would reorder the active model context");
  }
}

/**
 * A side-effect-free conversion. It never mutates or folds the original archive, and it copies none of it: the plan's
 * records, snapshot and model refer to the source's records and messages, which nothing changes in place.
 */
export function planLegacyMigration(records: readonly TranscriptRecord[], leadingSystem?: SystemMessage, fingerprint = legacyTranscriptFingerprint(records)): LegacyMigrationPlan {
  const transcript = reduced(records);
  if (transcript.active) throw new LegacyMigrationDeferred("active", "the legacy turn is still active");
  if (transcript.awaiting.length) throw new LegacyMigrationDeferred("awaiting", "a tool is waiting for human input");
  const snapshot = transcript.snapshot();
  // Native entry IDs are scoped to their storage. Fork/import archives retain the old cursor as evidence, but the
  // new storage starts a new projection domain and must not skip entries because of an ancestor's high watermark.
  delete snapshot.piCursor;
  if (!snapshot.system && leadingSystem) snapshot.system = leadingSystem;
  const model = [
    ...(snapshot.system ? [snapshot.system] : []),
    ...convertToLlm(transcript.view()),
  ];
  assertCompatibleContext(model);
  return { records: records as TranscriptRecord[], snapshot, model, fingerprint, historyCount: transcript.total };
}

/**
 * A context checkpoint as Pi entries: a head with the first message, then one entry per message, so the first run
 * after an import need not split it again (Pi can only cut a compaction between entries). `ids` has one per message.
 */
export function contextWrites(ids: readonly number[], conversationId: ConversationId, model: readonly Message[], data?: JsonValue): StorageWrite[] {
  if (ids.length !== Math.max(1, model.length)) throw new Error("A context checkpoint needs one ID per message");
  const head = ids[0] as EntryId;
  return [
    { type: "entry", value: { id: head, conversationId, kind: LEGACY_CONTEXT_KIND, head, model: model.slice(0, 1), ...(data === undefined ? {} : { data }) } },
    ...model.slice(1).map((message, index): StorageWrite => ({ type: "entry", value: { id: ids[index + 1] as EntryId, conversationId, kind: CONTEXT_MESSAGE_KIND, model: [message] } })),
  ];
}

/** A context checkpoint's messages: its head's, then those of the message entries that follow it. */
async function checkpointModel(storage: Storage, conversationId: ConversationId, head: EntryRecord, context: Context): Promise<Message[]> {
  const model = [...head.model ?? []];
  let cursor: Cursor | undefined;
  scan: do {
    const page = await storage.scanEntries({ conversationId, order: "ascending", minEntryId: (head.id + 1) as EntryId }, PAGE_SIZE, cursor, context);
    for (const entry of page.items) {
      if (entry.kind !== CONTEXT_MESSAGE_KIND) break scan;
      model.push(...entry.model ?? []);
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return model;
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

type CheckpointData = { fingerprint: string; snapshot?: TranscriptSnapshot; state?: Omit<TranscriptSnapshot, "context"> };

/** The import's context checkpoint, read by ID: its head holds one message (earlier imports: the whole context). */
async function checkpointOf(storage: Storage, metadata: LegacyMigrationMetadata, context: Context) {
  const record = await storage.entry(metadata.conversationId, metadata.contextEntryId, context);
  if (!record || record.entry.kind !== LEGACY_CONTEXT_KIND) throw new LegacyMigrationConflict("migration context checkpoint is missing");
  const data = record.entry.data as unknown as CheckpointData | undefined;
  if (!(data?.snapshot || data?.state) || data.fingerprint !== metadata.fingerprint) throw new LegacyMigrationConflict("migration context checkpoint does not match its marker");
  return { entry: record.entry, data };
}

/**
 * The reduced state the import began from. Its context is not stored a second time beside the checkpoint's messages
 * and the host document: this audit path reduces it from the archive again (earlier imports stored it whole).
 */
export async function loadMigratedSnapshot(storage: Storage, conversationId: ConversationId = LEGACY_CONVERSATION_ID, context: Context = BACKGROUND_CONTEXT): Promise<{ snapshot: TranscriptSnapshot; metadata: LegacyMigrationMetadata } | undefined> {
  const metadata = await loadLegacyMigration(storage, context);
  if (!metadata) return undefined;
  if (metadata.conversationId !== conversationId) throw new LegacyMigrationConflict("conversation mapping differs from the migration marker");
  const { data } = await checkpointOf(storage, metadata, context);
  if (data.snapshot) return { snapshot: json(data.snapshot), metadata };
  const { context: messages } = reduced(await readMigratedLegacyRecords(storage, context)).snapshot();
  return { snapshot: { context: messages, ...json(data.state!) }, metadata };
}

const lines = new WeakMap<Storage, Promise<unknown>>();

/**
 * Import while the host holds the session's exclusive claim, before opening its Harness. The original source is
 * retained by the host and also archived verbatim as non-model entries. One commit publishes every record, request
 * deduplication key, and the context head together. A failed commit publishes no partial conversation. No task is
 * created, resumed, settled, or retried by this function. The host changes its engine selector only after validation.
 *
 * Each thing is written once: the archive, and the context as one entry per message (`model` when the host's working
 * set differs from the reduced source, e.g. by a newer leading system message). No record is copied to build them.
 */
export async function importLegacyTranscript(options: {
  storage: Storage;
  sessionId: string;
  records: readonly TranscriptRecord[];
  leadingSystem?: SystemMessage;
  model?: Message[];
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
      await checkpointOf(storage, previous, context);
      return { ...previous, status: "existing" as const };
    }
    const plan = planLegacyMigration(records, leadingSystem, measuredFingerprint(records));
    const model = options.model ?? plan.model;
    if (model !== plan.model) assertCompatibleContext(model);
    const blockCount = Math.ceil(plan.records.length / ARCHIVE_BLOCK_RECORDS);
    // Postgres reserves the complete monotonic range under the host's claim in one transaction. Native SQLite mints
    // from its in-memory allocator. Both retain the storage's global ID-ownership checks in the final atomic commit.
    const contextIds = Math.max(1, model.length);
    const count = 1 + blockCount + contextIds + plan.snapshot.requests.length;
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
    const markerId = ids[nextId++] as EntryId, contextEntryId = ids[1 + blockCount] as EntryId;
    const metadata: LegacyMigrationMetadata = {
      version: VERSION, sessionId, fingerprint: plan.fingerprint, conversationId: LEGACY_CONVERSATION_ID,
      recordCount: plan.records.length, historyCount: plan.historyCount, contextCount: model.length,
      importedAt: now, markerId, contextEntryId,
    };
    const writes: StorageWrite[] = [
      { type: "conversation", value: { id: LEGACY_CONVERSATION_ID } },
      { type: "entry", value: { id: markerId, conversationId: LEGACY_CONVERSATION_ID, kind: LEGACY_MIGRATION_KIND, data: payload(metadata) } },
    ];
    for (let index = 0; index < plan.records.length; index += ARCHIVE_BLOCK_RECORDS) {
      // Blocks refer to the source's records: storage serializes them as it writes, so the archive is never copied.
      writes.push({ type: "entry", value: { id: ids[nextId++] as EntryId, conversationId: LEGACY_CONVERSATION_ID, kind: LEGACY_RECORD_KIND,
        data: { index, records: plan.records.slice(index, index + ARCHIVE_BLOCK_RECORDS) } as unknown as JsonValue } });
    }
    const { context: _context, ...state } = plan.snapshot;
    writes.push(...contextWrites(ids.slice(nextId, nextId += contextIds), LEGACY_CONVERSATION_ID, model, payload({ fingerprint: plan.fingerprint, state })));
    // Import historical request IDs as terminal admissions. Retrying one must never start a new model/tool run.
    for (const requestId of plan.snapshot.requests) writes.push({
      type: "submission",
      value: { id: ids[nextId++] as never, conversationId: LEGACY_CONVERSATION_ID, requestId, type: "input", status: "unanswered", reason: "legacy_import", detail: "Request already recorded by the legacy runtime; its original history is retained." },
    });
    await storage.commit(writes, context);
    // The commit is atomic: reading back its marker and checkpoint head confirms it landed, without reading the context again.
    const landed = await loadLegacyMigration(storage, context);
    if (!landed || !same(landed, metadata)) throw new LegacyMigrationConflict("persisted migration marker differs from the source");
    await checkpointOf(storage, landed, context);
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
  const { entry } = await checkpointOf(storage, loaded.metadata, context);
  const model = await checkpointModel(storage, loaded.metadata.conversationId, entry, context);
  if (entry.head !== entry.id || model.length !== plan.model.length || model.some((message, index) => !same(message, plan.model[index]))) throw new LegacyMigrationConflict("active model context differs");
  return loaded.metadata;
}
