import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CompactionTask, InboxDoc, LiveDoc, defineDoc, type EntryId, type TaskId } from "@earendil-works/pi-durable";
import type { AgentRuntime } from "./agent-runtime.ts";
import type { Config, Env } from "./agent-types.ts";

export const IDLE_COMPACTION_KEY = "idle-compaction";
export const IDLE_COMPACTION_INSTRUCTIONS = "camel.idle-compaction.v1";
const DISPATCH_BUFFER_MS = 5_000;

export type IdleCompactionCandidate = {
  at: number;
  dueAt: number;
  expiresAt: number;
  cutoff: EntryId;
  tail: EntryId;
  revision: number;
  taskId?: number;
};

/** Claim the tail in the same commit that queues the task, even if the alarm is interrupted before updating its KV row. */
export const IdleCompactionDoc = defineDoc({
  kind: "camel.idle-compaction", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: (): { tail?: number; taskId?: number } => ({}),
  checkpointWhen: () => true,
});

/** Ordinary conversation aborts leave background tasks running. Shutdown also drains idle compaction. */
export async function abortIdleCompaction(runtime: Pick<AgentRuntime, "harness">) {
  const pi = await runtime.harness.pi();
  const root = await pi.root(BACKGROUND_CONTEXT);
  const claim = await pi.snapshot(IdleCompactionDoc, root.id, BACKGROUND_CONTEXT);
  if (claim?.taskId === undefined) return;
  const id = claim.taskId as TaskId;
  const task = await pi.getTask(id, BACKGROUND_CONTEXT);
  if (!task || task.state.status === "terminal") return;
  await pi.abortTask(id, BACKGROUND_CONTEXT);
  await pi.waitForTask(id, BACKGROUND_CONTEXT);
}

export function idleCompactionEnabled(env: Pick<Env, "AGENT_IDLE_COMPACTION">, config?: Pick<Config["config"], "idleCompaction">) {
  return env.AGENT_IDLE_COMPACTION !== "0" && config?.idleCompaction !== false;
}

export function idleCompactionRevision(env: Pick<Env, "AGENT_IDLE_COMPACTION">, config?: Config) {
  if (!config || !idleCompactionEnabled(env, config.config) || (config.expiresAt !== null && config.expiresAt <= Date.now())) return undefined;
  return config.revision;
}

export function idleCompactionWindow(at: number, ttlMs: number) {
  const expiresAt = at + ttlMs;
  return { dueAt: expiresAt - Math.max(60_000, Math.ceil(ttlMs / 10)), expiresAt };
}

export function canDispatchIdleCompaction(expiresAt: number) {
  return Date.now() + DISPATCH_BUFFER_MS < expiresAt;
}

export async function idleCompactionDeadline(runtime: AgentRuntime, config?: Config) {
  if (!idleCompactionEnabled(runtime.env)) return Infinity;
  const storage = runtime.ctx.storage;
  const candidate = await storage.get<IdleCompactionCandidate>(IDLE_COMPACTION_KEY);
  if (!candidate) return Infinity;
  const revision = idleCompactionRevision(runtime.env, config ?? await storage.get<Config>("configuration"));
  if (revision === undefined || revision !== candidate.revision) return Infinity;
  return candidate.taskId === undefined ? Math.min(candidate.dueAt, candidate.expiresAt) : candidate.expiresAt;
}

export async function wakeIdleCompaction(runtime: AgentRuntime) {
  if (await idleCompactionDeadline(runtime) > Date.now()) return;
  const work = runtime.admission.then(async () => {
    const storage = runtime.ctx.storage;
    const candidate = await storage.get<IdleCompactionCandidate>(IDLE_COMPACTION_KEY);
    if (!candidate) return;
    let taskId: number | undefined;
    if (canDispatchIdleCompaction(candidate.expiresAt)) {
      if (candidate.taskId !== undefined || candidate.dueAt > Date.now()) return;
      const revision = idleCompactionRevision(runtime.env, await storage.get<Config>("configuration"));
      if (revision !== undefined && revision === candidate.revision && !runtime.shuttingDown && !await runtime.gone("wake", "idle_compaction") &&
          !(await runtime.records()).some(record => record.state !== "completed")) {
        const pi = await runtime.harness.pi();
        const root = await pi.root(BACKGROUND_CONTEXT);
        taskId = await root.commit(async tx => {
          const live = await tx.doc(LiveDoc, root.id);
          const inbox = await tx.doc(InboxDoc, root.id);
          if (!canDispatchIdleCompaction(candidate.expiresAt) || live.run || inbox.items.length || await tx.latestEntryId(root.id) !== candidate.tail) return;
          const claim = await tx.doc(IdleCompactionDoc, root.id);
          if (claim.tail === candidate.tail) return claim.taskId;
          if (live.compactions?.length) return;
          const id = await tx.createTask(CompactionTask, {
            reason: "threshold", instructions: `${IDLE_COMPACTION_INSTRUCTIONS}:${candidate.tail}`,
          }, { ownership: { kind: "conversation" }, conversationId: root.id, background: true });
          claim.tail = candidate.tail;
          claim.taskId = id;
          live.compactions = [{ taskId: id, trigger: "threshold", blocking: false, attempt: 1 }];
          return id;
        }, BACKGROUND_CONTEXT);
      }
    }
    await storage.transaction(async tx => {
      const latest = await tx.get<IdleCompactionCandidate>(IDLE_COMPACTION_KEY);
      if (latest?.tail !== candidate.tail || latest.revision !== candidate.revision) return;
      if (taskId === undefined) await tx.delete(IDLE_COMPACTION_KEY);
      else await tx.put(IDLE_COMPACTION_KEY, { ...latest, taskId });
    });
  });
  // Only wait for the durable admission. Pi owns the model call and places the summary at a safe conversation boundary.
  runtime.admission = work.catch(() => {});
  await work;
}
