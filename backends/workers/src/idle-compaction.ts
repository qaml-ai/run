import type { Context } from "@earendil-works/chord/context";
import type { Api, AssistantMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { CompactionTask, GenerationTask, InboxDoc, LiveDoc, hook, type EntryId, type Extension } from "@earendil-works/pi-durable";
import type { AgentRuntime } from "./agent-runtime.ts";
import type { Config } from "./agent-types.ts";
import { IDLE_COMPACTION_INSTRUCTIONS, IDLE_COMPACTION_KEY, IdleCompactionDoc, canDispatchIdleCompaction, idleCompactionEnabled, idleCompactionRevision, idleCompactionWindow, type IdleCompactionCandidate } from "./idle-compaction-schedule.ts";
import type { ModelIdleCache } from "./model-idle-compaction-payload.ts";
import { failure, metric } from "./observability.ts";
import { renderSenderMessages } from "./sender-extension.ts";

const STAGED_REQUEST = "idle-compaction-request";
const MIN_CACHED_TOKENS = 64_000;
const MAX_SUMMARY_TOKENS = 4_096;
export const IDLE_COMPACTION_SKIPPED = "Idle compaction skipped";
export const IDLE_SUMMARY_PROMPT = "Write a concise context checkpoint that another assistant can use to resume this conversation. Summarize the earlier history, preserving the user's goals and constraints, decisions, completed work, and pending work. Include exact paths, identifiers, and errors when they matter. Recent messages are retained separately. Only output the checkpoint. Do not continue the task or call tools.";

export type CachedRequest = {
  cache: ModelIdleCache;
  route?: { provider: string; id: string; serviceTier?: string };
  retention?: SimpleStreamOptions["cacheRetention"];
  keyHash: string;
  sessionId: string;
  at: number;
};
type StagedRequest = CachedRequest & { taskId: number; cutoff: EntryId; timestamp: number; revision: number };
type Candidate = IdleCompactionCandidate & CachedRequest;

export const IDLE_COMPACTION_CALL = Symbol("idleCompactionCall");
export type IdleCompactionDispatch = {
  [IDLE_COMPACTION_CALL]?:
    | { capture: (request: CachedRequest, message: AssistantMessage) => Promise<void> }
    | { replay: CachedRequest; stillIdle: () => Promise<boolean> };
};
type IdleCompactionOptions = SimpleStreamOptions & IdleCompactionDispatch;

function withOverrides<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, { get(object, key) {
    if (Object.hasOwn(overrides, key)) return Reflect.get(overrides, key);
    const value = Reflect.get(object, key, object);
    return typeof value === "function" ? value.bind(object) : value;
  } });
}

export function idleCompaction(host: AgentRuntime) {
  const storage = host.ctx.storage;
  const extension: Extension = {
    name: "camel.idle-compaction",
    hooks: [hook(GenerationTask, {
      afterRun: async (run, api, context) => {
        if (run.reason !== "answer") return;
        const staged = await storage.get<StagedRequest>(STAGED_REQUEST);
        if (staged?.taskId !== api.taskId) return;
        const answer = (await api.entry(run.answer, context))?.model?.[0];
        if (answer?.role !== "assistant" || answer.timestamp !== staged.timestamp) return;
        const { cache, at, cutoff, revision, keyHash, sessionId, route, retention } = staged;
        const candidate: Candidate = {
          cache, keyHash, sessionId, route, retention, at, cutoff, tail: run.last, revision,
          ...idleCompactionWindow(at, cache.ttlMs),
        };
        const stagedCandidate = await storage.transaction(async tx => {
          const config = await tx.get<Config>("configuration");
          const previous = await tx.get<Candidate>(IDLE_COMPACTION_KEY);
          await tx.delete(STAGED_REQUEST);
          if (revision === undefined || idleCompactionRevision(host.env, config) !== revision || !canDispatchIdleCompaction(candidate.expiresAt) ||
              (previous && previous.tail >= candidate.tail)) return false;
          await tx.put(IDLE_COMPACTION_KEY, candidate);
          return true;
        });
        if (stagedCandidate) host.ctx.waitUntil(host.arm().catch(error => failure(host.env, "idle_compaction_arm_failed", error)));
        return undefined;
      },
    })],
  };
  return {
    extension,
    generation: {
      definition: {
        ...GenerationTask.definition,
        phases: {
          ...GenerationTask.definition.phases,
          request: async (task, runtime, context) => {
            const original = GenerationTask.definition.phases.request;
            if (!idleCompactionEnabled(host.env)) return original(task, runtime, context);
            const checkpoint = task.state.checkpoint;
            if (checkpoint.phase !== "request") throw new Error("Missing request checkpoint");
            const revision = idleCompactionRevision(host.env, await storage.get<Config>("configuration"));
            if (revision === undefined) return original(task, runtime, context);
            const models = runtime.models;
            return original(task, withOverrides(runtime, {
              models: withOverrides(models, {
                streamSimple: (model, transcript, options) => {
                  const idleOptions: IdleCompactionOptions = {
                    ...options,
                    [IDLE_COMPACTION_CALL]: {
                      capture: async (request, message) => {
                        const { cacheRead, cacheWrite } = message.usage;
                        if (message.stopReason !== "stop" || cacheRead + cacheWrite < MIN_CACHED_TOKENS ||
                            !canDispatchIdleCompaction(request.at + request.cache.ttlMs)) return;
                        await storage.transaction(async tx => {
                          const config = await tx.get<Config>("configuration");
                          if (idleCompactionRevision(host.env, config) !== revision) return;
                          await tx.put<StagedRequest>(STAGED_REQUEST, {
                            ...request, taskId: task.id, cutoff: checkpoint.cutoff, timestamp: message.timestamp, revision,
                          });
                        });
                      },
                    },
                  };
                  return models.streamSimple(model, transcript, idleOptions);
                },
              }),
            }), context);
          },
        },
      },
    } satisfies typeof GenerationTask,
    compaction: {
      definition: {
        ...CompactionTask.definition,
        phases: {
          ...CompactionTask.definition.phases,
          summarize: async (task, runtime, context: Context) => {
            const original = CompactionTask.definition.phases.summarize;
            if (!task.input.instructions?.startsWith(`${IDLE_COMPACTION_INSTRUCTIONS}:`)) return original(task, runtime, context);
            const claim = await runtime.snapshot(IdleCompactionDoc, runtime.conversationId, context);
            if (claim?.taskId !== task.id) return original(task, runtime, context);
            const candidate = await storage.transaction(async tx => {
              const current = await tx.get<Candidate>(IDLE_COMPACTION_KEY);
              if (!current || current.tail !== claim.tail) return;
              await tx.delete(IDLE_COMPACTION_KEY);
              if (canDispatchIdleCompaction(current.expiresAt)) return current;
            });
            const stillIdle = async () => {
              if (!idleCompactionEnabled(host.env) || host.shuttingDown || !candidate || !canDispatchIdleCompaction(candidate.expiresAt)) return false;
              const [live, inbox, tail] = await Promise.all([
                runtime.snapshot(LiveDoc, runtime.conversationId, context),
                runtime.snapshot(InboxDoc, runtime.conversationId, context),
                runtime.entries({ order: "descending" }, 1, undefined, context),
              ]);
              if (live?.run || live?.compactions?.some(compaction => compaction.taskId !== task.id) || inbox?.items.length || tail.items[0]?.id !== candidate.tail) return false;
              const storageConfig = await storage.get<Config>("configuration");
              const revision = idleCompactionRevision(host.env, storageConfig);
              return revision !== undefined && revision === candidate.revision && !host.shuttingDown && canDispatchIdleCompaction(candidate.expiresAt);
            };
            if (!candidate || !await stillIdle())
              return CompactionTask.definition.abort(task, runtime, context);
            const originalRequest = await runtime.context(runtime.conversationId, context, { at: candidate.cutoff });
            const messages = await renderSenderMessages(originalRequest.messages, runtime, context, candidate.cutoff);
            const models = runtime.models;
            const skipped = new Error(IDLE_COMPACTION_SKIPPED);
            try {
              return await original(task, withOverrides(runtime, {
                settings: { ...runtime.settings, retry: { ...runtime.settings.retry, enabled: false } },
                models: withOverrides(models, {
                  completeSimple: async (model: Model<Api>, _transcript, options) => {
                    const idleOptions: IdleCompactionOptions = {
                      ...options,
                      maxRetries: 0,
                      maxTokens: Math.min(options?.maxTokens ?? MAX_SUMMARY_TOKENS, MAX_SUMMARY_TOKENS),
                      cacheRetention: candidate.retention,
                      [IDLE_COMPACTION_CALL]: { replay: candidate, stillIdle },
                    };
                    const message = await models.completeSimple(model, { messages: [
                      ...messages, { role: "user", timestamp: Date.now(), content: IDLE_SUMMARY_PROMPT },
                    ] }, idleOptions);
                    if (message.errorMessage?.includes(IDLE_COMPACTION_SKIPPED) && !message.usage.totalTokens) throw skipped;
                    const { input, cacheRead, cacheWrite, output } = message.usage;
                    metric(host.env, "idle_compaction_attempt", {
                      IdleCompactionAttempts: 1, IdleCompactionInputTokens: input, IdleCompactionCacheReadTokens: cacheRead,
                      IdleCompactionCacheWriteTokens: cacheWrite, IdleCompactionOutputTokens: output,
                    }, { Provider: message.provider, Model: message.model, Outcome: message.stopReason });
                    return message;
                  },
                }),
              }), context);
            } catch (error) {
              if (error !== skipped) throw error;
              return CompactionTask.definition.abort(task, runtime, context);
            }
          },
        },
      },
    } satisfies typeof CompactionTask,
  };
}
