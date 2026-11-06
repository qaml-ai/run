import { DECISION_MODEL, DecisionFailed, type Decider } from "./decisions.ts";
import { HttpError } from "./http-error.ts";
import { createToolJudge, type JudgeContext as SharedJudgeContext } from "./core/tool-judge.ts";
import type { UsageRecord } from "./client-sessions/state.ts";
export * from "./core/tool-judge.ts";
export type JudgeContext = SharedJudgeContext<UsageRecord>;

/** Bind the shared judgment policy to the Node decision service. */
export function toolJudge(decider: Decider, context: JudgeContext) {
  return createToolJudge(decider, context, {
    model: DECISION_MODEL,
    failure: error => new DecisionFailed(error.status, error.message, { ...(error.code ? { code: error.code } : {}) }),
    isCreditError: error => error instanceof HttpError && error.status === 402,
  });
}
