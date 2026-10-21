import { createHash } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, SystemMessage } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId, Storage, StorageWrite } from "@earendil-works/pi-durable";
import type { AppendLog } from "../../shared/append-log.ts";
import { convertToLlm } from "../pi-harness/messages.ts";
import { Transcript, type TranscriptRecord, type TranscriptSnapshot } from "../transcript.ts";

/**
 * The layout a session's Pi storage starts with, in one commit: a marker first, then the host generation, its archive
 * (the records the session starts with: none for a new agent, its source's for a fork), its context checkpoint, the
 * request IDs those records hold, and the host document (`NativeTranscript.seed`). Every session in production starts
 * this way, imported ones included (they were seeded from their legacy transcript, which no release reads to import
 * any more). Releases before #326 refuse a root whose first entry is not the marker, so the marker stays.
 */
export const SEED_MARKER_KIND = "camel.legacy.migration";
/** An archive block of the first seeds, before the host generation took its archive. */
export const SEED_RECORD_KIND = "camel.legacy.record";
/** The host's generation marker and archive blocks (NativeTranscript). */
export const HOST_BOOTSTRAP_KIND = "camel.host.bootstrap", HOST_ARCHIVE_KIND = "camel.host.archive";
export const CONTEXT_HEAD_KIND = "camel.legacy.context";
/** One message of a context checkpoint after its head entry: Pi can choose a compaction cut between them. */
export const CONTEXT_MESSAGE_KIND = "camel.context.message";
/** Each Camel session has its own fenced Pi storage, so it uses Pi's reserved root. */
export const SESSION_CONVERSATION_ID = 1 as ConversationId;
const VERSION = 1;
const ARCHIVE_BLOCK_RECORDS = 128;
/** What a seed copies at most. A fork's larger source keeps its archive in the fork's legacy log (`reference`). */
export const SEED_MAX_BYTES = 64 * 1024 * 1024;
export const SEED_MAX_RECORDS = 200_000;

/** The records' fingerprint, or undefined past the copy budget: each record is serialized once, on its own. */
export function copyFingerprint(records: readonly TranscriptRecord[]): string | undefined {
  if (records.length > SEED_MAX_RECORDS) return undefined;
  const hash = createHash("sha256");
  let bytes = 0;
  for (const record of records) {
    const text = JSON.stringify(record);
    bytes += Buffer.byteLength(text) + 1;
    if (bytes > SEED_MAX_BYTES) return undefined;
    hash.update(text).update("\n");
  }
  return hash.digest("hex");
}

export interface SeedMetadata {
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
  /** The host generation the seed starts (seeds before #322 have none: their host adopted them in its own). */
  generationId?: EntryId;
  /** "legacy-log": the records were too large to copy, so they stay in the session's legacy log, which the generation's history reads first. */
  archive?: "legacy-log";
}

/** Seeded storage belongs to one session and one source. */
export class SeedConflict extends Error {
  constructor(detail: string) {
    super(`Pi session seed conflict: ${detail}`);
    this.name = "SeedConflict";
  }
}

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const payload = (value: unknown): JsonValue => json(value) as JsonValue;

/** `records` applied to a transcript that writes nothing: it refers to their own message objects. */
export function reducedTranscript(records: readonly TranscriptRecord[]) {
  const transcript = new Transcript({ read: async () => [...records] } as AppendLog<TranscriptRecord>);
  for (const record of records) transcript.apply(record);
  return transcript;
}

/**
 * A context checkpoint as Pi entries: a head with the first message, then one entry per message, so the first run
 * after a seed need not split it again (Pi can only cut a compaction between entries). `ids` has one per message.
 */
export function contextWrites(ids: readonly number[], conversationId: ConversationId, model: readonly Message[], data?: JsonValue): StorageWrite[] {
  if (ids.length !== Math.max(1, model.length)) throw new Error("A context checkpoint needs one ID per message");
  const head = ids[0] as EntryId;
  return [
    { type: "entry", value: { id: head, conversationId, kind: CONTEXT_HEAD_KIND, head, model: model.slice(0, 1), ...(data === undefined ? {} : { data }) } },
    ...model.slice(1).map((message, index): StorageWrite => ({ type: "entry", value: { id: ids[index + 1] as EntryId, conversationId, kind: CONTEXT_MESSAGE_KIND, model: [message] } })),
  ];
}

/** The seed marker, the root's first entry; undefined when the root does not exist. */
export async function loadSeedMarker(storage: Storage, context: Context = BACKGROUND_CONTEXT): Promise<SeedMetadata | undefined> {
  if (!await storage.conversation(SESSION_CONVERSATION_ID, context)) return undefined;
  const first = (await storage.scanEntries({ conversationId: SESSION_CONVERSATION_ID, order: "ascending" }, 1, undefined, context)).items[0];
  if (!first || first.kind !== SEED_MARKER_KIND) throw new SeedConflict("Pi root contains data without a seed marker");
  const metadata = first.data as unknown as SeedMetadata;
  if (metadata?.version !== VERSION || metadata.markerId !== first.id || metadata.conversationId !== SESSION_CONVERSATION_ID) {
    throw new SeedConflict("unsupported or malformed seed marker");
  }
  return json(metadata);
}

const lines = new WeakMap<Storage, Promise<unknown>>();

/**
 * Seed `storage` with `source`, the records the session starts with, under the session's claim: the marker, the host
 * generation and its archive (copied, or with `reference` left in the session's legacy log), the context checkpoint
 * (`model`, else `source`'s context), the source's request IDs as terminal submissions (so a retried one is never run
 * again), and the writes `host` returns (its document), in one commit: a failed commit leaves nothing. Seeding the same
 * source again finds it seeded (`existing`).
 */
export async function seedStorage(options: {
  storage: Storage;
  sessionId: string;
  source: Transcript;
  records: readonly TranscriptRecord[];
  reference?: boolean;
  leadingSystem?: SystemMessage;
  model?: Message[];
  host: (generation: { generationId: EntryId; contextEntryId: EntryId }) => Promise<StorageWrite[]>;
  context?: Context;
  now?: number;
}): Promise<SeedMetadata & { status: "seeded" | "existing" }> {
  const { storage, sessionId, source, records, leadingSystem, context = BACKGROUND_CONTEXT, now = Date.now() } = options;
  if (!sessionId) throw new TypeError("A seed needs the session's public ID");
  const fingerprint = options.reference ? `legacy-log:${source.total}` : copyFingerprint(records);
  if (fingerprint === undefined) throw new RangeError("The records are past the copy budget: seed them by reference");
  const run = (lines.get(storage) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const previous = await loadSeedMarker(storage, context);
    if (previous) {
      if (previous.sessionId !== sessionId || previous.fingerprint !== fingerprint) throw new SeedConflict("storage belongs to another session or source");
      return { ...previous, status: "existing" as const };
    }
    const snapshot = source.snapshot();
    // Native entry IDs are scoped to their storage: a fork's archive keeps its source's cursors as evidence, and the
    // new storage starts a projection domain of its own.
    delete snapshot.piCursor;
    if (!snapshot.system && leadingSystem) snapshot.system = leadingSystem;
    const model = options.model ?? [...(snapshot.system ? [snapshot.system] : []), ...convertToLlm(source.view())];
    const archived = options.reference ? [] : records;
    const blockCount = Math.ceil(archived.length / ARCHIVE_BLOCK_RECORDS);
    // Postgres reserves the complete monotonic range under the claim in one transaction. Native SQLite mints from its
    // in-memory allocator. Both retain the storage's global ID-ownership checks in the final atomic commit.
    const contextIds = Math.max(1, model.length);
    const count = 2 + blockCount + contextIds + snapshot.requests.length;
    const bulk = storage as Storage & { mintIds?(count: number): Promise<number[]> };
    const ids = bulk.mintIds ? await bulk.mintIds(count) : await (async () => {
      const ids: number[] = [];
      for (let index = 0; index < count; index++) ids.push(await storage.mintId());
      return ids;
    })();
    if (ids.length !== count || ids.some((id, index) => !Number.isSafeInteger(id) || id <= 1 || index > 0 && id <= ids[index - 1])) {
      throw new SeedConflict("storage returned an invalid ID reservation");
    }
    let nextId = 0;
    const markerId = ids[nextId++] as EntryId, generationId = ids[nextId++] as EntryId;
    const contextEntryId = ids[2 + blockCount] as EntryId;
    const metadata: SeedMetadata = {
      version: VERSION, sessionId, fingerprint, conversationId: SESSION_CONVERSATION_ID,
      recordCount: archived.length, historyCount: source.total, contextCount: model.length,
      importedAt: now, markerId, contextEntryId, generationId, ...(options.reference ? { archive: "legacy-log" as const } : {}),
    };
    const writes: StorageWrite[] = [
      { type: "conversation", value: { id: SESSION_CONVERSATION_ID } },
      { type: "entry", value: { id: markerId, conversationId: SESSION_CONVERSATION_ID, kind: SEED_MARKER_KIND, data: payload(metadata) } },
      { type: "entry", value: { id: generationId, conversationId: SESSION_CONVERSATION_ID, kind: HOST_BOOTSTRAP_KIND, ...(options.reference ? { data: { archive: "legacy-log" } } : {}) } },
    ];
    for (let index = 0; index < archived.length; index += ARCHIVE_BLOCK_RECORDS) {
      // Blocks refer to the source's records: storage serializes them as it writes, so the archive is never copied.
      writes.push({ type: "entry", value: { id: ids[nextId++] as EntryId, conversationId: SESSION_CONVERSATION_ID, kind: HOST_ARCHIVE_KIND,
        data: { index, records: archived.slice(index, index + ARCHIVE_BLOCK_RECORDS) } as unknown as JsonValue } });
    }
    const { context: _context, ...state } = snapshot;
    writes.push(...contextWrites(ids.slice(nextId, nextId += contextIds), SESSION_CONVERSATION_ID, model, payload({ fingerprint, state })));
    for (const requestId of snapshot.requests) writes.push({
      type: "submission",
      value: { id: ids[nextId++] as never, conversationId: SESSION_CONVERSATION_ID, requestId, type: "input", status: "unanswered", reason: "legacy_import", detail: "Request already recorded in the history this session started with." },
    });
    writes.push(...await options.host({ generationId, contextEntryId }));
    await storage.commit(writes, context);
    // The commit is atomic: reading back its marker confirms it landed.
    const landed = await loadSeedMarker(storage, context);
    if (!landed || !same(landed, metadata)) throw new SeedConflict("the persisted seed marker differs from the source");
    return { ...metadata, status: "seeded" as const };
  });
  lines.set(storage, run);
  try { return await run; }
  finally { if (lines.get(storage) === run) lines.delete(storage); }
}
