import type { EntryRecord } from "@earendil-works/pi-durable";

/** Whether an entry has a model message other than a user's: a turn's answer, a tool's result, a system section. */
export const answers = (entry: Pick<EntryRecord, "model">) => (entry.model ?? []).some(message => message.role !== "user");

/**
 * Which `camel.prompt` entries, read in order, start a turn. On an agent whose queue batches, Pi starts one run with
 * every follow-up waiting (batch-queue.ts): the prompts after the first that Pi placed in the same run (`sameRun`: it
 * settles them with that run's answer) join the first's turn, so what follows them is the first's (usage, its answer).
 * `lead` is the prompt whose run is being read, until an answer.
 */
export class BatchRuns {
  lead?: string;
  starts(entry: Pick<EntryRecord, "kind" | "data" | "model">, sameRun = false) {
    if (entry.kind !== "camel.prompt") {
      if (answers(entry)) this.lead = undefined;
      return false;
    }
    if (this.lead !== undefined && sameRun) return false;
    this.lead = (entry.data as { requestId?: string } | undefined)?.requestId;
    return true;
  }
}
