import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { getCurrentSystemMessage, type Message } from "@earendil-works/pi-ai";
import type { Conversation } from "@earendil-works/pi-durable";
import { BadRequest } from "./validation.ts";
import {
  RESET_KEEP_MAX,
  RESET_SUMMARY_MAX,
  defaultResetSummary,
  keptTail,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
} from "./reset-policy.ts";

const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
const size = (entries: readonly unknown[]) => ({
  entries: entries.length,
  bytes: entries.reduce<number>((sum, entry) => sum + bytes(entry), 0),
});

/** One native head-marker write atomically replaces model context; history ignores this entry. */
export async function resetContext(
  root: Conversation,
  input: Record<string, unknown>,
  tail: () => Message[],
) {
  const keep = input.keepMessages ?? 0;
  if (
    typeof keep !== "number" ||
    !Number.isInteger(keep) ||
    keep < 0 ||
    keep > RESET_KEEP_MAX
  )
    throw new BadRequest(
      `keepMessages must be an integer from 0 to ${RESET_KEEP_MAX}`,
    );
  if (
    input.summary !== undefined &&
    (typeof input.summary !== "string" ||
      input.summary.length > RESET_SUMMARY_MAX)
  )
    throw new BadRequest(
      `summary must be at most ${RESET_SUMMARY_MAX} characters`,
    );
  const snapshot = await root.context(BACKGROUND_CONTEXT);
  const kept = keptTail(tail(), keep),
    now = Date.now();
  const system = getCurrentSystemMessage(snapshot.messages);
  const model: Message[] = [
    ...(system ? [system] : []),
    {
      role: "user",
      content:
        COMPACTION_SUMMARY_PREFIX +
        (input.summary ?? defaultResetSummary(now)) +
        COMPACTION_SUMMARY_SUFFIX,
      timestamp: now,
    },
    ...kept,
  ];
  const write = await root.submit(
    {
      type: "write",
      entry: {
        kind: "camel.context",
        head: "self",
        model,
        data: { reset: { at: now, keptMessages: kept.length } },
      },
    },
    BACKGROUND_CONTEXT,
  );
  await write.wait(BACKGROUND_CONTEXT);
  return {
    keptMessages: kept.length,
    before: size(snapshot.entries),
    after: size((await root.context(BACKGROUND_CONTEXT)).entries),
  };
}
