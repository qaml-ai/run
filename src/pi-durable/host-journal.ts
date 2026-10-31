import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createSession, defineDoc, type Cursor, type EntryDraft, type EntryId, type JsonObject, type Session, type Storage, type Tx } from "@earendil-works/pi-durable";
import { BASE_ADDRESS, HOST_MESSAGE_KIND, HOST_SYSTEM_KIND, HOST_USER_KIND, JournalHistory, MARKER_KIND, type At, type HistoryBase } from "./history.ts";
import { SESSION_CONVERSATION_ID as conversationId } from "./seed.ts";
import { keepingOpen } from "./storage.ts";

/** What the agent host writes to its session's journal (`HostJournal.commit`). */
export type HostRecord =
  /** A message the host made itself: a repair, an answer to a call that waited on a person, one that lands without a turn. */
  | { t: "message"; message: AgentMessage }
  /** Takes back the history's latest message: a failed response that is retried, an answer the output reminder replaces. */
  | { t: "retract" }
  | { t: "turn"; active: boolean }
  /**
   * Tool calls a suspended turn leaves open until a person answers (inputs.ts): no result is written for them meanwhile,
   * and a reload does not close them. `released` hands them back to the running turn, just before an approved call runs,
   * so a crash then closes them as unknown like any call.
   */
  | { t: "awaiting"; calls: string[]; released?: true }
  /** A system message from here on in Pi's context (a configuration change, the output reminder): never history. */
  | { t: "system"; message: SystemMessage }
  /**
   * Pi's messages after `after` (the history's newest before them) up to `cursor` that the history skips: what Pi
   * settled for an interrupted run the host discarded.
   */
  | { t: "pi"; cursor: At; after?: At };

/** Messages the history grows by past its base before the next turn's end writes a new one (`rebase`). */
const REBASE_MESSAGES = 256;

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** A journal write refused because its agent is closing: the next owner goes on from what is stored, as after a loss. */
export class JournalClosed extends Error {}

/** The session's newest base marker's entry, at the address `seedJournal` creates it. */
const BaseDoc = defineDoc({ kind: BASE_ADDRESS.kind, version: 1, scope: "session", initial: () => ({ entry: 0 as EntryId }), checkpointWhen: () => true });

/** A commit through Pi's Session; `own` names each entry the host appends in it. */
export type JournalSession = <T>(change: (tx: Tx, own: (id: EntryId) => void) => Promise<T>) => Promise<T>;

/**
 * An agent's history and turn as its host keeps them: in Pi's journal alone (plans/host-transcript-removal.md). Pi's
 * messages are history as Pi commits them; the host writes the messages it makes itself as native entries, and its
 * retractions, turns, calls left waiting and skips as markers (`MARKER_KIND`), which `JournalHistory` reads back. Writes
 * go one at a time, each as of every earlier one; a failed write fails every later one (`failed`), as only a reload
 * knows what the journal holds then.
 */
export class HostJournal {
  readonly history: JournalHistory;
  /** Where the newest base stands: the one this journal opened from, or one it wrote since. */
  private rebasedAt?: number;
  private readonly storage: Storage;
  /** The newest message the host wrote itself: a run's new messages are the ones Pi commits after it. */
  written?: At;
  /** Why a write failed: nothing more is written. */
  failed?: unknown;
  /** The Session of the journal's writes until an agent takes them over (`attach`), when no other is open on its storage. */
  private readonly own: Session;
  /**
   * The open agent's Session once it has one: its reads of a conversation's newest entry and context know only what it
   * commits itself, and every entry then commits in the order of its ID. Undefined once that agent is closing.
   */
  private session?: () => JournalSession | undefined;
  private line: Promise<unknown> = Promise.resolve();

  private constructor(storage: Storage, history: JournalHistory) {
    this.storage = storage; this.history = history;
    this.own = createSession(keepingOpen(storage));
  }

  /** The session's journal history (`JournalHistory.open`); undefined for a session with no base marker. */
  static async open(storage: Storage): Promise<HostJournal | undefined> {
    const history = await JournalHistory.open(storage);
    return history && new HostJournal(storage, history);
  }

  /** Writes go through the agent's Session from here on. */
  async attach(session: () => JournalSession | undefined) {
    this.session = session;
    await this.close();
  }

  /** End the journal's own Session; the storage stays open. */
  close() { return this.own.close(context).catch(() => {}); }

  /** Where a commit of these kinds of record goes. */
  private committing(kinds: string[]): JournalSession {
    if (!this.session) return change => this.own.commit(tx => change(tx, () => {}), context);
    const session = this.session();
    if (session) return session;
    // Calls left waiting for a person are stored even so: the person was asked already, and their answer goes on from here.
    // No place in the history hangs on this marker (`placeEntries`), so it may commit beside what Pi still stores.
    if (kinds.every(kind => kind === "awaiting")) return async change => {
      const closing = createSession(keepingOpen(this.storage));
      try { return await closing.commit(tx => change(tx, () => {}), context); }
      finally { await closing.close(context).catch(() => {}); }
    };
    console.error(JSON.stringify({ type: "journal_write_refused", reason: "agent_closing", kinds: [...new Set(kinds)] }));
    throw new JournalClosed("The agent is closing");
  }

  get total() { return this.history.total; }
  get active() { return this.history.active; }
  get turnStart() { return this.history.turnStart; }
  get awaiting() { return this.history.awaiting; }
  callIndex(id: string) { return this.history.callIndex(id); }

  /** Take in what Pi committed since the last read; after a failed write, nothing more (its Session closed the storage). */
  async refresh() { if (this.failed === undefined) await this.history.refresh(); }

  /** Whether request `requestId`'s message is in the history (its submission is recorded, compacted or not). */
  async hasRequest(requestId: string) { return !!await this.storage.submissionByRequest(conversationId, requestId, context); }

  /** The running (or last) turn's messages, from its start. */
  async turnMessages(): Promise<AgentMessage[]> {
    await this.refresh();
    const messages = await this.history.messagesFrom(this.turnStart);
    if (!messages) throw new Error(`The journal does not hold the turn from message ${this.turnStart}`);
    return messages;
  }

  /**
   * The history's messages from its latest one that `test` holds for, to its end (none if the journal holds none such):
   * from the latest assistant or user message, what an interrupted step's repairs close.
   */
  async since(test: (message: AgentMessage) => boolean): Promise<AgentMessage[]> {
    await this.refresh();
    for (let from = this.total - 1; from >= this.history.heldFrom; from--) {
      const message = (await this.history.messagesFrom(from, from + 1))?.[0];
      if (!message) break;
      if (test(message)) return (await this.history.messagesFrom(from))!;
    }
    return [];
  }

  /** The history's message at absolute index `index`, if the journal holds it. */
  async message(index: number): Promise<AgentMessage | undefined> {
    return (await this.history.messagesFrom(index, index + 1))?.[0];
  }

  /** The history's latest message, if the journal holds it. */
  async last(): Promise<AgentMessage | undefined> {
    await this.refresh();
    return this.total ? (await this.history.messagesFrom(this.total - 1))?.[0] : undefined;
  }

  /**
   * Commit the records `change` gives, as of every earlier commit and what Pi committed before it: written in one
   * commit, then read back into the history. A failed write fails every later commit. `change` may give none.
   */
  commit(change: () => HostRecord[] | Promise<HostRecord[]>): Promise<void> {
    const run = this.line.then(async () => {
      if (this.failed !== undefined) throw this.failed;
      await this.refresh();
      const records = await change();
      if (!records.length) return;
      try {
        const written = await this.committing(records.map(record => record.t))((tx, own) => this.write(records, tx, own));
        if (written) this.written = written;
      } catch (error) { if (!(error instanceof JournalClosed)) this.failed = error; throw error; }
      await this.refresh();
    });
    this.line = run.catch(() => {});
    return run;
  }

  /** `records` in a commit, as of the history now and each record before it. The newest message written, if any. */
  private async write(records: HostRecord[], tx: Tx, own: (id: EntryId) => void): Promise<At | undefined> {
    const entry = async (draft: EntryDraft) => { const { id } = await tx.appendEntry(conversationId, draft); own(id); return id; };
    // The history as of the records before each: a retraction takes back the message an earlier one wrote.
    const cursors: (At | undefined)[] = [];
    let total = this.total, written: At | undefined;
    const cursorOf = (index: number) => index >= this.total ? cursors[index - this.total] : this.history.cursorAt(index);
    for (const record of records) {
      if (record.t === "message") {
        const message = record.message;
        // An answer to a call that waited on a person replaces Pi's input-required placeholder in its context.
        const placeholder = message.role === "toolResult" ? await this.placeholder(message.toolCallId) : undefined;
        const id = await entry(message.role === "user"
          ? { kind: HOST_USER_KIND, data: json({ message }) as never, model: json([{ role: "user", content: message.content, timestamp: message.timestamp }]) as never }
          : { kind: HOST_MESSAGE_KIND, model: json([message]) as never, ...(placeholder ? { edits: [{ target: placeholder, action: "omit" as const }] } : {}) });
        const requestId = message.role === "user" ? (message as { requestId?: string }).requestId : undefined;
        // Read from the storage, as a Session's commit reads no table after its first write.
        if (requestId && !await this.storage.submissionByRequest(conversationId, requestId, context)) await tx.createSubmission({ conversationId, requestId, type: "input", status: "unanswered", reason: "host_input" });
        cursors.push(written = { entryId: id, index: 0 });
        total++;
      } else if (record.t === "retract") {
        // Taken out of Pi's context too: a failed response Pi leaves out anyway, an answer the output reminder replaces.
        const target = cursorOf(total - 1);
        await entry({ kind: MARKER_KIND, data: { t: "retract", index: total - 1 },
          ...(target && target.index === 0 ? { edits: [{ target: target.entryId as EntryId, action: "omit" as const }] } : {}) });
        if (total > this.total) cursors.pop();
        total--;
      } else if (record.t === "system") {
        await entry({ kind: HOST_SYSTEM_KIND, model: json([record.message]) as never });
      } else if (record.t === "pi") {
        // Out of Pi's context too: what Pi settled for the discarded run never reaches the model (a call made again
        // answers it instead).
        const skipped = [...new Set(this.history.cursorsBetween(record.after, record.cursor).map(at => at.entryId))];
        await entry({ kind: MARKER_KIND, data: json(record) as never,
          ...(skipped.length ? { edits: skipped.map(target => ({ target: target as EntryId, action: "omit" as const })) } : {}) });
      } else {
        await entry({ kind: MARKER_KIND, data: json(record.t === "turn" ? { ...record, total } : record) as never });
      }
    }
    return written;
  }

  push(message: AgentMessage) { return this.append([message]); }
  append(messages: AgentMessage[]) { return this.commit(() => messages.map(message => ({ t: "message" as const, message }))); }
  retract() { return this.commit(() => [{ t: "retract" }]); }
  /** Open or end a turn; an ended one moves the base on once the history has grown REBASE_MESSAGES past it (`rebase`). */
  async setActive(active: boolean) {
    await this.commit(() => [{ t: "turn", active }]);
    if (!active) await this.rebase();
  }
  /** Leave tool calls open for a person's input, or (`released`) give them back to the turn. */
  await(calls: string[], released = false) { return this.commit(() => [{ t: "awaiting", calls, ...(released ? { released: true as const } : {}) }]); }
  system(message: SystemMessage) { return this.commit(() => [{ t: "system", message }]); }
  skip(cursor: At, after?: At) { return this.commit(() => [{ t: "pi", cursor, ...(after ? { after } : {}) }]); }

  /**
   * Start later reads past the history as it stands, between turns, once it has grown REBASE_MESSAGES past its base: a
   * load then reads the journal from here, not from the session's first base (history reads go by ordinal, from Pi
   * storage, whatever the base). Whether a base was written.
   */
  rebase(): Promise<boolean> {
    const run = this.line.then(async () => {
      if (this.failed !== undefined) throw this.failed;
      await this.refresh();
      const base = this.history.settledBase();
      if (!base || base.total - (this.rebasedAt ?? this.history.baseTotal) < REBASE_MESSAGES) return false;
      try {
        await this.committing(["base"])(async (tx, own) => {
          const { id } = await tx.appendEntry(conversationId, { kind: MARKER_KIND, data: json(base) as never });
          own(id);
          (await tx.doc(BaseDoc)).entry = id;
        });
      } catch (error) { if (!(error instanceof JournalClosed)) this.failed = error; throw error; }
      this.rebasedAt = base.total;
      return true;
    });
    this.line = run.catch(() => {});
    return run;
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
}
