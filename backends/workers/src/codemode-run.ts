import { defineDoc, type ToolExecutionApi, type ToolTaskInput } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

/**
 * Pi's own record of a code mode run (pi-durable/codemode's CodemodeRunDoc, which it does not export): its `start`
 * (when and with which seed the script started, which names its VM run) and its `result`, set once the script ended,
 * however it ended. Only read here.
 */
export const CodemodeRunDoc = defineDoc({
  kind: "pi.codemode.run", version: 1, scope: "task",
  initial: (): { result?: { [key: string]: never }; start?: { startedAt: number; seed: number; deadline?: number; fingerprint?: string } } => ({}),
  checkpointWhen: () => false,
});

/** For a call from code: its VM call id (its key `c<id>`) and its script's start and state, from the code mode call's run. */
export async function scriptOf(api: Pick<ToolExecutionApi, "taskId" | "getTask" | "snapshot">, context: Context = BACKGROUND_CONTEXT) {
  const input = (await api.getTask(api.taskId, context))?.input as ToolTaskInput | undefined;
  if (input?.kind !== "nested" || !/^c\d+$/.test(input.key)) return undefined;
  const run = await api.snapshot(CodemodeRunDoc, input.parent, context);
  if (!run?.start) return undefined;
  return { call: Number(input.key.slice(1)), parent: String(input.parent), startedAt: run.start.startedAt, seed: run.start.seed, ended: run.result !== undefined };
}
