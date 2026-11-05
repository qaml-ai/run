import type { Conversation } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { importedHistory } from "./history-policy.ts";
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from "./reset-policy.ts";

export async function writeModelContext(root: Conversation, model: readonly Message[], data?: Record<string, any>) {
  const write = await root.submit({ type: "write", entry: { kind: "camel.context", head: "self", model, ...(data ? { data } : {}) } }, BACKGROUND_CONTEXT);
  await write.wait(BACKGROUND_CONTEXT);
}

/** Native messages are completed once; a summary only replaces the model's context. */
export async function seedHistory(root: Conversation, initial: unknown[]) {
  const { messages, compaction } = importedHistory(initial as never);
  for (const message of messages) {
    const write = await root.submit({ type: "write", entry: { kind: "camel.import", model: [message] as Message[] } }, BACKGROUND_CONTEXT);
    await write.wait(BACKGROUND_CONTEXT);
  }
  if (compaction) await writeModelContext(root, [
    { role: "user", content: COMPACTION_SUMMARY_PREFIX + compaction.summary + COMPACTION_SUMMARY_SUFFIX, timestamp: compaction.at },
    ...messages.slice(compaction.cut) as Message[],
  ], { importedCompaction: compaction });
}
