import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { JournalHistory } from "../../src/pi-durable/history.ts";
import { openPiStorage } from "../../src/pi-durable/storage.ts";
import type { AgentSupervisor } from "../../src/supervisor.ts";
import type { ForkHistory } from "../../src/pi-durable/fork.ts";

/**
 * An agent's history as its journal holds it, from its base on (the history these tests make has nothing before it):
 * read beside the supervisor without its process. Pages and full reads go by ordinal (history-pages.ts), in Postgres.
 */
export async function supervisorMessages(supervisor: AgentSupervisor, id: string): Promise<AgentMessage[]> {
  const storage = await openPiStorage((supervisor as unknown as { piLocation(id: string): { sessionId: string; directory: string } }).piLocation(id));
  try {
    const history = await JournalHistory.openAny(storage);
    return history ? (await history.messagesFrom(history.heldFrom)) ?? [] : [];
  } finally { await storage.close(BACKGROUND_CONTEXT); }
}

/**
 * A fork's read of a history (`journalForkCut`) from the journal alone, as the ordinal reads give it: `messages` (those
 * before the base given), turn starts where the journal marks them (before its base, at a user message after anything
 * else), and the journal's cursors.
 */
export function journalForkHistory(history: JournalHistory, messages: AgentMessage[]): ForkHistory {
  const before = messages.slice(0, history.baseTotal);
  const userTurns = before.flatMap((message, index) => message.role === "user" && before[index - 1]?.role !== "user" ? [index] : []);
  return {
    messages: async () => messages,
    turns: async () => [...new Set([...userTurns, ...history.turnsFrom(0)])].sort((a, b) => a - b),
    cursorAt: async index => history.cursorAt(index),
  };
}
