/** An agent's history as its Pi journal gives it, for tests that run a host without a history index. */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { JournalHistory } from "../../src/pi-durable/history.ts";
import { hasPiStorage, openPiStorage } from "../../src/pi-durable/storage.ts";
import { recordsHistory, retiredRecords } from "./retired-host.ts";

/** The whole history: what the retired host transcript held before the journal's base, then the journal's. */
export async function journalMessages(location: Parameters<typeof openPiStorage>[0]): Promise<AgentMessage[]> {
  if (!await hasPiStorage(location)) return [];
  const storage = await openPiStorage(location);
  try {
    const history = await JournalHistory.openAny(storage);
    if (!history) return [];
    const before = history.heldFrom ? recordsHistory(await retiredRecords(storage, undefined, true) ?? []).messages.slice(0, history.heldFrom) : [];
    const after = await history.messagesFrom(history.heldFrom);
    if (!after) throw new Error("The journal does not hold its history from its base");
    return [...before, ...after];
  } finally { await storage.close(context); }
}
