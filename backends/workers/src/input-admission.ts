import { enqueueTerminalEvents } from "./event-log.ts";
import { reqKey, type RequestRecord } from "./agent-types.ts";
import { retryable, RETRY_DELAYS_MS } from "./schedule-policy.ts";
import type { AgentRuntime } from "./agent-runtime.ts";

/** The normal alarm planner owns retry timing, including across an eviction. */
export function inputAdmissionDeadline(records: RequestRecord[]): number {
  return Math.min(Infinity, ...records.flatMap(record => record.heldForInput && record.state !== "completed" && record.inputAdmissionRetry ? [record.inputAdmissionRetry.at] : []));
}

/** Called under admission serialization. A refused prompt must not block later senders. */
export async function releaseInputPrompts(runtime: AgentRuntime) {
  let changed = false, completed = false;
  for (const record of await runtime.records()) {
    if (!record.heldForInput || record.state === "completed" || (record.inputAdmissionRetry?.at ?? 0) > Date.now()) continue;
    const attempts = record.inputAdmissionRetry?.attempts ?? 0;
    try {
      await runtime.admit({ id: record.id, method: record.method, params: record.params }, undefined, undefined, record.fingerprint);
    } catch (error) {
      const current = await runtime.ctx.storage.get<RequestRecord>(reqKey(record.id)) ?? record;
      if (current.state === "completed") continue;
      // The durable Pi submission can succeed before the final alarm write fails.
      if (current.accepted) { runtime.track(current.id); continue; }
      const attempt = attempts + 1;
      const delay = retryable((error as { status?: number })?.status) ? RETRY_DELAYS_MS[attempt - 1] : undefined;
      if (delay !== undefined) {
        await runtime.ctx.storage.put(reqKey(record.id), { ...current, heldForInput: true, inputAdmissionRetry: { attempts: attempt, at: Date.now() + delay } });
      } else {
        // Release before completing: an interrupted release remains a held request and is safe to repeat.
        if (current.admitted) {
          const conf = await runtime.config();
          await runtime.env.TENANTS.getByName(conf.tenantId).release(`${conf.id}:${record.id}`);
        }
        const outcome = { error: error instanceof Error ? error.message : String(error) };
        await runtime.ctx.storage.transaction(async tx => {
          const latest = await tx.get<RequestRecord>(reqKey(record.id));
          if (latest?.state === "completed") return;
          const { heldForInput: _, inputAdmissionRetry: _retry, ...rest } = latest ?? record;
          await tx.put(reqKey(record.id), { ...rest, state: "completed", status: "failed", endedAt: Date.now(), outcome });
          await enqueueTerminalEvents(tx, record.id, outcome, false);
        });
        completed = true;
      }
      changed = true;
    }
  }
  try {
    if (completed) await runtime.flushTerminalEvents();
  } finally {
    if (changed) await runtime.arm();
  }
}
