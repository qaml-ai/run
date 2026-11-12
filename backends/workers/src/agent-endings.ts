import { PARENT_KEYS, MULTI_AGENT_LIMITS } from "./multi-agent-policy.ts";
import { agentOwner, placementOf, type Owner } from "../../../shared/owner.ts";
import type { Config, RequestRecord } from "./agent-types.ts";
import { reqKey } from "./agent-types.ts";
import type { AgentRuntime } from "./agent-runtime.ts";

/**
 * Who owns a run's ending: the owner its placement names (a run its owner started through the binding), or, for a run
 * older code started (its prompt's metadata named the parent), that parent agent. Undefined for anyone else's run.
 */
export function runOwner(record: Pick<RequestRecord, "delegation" | "metadata" | "params">): Owner | undefined {
  const placed = placementOf(record.delegation);
  if (placed) return placed.owner;
  const metadata = (record.metadata ?? record.params?.metadata) as Record<string, unknown> | undefined;
  const parent = metadata?.[PARENT_KEYS.agent];
  return typeof parent === "string" && parent ? agentOwner(parent) : undefined;
}

/**
 * Stage a completed run's ending in this agent's outbox, in `tx` (the transaction committing its response event), and
 * mark the run staged so the start-up check below leaves it alone. Staged twice (a repeated emit), the owner's receive
 * takes it once.
 */
export async function stageEnding(runtime: AgentRuntime, tx: DurableObjectTransaction, conf: Config, record: RequestRecord, outcome: unknown) {
  const owner = runOwner(record);
  if (!owner) return false;
  const ended = { ...record, state: "completed" as const, outcome: (outcome ?? record.outcome) as RequestRecord["outcome"] };
  await runtime.outbox.stageEnding(tx, owner, { agentId: conf.id, requestId: record.id, record: ended as never });
  const current = await tx.get<RequestRecord>(reqKey(record.id));
  if (current) await tx.put(reqKey(record.id), { ...current, endingStaged: true } satisfies RequestRecord);
  return true;
}

/**
 * At start: a run that ended with no ending staged (its record completed, and the object lost before its response
 * event committed) stages it now. Only runs that ended within a child's lifetime are looked at.
 */
export async function stageMissedEndings(runtime: AgentRuntime, records: RequestRecord[]) {
  const conf = await runtime.ctx.storage.get<Config>("configuration");
  if (!conf) return;
  const since = Date.now() - MULTI_AGENT_LIMITS.childTtlSeconds * 1000;
  const missed = records.filter(record => record.state === "completed" && !record.endingStaged && (record.endedAt ?? 0) >= since && runOwner(record));
  if (!missed.length) return;
  await runtime.ctx.storage.transaction(async tx => {
    for (const record of missed) await stageEnding(runtime, tx, conf, record, record.outcome);
  });
  // Delivered by the caller's outbox flush (at start, after startup: agent-lifecycle restorePending).
}

/**
 * A deleted or expired agent's start (restorePendingImpl): it restores no work, but a run's ending it still owes (one that
 * ended as the object died, before the event that stages it) is staged and delivered, then its next wake planned.
 */
export async function goneStart(runtime: Pick<AgentRuntime, "ctx" | "outbox" | "records" | "arm">, afterStart: (task: () => Promise<unknown>) => void = task => { void task(); }) {
  await stageMissedEndings(runtime as AgentRuntime, await runtime.records());
  // Delivered after startup: a flush reaches the owners' objects (startup holds this one's input gate).
  afterStart(() => runtime.outbox.flush());
  await runtime.arm();
}
