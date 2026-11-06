import { DECISION_MODEL, Decider, DecisionFailed } from "./decision-policy.ts";
import { HttpError } from "./errors.ts";
import { createToolJudge, type JudgeContext } from "../../../src/core/tool-judge.ts";
export * from "../../../src/core/tool-judge.ts";

/** Bind the shared judgment policy to the Workers decision service. */
export function toolJudge(decider: Decider, context: JudgeContext) {
  return createToolJudge(decider, context, {
    model: DECISION_MODEL,
    failure: error => new DecisionFailed(error.status, error.message, { ...(error.code ? { code: error.code } : {}) }),
    isCreditError: error => error instanceof HttpError && error.status === 402,
  });
}
