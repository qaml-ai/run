import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Cursor, EntryId, EntryRecord, Storage } from "@earendil-works/pi-durable";
import { durableEntryMessages } from "./agent.ts";
import { HOST_BOOTSTRAP_KIND, LEGACY_CONVERSATION_ID as conversationId } from "./migration.ts";
import { MARKER_KIND } from "./transcript.ts";

/**
 * An agent's history as Pi's journal gives it (plans/host-transcript-removal.md, phase 2): the messages before the
 * session's base (`camel.history.base`, written once as its reads move to the journal) are the history index's, and
 * from there the journal's native messages, less what its markers take back or skip, are the history's next ones. The
 * host transcript is still written, and is what callers fall back to where the two disagree.
 */
export type At = { entryId: number; index: number };
/** The marker that starts a session's journal history: the host's history then, and where in the journal it stood. */
export type HistoryBase = { t: "base"; total: number; through?: At; active: boolean; turnStart: number; awaiting: string[]; calls?: [string, number][] };

/** How far back a read looks for an entry committed after a later one: more than either writer has in flight. */
const REORDER_WINDOW = 128;

const after = (a: At, b: At) => a.entryId > b.entryId || a.entryId === b.entryId && a.index > b.index;

export class JournalHistory {
  /** Messages in the history (after retractions); absolute indexes run 0 .. total - 1. */
  total: number;
  active: boolean;
  turnStart: number;
  awaiting: string[];
  /** The journal cursor of each history message from the base on: `cursors[i]` is the message at `base.total + i`. */
  private cursors: At[] = [];
  /** Each tool call's assistant message index: those the base holds (its working set's), and those made since. */
  private calls = new Map<string, number>();
  private readonly base: HistoryBase;
  private readonly baseId: number;
  private lastId: number;
  /** The entries applied within the last REORDER_WINDOW IDs: one committed after a later one is found among them. */
  private applied = new Set<number>();
  /** Where the history's entries begin: the base's cursor's entry, or past the base. */
  private readonly startId: number;
  private readonly storage: Pick<Storage, "scanEntries" | "entry">;

  private constructor(storage: Pick<Storage, "scanEntries" | "entry">, base: HistoryBase, baseId: number) {
    this.storage = storage; this.base = base; this.baseId = baseId; this.lastId = baseId;
    this.startId = base.through ? base.through.entryId : baseId + 1;
    this.total = base.total; this.active = base.active; this.turnStart = base.turnStart; this.awaiting = [...base.awaiting];
    this.calls = new Map(base.calls ?? []);
  }

  /** Back to the base, every entry since to be read again. */
  private reset() {
    this.lastId = this.baseId; this.applied.clear(); this.cursors = [];
    this.total = this.base.total; this.active = this.base.active; this.turnStart = this.base.turnStart; this.awaiting = [...this.base.awaiting];
    this.calls = new Map(this.base.calls ?? []);
  }

  /** The session's base marker, read back from the journal's end to its host generation's start; undefined if none. */
  static async findBase(storage: Pick<Storage, "scanEntries">): Promise<EntryRecord | undefined> {
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

  /** The journal history of a session with a base, read up to the journal's end; undefined for one without. */
  static async open(storage: Pick<Storage, "scanEntries" | "entry">): Promise<JournalHistory | undefined> {
    const base = await JournalHistory.findBase(storage);
    if (!base) return undefined;
    const history = new JournalHistory(storage, base.data as unknown as HistoryBase, base.id);
    // Native messages the base did not count yet (between its cursor and the base itself) come first.
    await history.read(history.startId);
    return history;
  }

  /**
   * Take in what the journal committed since the last read. Pi and the host take entry IDs from one sequence but
   * commit on their own, so an entry can land after one with a later ID that a read already took in: the recent IDs
   * are read again, and one not taken in yet means reading the history again from its base, in ID order (a retraction
   * or skip applies to what precedes it).
   */
  async refresh() {
    const late = (await this.entries(Math.max(this.startId, this.lastId - REORDER_WINDOW + 1))).some(entry => entry.id < this.lastId && !this.applied.has(entry.id));
    if (late) { this.reset(); await this.read(this.startId); return; }
    await this.read(this.lastId + 1);
  }

  private async entries(from: number) {
    const items: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page = await this.storage.scanEntries({ conversationId, order: "ascending", minEntryId: from as EntryId, maxEntryId: this.lastId as EntryId }, 256, cursor, context);
      items.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    return items;
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
    this.lastId = Math.max(this.lastId, entry.id);
    this.applied.add(entry.id);
    if (entry.kind === MARKER_KIND) {
      // Markers count from the base on; those before it are in its counts.
      if (entry.id <= this.baseId) return;
      const marker = entry.data as { t: string; active?: boolean; calls?: string[]; released?: boolean; cursor?: At; after?: At };
      if (marker.t === "retract") this.pop();
      else if (marker.t === "turn") { this.active = !!marker.active; if (marker.active) this.turnStart = this.total; }
      else if (marker.t === "awaiting" && marker.calls) {
        this.awaiting = marker.released ? this.awaiting.filter(id => !marker.calls!.includes(id)) : [...this.awaiting, ...marker.calls.filter(id => !this.awaiting.includes(id))];
      } else if (marker.t === "pi" && marker.cursor) {
        // Journal messages the host skipped (Pi's results for an interrupted run it discarded): not history.
        const kept = this.cursors.filter(at => (marker.after && !after(at, marker.after)) || after(at, marker.cursor!));
        this.total -= this.cursors.length - kept.length;
        this.cursors = kept;
        this.forgetCallsFrom(this.total);
      }
      return;
    }
    for (const item of durableEntryMessages(entry)) {
      if (this.base.through && !after(item.cursor, this.base.through)) continue;
      const index = this.total++;
      this.cursors.push(item.cursor);
      if (item.message.role === "assistant") for (const part of item.message.content) if (part.type === "toolCall") this.calls.set(part.id, index);
      if (item.message.role === "toolResult") this.awaiting = this.awaiting.filter(id => id !== (item.message as { toolCallId: string }).toolCallId);
    }
  }

  private pop() {
    this.total--;
    if (this.total >= this.base.total) this.cursors.pop();
    this.forgetCallsFrom(this.total);
  }

  /** Calls made by messages at `index` or later, which are no longer history. */
  private forgetCallsFrom(index: number) {
    for (const [id, at] of this.calls) if (at >= index) this.calls.delete(id);
  }

  /** The index of the assistant message that made call `id`, if the base holds it or it was made since. */
  callIndex(id: string): number | undefined { return this.calls.get(id); }

  /** The history's messages from absolute index `from` to its end, when the journal has them all (from the base on). */
  async messagesFrom(from: number): Promise<AgentMessage[] | undefined> {
    if (from < this.base.total || from > this.total) return undefined;
    const wanted = this.cursors.slice(from - this.base.total, this.total - this.base.total);
    const messages: AgentMessage[] = [];
    const entries = new Map<number, ReturnType<typeof durableEntryMessages>>();
    for (const at of wanted) {
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
}
