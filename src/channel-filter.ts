import { HttpError } from "./http.ts";
import { questionInput, type NoulQuestion, type State } from "./decisions.ts";

/**
 * A channel's filter: one yes/no question a decision model answers about each message before it starts a turn, and the
 * probability the answer must reach. A message below it never starts a run: it is kept for FILTERED_DAYS, listed by
 * `GET /v1/channels/:id/events`, and can still be delivered. channels.ts asks, for every channel type alike.
 */
export interface ChannelFilter { instructions: string; criteria?: { true?: string; false?: string }; threshold: number }

/**
 * Why a message passed or not. `score`: the model's answer against the threshold. `decision_failed`: no answer, so it
 * went on rather than be dropped. The rest are never asked about: a message with `no_text`, one that `answers_input` the
 * agent waits on, and a `follow_up` in a thread with an agent.
 */
export type VerdictReason = "score" | "decision_failed" | "no_text" | "answers_input" | "follow_up";
/** What a filter said about one message, stored with its seen marker: no content, no state, no provider's words. */
export type Verdict = {
  item: string; conversation: string; at: number; outcome: "passed" | "filtered"; reason: VerdictReason; threshold: number;
  score?: number; model?: string; costUsd?: number; ms?: number;
  error?: { status: number; code?: string };
  deliveredAt?: number;
};

export const DEFAULT_THRESHOLD = 0.5;
/** How long a filtered message can be delivered, and its record listed. */
export const FILTERED_DAYS = 14;
/** One message's wait for an answer, retries included; past it the message goes on. Jev answers in 70-500 ms. */
export const FILTER_TIMEOUT_MS = 15_000;
/** The message's text sent as the state, from its start (about 5,000 tokens). */
export const FILTER_TEXT_CHARS = 16_000;
export const FILTER_QUESTION = "passes";

/** A filter as given, checked; `criteria` as a noul question takes it. */
export function channelFilter(value: unknown): ChannelFilter {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "filter is {instructions, criteria?, threshold?}");
  const { threshold, ...question } = value as Record<string, unknown>;
  const extra = Object.keys(question).filter(key => key !== "instructions" && key !== "criteria");
  if (extra.length) throw new HttpError(400, `filter has unknown fields: ${extra.join(", ")}`);
  if (threshold !== undefined && (typeof threshold !== "number" || !(threshold >= 0 && threshold <= 1))) throw new HttpError(400, "filter.threshold is a probability from 0 to 1");
  const { instructions, criteria } = questionInput({ type: "noul", ...question }, FILTER_QUESTION, "filter") as NoulQuestion;
  return { instructions, ...(criteria ? { criteria } : {}), threshold: threshold === undefined ? DEFAULT_THRESHOLD : threshold as number };
}

/** What the model is asked about: the message as the agent would get it, its text bounded, attachments by name only. */
export function filterState(type: string, inbound: { sender: { id: string; name?: string; username?: string }; text: string; files?: { name: string }[]; title?: string; unverified?: boolean }): State {
  const { id, name, username } = inbound.sender;
  return {
    channel: type, from: { id, ...(name ? { name } : {}), ...(username ? { username } : {}) }, ...(inbound.unverified ? { unverified: true } : {}),
    ...(inbound.title ? { title: inbound.title } : {}), text: inbound.text.slice(0, FILTER_TEXT_CHARS),
    ...(inbound.files?.length ? { attachments: inbound.files.slice(0, 10).map(file => file.name.slice(0, 200)) } : {}),
  };
}
