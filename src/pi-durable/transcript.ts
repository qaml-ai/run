import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { convertToLlm } from "../pi-harness/messages.ts";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Op } from "@earendil-works/chord/delta";
import type { JsonObject, Storage, StorageWrite, DocumentId, DocumentContent, EntryId, EntryRecord, Cursor } from "@earendil-works/pi-durable";
import type { AppendLog } from "../../shared/append-log.ts";
import { Transcript, type TranscriptRecord, type TranscriptSnapshot } from "../transcript.ts";
import { durableEntryMessages } from "./agent.ts";
import { JournalHistory, type HistoryBase } from "./history.ts";
import { SESSION_CONVERSATION_ID as conversationId, HOST_ARCHIVE_KIND as ARCHIVE, HOST_BOOTSTRAP_KIND as BOOTSTRAP, reducedTranscript, seedStorage } from "./seed.ts";

const ADDRESS = { kind: "camel.host.snapshot", scope: { kind: "session" as const } };
const RECORD = "camel.host.record", DISABLED = "camel.host.disabled";
/** Phase 1's native entries: a message the host wrote, as Pi's adapter writes a non-user message and a user one. */
export const HOST_MESSAGE_KIND = "camel.message", HOST_USER_KIND = "camel.user";
/** Phase 1's markers: `retract` (with the index it took back), `turn` (with the history's length), `awaiting`, and `pi` (a skip). */
export const MARKER_KIND = "camel.history.marker";
/** Whether this process dual-writes (AGENT_PI_DUAL_WRITE=1; off unless set): a node's setting, as its agents' processes get it. */
let dualWrite = false;
export function setDualWrite(on: boolean) { dualWrite = on; }
export const dualWriting = () => dualWrite;
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

/**
 * Full export is deliberately separate from bounded reload. Canonical bodies are stored once. A generation whose
 * import was too large to copy keeps its archive in the legacy log: its records come first, from `legacy`.
 */
export async function nativeTranscriptRecords(storage: Pick<Storage, "scanEntries">, legacy?: () => Promise<TranscriptRecord[]>): Promise<TranscriptRecord[] | undefined> {
  const bootstrap = await generation(storage);
  if (!bootstrap) return undefined;
  const start = bootstrap.id;
  const records: TranscriptRecord[] = [];
  if ((bootstrap.data as { archive?: string } | undefined)?.archive === "legacy-log") {
    if (!legacy) throw new Error("This session's history before its import is in its legacy log, which this read was not given");
    for (const record of await legacy()) records.push(record);
  }
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
 * Whether a later release took this session's history off the host transcript: it set the host document's `retired`
 * (with `enabled: false`) once its history was read from Pi's journal alone. This release must not open it.
 */
export async function hostRetired(storage: Pick<Storage, "findDocument" | "document">): Promise<boolean> {
  const document = await storage.findDocument(ADDRESS, "current", context);
  if (!document) return false;
  return !!((await storage.document(document.id, "current", context))?.value as { retired?: unknown } | undefined)?.retired;
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
  private constructor(storage: Storage, documentId: DocumentId, generationId: number, indexed?: number, bound?: number, legacy?: AppendLog<TranscriptRecord>) {
    super({ read: async () => (await nativeTranscriptRecords(storage, legacy && (() => legacy.read())))!, close: async () => {},
      append: () => { throw new Error("Use NativeTranscript.commit"); }, flush: async () => {},
      rewrite: async () => { throw new Error("Use NativeTranscript.replace"); }, appendedSinceRewrite: 0 } as AppendLog<TranscriptRecord>, indexed, bound);
    this.storage = storage; this.documentId = documentId; this.generationId = generationId;
  }

  /** `legacy`: the session's legacy log, whose records an import too large to copy left there (`nativeTranscriptRecords`). */
  static async open(storage: Storage, indexed?: number, bound?: number, legacy?: AppendLog<TranscriptRecord>): Promise<NativeTranscript | undefined> {
    const document = await storage.findDocument(ADDRESS, "current", context);
    if (!document) return undefined;
    const stored = await storage.document(document.id, "current", context);
    const state = stored?.value as unknown as State;
    if (!state?.enabled) return undefined;
    const transcript = new NativeTranscript(storage, document.id, state.generation, indexed, bound, legacy);
    // The document was just read: nothing else holds its objects. One with no backlog (a seed's) keeps none: the
    // constructor's, empty from `indexed`, would hide every message after it from the index.
    transcript.restore({ backlog: undefined, ...state.snapshot });
    transcript.stored = { context: [...transcript.context], fields: fieldsOf(state.snapshot), deltas: stored!.deltasSinceBase, bytes: 0, base: 0 };
    transcript.prune();
    if (indexed === undefined) transcript.backlog = undefined;
    else if (!transcript.backlog || indexed < transcript.backlog.from) transcript.backlog = { from: indexed, kept: transcript.total, messages: [], sizes: [], bytes: 0, turns: [] };
    else transcript.indexed(indexed);
    return transcript;
  }

  /**
   * Start a session's host generation (`seedStorage`): a new agent's with no records, a fork's with its source's, copied,
   * or (`legacy`, past the copy budget) left in the session's legacy log, which the transcript's history reads first.
   * `working` is Pi's context to start from (the host's leading system message and the records' context). Undefined
   * when the session was seeded already.
   */
  static async seed(storage: Storage, options: { sessionId: string; records: readonly TranscriptRecord[]; legacy?: AppendLog<TranscriptRecord>;
    leadingSystem?: SystemMessage; working?: AgentMessage[]; indexed?: number; bound?: number }): Promise<NativeTranscript | undefined> {
    const source = reducedTranscript(options.records);
    let transcript: NativeTranscript | undefined, stored: Stored | undefined;
    const seeded = await seedStorage({ storage, sessionId: options.sessionId, source, records: options.records, reference: !!options.legacy,
      leadingSystem: options.leadingSystem, ...(options.working ? { model: convertToLlm(options.working) } : {}),
      host: async ({ generationId, contextEntryId }) => {
        const documentId = await storage.mintId<DocumentId>();
        transcript = NativeTranscript.from(storage, source, documentId, generationId, options.indexed, options.bound, options.legacy);
        transcript.piCursor = { entryId: contextEntryId, index: -1 };
        transcript.prune();
        const base = transcript.document();
        stored = base.stored;
        return [{ type: "document.create", record: { id: documentId, ...ADDRESS }, content: base.content }];
      } });
    if (seeded.status !== "seeded" || !transcript) return undefined;
    transcript.stored = stored;
    return transcript;
  }

  /** A host transcript continuing `source`: the source is left behind, so its messages are shared rather than copied. */
  private static from(storage: Storage, source: Transcript, documentId: DocumentId, generationId: number, indexed?: number, bound?: number, legacy?: AppendLog<TranscriptRecord>) {
    const transcript = new NativeTranscript(storage, documentId, generationId, indexed, bound, legacy);
    const { context: messages, updates, awaiting, backlog, ...rest } = source.snapshot();
    transcript.restore({ ...rest, context: [...messages], updates: updates.map(update => ({ ...update })), awaiting: [...awaiting],
      ...(backlog ? { backlog: { ...backlog, messages: [...backlog.messages], sizes: [...backlog.sizes], turns: [...backlog.turns] } } : {}) });
    transcript.pin = source.pin;
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
  private document(): { content: Extract<DocumentContent, { kind: "base" }>; stored: Stored } {
    const snapshot = this.stateSnapshot();
    // Storage serializes (or clones) the value as it commits. Messages are never changed in place, so the base refers
    // to them, and its size is measured one message at a time rather than as one working-set-sized string.
    const context = [...snapshot.context];
    const fields = fieldsOf(snapshot);
    let base = 0;
    for (const message of context) base += JSON.stringify(message).length + 1;
    for (const text of fields.values()) base += text.length;
    return { content: { version: 1, kind: "base", value: { enabled: true, generation: this.generationId, snapshot: { ...snapshot, context } } as unknown as JsonObject },
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
        for (let record of records) {
          // Dual write (plans/host-transcript-removal.md, phase 1): what the host writes itself is in Pi's journal too,
          // in the same commit, so Pi's journal alone gives the history. A message the host writes (a repair, an input's
          // answer, a message that lands without a turn) is a native entry, which its record refers to; a retraction, a
          // turn's start or end, calls left waiting and journal messages skipped are markers.
          if (dualWrite && record.t === "message" && !record.pi) {
            const id = await this.storage.mintId<EntryId>(), message = record.message;
            // An answer to a call that waited on a person replaces Pi's input-required placeholder in its context.
            const placeholder = message.role === "toolResult" ? await this.placeholder(message.toolCallId) : undefined;
            writes.push({ type: "entry", value: { id, conversationId, ...(message.role === "user"
              ? { kind: HOST_USER_KIND, data: json({ message }), model: json([{ role: "user", content: message.content, timestamp: message.timestamp }]) }
              : { kind: HOST_MESSAGE_KIND, model: json([message]), ...(placeholder ? { edits: [{ target: placeholder, action: "omit" as const }] } : {}) }) } });
            record = { ...record, pi: { entryId: id, index: 0 } };
          } else if (dualWrite && record.t !== "message" && record.t !== "reset" && record.t !== "compaction" && record.t !== "system") {
            writes.push({ type: "entry", value: { id: await this.storage.mintId<EntryId>(), conversationId, kind: MARKER_KIND,
              data: json(record.t === "retract" ? { t: "retract", index: this.total - 1 } : record.t === "turn" ? { ...record, total: this.total }
                : record.t === "pi" ? { ...record, ...(this.piCursor ? { after: this.piCursor } : {}) } : record) } });
          }
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
  /** The journal's input-required placeholder for call `id`, read back from its end as far as the turn's start. */
  private async placeholder(id: string): Promise<EntryId | undefined> {
    let cursor: Cursor | undefined;
    do {
      const page = await this.storage.scanEntries({ conversationId, order: "descending" }, 64, cursor, context);
      for (const entry of page.items) {
        if (entry.kind === "pi.tool-result" && entry.model?.some(message => message.role === "toolResult" && message.toolCallId === id &&
          (message.details as { inputRequired?: boolean } | undefined)?.inputRequired)) return entry.id;
        if (entry.kind === "pi.assistant" && entry.model?.some(message => message.role === "assistant" && message.content.some(part => part.type === "toolCall" && part.id === id))) return undefined;
      }
      cursor = page.next;
    } while (cursor);
  }
  /**
   * Start the session's journal history (pi-durable/history.ts) where the host's stands now, once: a base marker with
   * its history's length, where it stands in the journal, and its turn. A session that has one keeps it. On the commit
   * line, so no record lands between what it counts and the marker; under the owner's claim, as every write.
   */
  writeBase(): Promise<boolean> {
    return this.enqueue(async () => {
      if (await JournalHistory.findBase(this.storage)) return false;
      const base: HistoryBase = { t: "base", total: this.total, ...(this.piCursor ? { through: this.piCursor } : {}), active: this.active, turnStart: this.turnStart, awaiting: [...this.awaiting], calls: [...this.calls] };
      try { await this.storage.commit([{ type: "entry", value: { id: await this.storage.mintId<EntryId>(), conversationId, kind: MARKER_KIND, data: json(base) } }], context); }
      catch (error) { this.failed = error; throw error; }
      return true;
    });
  }
  override replace(messages: Parameters<Transcript["replace"]>[0], active = this.active,
    compaction?: Parameters<Transcript["replace"]>[2]) {
    return this.commit(() => [{ t: "reset", messages, ...(compaction ? { compaction } : {}) }, { t: "turn", active }]);
  }
}
