import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { convertToLlm } from "../pi-harness/messages.ts";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Op } from "@earendil-works/chord/delta";
import type { JsonObject, Storage, StorageWrite, DocumentId, DocumentContent, EntryId, EntryRecord, Cursor } from "@earendil-works/pi-durable";
import type { AppendLog } from "../../shared/append-log.ts";
import { Transcript, type TranscriptRecord, type TranscriptSnapshot } from "../transcript.ts";
import { durableEntryMessages } from "./agent.ts";
import { LEGACY_CONVERSATION_ID as conversationId, HOST_ARCHIVE_KIND as ARCHIVE, HOST_BOOTSTRAP_KIND as BOOTSTRAP, readMigrationRecords, contextWrites, importLegacyTranscript } from "./migration.ts";

const ADDRESS = { kind: "camel.host.snapshot", scope: { kind: "session" as const } };
const RECORD = "camel.host.record", DISABLED = "camel.host.disabled";
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
type State = { enabled: boolean; generation: number; snapshot: TranscriptSnapshot };
/**
 * What the host document holds as of its last write: the context's messages (by identity) and every other snapshot
 * field's JSON. A commit that only appends messages writes them as a delta instead of the whole working set again.
 */
type Stored = { context: AgentMessage[]; fields: Map<string, string>; deltas: number; bytes: number; base: number };
/** A new base is written past this many deltas, or once deltas outweigh the base (and this many bytes): reload reads base + deltas. */
const MAX_DELTAS = 512, MIN_REBASE_BYTES = 8 * 1024 * 1024;

function fieldsOf(snapshot: TranscriptSnapshot) {
  const fields = new Map<string, string>();
  for (const [key, value] of Object.entries(snapshot)) if (key !== "context" && value !== undefined) fields.set(key, JSON.stringify(value));
  return fields;
}

/** Find the latest host generation without materializing the historical archive. */
async function generation(storage: Pick<Storage, "scanEntries">): Promise<EntryRecord | undefined> {
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanEntries({ conversationId, order: "descending" }, 128, cursor, context);
    for (const entry of page.items) {
      if (entry.kind === DISABLED) return undefined;
      if (entry.kind === BOOTSTRAP) return entry;
    }
    cursor = page.next;
  } while (cursor);
}

/** Full export is deliberately separate from bounded reload. Canonical bodies are stored once. */
export async function nativeTranscriptRecords(storage: Pick<Storage, "scanEntries">): Promise<TranscriptRecord[] | undefined> {
  const start = (await generation(storage))?.id;
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

const later = (a: { entryId: number; index: number }, b: { entryId: number; index: number }) => a.entryId > b.entryId || a.entryId === b.entryId && a.index > b.index;

/**
 * Whether the journal ends with a canonical message the host never recorded (a process that died between Pi's commit
 * and its host record). Read back from the journal's end only as far as the newest recorded message: one turn's entries.
 */
export async function nativeUnrecorded(storage: Pick<Storage, "scanEntries">): Promise<boolean> {
  let recorded: { entryId: number; index: number } | undefined;
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanEntries({ conversationId, order: "descending" }, 64, cursor, context);
    for (const entry of page.items) {
      if (entry.kind === BOOTSTRAP || entry.kind === DISABLED) return false;
      if (entry.kind === RECORD) {
        const data = entry.data as any;
        const at = data.pi ?? (data.record?.t === "pi" ? data.record.cursor : undefined);
        if (at && (!recorded || later(at, recorded))) recorded = at;
        continue;
      }
      const last = durableEntryMessages(entry).at(-1);
      if (last) return !recorded || later(last.cursor, recorded);
    }
    cursor = page.next;
  } while (cursor);
  return false;
}

/**
 * Pi's latest-only document holds bounded host state; immutable host records refer
 * to canonical messages by ID. No legacy log is read or appended during normal use.
 */
export class NativeTranscript extends Transcript {
  private storage: Storage;
  private documentId: DocumentId;
  private generationId: number;
  private stored?: Stored;
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
    // The document was just read: nothing else holds its objects.
    transcript.restore(state.snapshot);
    transcript.stored = { context: [...transcript.context], fields: fieldsOf(state.snapshot), deltas: stored!.deltasSinceBase, bytes: 0, base: 0 };
    transcript.prune();
    if (indexed === undefined) transcript.backlog = undefined;
    else if (!transcript.backlog || indexed < transcript.backlog.from) transcript.backlog = { from: indexed, kept: transcript.total, messages: [], sizes: [], bytes: 0, turns: [] };
    else transcript.indexed(indexed);
    return transcript;
  }

  /**
   * Import a legacy session and start the host's generation in one commit: the import's archive is the generation's
   * archive, and its per-message checkpoint the generation's context, so nothing is written twice or read back.
   * Undefined when the session was already imported (adopt it instead).
   */
  static async importLegacy(storage: Storage, source: Transcript, options: { sessionId: string; records: readonly TranscriptRecord[];
    leadingSystem?: SystemMessage; working: AgentMessage[]; indexed?: number; bound?: number }) {
    let transcript: NativeTranscript | undefined, stored: Stored | undefined;
    const metadata = await importLegacyTranscript({ storage, sessionId: options.sessionId, records: options.records,
      leadingSystem: options.leadingSystem, model: convertToLlm(options.working),
      host: async ({ generationId, contextEntryId }) => {
        const documentId = await storage.mintId<DocumentId>();
        transcript = NativeTranscript.from(storage, source, documentId, generationId, options.indexed, options.bound);
        transcript.piCursor = { entryId: contextEntryId, index: -1 };
        transcript.prune();
        const base = transcript.document();
        stored = base.stored;
        return [{ type: "document.create", record: { id: documentId, ...ADDRESS }, content: base.content }];
      } });
    if (metadata.status !== "imported" || !transcript) return { metadata };
    transcript.stored = stored;
    return { metadata, transcript };
  }

  /** A host transcript continuing `source`: the source is left behind, so its messages are shared rather than copied. */
  private static from(storage: Storage, source: Transcript, documentId: DocumentId, generationId: number, indexed?: number, bound?: number) {
    const transcript = new NativeTranscript(storage, documentId, generationId, indexed, bound);
    const { context: messages, updates, awaiting, backlog, ...rest } = source.snapshot();
    transcript.restore({ ...rest, context: [...messages], updates: updates.map(update => ({ ...update })), awaiting: [...awaiting],
      ...(backlog ? { backlog: { ...backlog, messages: [...backlog.messages], sizes: [...backlog.sizes], turns: [...backlog.turns] } } : {}) });
    transcript.pin = source.pin;
    return transcript;
  }

  static async adopt(storage: Storage, source: Transcript, indexed?: number, bound?: number, working?: AgentMessage[]) {
    const previous = await storage.findDocument(ADDRESS, "current", context);
    const records = await readMigrationRecords(source.log);
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
    const model = convertToLlm(working ?? [...(source.system ? [source.system] : []), ...source.view()]);
    const contextIds = Math.max(1, model.length);
    const count = 1 + Math.ceil(records.length / 128) + missing.size + (previous ? 0 : 1) + contextIds;
    const bulk = storage as Storage & { mintIds?(count: number): Promise<number[]> };
    const ids = bulk.mintIds ? await bulk.mintIds(count) : await (async () => {
      const ids: number[] = [];
      for (let i = 0; i < count; i++) ids.push(await storage.mintId());
      return ids;
    })();
    let next = 0;
    const generationId = ids[next++] as EntryId;
    const documentId = previous?.id ?? ids[next++] as DocumentId;
    const transcript = NativeTranscript.from(storage, source, documentId, generationId, indexed, bound);
    const writes: StorageWrite[] = [{ type: "entry", value: { id: generationId, conversationId, kind: BOOTSTRAP } }];
    for (let at = 0; at < records.length; at += 128) writes.push({ type: "entry", value: {
      id: ids[next++] as EntryId, conversationId, kind: ARCHIVE, data: { records: records.slice(at, at + 128) } as unknown as JsonObject,
    } });
    for (const requestId of missing) writes.push({ type: "submission", value: {
      id: ids[next++] as never, conversationId, requestId, type: "input", status: "unanswered", reason: "legacy_import",
    } });
    // The checkpoint covers the complete adopted archive. Recovery starts
    // after this small barrier, never in archive blocks carrying old bodies.
    const ready = ids[next] as EntryId;
    writes.push(...contextWrites(ids.slice(next, next += contextIds), conversationId, model));
    transcript.piCursor = { entryId: ready, index: -1 };
    transcript.prune();
    const base = transcript.document();
    writes.push(previous ? { type: "document.change", id: documentId, content: base.content } :
      { type: "document.create", record: { id: documentId, ...ADDRESS }, content: base.content });
    await storage.commit(writes, context);
    transcript.stored = base.stored;
    return transcript;
  }

  private prune() {
    this.requests.clear();
    for (const [id, index] of this.calls) if (index < this.offset) this.calls.delete(id);
  }
  private stateSnapshot() {
    const snapshot = this.snapshot();
    // History indexing can always recover its backlog from immutable records.
    // Avoid rewriting a multi-megabyte indexing backlog with every checkpoint.
    if (snapshot.backlog) snapshot.backlog = { from: snapshot.backlog.from, kept: snapshot.total, messages: [], sizes: [], bytes: 0, turns: [] };
    return snapshot;
  }
  /** The whole host state as a new base. */
  private document(enabled = true): { content: Extract<DocumentContent, { kind: "base" }>; stored: Stored } {
    const snapshot = this.stateSnapshot();
    // Storage serializes (or clones) the value as it commits. Messages are never changed in place, so the base refers
    // to them, and its size is measured one message at a time rather than as one working-set-sized string.
    const context = [...snapshot.context];
    const fields = fieldsOf(snapshot);
    let base = 0;
    for (const message of context) base += JSON.stringify(message).length + 1;
    for (const text of fields.values()) base += text.length;
    return { content: { version: 1, kind: "base", value: { enabled, generation: this.generationId, snapshot: { ...snapshot, context } } as unknown as JsonObject },
      stored: { context, fields, deltas: 0, bytes: 0, base } };
  }
  /**
   * The change since the stored document: appended messages and changed fields as a delta, so a commit costs what it
   * adds rather than the whole working set. Anything else (a reset, retraction or compaction) writes a new base.
   */
  private change(): { content?: DocumentContent; stored: Stored } {
    const stored = this.stored, snapshot = this.stateSnapshot();
    if (!stored || stored.deltas >= MAX_DELTAS || stored.bytes > Math.max(stored.base, MIN_REBASE_BYTES) ||
      snapshot.context.length < stored.context.length || stored.context.some((message, index) => snapshot.context[index] !== message)) return this.document();
    const ops: Op[] = [], fields = fieldsOf(snapshot);
    let bytes = 0;
    for (const [key, text] of fields) if (stored.fields.get(key) !== text) { ops.push(["s", ["snapshot", key], JSON.parse(text)]); bytes += text.length; }
    for (const key of stored.fields.keys()) if (!fields.has(key)) ops.push(["d", ["snapshot", key]]);
    if (snapshot.context.length > stored.context.length) {
      const text = JSON.stringify(snapshot.context.slice(stored.context.length));
      ops.push(["p", ["snapshot", "context"], stored.context.length, 0, JSON.parse(text)]);
      bytes += text.length;
    }
    const next = { ...stored, context: [...snapshot.context], fields };
    return ops.length ? { content: { version: 1, kind: "delta", ops }, stored: { ...next, deltas: stored.deltas + 1, bytes: stored.bytes + bytes } } : { stored: next };
  }
  override async hasRequest(requestId: string) {
    return !!await this.storage.submissionByRequest(conversationId, requestId, context);
  }
  override commit(change: () => TranscriptRecord[]): Promise<void> {
    return this.enqueue(async () => {
      const records = change();
      if (!records.length) return;
      // Messages are never changed in place: the rollback copies the context's array, not its (large) bodies.
      const { context: kept, ...rest } = this.snapshot();
      const before = { ...structuredClone(rest), context: [...kept] };
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
        const change = this.change();
        if (change.content) writes.push({ type: "document.change", id: this.documentId, content: change.content });
        await this.storage.commit(writes, context);
        this.stored = change.stored;
      } catch (error) { this.restore(before); this.failed = error; throw error; }
    });
  }
  override replace(messages: Parameters<Transcript["replace"]>[0], active = this.active,
    compaction?: Parameters<Transcript["replace"]>[2]) {
    return this.commit(() => [{ t: "reset", messages, ...(compaction ? { compaction } : {}) }, { t: "turn", active }]);
  }
  async disable() {
    await this.storage.commit([{ type: "entry", value: { id: await this.storage.mintId<EntryId>(), conversationId, kind: DISABLED } },
      { type: "document.change", id: this.documentId, content: this.document(false).content }], context);
    this.stored = undefined;
  }
}
