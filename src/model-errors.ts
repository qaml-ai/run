/**
 * A failed model response, as the API describes it: what kind of failure (`errorClass`), the provider's HTTP status
 * when its error gives one, whether the runtime retries such a failure, and the model that failed. The one place that
 * decides: metrics count failures by `errorClass` (metrics.ts), the host retries what `retriesModelError` says, and a
 * run's error, its events and webhooks carry `modelFailure`, built from both, so none of them can disagree.
 */
import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { errorClass } from "./metrics.ts";
import { isStalled } from "./model-stream.ts";
import { refusedReasoningReplay } from "./deepseek-replay.ts";

/** Why a model request was cut by its node's stale lease. Retryable (a lost connection): it is made again once the lease is fresh, or by the agent's next owner. */
export const MODEL_INTERRUPTED = "Model request interrupted: this node's connection to its cluster was lost; it is made again once the node's lease is renewed";

export const MODEL_ERROR_CLASSES = ["billing", "rate_limit", "server", "refusal", "auth", "timeout", "other"] as const;
export type ModelErrorClass = typeof MODEL_ERROR_CLASSES[number];

/** A failed model response's facts, as a run's error, its `run.failed` webhook and its stream's events carry them. */
export interface ModelFailure {
  errorClass: ModelErrorClass;
  /** The provider's HTTP status, when its error says it. */
  providerStatus?: number;
  /** Whether the runtime retries this kind of failure itself: on a run that failed with it, its retries ran out. */
  retryable: boolean;
  /** The model that failed, as `provider/model-id` (an id of GET /v1/models). */
  model: string;
}

/** The metric classes (metrics.ts `errorClass`) as the API's fewer: what a caller would do differently for each. */
const API_CLASSES: Record<string, ModelErrorClass> = {
  billing: "billing",
  rate_limit: "rate_limit",
  overloaded: "server",
  provider_5xx: "server",
  network: "server",
  refusal: "refusal",
  auth: "auth",
  timeout: "timeout",
  stream_stalled: "timeout",
};

/** A failed response as the metric class `errorClass` gives it, in the API's classes. */
export function apiErrorClass(metricClass: string): ModelErrorClass {
  return API_CLASSES[metricClass] ?? "other";
}

/**
 * The HTTP status a provider's error carries in its message, as pi-ai and the providers' SDKs write it: leading
 * (`429 {…}`, `402: …`), in parentheses (`Mistral API error (429): …`), or named (`status code 503`, `HTTP 502`).
 */
export function providerStatus(message: string | null | undefined): number | undefined {
  if (!message) return undefined;
  const found = /^([45]\d\d)\b/.exec(message) ?? /\(([45]\d\d)\)/.exec(message) ?? /\b(?:status(?: code)?|HTTP)[ :=]*([45]\d\d)\b/i.exec(message);
  return found ? Number(found[1]) : undefined;
}

type Failed = Pick<AssistantMessage, "stopReason" | "errorMessage" | "provider" | "model"> & { rawStopReason?: string };
/** Where the failed request went: a tenant's own endpoint (`ownEndpoint`, which retries for itself), and the model's context window. */
export type FailureContext = { ownEndpoint: boolean; contextWindow?: number };

/**
 * Whether the host retries a failed response (agent-host.ts `recoverFailedResponses`): a request cut by this node's
 * stale lease always; DeepSeek's own endpoint refusing history without reasoning, on OpenRouter (the same request, which
 * OpenRouter's load balancing may give another host); otherwise what pi-ai deems transient (`isRetryableAssistantError`). A tenant's own endpoint has
 * retried already, so its errors end the turn, except a stream that went quiet: the runtime's own timeout, which no
 * endpoint could have retried. A context overflow is never retried as it is (the host compacts and continues instead,
 * before it asks this).
 */
export function retriesModelError(message: Failed, { ownEndpoint, contextWindow }: FailureContext): boolean {
  if (message.errorMessage === MODEL_INTERRUPTED) return true;
  if (isContextOverflow(message as AssistantMessage, contextWindow)) return false;
  // DeepSeek's own endpoint refusing history without reasoning (deepseek-replay.ts): asked again as it was, on whichever
  // host OpenRouter's load balancing picks.
  if (!ownEndpoint && message.provider === "openrouter" && refusedReasoningReplay(message.errorMessage)) return true;
  return isRetryableAssistantError(message as AssistantMessage) && (!ownEndpoint || isStalled(message.errorMessage));
}

/** A failed response (`stopReason: "error"`) as the API describes it. */
export function modelFailure(message: Failed, context: FailureContext): ModelFailure {
  const status = providerStatus(message.errorMessage);
  return {
    errorClass: apiErrorClass(errorClass(message.errorMessage || "error", message.rawStopReason)),
    ...(status !== undefined ? { providerStatus: status } : {}),
    retryable: retriesModelError(message, context),
    model: `${message.provider}/${message.model}`,
  };
}
