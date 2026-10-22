import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Cursor, EntryId, EntryRecord, Storage } from "@earendil-works/pi-durable";
import { convertToLlm } from "../pi-harness/messages.ts";
import { piOrdered } from "./agent.ts";
import type { At, JournalHistory } from "./history.ts";
import { SESSION_CONVERSATION_ID as conversationId } from "./seed.ts";

/**
 * A fork cut from Pi's journal (plans/host-transcript-removal.md, appendix): which of the source's history messages the
 * fork keeps, and the context its model starts with, Pi's own as of the cut.
 */
export interface JournalForkCut {
  /** The history index of the last message the fork keeps (null: none). */
  through: number | null;
  /** The history the fork starts with, and where its turns began. */
  messages: AgentMessage[];
  turns: number[];
  /** Pi's context as of the cut, or raw history when the cut predates its retained head. */
  model: Message[];
  /** The retained context could not cover the cut; the model starts from raw history. */
  fromHistory?: true;
}

/** The journal's retained context cannot reconstruct this point; use the settled history instead. */
class ForkBeforeHead extends Error {
  readonly status = 400;
  readonly code = "FORK_POINT_INVALID";
  constructor() {
    super("This fork point is before the newest context checkpoint or compaction; fork at a later message");
    this.name = "ForkBeforeHead";
  }
}

const refused = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });
const callsOf = (message: AgentMessage) => message.role === "assistant" ? message.content.flatMap(part => part.type === "toolCall" ? [part.id] : []) : [];
/** Where conversational turns begin in `messages` without turn records: at a user message after anything else. */
const userTurns = (messages: readonly AgentMessage[]) => messages.flatMap((message, index) => message.role === "user" && messages[index - 1]?.role !== "user" ? [index] : []);

/**
 * How many of the history's messages a fork at `at` keeps: by default up to the last turn that ended; at a history
 * index, that message and the results answering it; at a request id, the whole turn that request ran. A message of the
 * running turn, or one whose calls have no results in what is kept, is refused (409 FORK_POINT_RUNNING).
 */
export function forkCount(history: Pick<JournalHistory, "total" | "active" | "turnStart" | "awaiting">, messages: readonly AgentMessage[], turns: readonly number[], at?: number | string): number {
  const open = history.active || history.awaiting.length > 0;
  if (at === undefined) return open ? history.turnStart : history.total;
  if (typeof at === "string") {
    const index = messages.findLastIndex(message => message.role === "user" && (message as { requestId?: string }).requestId === at);
    if (index < 0) throw refused(400, "FORK_POINT_INVALID", `No message in this agent's history was sent by request ${at}`);
    const end = [...turns, history.total].filter(turn => turn > index).sort((a, b) => a - b)[0] ?? history.total;
    if (open && end > history.turnStart) throw refused(409, "FORK_POINT_RUNNING", `Request ${at}'s turn has not ended yet; fork once it has, or at an earlier message`);
    return end;
  }
  if (!Number.isSafeInteger(at) || at < 0 || at >= history.total) throw refused(400, "FORK_POINT_INVALID", `atMessage is a history index from 0 to ${history.total - 1}, or a request id`);
  let count = at + 1;
  while (messages[count]?.role === "toolResult") count++;
  const pending = new Set<string>();
  for (const message of messages.slice(0, count)) {
    if (message.role === "assistant") { pending.clear(); for (const id of callsOf(message)) pending.add(id); }
    else if (message.role === "toolResult") pending.delete(message.toolCallId);
    else if (message.role === "user") pending.clear();
  }
  if (pending.size || (open && count > history.turnStart)) throw refused(409, "FORK_POINT_RUNNING", `Message ${at} is in a turn that has not ended yet; fork at an earlier message, or once it ends`);
  return count;
}

/**
 * Pi's retained model context through journal cursor `at` (`index` -1: the whole entry; past every entry: the journal's
 * end): the newest head marker (a compaction's summary, or a context checkpoint), then the entries from its head
 * through `at` (each entry's messages as its newest edit leaves them; later head markers' own messages left out),
 * settled as Pi settles them (`piOrdered`).
 */
export async function contextAt(storage: Pick<Storage, "scanEntries" | "findLatestHeadMarker">, at: At): Promise<Message[]> {
  const end = Number.isSafeInteger(at.entryId) && at.entryId < Number.MAX_SAFE_INTEGER ? at.entryId as EntryId : undefined;
  const head = await storage.findLatestHeadMarker(conversationId, undefined, context);
  if (head && end !== undefined && end < (head.head ?? head.id)) {
    throw new ForkBeforeHead();
  }
  // A compaction marker can follow the first message it keeps. That retained range already belongs to its
  // context: older checkpoints may have been reclaimed, even when the cut precedes the marker's own ID.
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanEntries({ conversationId, order: "ascending", minEntryId: (head?.head ?? 0) as EntryId, ...(end === undefined ? {} : { maxEntryId: end }) }, 256, cursor, context);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  const omitted = new Set<number>();
  for (const entry of entries) for (const edit of entry.edits ?? []) if (edit.action === "omit") omitted.add(edit.target);
  const messages: Message[] = head && head.head !== head.id ? [...head.model ?? []] : [];
  for (const entry of entries) {
    if (omitted.has(entry.id) || (entry.head !== undefined && entry.id !== head?.id) || (head && entry.id === head.id && head.head !== head.id)) continue;
    const model = entry.model ?? [];
    messages.push(...(entry.id === at.entryId && at.index >= 0 ? model.slice(0, at.index + 1) : model));
  }
  return piOrdered(messages as AgentMessage[]) as Message[];
}

/**
 * The fork of a session at `at` from its journal: `messages` is its whole history (the history index's settled part,
 * then the journal's), `history` its journal history. Its model starts from Pi's context as of the cut. Before the
 * retained head, or the journal base (whose messages have no cursor), it starts from raw kept history, which Pi
 * compacts on the first turn as needed.
 */
export async function journalForkCut(storage: Pick<Storage, "scanEntries" | "findLatestHeadMarker">, history: JournalHistory, messages: readonly AgentMessage[], at?: number | string): Promise<JournalForkCut> {
  if (messages.length !== history.total) throw new Error(`The agent's history has ${messages.length} messages, its journal ${history.total}`);
  // Turn starts the journal records, and before its base, where user messages begin them.
  const turns = [...new Set([...userTurns(messages.slice(0, history.baseTotal)), ...history.turnsFrom(0)])].sort((a, b) => a - b);
  const count = forkCount(history, messages, turns, at);
  const kept = messages.slice(0, count);
  if (!count) return { through: null, messages: [], turns: [], model: [] };
  // Pi's context just before the next history message: with what the journal holds between (a compaction or a
  // checkpoint that summarizes what the fork keeps, an import's summary at its cut), never anything after.
  const cursor = history.cursorAt(count - 1), next = history.cursorAt(count);
  const through = !cursor ? undefined : !next ? { entryId: Number.MAX_SAFE_INTEGER, index: -1 } : next.index > 0 ? { entryId: next.entryId, index: next.index - 1 } : { entryId: next.entryId - 1, index: -1 };
  if (through) {
    try {
      const model = await contextAt(storage, through);
      return { through: count - 1, messages: [...kept], turns: turns.filter(turn => turn < count), model };
    } catch (error) {
      if (!(error instanceof ForkBeforeHead)) throw error;
    }
  }
  return { through: count - 1, messages: [...kept], turns: turns.filter(turn => turn < count), model: convertToLlm([...kept]), fromHistory: true };
}
