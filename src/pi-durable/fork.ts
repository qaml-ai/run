import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Cursor, EntryId, EntryRecord, Storage } from "@earendil-works/pi-durable";
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from "../pi-harness/messages.ts";
import type { CompactionState, TranscriptRecord } from "../transcript.ts";
import { piOrdered } from "./agent.ts";
import type { At, JournalHistory } from "./history.ts";
import { SESSION_CONVERSATION_ID as conversationId } from "./seed.ts";

/**
 * A fork cut from Pi's journal (plans/host-transcript-removal.md, appendix): which of the source's history messages the
 * fork keeps, and the context its model starts with, Pi's own as of the cut, with no host transcript read.
 */
export interface JournalForkCut {
  /** The history index of the last message the fork keeps (null: none). */
  through: number | null;
  /** What the fork's host transcript starts with: the kept history, its context's summary where it has one. */
  records: TranscriptRecord[];
  /** The fork's model context as of the cut, as Pi derives it. */
  model: Message[];
}

/** The journal's retained context cannot reconstruct this point; do not fall back to the host's fork. */
export class ForkBeforeHead extends Error {
  readonly status = 400;
  readonly code = "FORK_POINT_INVALID";
  constructor() {
    super("This fork point is before the newest context checkpoint or compaction; fork at a later message");
    this.name = "ForkBeforeHead";
  }
}

const refused = (status: number, code: string, message: string) => Object.assign(new Error(message), { status, code });
const callsOf = (message: AgentMessage) => message.role === "assistant" ? message.content.flatMap(part => part.type === "toolCall" ? [part.id] : []) : [];
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("");

/**
 * How many of the history's messages a fork at `at` keeps, by the rules `forkCut` (transcript.ts) applies to the host's
 * records: by default up to the last turn that ended; at a history index, that message and the results answering it;
 * at a request id, the whole turn that request ran. A message of the running turn, or one whose calls have no results
 * in what is kept, is refused (409 FORK_POINT_RUNNING).
 */
export function forkCount(history: Pick<JournalHistory, "total" | "active" | "turnStart" | "awaiting">, messages: readonly AgentMessage[], turns: readonly number[], at?: number | string, baseTotal = 0): number | undefined {
  const open = history.active || history.awaiting.length > 0;
  if (at === undefined) return open ? history.turnStart : history.total;
  if (typeof at === "string") {
    const index = messages.findLastIndex(message => message.role === "user" && (message as { requestId?: string }).requestId === at);
    if (index < 0) throw refused(400, "FORK_POINT_INVALID", `No message in this agent's history was sent by request ${at}`);
    // A turn before the base: where it ended is the host's to say.
    if (index < baseTotal) return undefined;
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
 * Pi's retained model context through journal cursor `at`: the newest head marker (a compaction's summary, or a
 * context checkpoint), then the entries from its head through `at` (each entry's messages as its newest edit leaves
 * them; later head markers' own messages left out), settled as Pi settles them (`piOrdered`).
 */
export async function contextAt(storage: Pick<Storage, "scanEntries" | "findLatestHeadMarker">, at: At): Promise<Message[]> {
  const head = await storage.findLatestHeadMarker(conversationId, undefined, context);
  if (head && at.entryId < (head.head ?? head.id)) {
    throw new ForkBeforeHead();
  }
  // A compaction marker can follow the first message it keeps. That retained range already belongs to its
  // context: older checkpoints may have been reclaimed, even when the cut precedes the marker's own ID.
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await storage.scanEntries({ conversationId, order: "ascending", minEntryId: (head?.head ?? 0) as EntryId, maxEntryId: at.entryId as EntryId }, 256, cursor, context);
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
 * The summary a context leads with (a compaction's, as Pi or the host's checkpoint renders it), and how many history
 * messages it keeps after it: what the fork's host transcript starts with, so its working set is Pi's context.
 */
export function contextSummary(model: readonly Message[]): { summary: string; kept: number; at: number } | undefined {
  const index = model.findIndex(message => message.role === "user" && textOf(message).startsWith(COMPACTION_SUMMARY_PREFIX) && textOf(message).endsWith(COMPACTION_SUMMARY_SUFFIX));
  if (index < 0) return undefined;
  const text = textOf(model[index]);
  return { summary: text.slice(COMPACTION_SUMMARY_PREFIX.length, -COMPACTION_SUMMARY_SUFFIX.length),
    kept: model.slice(index + 1).filter(message => message.role !== "system").length, at: model[index].timestamp };
}

/**
 * The fork of a session at `at` from its journal: `messages` is its whole history (the history index's settled part,
 * then the journal's), `history` its journal history. Undefined where the journal cannot place the cut (a cut before
 * the session's base, whose messages have no journal cursor here).
 */
export async function journalForkCut(storage: Pick<Storage, "scanEntries" | "findLatestHeadMarker">, history: JournalHistory, messages: readonly AgentMessage[], at?: number | string): Promise<JournalForkCut | undefined> {
  if (messages.length !== history.total) return undefined;
  const count = forkCount(history, messages, history.turnsFrom(0), at, history.baseTotal);
  if (count === undefined) return undefined;
  const kept = messages.slice(0, count);
  if (!count) return { through: null, records: [], model: [] };
  const cursor = history.cursorAt(count - 1);
  if (!cursor) return undefined;
  const model = await contextAt(storage, cursor);
  const summary = contextSummary(model);
  const compaction: CompactionState | undefined = summary && summary.kept <= count ? { summary: summary.summary, cut: count - summary.kept, tokensBefore: 0, at: summary.at } : undefined;
  return { through: count - 1, records: [{ t: "reset", messages: [...kept], ...(compaction ? { compaction } : {}) }], model };
}
