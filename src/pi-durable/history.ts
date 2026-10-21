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
  private readonly storage: Pick<Storage, "scanEntries" | "entry">;

  private constructor(storage: Pick<Storage, "scanEntries" | "entry">, base: HistoryBase, baseId: number) {
    this.storage = storage; this.base = base; this.baseId = baseId; this.lastId = baseId;
    this.total = base.total; this.active = base.active; this.turnStart = base.turnStart; this.awaiting = [...base.awaiting];
    this.calls = new Map(base.calls ?? []);
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
    if (history.base.through) await history.read(history.base.through.entryId, true);
    else await history.read(base.id, false);
    return history;
  }

  /** Take in what the journal committed since the last read. */
  refresh() { return this.read(this.lastId, false); }

  private async read(from: number, inclusive: boolean) {
    let cursor: Cursor | undefined;
    do {
      const page = await this.storage.scanEntries({ conversationId, order: "ascending", minEntryId: (inclusive ? from : from + 1) as EntryId }, 256, cursor, context);
      for (const entry of page.items) this.apply(entry);
      cursor = page.next;
    } while (cursor !== undefined);
  }

  private apply(entry: EntryRecord) {
    this.lastId = Math.max(this.lastId, entry.id);
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
