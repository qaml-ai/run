import { HttpError } from "../http.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Cursor, DocumentId, EntryId, EntryRecord, Storage, StorageWrite } from "@earendil-works/pi-durable";
import { durableEntryMessages } from "./agent.ts";
import { HOST_BOOTSTRAP_KIND, SESSION_CONVERSATION_ID as conversationId } from "./seed.ts";
import { entryIds, type EntryIdLister } from "./storage.ts";
import { always } from "../assert.ts";
import { MARKER_KIND } from "./ordinals.ts";

/**
 * An agent's history as Pi's journal gives it (plans/host-transcript-removal.md): the messages before the session's
 * base marker are the history index's, and from there the journal's native messages, less what the host's markers take
 * back or skip, are the history's next ones.
 */
export type At = { entryId: number; index: number };
/**
 * The marker a session's journal history starts from: its history's length then, where in the journal it stood, and
 * its turn. `kept`: the messages just before it of the turn running or waiting on input (the index has only settled ones).
 */
export type HistoryBase = { t: "base"; total: number; through?: At; active: boolean; turnStart: number; awaiting: string[]; calls?: [string, number][]; kept?: AgentMessage[] };

/** The host's markers: `base`, `retract` (with the index it took back), `turn` (with the history's length), `awaiting`, and `pi` (a skip). */
export { MARKER_KIND };
/** A message the host wrote itself, as Pi's adapter writes a non-user message and a user one: history, and in Pi's context. */
export const HOST_MESSAGE_KIND = "camel.message", HOST_USER_KIND = "camel.user";
/** A system message the host declared (a configuration change, the output reminder): in Pi's context, never history. */
export const HOST_SYSTEM_KIND = "camel.system";
/** The session's newest base marker's entry (`JournalHistory.findBase` reads it rather than scan for the marker). */
export const BASE_ADDRESS = { kind: "camel.history.base", scope: { kind: "session" as const } };

/** The host transcript's state document and records (written by releases before its removal): read, never written, here. */
const SNAPSHOT_ADDRESS = { kind: "camel.host.snapshot", scope: { kind: "session" as const } };
const RECORD_KIND = "camel.host.record";
type Snapshot = { total: number; piCursor?: At; active: boolean; turnStart: number; awaiting?: string[]; calls?: [string, number][]; context?: AgentMessage[] };

/** How far back a refresh looks for an entry committed after a later one: more than either writer has in flight. */
const REORDER_WINDOW = 128;
/**
 * The most message JSON (in characters) one read of the history takes into memory: past it the read fails, rather than
 * the node running out of heap (2026-10-27: reads of whole running turns took nodes to their 2 GB limit, one after another).
 */
export const MESSAGES_READ_CHARS = 64 * 1024 * 1024;

/** Whether an entry can hold history messages (`durableEntryMessages` reads only these). */
const nativeKind = (entry: EntryRecord) => !!entry.model?.length && entry.kind !== "camel.legacy.context" && entry.kind !== "camel.context.message" && entry.kind !== HOST_SYSTEM_KIND;
const after = (a: At, b: At) => a.entryId > b.entryId || a.entryId === b.entryId && a.index > b.index;
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** The writes of a base marker `base` with entry ID `id`, and of the base document naming it (`document`: create it, or change it). */
export function baseWrites(id: EntryId, base: HistoryBase, document: { id: DocumentId; create: boolean }): StorageWrite[] {
  return [
    { type: "entry", value: { id, conversationId, kind: MARKER_KIND, data: json(base) as never } },
    document.create
      ? { type: "document.create", record: { id: document.id, ...BASE_ADDRESS }, content: { version: 1, kind: "base", value: { entry: id } } }
      : { type: "document.change", id: document.id, content: { version: 1, kind: "base", value: { entry: id } } },
  ];
}

/**
 * A history message the journal holds: where it is in the journal (`at`), or which of the base's `kept` messages it is
 * (the running turn's, from before the base); with its size (its JSON's length), for the history index's chunks.
 */
type Slot = { at: At; size: number } | { kept: number; size: number };

type Reader = Pick<Storage, "scanEntries" | "entry"> & Partial<Pick<Storage, "findDocument" | "document" | "conversation">> & Partial<EntryIdLister>;

export class JournalHistory {
  /** Messages in the history (after retractions); absolute indexes run 0 .. total - 1. */
  total: number;
  active: boolean;
  turnStart: number;
  awaiting: string[];
  /** Each history message the journal holds, from `heldFrom` on: `slots[i]` is the message at `heldFrom + i`. */
  private slots: Slot[];
  /** Where turns began (their first message's index), from the base on. */
  private turnStarts: number[] = [];
  /** Each tool call's assistant message index: those the base holds (its working set's), and those made since. */
  private calls = new Map<string, number>();
  readonly base: HistoryBase;
  readonly baseId: number;
  private lastId: number;
  /** The entries applied within the last REORDER_WINDOW IDs: one committed after a later one is found among them. */
  private applied = new Set<number>();
  /** Where the history's entries begin: the base's cursor's entry, or past the base. */
  private readonly startId: number;
  /** The read in progress: reads run one at a time, so each starts past what the one before took in. */
  private reading: Promise<void> = Promise.resolve();
  private readonly storage: Reader;

  private constructor(storage: Reader, base: HistoryBase, baseId: number) {
    this.storage = storage; this.base = base; this.baseId = baseId; this.lastId = baseId;
    this.startId = base.through ? base.through.entryId : baseId + 1;
    this.total = base.total; this.active = base.active; this.turnStart = base.turnStart; this.awaiting = [...base.awaiting];
    this.calls = new Map(base.calls ?? []);
    this.slots = this.keptSlots();
  }

  /** The slots of the base's `kept` messages. */
  private keptSlots(): Slot[] { return (this.base.kept ?? []).map((message, kept) => ({ kept, size: JSON.stringify(message).length })); }

  /** Back to the base, every entry since to be read again. */
  private reset() {
    this.lastId = this.baseId; this.applied.clear(); this.slots = this.keptSlots(); this.turnStarts = [];
    this.total = this.base.total; this.active = this.base.active; this.turnStart = this.base.turnStart; this.awaiting = [...this.base.awaiting];
    this.calls = new Map(this.base.calls ?? []);
  }

  /**
   * The session's newest base marker: the one its base document names, or (sessions from before the document) read back
   * from the journal's end to its host generation's start. Undefined if none.
   */
  static async findBase(storage: Reader): Promise<EntryRecord | undefined> {
    if (storage.conversation && !await storage.conversation(conversationId, context)) return undefined;
    const document = await storage.findDocument?.(BASE_ADDRESS, "current", context);
    if (document) {
      const id = ((await storage.document!(document.id, "current", context))?.value as { entry?: number } | undefined)?.entry;
      const found = id === undefined ? undefined : await storage.entry(conversationId, id as EntryId, context);
      if (!found) throw new Error("The session's base document names a marker its journal does not hold");
      return found.entry;
    }
    let cursor: Cursor | undefined;
    do {
      const page = await storage.scanEntries({ conversationId, order: "descending" }, 128, cursor, context);
      for (const entry of page.items) {
        if (entry.kind === MARKER_KIND && (entry.data as { t?: string } | undefined)?.t === "base") return entry;
        if (entry.kind === HOST_BOOTSTRAP_KIND) return undefined;
      }
      cursor = page.next;
    } while (cursor !== undefined);
  }

  /** The base document's ID, if the session has one. */
  static async baseDocument(storage: Pick<Storage, "findDocument">): Promise<DocumentId | undefined> {
    return (await storage.findDocument(BASE_ADDRESS, "current", context))?.id as DocumentId | undefined;
  }

  /** The journal history of a session with a base, read up to the journal's end; undefined for one without. */
  static async open(storage: Reader): Promise<JournalHistory | undefined> {
    const base = await JournalHistory.findBase(storage);
    if (!base) return undefined;
    return JournalHistory.from(storage, base.data as unknown as HistoryBase, base.id);
  }

  /**
   * Where a session the host transcript wrote stood as its last record was written: its last snapshot document's state
   * (the host wrote both in one commit), as a base, with the running turn's messages before it (`kept`), and the entry
   * of its newest record. Undefined for a session with no snapshot.
   */
  static async snapshotBase(storage: Pick<Storage, "scanEntries" | "findDocument" | "document">): Promise<{ base: HistoryBase; id: number; enabled: boolean; documentId: DocumentId; value: Record<string, unknown> } | undefined> {
    const document = await storage.findDocument(SNAPSHOT_ADDRESS, "current", context);
    const value = document && (await storage.document(document.id, "current", context))?.value as { enabled?: boolean; snapshot?: Snapshot } | undefined;
    const snapshot = value?.snapshot;
    if (!snapshot) return undefined;
    const last = await JournalHistory.lastRecord(storage);
    if (last === undefined) return undefined;
    const offset = snapshot.total - (snapshot.context?.length ?? 0);
    // A turn running, or waiting on a person's input, keeps its messages: the index has only settled ones.
    const kept = (snapshot.active || snapshot.awaiting?.length) && snapshot.context ? snapshot.context.slice(Math.max(0, snapshot.turnStart - offset)) : [];
    return { id: last, enabled: !!value.enabled, documentId: document!.id as DocumentId, value: value as Record<string, unknown>,
      base: { t: "base", total: snapshot.total, ...(snapshot.piCursor ? { through: snapshot.piCursor } : {}), active: snapshot.active,
        turnStart: snapshot.turnStart, awaiting: snapshot.awaiting ?? [], calls: snapshot.calls ?? [], ...(kept.length ? { kept } : {}) } };
  }

  /**
   * The journal history of any session: its base marker's, or, without one, the host's last snapshot document's (see
   * `snapshotBase`). Undefined for a session with neither.
   */
  static async openAny(storage: Pick<Storage, "scanEntries" | "entry" | "findDocument" | "document">): Promise<JournalHistory | undefined> {
    const marked = await JournalHistory.open(storage);
    if (marked) return marked;
    // A host transcript an earlier release disabled (a rollback to the legacy engine) is not where the history stands.
    const found = await JournalHistory.snapshotBase(storage);
    return found?.enabled ? JournalHistory.from(storage, found.base, found.id) : undefined;
  }

  /** The newest host record's entry, read back from the journal's end to its host generation's start. */
  private static async lastRecord(storage: Pick<Storage, "scanEntries">): Promise<number | undefined> {
    let cursor: Cursor | undefined;
    do {
      const page = await storage.scanEntries({ conversationId, order: "descending" }, 128, cursor, context);
      for (const entry of page.items) {
        if (entry.kind === RECORD_KIND) return entry.id;
        if (entry.kind === HOST_BOOTSTRAP_KIND) return entry.id;
      }
      cursor = page.next;
    } while (cursor !== undefined);
  }

  private static async from(storage: Reader, base: HistoryBase, baseId: number) {
    const history = new JournalHistory(storage, base, baseId);
    // Native messages the base did not count yet (between its cursor and the base itself) come first.
    await history.read(history.startId);
    return history;
  }

  /**
   * Take in what the journal committed since the last read. Callers overlap (parallel tool calls each ask for their
   * call's index): each read waits for the one before, as two reads from the same point would count its entries twice.
   */
  refresh() {
    const next = this.reading.catch(() => {}).then(() => this.catchUp());
    this.reading = next;
    return next;
  }

  /**
   * One refresh, on the reading line. Pi and the host take entry IDs from one sequence but commit on their own, so an
   * entry can land after one with a later ID that a read already took in: the recent IDs are listed again (IDs only,
   * not their records), and one not taken in yet means reading the history again from its base, in ID order (a
   * retraction or skip applies to what precedes it).
   */
  private async catchUp() {
    const recent = await entryIds(this.storage, conversationId, Math.max(this.startId, this.lastId - REORDER_WINDOW + 1), this.lastId);
    if (recent.some(id => id < this.lastId && !this.applied.has(id))) {
      this.reset();
      await this.read(this.startId);
      return;
    }
    await this.read(this.lastId + 1);
  }

  private async read(from: number) {
    let cursor: Cursor | undefined;
    do {
      const page = await this.storage.scanEntries({ conversationId, order: "ascending", minEntryId: from as EntryId }, 256, cursor, context);
      for (const entry of page.items) this.apply(entry);
      cursor = page.next;
    } while (cursor !== undefined);
    for (const id of this.applied) if (id <= this.lastId - REORDER_WINDOW) this.applied.delete(id);
  }

  private apply(entry: EntryRecord) {
    // Each entry counts once, whatever reads it.
    if (this.applied.has(entry.id)) return;
    this.applied.add(entry.id);
    this.lastId = Math.max(this.lastId, entry.id);
    if (entry.kind === MARKER_KIND) {
      // Markers count from the base on; those before it are in its counts.
      if (entry.id <= this.baseId) return;
      const marker = entry.data as { t: string; active?: boolean; calls?: string[]; released?: boolean; cursor?: At; after?: At };
      if (marker.t === "retract") this.pop();
      else if (marker.t === "turn") {
        this.active = !!marker.active;
        if (marker.active) { this.turnStart = this.total; this.turnStarts.push(this.total); }
      }
      else if (marker.t === "awaiting" && marker.calls) {
        this.awaiting = marker.released ? this.awaiting.filter(id => !marker.calls!.includes(id)) : [...this.awaiting, ...marker.calls.filter(id => !this.awaiting.includes(id))];
      } else if (marker.t === "pi" && marker.cursor) {
        // Journal messages the host skipped (Pi's results for an interrupted run it discarded): not history.
        const kept = this.slots.filter(slot => !("at" in slot) || (marker.after && !after(slot.at, marker.after)) || after(slot.at, marker.cursor!));
        this.total -= this.slots.length - kept.length;
        this.slots = kept;
        this.forgetCallsFrom(this.total);
      }
      return;
    }
    for (const item of durableEntryMessages(entry)) {
      if (this.base.through && !after(item.cursor, this.base.through)) continue;
      const index = this.total++;
      this.slots.push({ at: item.cursor, size: JSON.stringify(item.message).length });
      if (item.message.role === "assistant") for (const part of item.message.content) if (part.type === "toolCall") this.calls.set(part.id, index);
      if (item.message.role === "toolResult") this.awaiting = this.awaiting.filter(id => id !== (item.message as { toolCallId: string }).toolCallId);
    }
  }

  private pop() {
    // A retraction takes back the running turn's latest message: never one the index holds.
    always(this.total > this.heldFrom, "a retraction takes back a message the journal holds");
    this.total--;
    if (this.total >= this.heldFrom) this.slots.pop();
    this.forgetCallsFrom(this.total);
  }

  /** Calls made by messages at `index` or later, which are no longer history. */
  private forgetCallsFrom(index: number) {
    for (const [id, at] of this.calls) if (at >= index) this.calls.delete(id);
  }

  /** The history's length at its base: messages before it are the history index's, with no journal cursor here. */
  get baseTotal() { return this.base.total; }

  /** The newest history message's journal cursor, else the base's. */
  get latest(): At | undefined {
    for (let index = this.slots.length - 1; index >= 0; index--) { const slot = this.slots[index]; if ("at" in slot) return slot.at; }
    return this.base.through;
  }

  /** The journal cursors of the history messages after `from` (all, without it) up to `to`: what a skip of them takes. */
  cursorsBetween(from: At | undefined, to: At): At[] {
    return this.slots.flatMap(slot => "at" in slot && (!from || after(slot.at, from)) && !after(slot.at, to) ? [slot.at] : []);
  }

  /** The journal cursor of the history message at absolute index `index`, if the journal has one for it. */
  cursorAt(index: number): At | undefined {
    const slot = index >= this.heldFrom && index < this.total ? this.slots[index - this.heldFrom] : undefined;
    return slot && "at" in slot ? slot.at : undefined;
  }

  /** Where turns began, among the history's messages from absolute index `from` on. */
  turnsFrom(from: number): number[] { return this.turnStarts.filter(turn => turn >= from && turn < this.total); }

  /** The index of the assistant message that made call `id`, if the base holds it or it was made since. */
  callIndex(id: string): number | undefined { return this.calls.get(id); }

  /** Where the messages the journal holds begin: the base, less the running turn's messages it keeps. */
  get heldFrom() { return this.base.total - (this.base.kept?.length ?? 0); }

  /**
   * The history's messages from absolute index `from` to `to` (its end by default), when the journal has them all (from
   * the base on, and the running turn's before it).
   */
  async messagesFrom(from: number, to = this.total): Promise<AgentMessage[] | undefined> {
    if (from < this.heldFrom || from > to || to > this.total) return undefined;
    const chars = this.slots.slice(from - this.heldFrom, to - this.heldFrom).reduce((sum, slot) => sum + slot.size, 0);
    if (chars > MESSAGES_READ_CHARS) throw new HttpError(413, `History messages ${from} to ${to} are ${chars} characters, past the ${MESSAGES_READ_CHARS} one read takes. Full-history reads and forks are limited; read it in pages with limit/before/maxBytes.`);
    const messages: AgentMessage[] = [];
    const entries = new Map<number, ReturnType<typeof durableEntryMessages>>();
    const slots = this.slots.slice(from - this.heldFrom, to - this.heldFrom);
    const ids = slots.flatMap(slot => "at" in slot ? [slot.at.entryId] : []);
    // Many messages are read as one scan of their entries' range, rather than an entry at a time.
    if (ids.length > 8) {
      let cursor: Cursor | undefined;
      do {
        const page = await this.storage.scanEntries({ conversationId, order: "ascending", minEntryId: ids[0] as EntryId, maxEntryId: ids.at(-1) as EntryId }, 256, cursor, context);
        for (const entry of page.items) if (nativeKind(entry)) entries.set(entry.id, durableEntryMessages(entry));
        cursor = page.next;
      } while (cursor !== undefined);
    }
    for (const slot of slots) {
      if (!("at" in slot)) { messages.push(this.base.kept![slot.kept]); continue; }
      const at = slot.at;
      if (!entries.has(at.entryId)) {
        const found = await this.storage.entry(conversationId, at.entryId as EntryId, context);
        entries.set(at.entryId, found ? durableEntryMessages(found.entry) : []);
      }
      const message = entries.get(at.entryId)!.find(item => item.cursor.index === at.index)?.message;
      if (!message) return undefined;
      messages.push(message);
    }
    return messages;
  }

  /**
   * A base where the history stands now, to start later reads from: only between turns, so it holds no turn, calls or
   * messages of one. Undefined while a turn runs or waits on input.
   */
  settledBase(): HistoryBase | undefined {
    if (this.active || this.awaiting.length) return undefined;
    const through = this.latest;
    return { t: "base", total: this.total, ...(through ? { through } : {}), active: false, turnStart: this.turnStart, awaiting: [] };
  }
}
