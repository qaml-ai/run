import { answerValue, type InputAnswer, type InputValue } from "@camelai/run/chat";
import type { InboxItem, InboxPage } from "../../../clients/typescript";
import { api } from "./api";
export type { InboxItem, InboxPage };
export const inboxCount = (page?: InboxPage) => Object.values(page?.counts?.priority ?? {}).reduce((sum, n) => sum + n, 0);
/** Single boundary to replace when the batch inbox answer endpoint ships. */
export async function answerInbox(item: InboxItem, value: InputValue | InputAnswer) {
  const answer = typeof value === "object" && value !== null && "action" in value ? value : answerValue(item, value as InputValue);
  await api(`/v1/agents/${encodeURIComponent(item.agent)}/inputs/${encodeURIComponent(item.inputId)}`, { body: answer });
  window.dispatchEvent(new Event("inbox-changed"));
}
