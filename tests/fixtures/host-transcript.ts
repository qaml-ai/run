/**
 * The host transcript as releases before its removal wrote it (src/transcript.ts, src/pi-durable/transcript.ts and the
 * host generation's seed in src/pi-durable/seed.ts at 6694b002), verbatim but for imports and what only its own reads
 * used: sessions in production are in this format until their first load retires it (`HostJournal.retire`), and tests
 * write them with this. With `setDualWrite(true)`, as production ran: what the host wrote went into Pi's journal too.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, SystemMessage } from "@earendil-works/pi-ai";
import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Op } from "@earendil-works/chord/delta";
import type { JsonObject, Storage, StorageWrite, DocumentId, DocumentContent, EntryId, EntryRecord, Cursor } from "@earendil-works/pi-durable";
import { createHash } from "node:crypto";
import type { AppendLog } from "../../shared/append-log.ts";
import { convertToLlm, createCompactionSummaryMessage } from "../../src/pi-harness/messages.ts";
import { durableEntryMessages } from "../../src/pi-durable/agent.ts";
import { retireHostTranscript } from "./retired-host.ts";
import { JournalHistory, MARKER_KIND, HOST_MESSAGE_KIND, HOST_USER_KIND, type HistoryBase } from "../../src/pi-durable/history.ts";
import { contextWrites, loadSeedMarker, SeedConflict, SEED_MARKER_KIND, SESSION_CONVERSATION_ID, HOST_ARCHIVE_KIND, HOST_BOOTSTRAP_KIND, type SeedMetadata } from "../../src/pi-durable/seed.ts";
import { commitWrites } from "@earendil-works/pi-durable/testing";
const conversationId = SESSION_CONVERSATION_ID, ARCHIVE = HOST_ARCHIVE_KIND, BOOTSTRAP = HOST_BOOTSTRAP_KIND;
const VERSION = 1;
const ARCHIVE_BLOCK_RECORDS = 128;
/** What a seed copies at most. A fork's larger source keeps its archive in the fork's legacy log (`reference`). */
export const SEED_MAX_BYTES = 64 * 1024 * 1024;
export const SEED_MAX_RECORDS = 200_000;
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const payload = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;


/** A compaction: `summary` replaces every message before absolute index `cut`. */
export interface CompactionState {
  summary: string;
  cut: number;
  tokensBefore: number;
  details?: unknown;
  at: number;
}

/** A model message's stable location in Pi's durable journal, also kept with its projection. */
export type PiMessageCursor = { entryId: number; index: number };

/** Native Pi messages, appended as each one ends; never re-serialized per delta. */
export type TranscriptRecord =
  | { t: "message"; message: AgentMessage; pi?: PiMessageCursor }
  /** Native execution records already projected, including intentionally suppressed abort results. */
  | { t: "pi"; cursor: PiMessageCursor }
  /** Drops the latest message: a provider error that was retried. */
  | { t: "retract" }
  | { t: "turn"; active: boolean }
  /**
   * Tool calls a suspended turn leaves open until a person answers (inputs.ts): no result is written
   * for them meanwhile, and a reload does not close them. `released` hands them back to the running
   * turn, just before an approved call runs, so a crash then closes them as unknown like any call.
   */
  | { t: "awaiting"; calls: string[]; released?: true }
  /** Replaces all earlier messages (import, or folding the log). */
  | { t: "reset"; messages: AgentMessage[]; compaction?: CompactionState }
  /**
   * The runtime's system messages, never a tenant's. `leading` pins the context's first one, the
   * provider's cached prefix; any other changes the prompt or tools from this point in the conversation.
   */
  | { t: "system"; message: SystemMessage; leading?: true }
  /**
   * The model's context from now on is `summary` plus messages from index `cut`. `system` is the
   * leading system message with every change before the cut folded in.
   */
  | ({ t: "compaction"; system?: SystemMessage } & CompactionState);

export function historyOf(records: TranscriptRecord[]): AgentMessage[] {
  let messages: AgentMessage[] = [];
  for (const record of records) {
    if (record.t === "message") messages.push(record.message);
    else if (record.t === "retract") messages.pop();
    else if (record.t === "reset") messages = [...record.messages];
  }
  return messages;
}

/**
 * Messages the agent's history index (history-pages.ts) does not have yet, from absolute index
 * `from` on, and where runs began among them (`turn` records). Memory holds those from `kept` on,
 * with each one's size; the ones before it (more than a backlog holds) are read from the log.
 */
export interface Backlog { from: number; kept: number; messages: AgentMessage[]; sizes: number[]; bytes: number; turns: number[] }

/** An owner's reduced transcript for initializing an agent process, rather than sending its entire log over IPC. */
export type TranscriptSnapshot = Pick<Transcript, "context" | "total" | "compaction" | "system" | "updates" | "active" | "turnStart" | "awaiting" | "backlog" | "piCursor"> & {
  requests: string[];
  calls: [string, number][];
};

/** The most a backlog holds in memory by default; past it, what it holds is left to the log. */
export const BACKLOG_BYTES = 8_000_000;

/** Where conversational turns begin in `messages` (absolute index `from` on) without turn records: at a user message after anything else, and at 0. */
function userTurns(from: number, messages: AgentMessage[]) {
  return messages.flatMap((message, index) => message.role === "user" && (from + index === 0 || messages[index - 1]?.role !== "user") ? [from + index] : []);
}

/**
 * The agent's working set: the latest compaction summary plus the messages after
 * its cut. Earlier messages stay in the log (for history) but not in memory, so
 * message bodies retained between runs do not grow with its age. Reload still scans the log; request and call IDs
 * are retained for deduplication and call identity even after their messages have been compacted.
 */
/** The request a user message was sent by, if it names one. */
const requestOf = (message: AgentMessage) => message.role === "user" ? (message as { requestId?: string }).requestId : undefined;
/** The ids of the tool calls an assistant message makes. */
const callsOf = (message: AgentMessage) => message.role === "assistant" ? message.content.flatMap(part => part.type === "toolCall" ? [part.id] : []) : [];

export class Transcript {
  /** Messages at absolute indexes `offset` .. `total - 1`. */
  context: AgentMessage[] = [];
  /** Messages ever recorded (after retractions); absolute indexes run 0 .. total - 1. */
  total = 0;
  compaction?: CompactionState;
  /** The pinned leading system message; until a change needs one, it is built from configuration. */
  system?: SystemMessage;
  /**
   * The leading system message as the model sees it now, pinned with the first message written while none is: from
   * then on a change of configuration (mounts, prompt, tools) follows as a system message of its own instead of
   * rebuilding the leading one, so the provider's cached prefix holds.
   */
  pin?: () => SystemMessage | undefined;
  /** Later system messages, each placed before the message at absolute index `at`. */
  updates: { at: number; message: SystemMessage }[] = [];
  /** A turn was running when the log was last written. */
  active = false;
  /** `total` when the running turn started. */
  turnStart = 0;
  /** Tool calls waiting on a person's input, in the order they were suspended. */
  awaiting: string[] = [];
  /** The requests whose user messages the whole log holds (compacted ones included): a request's message is taken once. */
  requests = new Set<string>();
  /** Each tool call id, and the index of the latest assistant message that made a call with it, over the whole log. */
  calls = new Map<string, number>();
  /** The latest native Pi message copied to this transcript; survives retractions. */
  piCursor?: PiMessageCursor;
  /** What the history index lacks, kept while this transcript is written; undefined when nothing indexes it. */
  backlog?: Backlog;
  readonly log: AppendLog<TranscriptRecord>;
  /** Past this many bytes, the backlog's messages are left to the log (see `Backlog`). */
  private readonly bound: number;
  /** `indexed`: how many messages the history index has; this transcript then keeps the ones after as `backlog`. */
  constructor(log: AppendLog<TranscriptRecord>, indexed?: number, bound = BACKLOG_BYTES) {
    this.log = log;
    this.bound = bound;
    if (indexed !== undefined) this.backlog = { from: indexed, kept: indexed, messages: [], sizes: [], bytes: 0, turns: [] };
  }

  /** The history index now has messages up to `indexed`: they leave the backlog. */
  indexed(indexed: number) {
    const backlog = this.backlog;
    if (!backlog || indexed <= backlog.from) return;
    const taken = Math.max(0, Math.min(indexed - backlog.kept, backlog.messages.length));
    backlog.messages.splice(0, taken);
    for (const size of backlog.sizes.splice(0, taken)) backlog.bytes -= size;
    backlog.from = indexed;
    backlog.kept = Math.max(backlog.kept, indexed);
    backlog.turns = backlog.turns.filter(turn => turn >= indexed);
  }

  /** Leave what the backlog holds to the log: memory keeps only messages from here on. */
  private spill(backlog: Backlog) {
    backlog.kept += backlog.messages.length;
    backlog.messages = [];
    backlog.sizes = [];
    backlog.bytes = 0;
  }

  get offset() { return this.total - this.context.length; }

  /** What the model sees after the leading system message: the summary, and the kept messages with later system messages in place. */
  view(): AgentMessage[] {
    const view: AgentMessage[] = this.compaction ? [summaryMessage(this.compaction)] : [];
    let next = 0;
    this.context.forEach((message, index) => {
      for (; next < this.updates.length && this.updates[next].at <= this.offset + index; next++) view.push(this.updates[next].message);
      view.push(message);
    });
    for (; next < this.updates.length; next++) view.push(this.updates[next].message);
    return view;
  }

  async hasRequest(requestId: string) { return this.requests.has(requestId); }

  async load() {
    for (const record of await this.log.read()) this.apply(record);
  }

  snapshot(): TranscriptSnapshot {
    const { context, total, compaction, system, updates, active, turnStart, awaiting, backlog, piCursor } = this;
    return { context, total, compaction, system, updates, active, turnStart, awaiting, backlog, ...(piCursor ? { piCursor } : {}), requests: [...this.requests], calls: [...this.calls] };
  }

  restore({ requests, calls, ...state }: TranscriptSnapshot) {
    Object.assign(this, state);
    this.requests = new Set(requests);
    this.calls = new Map(calls);
  }

  apply(record: TranscriptRecord) {
    const backlog = this.backlog;
    if (record.t === "message") {
      if (record.pi) this.piCursor = record.pi;
      if (backlog && this.total >= backlog.kept + backlog.messages.length) {
        const size = JSON.stringify(record.message).length;
        backlog.messages.push(record.message);
        backlog.sizes.push(size);
        backlog.bytes += size;
        if (backlog.bytes > this.bound) this.spill(backlog);
      }
      this.context.push(record.message);
      this.total++;
      const request = requestOf(record.message);
      if (request) this.requests.add(request);
      for (const id of callsOf(record.message)) this.calls.set(id, this.total - 1);
      if (record.message.role === "toolResult") this.awaiting = this.awaiting.filter(id => id !== (record.message as { toolCallId: string }).toolCallId);
    }
    else if (record.t === "pi") this.piCursor = record.cursor;
    else if (record.t === "retract") {
      const popped = this.context.pop();
      if (popped) {
        const request = requestOf(popped);
        if (request) this.requests.delete(request);
        for (const id of callsOf(popped)) if (this.calls.get(id) === this.total - 1) this.calls.delete(id);
        this.total--;
        if (backlog && this.total >= backlog.kept && this.total === backlog.kept + backlog.messages.length - 1) {
          backlog.messages.pop();
          backlog.bytes -= backlog.sizes.pop()!;
        } else if (backlog && this.total < backlog.kept) backlog.kept = Math.max(backlog.from, this.total);
      }
      for (const update of this.updates) update.at = Math.min(update.at, this.total);
    }
    else if (record.t === "turn") {
      this.active = record.active;
      if (record.active) this.turnStart = this.total;
      if (record.active && backlog && this.total >= backlog.from) backlog.turns.push(this.total);
    }
    else if (record.t === "awaiting") this.awaiting = record.released ? this.awaiting.filter(id => !record.calls.includes(id)) : [...this.awaiting, ...record.calls.filter(id => !this.awaiting.includes(id))];
    else if (record.t === "reset") {
      if (backlog) {
        // A reset is an import into an empty transcript: its messages have no turn records.
        const messages = record.messages.slice(backlog.from);
        backlog.kept = backlog.from;
        backlog.messages = messages;
        backlog.sizes = messages.map(message => JSON.stringify(message).length);
        backlog.bytes = backlog.sizes.reduce((sum, size) => sum + size, 0);
        backlog.turns = userTurns(backlog.from, messages);
        if (backlog.bytes > this.bound) this.spill(backlog);
      }
      this.total = record.messages.length;
      this.requests = new Set(record.messages.map(requestOf).filter((request): request is string => !!request));
      this.calls = new Map(record.messages.flatMap((message, index) => callsOf(message).map(id => [id, index] as const)));
      this.compaction = record.compaction;
      this.context = record.messages.slice(record.compaction?.cut ?? 0);
      this.system = undefined;
      this.updates = [];
      this.awaiting = [];
    } else if (record.t === "system") {
      if (record.leading) { this.system = record.message; this.updates = []; }
      else this.updates.push({ at: this.total, message: record.message });
    } else if (record.t === "compaction") {
      const { t: _type, system, ...state } = record;
      if (state.cut < this.offset || state.cut > this.total) throw new Error(`Compaction cut ${state.cut} is outside the working set (${this.offset}..${this.total})`);
      this.context = this.context.slice(state.cut - this.offset);
      this.compaction = state;
      if (system) this.system = system;
      this.updates = this.updates.filter(update => update.at > state.cut);
    } else throw new Error(`Unknown transcript record: ${(record as { t: string }).t}`);
  }

  /** The commit line: one write at a time, in order. */
  private line: Promise<unknown> = Promise.resolve();
  /** Why a write failed. The log may hold part of what it wrote, so nothing more is written: only a reload knows what it holds. */
  failed?: unknown;

  /** Run `job` on the commit line, once every earlier commit has settled; none runs after a failed write. */
  protected enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.line.then(() => {
      if (this.failed !== undefined) throw this.failed;
      return job();
    });
    this.line = run.catch(() => {});
    return run;
  }

  /**
   * Commit the records `change` gives as of every earlier commit: they are written durably, then applied, so memory
   * (and what the agent acts on) never holds what the log may not. A failed write leaves memory as it was, and every
   * later commit fails with it. `change` may give none, to write nothing.
   */
  commit(change: () => TranscriptRecord[]): Promise<void> {
    return this.enqueue(async () => {
      const records = change();
      if (!records.length) return;
      for (const record of records) this.log.append(record);
      try { await this.log.flush(true); }
      catch (error) { this.failed = error; throw error; }
      for (const record of records) this.apply(record);
    });
  }

  push(message: AgentMessage, pi?: PiMessageCursor) {
    if (!pi) return this.append([message]);
    return this.commit(() => {
      const leading = !this.system ? this.pin?.() : undefined;
      return [...(leading ? [{ t: "system" as const, message: leading, leading: true as const }] : []), { t: "message" as const, message, pi }];
    });
  }
  append(messages: AgentMessage[]) {
    return this.commit(() => {
      const leading = !this.system && messages.length ? this.pin?.() : undefined;
      return [...(leading ? [{ t: "system" as const, message: leading, leading: true as const }] : []), ...messages.map(message => ({ t: "message" as const, message }))];
    });
  }
  retract() { return this.commit(() => [{ t: "retract" }]); }
  setActive(active: boolean) { return this.commit(() => [{ t: "turn", active }]); }
  /** Leave tool calls open for a person's input, or (`released`) give them back to the turn. */
  await(calls: string[], released = false) { return this.commit(() => [{ t: "awaiting", calls, ...(released ? { released: true as const } : {}) }]); }
  /**
   * Change the prompt or tools from here on, after the leading system message, pinning `leading` as it first when
   * nothing has been pinned yet: one commit, so a node reloading the agent rebuilds the same context.
   */
  declareSystem(message: SystemMessage, leading: SystemMessage) {
    return this.commit(() => [...(this.system ? [] : [{ t: "system" as const, message: leading, leading: true as const }]), { t: "system", message }]);
  }

  /**
   * Replace the messages before `state.cut` with its summary, only onto the working set it summarized: `previous` still
   * the latest summary, and the cut within what history holds. System messages before the cut fold into the leading one
   * (`fold`). Whether it was written, and the system messages it folded.
   */
  async compact(state: CompactionState, previous: CompactionState | undefined, fold: (changes: SystemMessage[]) => SystemMessage | undefined) {
    let folded: SystemMessage[] | undefined;
    await this.commit(() => {
      if (this.compaction !== previous || state.cut < this.offset || state.cut > this.total) return [];
      folded = this.updates.filter(update => update.at <= state.cut).map(update => update.message);
      const system = folded.length ? fold(folded) : undefined;
      return [{ t: "compaction", ...state, ...(system ? { system } : {}) }];
    });
    return folded;
  }

  /** Atomically replace the history (imports), folding the log to a single snapshot record. */
  replace(messages: AgentMessage[], active = this.active, compaction?: CompactionState) {
    return this.enqueue(async () => {
      const reset = { t: "reset" as const, messages: [...messages], ...(compaction ? { compaction } : {}) };
      try { await this.log.rewrite(() => [reset, ...(active ? [{ t: "turn" as const, active: true }] : [])]); }
      catch (error) { this.failed = error; throw error; }
      this.apply(reset);
      this.active = active;
    });
  }
}

export function summaryMessage(state: CompactionState): AgentMessage {
  return createCompactionSummaryMessage(state.summary, state.tokensBefore, new Date(state.at).toISOString()) as AgentMessage;
}

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


/** `records` applied to a transcript that writes nothing: it refers to their own message objects. */
export function reducedTranscript(records: readonly TranscriptRecord[]) {
  const transcript = new Transcript({ read: async () => [...records] } as AppendLog<TranscriptRecord>);
  for (const record of records) transcript.apply(record);
  return transcript;
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
    await commitWrites(storage, writes, context);
    // The commit is atomic: reading back its marker confirms it landed.
    const landed = await loadSeedMarker(storage, context);
    if (!landed || !same(landed, metadata)) throw new SeedConflict("the persisted seed marker differs from the source");
    return { ...metadata, status: "seeded" as const };
  });
  lines.set(storage, run);
  try { return await run; }
  finally { if (lines.get(storage) === run) lines.delete(storage); }
}


const ADDRESS = { kind: "camel.host.snapshot", scope: { kind: "session" as const } };
const RECORD = "camel.host.record", DISABLED = "camel.host.disabled";
/** Phase 1's native entries: a message the host wrote, as Pi's adapter writes a non-user message and a user one. */
/** Phase 1's markers: `retract` (with the index it took back), `turn` (with the history's length), `awaiting`, and `pi` (a skip). */
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
        await commitWrites(this.storage, writes, context);
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
      try { await commitWrites(this.storage, [{ type: "entry", value: { id: await this.storage.mintId<EntryId>(), conversationId, kind: MARKER_KIND, data: json(base) } }], context); }
      catch (error) { this.failed = error; throw error; }
      return true;
    });
  }
  override replace(messages: Parameters<Transcript["replace"]>[0], active = this.active,
    compaction?: Parameters<Transcript["replace"]>[2]) {
    return this.commit(() => [{ t: "reset", messages, ...(compaction ? { compaction } : {}) }, { t: "turn", active }]);
  }
}

/**
 * A session as a release before the host transcript's removal left it (`NativeTranscript.seed`): its Pi storage at
 * `location`, seeded with `records` (an import's, or a fork's), with `setDualWrite`'s setting, and retired (`unretired`: as it
 * was left, which this release refuses).
 */
export async function hostTranscriptSession(location: Parameters<typeof import("../../src/pi-durable/storage.ts").openPiStorage>[0], records: TranscriptRecord[], options: { legacy?: AppendLog<TranscriptRecord>; leadingSystem?: SystemMessage; unretired?: boolean; index?: Parameters<typeof retireHostTranscript>[1] } = {}) {
  const { openPiStorage } = await import("../../src/pi-durable/storage.ts");
  const storage = await openPiStorage(location);
  try {
    if (options.legacy) await options.legacy.rewrite(() => records);
    const seeded = await NativeTranscript.seed(storage, { sessionId: location.sessionId, records, ...(options.legacy ? { legacy: options.legacy } : {}), ...(options.leadingSystem ? { leadingSystem: options.leadingSystem } : {}) });
    if (!seeded) throw new Error("The session was seeded already");
    // Retired, as releases that read the host transcript did at its first load; this release refuses one that is not.
    if (!options.unretired) await retireHostTranscript(storage, { ...options.index ? options.index : {}, ...(options.legacy ? { legacy: () => options.legacy!.read() as never } : {}) });
    return seeded;
  } finally { await storage.close(BACKGROUND_CONTEXT); }
}
