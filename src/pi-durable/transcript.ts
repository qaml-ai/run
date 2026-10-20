import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "../pi-harness/messages.ts";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { JsonObject, Storage, StorageWrite, DocumentId, EntryId, EntryRecord, Cursor } from "@earendil-works/pi-durable";
import type { AppendLog } from "../../shared/append-log.ts";
import { Transcript, type TranscriptRecord, type TranscriptSnapshot } from "../transcript.ts";
import { durableEntryMessages } from "./agent.ts";
import { LEGACY_CONVERSATION_ID as conversationId, readMigrationRecords, assertMigrationFits } from "./migration.ts";

const ADDRESS = { kind: "camel.host.snapshot", scope: { kind: "session" as const } };
const BOOTSTRAP = "camel.host.bootstrap", ARCHIVE = "camel.host.archive", RECORD = "camel.host.record", DISABLED = "camel.host.disabled";
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
type State = { enabled: boolean; generation: number; snapshot: TranscriptSnapshot };

/** Find the latest host generation without materializing the historical archive. */
async function generation(storage: Pick<Storage, "scanEntries">): Promise<number | undefined> {
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanEntries({ conversationId, order: "descending" }, 128, cursor, context);
    for (const entry of page.items) {
      if (entry.kind === DISABLED) return undefined;
      if (entry.kind === BOOTSTRAP) return entry.id;
    }
    cursor = page.next;
  } while (cursor);
}

/** Full export is deliberately separate from bounded reload. Canonical bodies are stored once. */
export async function nativeTranscriptRecords(storage: Pick<Storage, "scanEntries">): Promise<TranscriptRecord[] | undefined> {
  const start = await generation(storage);
  if (!start) return undefined;
  const records: TranscriptRecord[] = [];
  const pending = new Map<number, ReturnType<typeof durableEntryMessages>>();
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanEntries({ conversationId, minEntryId: start as EntryId, order: "ascending" }, 256, cursor, context);
    for (const entry of page.items) {
      if (entry.kind === ARCHIVE) records.push(...(entry.data as any).records);
      else if (entry.kind === RECORD) {
        const data = entry.data as any;
        if (data.pi) {
          const message = pending.get(data.pi.entryId)?.find(item => item.cursor.index === data.pi.index)?.message;
          if (!message) throw new Error("Native transcript references a missing message");
          records.push({ t: "message", message, pi: data.pi });
          const remaining = pending.get(data.pi.entryId)!.filter(item => item.cursor.index !== data.pi.index);
          if (remaining.length) pending.set(data.pi.entryId, remaining); else pending.delete(data.pi.entryId);
        } else {
          records.push(data.record);
          if (data.record.t === "pi") for (const id of pending.keys()) if (id <= data.record.cursor.entryId) pending.delete(id);
        }
      } else {
        const messages = durableEntryMessages(entry);
        if (messages.length) pending.set(entry.id, messages);
      }
    }
    cursor = page.next;
  } while (cursor);
  // A process may die after a canonical commit but before the host checkpoint.
  for (const items of pending.values()) for (const item of items) records.push({ t: "message", message: item.message, pi: item.cursor });
  return records;
}

/**
 * Pi's latest-only document holds bounded host state; immutable host records refer
 * to canonical messages by ID. No legacy log is read or appended during normal use.
 */
export class NativeTranscript extends Transcript {
  private storage: Storage;
  private documentId: DocumentId;
  private generationId: number;
  private constructor(storage: Storage, documentId: DocumentId, generationId: number, indexed?: number, bound?: number) {
    super({ read: async () => (await nativeTranscriptRecords(storage))!, close: async () => {},
      append: () => { throw new Error("Use NativeTranscript.commit"); }, flush: async () => {},
      rewrite: async () => { throw new Error("Use NativeTranscript.replace"); }, appendedSinceRewrite: 0 } as AppendLog<TranscriptRecord>, indexed, bound);
    this.storage = storage; this.documentId = documentId; this.generationId = generationId;
  }

  static async open(storage: Storage, indexed?: number, bound?: number): Promise<NativeTranscript | undefined> {
    const document = await storage.findDocument(ADDRESS, "current", context);
    if (!document) return undefined;
    const stored = await storage.document(document.id, "current", context);
    const state = stored?.value as unknown as State;
    if (!state?.enabled) return undefined;
    const transcript = new NativeTranscript(storage, document.id, state.generation, indexed, bound);
    transcript.restore(structuredClone(state.snapshot));
    transcript.prune();
    if (indexed === undefined) transcript.backlog = undefined;
    else if (!transcript.backlog || indexed < transcript.backlog.from) transcript.backlog = { from: indexed, kept: transcript.total, messages: [], sizes: [], bytes: 0, turns: [] };
    else transcript.indexed(indexed);
    return transcript;
  }

  static async adopt(storage: Storage, source: Transcript, indexed?: number, bound?: number, working?: AgentMessage[], importedRecords?: readonly TranscriptRecord[]) {
    const previous = await storage.findDocument(ADDRESS, "current", context);
    const records = importedRecords ?? await readMigrationRecords(source.log);
    assertMigrationFits(records);
    // Initial migration already indexed these keys. Find rollback-era additions
    // by pages, rather than doing a database round trip per historical request.
    const missing = new Set(source.requests);
    let cursor: Cursor | undefined;
    while (missing.size) {
      const page = await storage.scanSubmissions({ conversationId, order: "ascending" }, 512, cursor, context);
      for (const submission of page.items) if (submission.requestId) missing.delete(submission.requestId);
      cursor = page.next;
      if (!cursor) break;
    }
    const count = 2 + Math.ceil(records.length / 128) + missing.size + (previous ? 0 : 1);
    const bulk = storage as Storage & { mintIds?(count: number): Promise<number[]> };
    const ids = bulk.mintIds ? await bulk.mintIds(count) : await (async () => {
      const ids: number[] = [];
      for (let i = 0; i < count; i++) ids.push(await storage.mintId());
      return ids;
    })();
    let next = 0;
    const generationId = ids[next++] as EntryId;
    const documentId = previous?.id ?? ids[next++] as DocumentId;
    const transcript = new NativeTranscript(storage, documentId, generationId, indexed, bound);
    transcript.restore(structuredClone(source.snapshot()));
    transcript.pin = source.pin;
    const writes: StorageWrite[] = [{ type: "entry", value: { id: generationId, conversationId, kind: BOOTSTRAP } }];
    for (let at = 0; at < records.length; at += 128) writes.push({ type: "entry", value: {
      id: ids[next++] as EntryId, conversationId, kind: ARCHIVE, data: json({ records: records.slice(at, at + 128) }),
    } });
    for (const requestId of missing) writes.push({ type: "submission", value: {
      id: ids[next++] as never, conversationId, requestId, type: "input", status: "unanswered", reason: "legacy_import",
    } });
    // The checkpoint covers the complete adopted archive. Recovery starts
    // after this small barrier, never in archive blocks carrying old bodies.
    const ready = ids[next++] as EntryId;
    writes.push({ type: "entry", value: { id: ready, conversationId, kind: "camel.legacy.context", head: ready,
      model: json(convertToLlm(working ?? [...(source.system ? [source.system] : []), ...source.view()])) } });
    transcript.piCursor = { entryId: ready, index: -1 };
    transcript.prune();
    writes.push(previous ? { type: "document.change", id: documentId, content: transcript.content() } :
      { type: "document.create", record: { id: documentId, ...ADDRESS }, content: transcript.content() });
    await storage.commit(writes, context);
    return transcript;
  }

  private prune() {
    this.requests.clear();
    for (const [id, index] of this.calls) if (index < this.offset) this.calls.delete(id);
  }
  private content(enabled = true) {
    const snapshot = this.snapshot();
    // History indexing can always recover its backlog from immutable records.
    // Avoid rewriting a multi-megabyte indexing backlog with every checkpoint.
    if (snapshot.backlog) snapshot.backlog = { from: snapshot.backlog.from, kept: snapshot.total, messages: [], sizes: [], bytes: 0, turns: [] };
    return { version: 1, kind: "base" as const, value: json({ enabled, generation: this.generationId, snapshot }) as JsonObject };
  }
  override async hasRequest(requestId: string) {
    return !!await this.storage.submissionByRequest(conversationId, requestId, context);
  }
  override commit(change: () => TranscriptRecord[]): Promise<void> {
    return this.enqueue(async () => {
      const records = change();
      if (!records.length) return;
      const before = structuredClone(this.snapshot());
      try {
        const writes: StorageWrite[] = [];
        for (const record of records) {
          const data = record.t === "message" && record.pi ? { pi: record.pi } : { record };
          writes.push({ type: "entry", value: { id: await this.storage.mintId<EntryId>(), conversationId, kind: RECORD, data: json(data) } });
          if (record.t === "message" && record.message.role === "user") {
            const requestId = (record.message as { requestId?: string }).requestId;
            if (requestId && !await this.storage.submissionByRequest(conversationId, requestId, context)) writes.push({ type: "submission", value: {
              id: await this.storage.mintId(), conversationId, requestId, type: "input", status: "unanswered", reason: "host_input",
            } });
          }
          this.apply(record);
        }
        this.prune();
        writes.push({ type: "document.change", id: this.documentId, content: this.content() });
        await this.storage.commit(writes, context);
      } catch (error) { this.restore(before); this.failed = error; throw error; }
    });
  }
  override replace(messages: Parameters<Transcript["replace"]>[0], active = this.active,
    compaction?: Parameters<Transcript["replace"]>[2]) {
    return this.commit(() => [{ t: "reset", messages, ...(compaction ? { compaction } : {}) }, { t: "turn", active }]);
  }
  async disable() {
    await this.storage.commit([{ type: "entry", value: { id: await this.storage.mintId<EntryId>(), conversationId, kind: DISABLED } },
      { type: "document.change", id: this.documentId, content: this.content(false) }], context);
  }
}
