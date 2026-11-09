import { answerValue, type InputAnswer, type InputValue } from "@camelai/run/chat";
import type { InboxItem, InboxPage, InboxOutcome } from "../../../clients/typescript";
import { api, ApiError } from "./api";
export type { InboxItem, InboxPage };
export const inboxCount = (page?: InboxPage) => Object.values(page?.counts?.priority ?? {}).reduce((sum, n) => sum + n, 0);
/** Answer the observed version; the caller can reuse the key after a lost response. */
export async function answerInbox(item: InboxItem, value: InputValue | InputAnswer, requestId: string = crypto.randomUUID()) {
  const answer = typeof value === "object" && value !== null && "action" in value ? value : answerValue(item, value as InputValue);
  const result = await api<{ outcomes: InboxOutcome[] }>("/v1/inbox/answers", { body: {
    requestId, answers: [{ ...answer, agent: item.agent, id: item.id, version: item.version }],
  } });
  const outcome = result.outcomes.find(outcome => outcome.agent === item.agent && outcome.id === item.id);
  window.dispatchEvent(new Event("inbox-changed"));
  if (!outcome) throw new Error("The answer response is missing this input.");
  if (outcome.outcome !== "answered" && outcome.outcome !== "same")
    throw new ApiError(outcome.status, outcome.error ?? (outcome.retryable ? "The agent is unavailable. Try again." : "This input changed. Review it and try again."), outcome.outcome);
  return outcome;
}
