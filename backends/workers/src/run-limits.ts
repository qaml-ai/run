import {
  GenerationTask,
  hook,
  type Extension,
} from "@earendil-works/pi-durable";
import type { AgentConfiguration } from "./api-contract.ts";
import { dollars } from "./agent-spend-policy.ts";
import { agentSpendRefusal, type SpendLimit } from "./agent-spend.ts";
import { RUN_LIMITS, duration } from "./run-caps-policy.ts";

type Run = {
  id: string;
  began?: number;
  startedAt?: number;
  state?: string;
  params?: Record<string, unknown>;
  agentSpendAt?: number | null;
};
type Usage = { responses: number; costUsd: number };
export type RuntimeLimit = {
  error: string;
  code: "turn_limit" | "spend_limit";
  stopped: "turn_limit" | "spend_limit";
  limit?: "run" | "agent";
};
const defaults = RUN_LIMITS;

/** Agent and request caps can lower the runtime's cap; neither can raise it. */
export function runCaps(config: AgentConfiguration, run: Run, most = defaults) {
  const own = config.runLimits ?? {},
    per = run.params?.runLimits as typeof own | undefined;
  const spend = run.params?.spendLimit as { usd: number } | undefined;
  return {
    maxResponses: Math.min(
      most.maxResponses,
      own.maxResponses ?? Infinity,
      per?.maxResponses ?? Infinity,
    ),
    maxSeconds: Math.min(
      most.maxSeconds,
      own.maxSeconds ?? Infinity,
      per?.maxSeconds ?? Infinity,
    ),
    spendUsd: spend?.usd ?? Infinity,
  };
}
export function runLimit(
  config: AgentConfiguration,
  run: Run,
  usage: Usage,
  now = Date.now(),
  most = defaults,
): RuntimeLimit | undefined {
  const caps = runCaps(config, run, most);
  const error =
    usage.responses >= caps.maxResponses
      ? `This run stopped at its limit of ${caps.maxResponses} model responses. Send another message to continue`
      : run.began !== undefined && now - run.began >= caps.maxSeconds * 1000
        ? `This run stopped at its time limit of ${duration(caps.maxSeconds)}. Send another message to continue`
        : undefined;
  if (error) return { error, code: "turn_limit", stopped: "turn_limit" };
  if (usage.costUsd >= caps.spendUsd)
    return {
      error: `This run has reached its spend limit of ${dollars(caps.spendUsd)} (${dollars(usage.costUsd)} spent)`,
      limit: "run",
      code: "spend_limit",
      stopped: "spend_limit",
    };
}

export class AgentRunLimits {
  private storage: DurableObjectStorage;
  private current: () => Promise<{
    config: AgentConfiguration;
    run: Run;
    agentId?: string;
    spend?: SpendLimit | null;
    most?: typeof defaults;
  }>;
  constructor(
    storage: DurableObjectStorage,
    current: AgentRunLimits["current"],
  ) {
    this.storage = storage;
    this.current = current;
  }
  async check(now = Date.now()) {
    const { config, run, agentId, spend, most } = await this.current();
    if (!run.state || run.state === "completed") return;
    const usage = (await this.storage.get<Usage>(`run-usage:${run.id}`)) ?? {
      responses: 0,
      costUsd: 0,
    };
    const stopped =
      runLimit(config, run, usage, now, most) ??
      (agentId ? agentSpendRefusal(agentId, spend ?? null) : undefined);
    if (stopped) await this.storage.put(`run-limit:${run.id}`, stopped);
    return stopped;
  }
  async deadline() {
    const { config, run, most } = await this.current();
    return run.state === "running" && run.began !== undefined
      ? run.began + runCaps(config, run, most).maxSeconds * 1000
      : Infinity;
  }
  extension(): Extension {
    return {
      name: "camel.run-limits",
      hooks: [
        hook(GenerationTask, {
          beforeRequest: async () => {
            const stopped = await this.check();
            if (stopped) throw new Error(stopped.error);
            return undefined;
          },
          afterResponse: async (message, api, context) => {
            const { run } = await this.current();
            const key = `run-response:${run.id}:${api.taskId}:${message.timestamp}`;
            if (await this.storage.get(key)) return;
            await this.storage.transaction(async (tx) => {
              if (await tx.get(key)) return;
              const usage = (await tx.get<Usage>(`run-usage:${run.id}`)) ?? {
                responses: 0,
                costUsd: 0,
              };
              usage.responses++;
              usage.costUsd += message.usage.cost.total;
              await tx.put(`run-usage:${run.id}`, usage);
              await tx.put(key, true);
            });
          },
        }),
      ],
    };
  }
}
