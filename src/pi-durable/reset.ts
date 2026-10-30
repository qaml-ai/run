import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage, type SystemMessage } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { ConversationId, Storage } from "@earendil-works/pi-durable";
import { HttpError } from "../http.ts";
import { CONTEXT_TOO_LARGE } from "../protocol.ts";
import { convertToLlm, createCompactionSummaryMessage } from "../pi-harness/messages.ts";
import { JournalHistory } from "./history.ts";
import { contextWrites, SESSION_CONVERSATION_ID } from "./seed.ts";
import { commitBatch, contextRangeSize, contextSystemRows, type ContextRangeSize } from "./storage.ts";

/** The most history messages a reset keeps after its summary. */
export const RESET_KEEP_MAX = 20;
/** The longest summary a reset takes, in characters. */
export const RESET_SUMMARY_MAX = 65_536;

export const defaultResetSummary = (now: number) => `Earlier conversation was reset by the operator on ${new Date(now).toISOString().slice(0, 10)}; the full history remains in the agent's history and files.`;

/**
 * The context's current system message: its system messages folded (`getCurrentSystemMessage`) as Pi derives them,
 * the newest head marker's and those after it, less older markers and what edits omit. Read in SQL, so the range's
 * other messages are never loaded. Undefined when the context holds none (a compaction's, before its next request).
 */
export async function currentSystemMessage(storage: Storage, conversationId: ConversationId = SESSION_CONVERSATION_ID): Promise<SystemMessage | undefined> {
  const rows = await contextSystemRows(storage, conversationId);
  // Nothing writes replace edits today; one would change what the context holds in a way this read does not follow.
  if (rows.some(row => row.replaces.length)) throw new Error("The context holds replace edits, which a reset cannot read its system message past");
  const omitted = new Set(rows.flatMap(row => row.omits));
  const marker = rows[0]?.marker;
  const messages = rows.filter(row => !omitted.has(row.id) && (row.head === undefined || row.id === marker)).flatMap(row => row.system);
  return getCurrentSystemMessage(messages);
}

/** The last `count` messages, never starting on a tool result: one whose call is not kept would answer nothing. */
export function keptTail(messages: AgentMessage[], count: number): AgentMessage[] {
  const kept = count > 0 ? messages.slice(-count) : [];
  while (kept[0]?.role === "toolResult") kept.shift();
  return kept;
}

export type ContextReset = { keptMessages: number; before: ContextRangeSize; after: ContextRangeSize };

/**
 * Replace the agent's Pi context with a new checkpoint at the journal's tail (a head marker, as `replaceContext` and a
 * seed write it), without loading the range it replaces: its current system message (read in SQL), a summary, and the
 * last `keepMessages` history messages (`read` [from, to): by ordinal, bounded before it reads). The history is untouched: the checkpoint's entries are not history. Refused (409) while the journal holds a turn open, and
 * when the new context would itself be past `limit` bytes. The caller holds the agent's claim, and no host runs it.
 */
export async function resetContext(storage: Storage, options: { summary?: string; keepMessages?: number; limit: number; now?: number; read?: (from: number, to: number) => Promise<AgentMessage[]>; beforeCommit?: () => void }): Promise<ContextReset> {
  const { limit, now = Date.now() } = options;
  const keepMessages = options.keepMessages ?? 0;
  const before = await contextRangeSize(storage, SESSION_CONVERSATION_ID);
  let kept: AgentMessage[] = [];
  // Only a reset that keeps messages reads the history: its reader takes in the journal from its base, a page at a time.
  if (keepMessages > 0) {
    const history = await JournalHistory.openAny(storage);
    if (!history) throw new HttpError(409, "This agent's journal has no history to keep messages from; reset it with keepMessages 0");
    if (history.active || history.awaiting.length) throw new HttpError(409, "This agent's turn has not ended; abort it first", "AGENT_BUSY");
    const from = Math.max(0, history.total - keepMessages);
    if (!options.read) throw new Error("A reset that keeps messages needs the history's reader");
    kept = keptTail(await options.read(from, history.total), keepMessages);
  }
  const system = await currentSystemMessage(storage);
  const summary = createCompactionSummaryMessage(options.summary ?? defaultResetSummary(now), Math.ceil(before.bytes / 4), now);
  const model = convertToLlm([...system ? [system] : [], summary as AgentMessage, ...kept]);
  const bulk = storage as Storage & { mintIds?(count: number): Promise<number[]> };
  const ids: number[] = bulk.mintIds ? await bulk.mintIds(model.length) : [];
  while (ids.length < model.length) ids.push(await storage.mintId());
  const writes = contextWrites(ids, SESSION_CONVERSATION_ID, model, { reset: { at: now, keptMessages: kept.length, bytesBefore: before.bytes } });
  // As the storage serializes them: a reset that would leave a context the next run could not load writes nothing.
  const bytes = writes.reduce((sum, write) => sum + Buffer.byteLength(JSON.stringify(write.type === "entry" ? write.value : "")), 0);
  if (bytes > limit) throw new HttpError(409, `The reset context would be ${bytes} bytes, past the ${limit} bytes a run can load; keep fewer messages or give a shorter summary`, CONTEXT_TOO_LARGE);
  // The caller's last check (no host started meanwhile), right before the write.
  options.beforeCommit?.();
  await commitBatch(storage, writes, context);
  return { keptMessages: kept.length, before, after: await contextRangeSize(storage, SESSION_CONVERSATION_ID) };
}
