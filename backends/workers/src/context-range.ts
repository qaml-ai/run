import { GenerationTask, hook, type Conversation, type Extension } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

export const CONTEXT_RANGE_MAX_BYTES = 128 * 1024 * 1024;
export function contextRangeLimit(value?: string) {
  const limit = value === undefined ? CONTEXT_RANGE_MAX_BYTES : Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("AGENT_CONTEXT_RANGE_MAX_BYTES must be a positive safe integer");
  return limit;
}
export async function contextRange(root: Conversation) {
  const view = await root.context(BACKGROUND_CONTEXT);
  return { entries: view.entries.length, bytes: view.entries.reduce((sum, entry) => sum + new TextEncoder().encode(JSON.stringify(entry)).length, 0) };
}

/** Provider admission must fail outside Pi's best-effort extension hooks. */
export async function assertContextRange(limit: number, root: Conversation, refuse: (failure: { error: string; code: string; stopped: string }) => Promise<void>) {
  const range = await contextRange(root);
  if (range.bytes <= limit) return;
  const error = `This agent's context since its last compaction is ${range.bytes} bytes, past the ${limit} bytes a run can load; start a new agent with a summary of the history, or ask the operator to raise AGENT_CONTEXT_RANGE_MAX_BYTES.`;
  await refuse({ error, code: "context_too_large", stopped: "turn_limit" });
  throw new Error(`context_too_large: ${error}`);
}

export function contextRangeExtension(limit: number, root: () => Promise<Conversation>, refuse: (failure: { error: string; code: string; stopped: string }) => Promise<void>): Extension {
  return { name: "camel.context-range", hooks: [hook(GenerationTask, {
    beforeRequest: async () => {
      await assertContextRange(limit, await root(), refuse);
      return undefined;
    },
  })] };
}
