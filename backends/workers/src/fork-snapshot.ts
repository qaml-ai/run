import type { Conversation, EntryId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { forkCount } from "./fork-policy.ts";
import type { AgentHistory } from "./history.ts";

/** Keep public history and Pi's retained model context as separate snapshots. */
export async function forkSnapshot(root: Conversation, history: AgentHistory, at: number | string | undefined, running: ReadonlySet<string>) {
  await history.sync(root);
  const messages = history.tail(history.total());
  const turns = messages.flatMap((message, index) => message.role === "user" && messages[index - 1]?.role !== "user" ? [index] : []);
  const activeAt = messages.findIndex(message => message.role === "user" && running.has(message.requestId));
  const count = forkCount({ total: messages.length, active: activeAt >= 0, turnStart: activeAt >= 0 ? activeAt : messages.length, awaiting: [] }, messages, turns, at);
  const through = count ? count - 1 : null;
  if (!count) return { through, messages: [], model: [] };
  const cursor = history.cursorAt(count - 1), next = history.cursorAt(count);
  const view = await root.context(BACKGROUND_CONTEXT);
  const imported = (view.head?.data as { importedCompaction?: { cut: number } } | undefined)?.importedCompaction;
  if (imported && count >= imported.cut) return { through, messages: messages.slice(0, count), model: [
    ...view.head!.model!.slice(0, 1), ...messages.slice(imported.cut, count),
  ] };
  // Entry IDs share a sequence with tasks and documents; subtracting one from
  // the next ID can name no entry. Use the last message's actual journal ID.
  const upper = next ? cursor?.entry : undefined;
  // A cut within an entry or before the retained head can only use raw history.
  if (!cursor || (next && next.entry === cursor.entry) || (upper !== undefined && view.head && upper < Number(view.head.head ?? view.head.id)))
    return { through, messages: messages.slice(0, count), model: messages.slice(0, count) };
  const context = upper === undefined ? view : await root.context(BACKGROUND_CONTEXT, { at: upper as EntryId });
  return { through, messages: messages.slice(0, count), model: context.messages.filter(message => message.role !== "system") };
}
