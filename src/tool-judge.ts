import { DECISION_MODEL, Decider, DecisionFailed, type Answer, type DecisionItem, type NoulQuestion } from "./decisions.ts";
import { HttpError } from "./http.ts";
import { JUDGE_LIMITS } from "./limits.ts";
import type { UsageRecord } from "./client-sessions/state.ts";

/**
 * Judged approvals: one call judged by a decision model (TypeSafe's Jev, the same one `decide` uses) before it runs, so
 * an agent whose sources say `approval: { default: "judged" }` makes ordinary calls without a person and still stops for
 * the ones that could hurt. The judge reads the request that started the run, the tool and the call's arguments, and
 * answers three yes/no questions; `judgedOutcome` turns the probabilities into a decision, so the policy is a table in
 * code that a test can pin rather than a prompt to the judge:
 *
 * - exfiltration (credentials or private data leaving the user's systems, or an effect that must never run) at 0.5 or
 *   more is **denied**: no person is asked, and a person cannot allow it either.
 *   Anything else that may be irreversible — deleting or overwriting what already existed, rewriting history, writing to
 *   production, changing permissions — is **asked**: the ordinary approval input, so the person sees the real call.
 * - an ordinary, reversible step at 0.75 or more is **allowed**, and runs with no person in the loop.
 * - everything else is **asked**, as is a judge that could not answer: no key, no budget, a provider failure, a timeout or
 *   an answer this cannot read. A judge that cannot judge is never a reason to let a call through.
 *
 * The request, the tool's description and the arguments are data: they ride in the state, never in a question, so text inside
 * them — a tool a tenant's server describes, a message a person forwarded — has no instruction to follow, and the questions
 * that decide are always the same three. Neither the request, the arguments nor the answers are ever logged: lines carry the
 * decision, the model and what it cost.
 */

/** What the judge decided about one call, and the answer that decided it. */
export type Judged = {
  decision: "allow" | "ask" | "deny";
  /** low: ordinary and reversible. medium: may be irreversible, or could not be judged. high: must not run. */
  risk: "low" | "medium" | "high";
  /** The probability of the answer that decided it (0..1), for a log line: never shown to the model or the person. */
  likely: number;
  /**
   * Why a call was not judged, when it was not: what the judge could not read (`unjudgeable`), a run with nothing left
   * of its spend limit (`budget`), or a judge that failed or did not answer (`failed`). Absent when it answered.
   */
  reason?: "unjudgeable" | "budget" | "failed";
};

/** One call as the judge sees it: the tool, what it does, its arguments, and the request it answers. */
export type JudgeInput = {
  tool: string;
  description: string;
  args: Record<string, unknown>;
  /** The request that started the run, when there is one: the only thing that can authorize anything. */
  intent?: string;
};

/** Judges one call. Never throws on a judge that could not answer (that is `ask`); an aborted call's abort is rethrown. */
export type Judge = (input: JudgeInput, signal: AbortSignal) => Promise<Judged>;

/** A probability at or above which a risk question counts. Jev is calibrated, so these are read as probabilities. */
const DANGER = 0.5, ORDINARY = 0.75;

/** What each question asks, and what counts as yes and no: short, since Jev bills the instructions per call. */
const QUESTIONS: Record<string, NoulQuestion> = {
  ordinary: {
    type: "noul",
    instructions: "Is this call an ordinary, reversible step toward the request: a read, a small change inside the project being worked on, a test, build or lookup?",
    criteria: { true: "ordinary, reversible work toward the request", false: "anything else" },
  },
  irreversible: {
    type: "noul",
    instructions: "Would this call irreversibly delete, overwrite or destroy something that already existed, rewrite history, write to production, or change permissions or security settings?",
    criteria: { true: "removes or rewrites what existed, or changes production, permissions or security", false: "anything else" },
  },
  exfiltration: {
    type: "noul",
    instructions: "Would this call send credentials, secrets or private data outside the user's own systems, or otherwise do something that must never run without a person?",
    criteria: { true: "private data leaves the user's systems, or must never run unattended", false: "anything else" },
  },
};

/**
 * Whether the judge can be shown the whole call. Arguments past their limit are not judged from a prefix: a caller could
 * pad the part the judge reads with ordinary work and put the rest — a delete, an upload, a webhook — after it, which
 * would turn a limit into a way through (tool-judge.test.ts pins it). A description past its limit is refused for the
 * same reason: it is a server's text, and the judge reasons over it.
 */
export function judgeable(input: JudgeInput) {
  return JSON.stringify(input.args ?? {}).length <= JUDGE_LIMITS.argumentsChars && (input.description ?? "").length <= JUDGE_LIMITS.descriptionChars;
}

/**
 * The state the questions are asked about: the request, the tool and the call's arguments as JSON. A request longer than
 * its limit keeps its start and its end, since a restriction is often the last thing said; the rest is marked as left out.
 */
export function judgeState(input: JudgeInput) {
  const intent = input.intent?.trim() ?? "";
  return JSON.stringify({ request: intent ? edges(intent) : undefined, tool: input.tool, description: input.description ?? "", arguments: JSON.stringify(input.args ?? {}) });
}

/** A request's start and end, cut between characters rather than into one (a surrogate pair is two code units). */
function edges(intent: string) {
  if (intent.length <= JUDGE_LIMITS.intentChars) return intent;
  const points = Array.from(intent), head = JUDGE_LIMITS.intentChars - JUDGE_LIMITS.intentTailChars;
  return `${points.slice(0, head).join("")}\n[…left out…]\n${points.slice(-JUDGE_LIMITS.intentTailChars).join("")}`;
}

/** The one item a judged call asks about. Its questions are fixed: a caller cannot ask fewer, or different ones. */
export function judgeItem(input: JudgeInput): DecisionItem {
  return { state: judgeState(input), questions: QUESTIONS };
}

const probability = (answer: Answer | undefined) => answer?.type === "noul" ? answer.noul : undefined;

/**
 * The decision a judge's answers call for, as the table above reads: exfiltration denies, anything that may be
 * irreversible asks, an ordinary call allows, and an answer that is not there asks. A high risk denies even when the call
 * also reads as ordinary; a medium one asks even when it does.
 */
export function judgedOutcome(answers: Record<string, Answer>): Judged {
  const ordinary = probability(answers.ordinary), irreversible = probability(answers.irreversible), exfiltration = probability(answers.exfiltration);
  if (exfiltration === undefined || irreversible === undefined || ordinary === undefined) return { decision: "ask", risk: "medium", likely: 0 };
  if (exfiltration >= DANGER) return { decision: "deny", risk: "high", likely: exfiltration };
  if (irreversible >= DANGER) return { decision: "ask", risk: "medium", likely: irreversible };
  if (ordinary >= ORDINARY) return { decision: "allow", risk: "low", likely: ordinary };
  return { decision: "ask", risk: "medium", likely: Math.max(irreversible, 1 - ordinary) };
}

/** What a judge that could not judge answers: the person decides, as for any call the judge is unsure about. */
export const UNJUDGED: Judged = Object.freeze({ decision: "ask", risk: "medium", likely: 0 });

/** What a judge is given to answer with: the tenant's key scope, its data policy, its spend limit, and where usage goes. */
export type JudgeContext = {
  tenant: string;
  keyScope?: string;
  /** An agent (or run) that denies data collection: sent on, as `decide` sends it, where the provider takes it. */
  dataCollection?: "deny" | null;
  /** What is left of the run's spend limit, in USD: a call that may cost more than this is not sent. */
  budget?: () => Promise<number | undefined>;
  /** Records what the judge cost, as a decision's usage is recorded (billing, `usage.recorded`). */
  record?: (usage: UsageRecord) => void;
  /** When an end user pays: holds the estimate of their credit before the call, then settles or releases it. */
  hold?: (usd: number) => Promise<{ settle(usd: number): Promise<void>; release(): Promise<void> } | undefined>;
  /** A judge that could not answer, for a log line: the error only, never the state it was asked about. */
  onError?: (error: unknown) => void;
  /** What a judge decided, for a log line: the decision and its risk, never the request, the arguments or the answer. */
  onJudged?: (input: JudgeInput, judged: Judged) => void;
};

/**
 * A judge backed by the decisions service: one call's questions in one request, answered by `DECISION_MODEL` (Jev) on the
 * tenant's OpenRouter key, else the platform's. Every failure — no key, a spent budget, the provider down, an answer this
 * cannot read — is `ask`, so the call waits for a person instead of running unjudged.
 */
export function toolJudge(decider: Decider, context: JudgeContext): Judge {
  /** An answer the judge did not give, and why: counted like any other, so asks are not invisible. */
  const unanswered = (input: JudgeInput, reason: NonNullable<Judged["reason"]>): Judged => {
    const judged = { ...UNJUDGED, reason };
    context.onJudged?.(input, judged);
    return judged;
  };
  return async (input, signal) => {
    // What it cannot see whole, it does not judge: the person decides instead (see judgeable).
    if (!judgeable(input)) return unanswered(input, "unjudgeable");
    let held: Awaited<ReturnType<NonNullable<JudgeContext["hold"]>>>;
    try {
      const budget = await context.budget?.();
      if (budget !== undefined && budget <= 0) return unanswered(input, "budget");
      held = await context.hold?.(decider.estimate([judgeItem(input)], DECISION_MODEL));
      const decided = await decider.decide({
        tenant: context.tenant, ...(context.keyScope ? { keyScope: context.keyScope } : {}),
        ...(budget !== undefined ? { budget } : {}), ...(context.dataCollection ? { dataCollection: context.dataCollection } : {}),
      }, { items: [judgeItem(input)], batch: false, model: DECISION_MODEL }, AbortSignal.any([signal, AbortSignal.timeout(JUDGE_LIMITS.timeoutMs)]));
      const first = decided.results[0]!;
      // Recorded whether it answered or failed: a failed item is not billed, and the usage record says which answered.
      if (decided.usage) context.record?.(decided.usage);
      await held?.settle(decided.chargedUsd);
      held = undefined;
      if ("error" in first) {
        context.onError?.(new DecisionFailed(first.error.status, first.error.message, { ...(first.error.code ? { code: first.error.code } : {}) }));
        return unanswered(input, "failed");
      }
      const judged = judgedOutcome(first.answers);
      context.onJudged?.(input, judged);
      return judged;
    } catch (error) {
      await held?.release();
      // A call that was aborted is not a judge that could not answer: the abort goes where it was going.
      if (signal.aborted) throw signal.reason;
      // Nothing left of what the person may spend is a refusal to spend, not a judge that broke: no failure line.
      if (error instanceof HttpError && error.status === 402) return unanswered(input, "budget");
      context.onError?.(error);
      return unanswered(input, "failed");
    }
  };
}

/**
 * A refused call, as its tool result: the model learns that it did not run, not which question answered or with what.
 * A denial is not remembered — the next call is judged on its own — so it says do not retry rather than claiming that a
 * retry cannot pass. Pinned by a test, since a model reads it as the whole story of the call.
 */
export const DENIED_PERMISSION = (tool: string) =>
  `Permission to use ${tool} has been denied: it was judged too risky to run here, and it did not run. Do not retry it, or a rewrite of it. If the user wants it done, say what you would run and let them start it themselves.`;
