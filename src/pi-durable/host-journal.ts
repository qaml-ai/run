import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Cursor, DocumentId, EntryId, JsonObject, Storage, StorageWrite } from "@earendil-works/pi-durable";
import { BASE_ADDRESS, baseWrites, HOST_MESSAGE_KIND, HOST_SYSTEM_KIND, HOST_USER_KIND, JournalHistory, MARKER_KIND, type At, type HistoryBase } from "./history.ts";
import { recordsHistory, retiredRecords, type RetiredRecord } from "./retired-host.ts";
import { SESSION_CONVERSATION_ID as conversationId } from "./seed.ts";
import { commitTo } from "./storage.ts";

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

/** What a retirement did (or, dry, would do): the history's length at its base, how much of it is settled, and where the index ends. */
export type Retirement = { total: number; settled: number; indexed?: number };

/** Messages the history grows by past its base before the next turn's end writes a new one (`rebase`). */
const REBASE_MESSAGES = 256;

const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/**
 * An agent's history and turn as its host keeps them: in Pi's journal alone (plans/host-transcript-removal.md). Pi's
 * messages are history as Pi commits them; the host writes the messages it makes itself as native entries, and its
 * retractions, turns, calls left waiting and skips as markers (`MARKER_KIND`), which `JournalHistory` reads back. Writes
 * go one at a time, each as of every earlier one; a failed write fails every later one (`failed`), as only a reload
 * knows what the journal holds then.
 */
export class HostJournal {
  readonly history: JournalHistory;
  private readonly storage: Storage;
  /** The newest message the host wrote itself: a run's new messages are the ones Pi commits after it. */
  written?: At;
  /** Why a write failed: nothing more is written. */
  failed?: unknown;
  private line: Promise<unknown> = Promise.resolve();

  private dedupeUserEntries: boolean;
  private constructor(storage: Storage, history: JournalHistory, dedupeUserEntries = false) { this.storage = storage; this.history = history; this.dedupeUserEntries = dedupeUserEntries; }

  /** The session's journal history (`JournalHistory.open`); undefined for a session with no base marker. */
  static async open(storage: Storage, dedupeUserEntries = false): Promise<HostJournal | undefined> {
    const history = await JournalHistory.open(storage);
    return history && new HostJournal(storage, history, dedupeUserEntries);
  }

  /**
   * Retire a session's host transcript, once, as its first release without it loads the session. Its journal history
   * starts from the base marker an earlier release wrote, or else where the host's last snapshot stood (and so does one
   * written as a turn ran or waited on input, which holds none of that turn's messages): that base, with that turn's
   * messages before it (`kept`), is written then. Every settled message before the base the history index lacks is first indexed
   * from the host's records (`index`; the session's legacy log first, for an import too large to copy: `legacy`), so
   * none is only in them. Then, in one commit: the base, the base document, and the host document disabled and marked
   * `retired`, with a `camel.host.disabled` entry. An earlier release refuses the session from then on (its history
   * format is newer) rather than continue from that snapshot. False when there is no enabled host transcript to retire.
   */
  /**
   * What a retirement of the session's host transcript starts from (as `retire` reads it): its base, the settled
   * messages before it, and where the running turn's messages it keeps begin (`keptFrom`, when it keeps them from the
   * host's records). Undefined when there is no enabled host transcript.
   */
  static async retirementPlan(storage: Storage): Promise<{ base: HistoryBase; settled: number; keptFrom?: number } | undefined> {
    const found = await JournalHistory.snapshotBase(storage);
    if (!found?.enabled) return undefined;
    const marked = (await JournalHistory.findBase(storage))?.data as unknown as HistoryBase | undefined;
    const open = (base: HistoryBase) => (base.active || base.awaiting.length > 0) && base.turnStart < base.total;
    const keep = marked && !open(marked) ? marked : undefined;
    const base = keep ?? found.base;
    return { base, settled: open(base) ? base.turnStart : base.total, ...(!keep && open(base) ? { keptFrom: base.turnStart } : {}) };
  }

  static async retire(storage: Storage, options: {
    indexed?: number;
    /** Index `messages` (the history's from `from`, where `turns` begin), as chunks; returns where the index ends then. */
    index?: (from: number, messages: AgentMessage[], turns: number[]) => Promise<number>;
    legacy?: () => Promise<RetiredRecord[]>;
    /** Read and check everything the retirement would, and write nothing (`POST /v1/operations/legacy-migrate`'s dry run). */
    dryRun?: boolean;
    /** The running turn's messages before the base, read already (legacy-migrate.ts streams them): not read again. */
    kept?: AgentMessage[];
  } = {}): Promise<false | Retirement> {
    const found = await JournalHistory.snapshotBase(storage);
    if (!found?.enabled) return false;
    const marker = await JournalHistory.findBase(storage);
    const marked = marker?.data as unknown as HistoryBase | undefined;
    const open = (base: HistoryBase) => (base.active || base.awaiting.length > 0) && base.turnStart < base.total;
    const keep = marked && !open(marked) ? marked : undefined;
    const base = keep ?? found.base;
    let history: ReturnType<typeof recordsHistory> | undefined;
    const records = async () => history ??= recordsHistory(await retiredRecords(storage, options.legacy) ?? []);
    if (!keep && open(base) && options.kept) {
      if (options.kept.length !== base.total - base.turnStart) throw new Error(`The running turn has ${options.kept.length} messages given, its snapshot ${base.total - base.turnStart}`);
      base.kept = options.kept;
    } else if (!keep && open(base)) {
      // The running turn's messages before the base, whole (the snapshot's may start past a compaction within the turn).
      const all = (await records()).messages;
      if (all.length !== base.total) throw new Error(`The host's records hold ${all.length} messages, its snapshot ${base.total}`);
      base.kept = all.slice(base.turnStart);
    }
    const settled = open(base) ? base.turnStart : base.total;
    let indexed = options.indexed;
    if ((options.index || options.dryRun) && indexed !== undefined && indexed < settled) {
      const { messages, turns } = await records();
      if (messages.length < settled) throw new Error(`The host's records hold ${messages.length} messages, before its base ${settled}`);
      if (options.dryRun) indexed = settled;
      else {
        indexed = await options.index!(indexed, messages.slice(indexed, settled), turns);
        if (indexed < settled) throw new Error(`The history index ends at ${indexed}, before the journal's base ${settled}`);
      }
    }
    const retirement: Retirement = { total: base.total, settled, ...(indexed !== undefined ? { indexed } : {}) };
    if (options.dryRun) return retirement;
    const writes: StorageWrite[] = [];
    const existing = await JournalHistory.baseDocument(storage);
    if (!keep) writes.push(...baseWrites(await storage.mintId<EntryId>(), base, { id: existing ?? await storage.mintId<DocumentId>(), create: !existing }));
    else if (!existing) writes.push({ type: "document.create", record: { id: await storage.mintId<DocumentId>(), ...BASE_ADDRESS }, content: { version: 1, kind: "base", value: { entry: marker!.id } } });
    writes.push(
      { type: "entry", value: { id: await storage.mintId<EntryId>(), conversationId, kind: "camel.host.disabled", data: { retired: "journal" } } },
      { type: "document.change", id: found.documentId, content: { version: 1, kind: "base", value: { ...found.value, enabled: false, retired: "journal" } as JsonObject } },
    );
    await commitTo(storage, writes, context);
    return retirement;
  }

  get total() { return this.history.total; }
  get active() { return this.history.active; }
  get turnStart() { return this.history.turnStart; }
  get awaiting() { return this.history.awaiting; }
  callIndex(id: string) { return this.history.callIndex(id); }

  /** Take in what Pi committed since the last read. */
  refresh() { return this.history.refresh(); }

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
        const writes: StorageWrite[] = [];
        // The history as of the records before each: a retraction takes back the message an earlier one wrote.
        const cursors: (At | undefined)[] = [];
        let total = this.total, written: At | undefined;
        const cursorOf = (index: number) => index >= this.total ? cursors[index - this.total] : this.history.cursorAt(index);
        for (const record of records) {
          const id = await this.storage.mintId<EntryId>();
          if (record.t === "message") {
            const message = record.message;
            const { content, ...metadata } = message.role === "user" ? message : { content: undefined };
            // An answer to a call that waited on a person replaces Pi's input-required placeholder in its context.
            const placeholder = message.role === "toolResult" ? await this.placeholder(message.toolCallId) : undefined;
            writes.push({ type: "entry", value: { id, conversationId, ...(message.role === "user"
              ? { kind: HOST_USER_KIND, data: json({ message: this.dedupeUserEntries ? metadata : message }) as never, model: json([{ role: "user", content, timestamp: message.timestamp }]) as never }
              : { kind: HOST_MESSAGE_KIND, model: json([message]) as never, ...(placeholder ? { edits: [{ target: placeholder, action: "omit" as const }] } : {}) }) } });
            const requestId = message.role === "user" ? (message as { requestId?: string }).requestId : undefined;
            if (requestId && !await this.storage.submissionByRequest(conversationId, requestId, context)) writes.push({ type: "submission", value: {
              id: await this.storage.mintId(), conversationId, requestId, type: "input", status: "unanswered", reason: "host_input",
            } });
            cursors.push(written = { entryId: id, index: 0 });
            total++;
          } else if (record.t === "retract") {
            // Taken out of Pi's context too: a failed response Pi leaves out anyway, an answer the output reminder replaces.
            const target = cursorOf(total - 1);
            writes.push({ type: "entry", value: { id, conversationId, kind: MARKER_KIND, data: { t: "retract", index: total - 1 },
              ...(target && target.index === 0 ? { edits: [{ target: target.entryId as EntryId, action: "omit" as const }] } : {}) } });
            if (total > this.total) cursors.pop();
            total--;
          } else if (record.t === "system") {
            writes.push({ type: "entry", value: { id, conversationId, kind: HOST_SYSTEM_KIND, model: json([record.message]) as never } });
          } else if (record.t === "pi") {
            // Out of Pi's context too: what Pi settled for the discarded run never reaches the model (a call made again
            // answers it instead).
            const skipped = [...new Set(this.history.cursorsBetween(record.after, record.cursor).map(at => at.entryId))];
            writes.push({ type: "entry", value: { id, conversationId, kind: MARKER_KIND, data: json(record) as never,
              ...(skipped.length ? { edits: skipped.map(target => ({ target: target as EntryId, action: "omit" as const })) } : {}) } });
          } else {
            writes.push({ type: "entry", value: { id, conversationId, kind: MARKER_KIND, data: json(record.t === "turn" ? { ...record, total } : record) as never } });
          }
        }
        await commitTo(this.storage, writes, context);
        if (written) this.written = written;
      } catch (error) { this.failed = error; throw error; }
      await this.refresh();
    });
    this.line = run.catch(() => {});
    return run;
  }

  push(message: AgentMessage) { return this.append([message]); }
  append(messages: AgentMessage[]) { return this.commit(() => messages.map(message => ({ t: "message" as const, message }))); }
  retract() { return this.commit(() => [{ t: "retract" }]); }
  setActive(active: boolean) { return this.commit(() => [{ t: "turn", active }]); }
  /** Leave tool calls open for a person's input, or (`released`) give them back to the turn. */
  await(calls: string[], released = false) { return this.commit(() => [{ t: "awaiting", calls, ...(released ? { released: true as const } : {}) }]); }
  system(message: SystemMessage) { return this.commit(() => [{ t: "system", message }]); }
  skip(cursor: At, after?: At) { return this.commit(() => [{ t: "pi", cursor, ...(after ? { after } : {}) }]); }

  /**
   * Start later reads past the history as it stands, between turns, once it has grown REBASE_MESSAGES past its base and
   * the history index holds every message before it (`indexed`): a load then reads the journal from here, not from the
   * session's first base. Whether a base was written.
   */
  rebase(indexed: number): Promise<boolean> {
    const run = this.line.then(async () => {
      if (this.failed !== undefined) throw this.failed;
      await this.refresh();
      const base = this.history.settledBase();
      if (!base || base.total - this.history.baseTotal < REBASE_MESSAGES || indexed < base.total) return false;
      const document = await JournalHistory.baseDocument(this.storage);
      try { await commitTo(this.storage, baseWrites(await this.storage.mintId<EntryId>(), base, { id: document ?? await this.storage.mintId<DocumentId>(), create: !document }), context); }
      catch (error) { this.failed = error; throw error; }
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
