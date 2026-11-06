import { DECISION_MODEL, DecisionFailed, type Decider } from "./decision-policy.ts";
import { HttpError } from "./errors.ts";
import { createToolJudge, type JudgeContext as SharedJudgeContext } from "../../../src/core/tool-judge.ts";
import type { UsageRecord } from "./policy-host.ts";
export * from "../../../src/core/tool-judge.ts";
export type JudgeContext = SharedJudgeContext<UsageRecord>;

/** Bind the shared judgment policy to the Workers decision service. */
export function toolJudge(decider: Decider, context: JudgeContext) {
  return createToolJudge(decider, context, {
    model: DECISION_MODEL,
    failure: error => new DecisionFailed(error.status, error.message, { ...(error.code ? { code: error.code } : {}) }),
    isCreditError: error => error instanceof HttpError && error.status === 402,
  });
}
